import test from "node:test";
import assert from "node:assert/strict";
import {runNaming} from "../naming.mjs";
const selection={providerId:"fixture-provider",modelId:"fixture-model",options:{reasoningLevel:"low"}};
const base={title:"原名",fingerprint:"content-v1",latestUserId:"u3",turnCount:3,context:{current_title:"原名",recent_turns:[]}};
const candidate={action:"rename",title:"🧩 双链联想｜编辑体验改进",reason:"基于持续目标"};
function fixture() {
  const box={snapshot:structuredClone(base),state:{},generations:0,renames:0};
  box.backend={
    read:async()=>structuredClone(box.snapshot),
    generate:async()=>{box.generations++;return{text:JSON.stringify(candidate),finishReason:"stop",usage:{inputTokens:40,outputTokens:10}};},
    rename:async title=>{box.renames++;box.snapshot.title=title;},
    saveState:async state=>{box.state=structuredClone(state);}
  };
  return box;
}
test("独立生成标题，写原 Host 并读回；重复 Stop 不重复调用模型",async()=>{
  const box=fixture();
  const result=await runNaming({backend:box.backend,selection,state:box.state,apply:true,eventUserId:"u3"});
  assert.equal(result.status,"renamed");assert.equal(box.snapshot.title,candidate.title);
  assert.equal(box.renames,1);assert.equal(box.state.lastTitle,candidate.title);
  const repeated=await runNaming({backend:box.backend,selection,state:box.state,apply:true});
  assert.equal(repeated.status,"unchanged");assert.equal(box.generations,1);
});
test("生成期间发生新输入，丢弃候选；旧 Stop 和手动标题不触发模型",async()=>{
  const box=fixture();
  box.backend.generate=async()=>{box.generations++;box.snapshot.fingerprint="content-v2";return{text:JSON.stringify(candidate),finishReason:"stop"};};
  const result=await runNaming({backend:box.backend,selection,state:{},apply:true});
  assert.equal(result.status,"stale_result");assert.equal(box.renames,0);
  const outdated=await runNaming({backend:box.backend,selection,state:{},apply:true,eventUserId:"u2"});
  assert.equal(outdated.status,"outdated_event");
  const manual=await runNaming({backend:box.backend,selection,state:{lastFingerprint:"v0",lastTitle:"此前自动标题"},apply:true});
  assert.equal(manual.status,"manual_title");assert.equal(box.state.locked,true);
  assert.equal(box.generations,1);
});
test("格式错误或模型截断时失败，原标题保持；keep 建立去重基线",async()=>{
  const box=fixture();
  box.backend.generate=async()=>({text:JSON.stringify({...candidate,title:"bad\nname"}),finishReason:"stop"});
  await assert.rejects(runNaming({backend:box.backend,selection,apply:true}),/标题/);
  assert.equal(box.renames,0);
  box.backend.generate=async()=>({text:JSON.stringify(candidate),finishReason:"length"});
  await assert.rejects(runNaming({backend:box.backend,selection,apply:true}),/结束/);
  box.backend.generate=async()=>({text:JSON.stringify({action:"keep",title:"模型错误复制",reason:"原标题合适"}),finishReason:"stop"});
  const keep=await runNaming({backend:box.backend,selection,apply:true,state:{}});
  assert.equal(keep.status,"kept");assert.equal(keep.title,"原名");assert.equal(box.state.lastFingerprint,"content-v1");
});
test("有待确认写入时通过读回恢复基线，归档/运行中会话不生成",async()=>{
  const box=fixture();box.snapshot.title=candidate.title;
  const result=await runNaming({backend:box.backend,selection,apply:true,state:{pendingTitle:candidate.title,pendingFingerprint:"content-v1"}});
  assert.equal(result.status,"unchanged");assert.equal(box.generations,0);
  box.snapshot.archived=true;
  assert.equal((await runNaming({backend:box.backend,selection,apply:true})).status,"archived");
  box.snapshot.archived=false;box.snapshot.running=true;
  assert.equal((await runNaming({backend:box.backend,selection,apply:true})).status,"running");
  assert.equal(box.generations,0);
});

test("stale_result 记录具体漂移原因：fingerprint/running/title",async()=>{
  const drift=(mutation,expected)=>{
    const box=fixture();
    box.backend.generate=async()=>{box.generations++;mutation(box.snapshot);return{text:JSON.stringify(candidate),finishReason:"stop"};};
    return runNaming({backend:box.backend,selection,state:{},apply:true}).then(r=>{
      assert.equal(r.status,"stale_result");
      assert.equal(r.staleReason,expected);
      assert.equal(box.renames,0);
    });
  };
  await drift(s=>{s.fingerprint="content-v2";},"fingerprint");
  await drift(s=>{s.running=true;},"running");
  await drift(s=>{s.title="他方改写";},"title");
});

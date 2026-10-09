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
test("宿主自动改名（generated）不锁定并重新命名；unchanged 需指纹与标题都一致",async()=>{
  const box=fixture();box.snapshot.title="宿主生成标题";box.snapshot.titleSource="generated";
  box.snapshot.fingerprint="content-v1";
  const result=await runNaming({backend:box.backend,selection,state:{lastFingerprint:"content-v1",lastTitle:"🧩 旧标题｜已过时"},apply:true});
  assert.equal(result.status,"renamed","generated 来源的标题变化是宿主竞争，不是用户手动");
  assert.equal(box.snapshot.title,candidate.title);
  const again=await runNaming({backend:box.backend,selection,state:box.state,apply:true});
  assert.equal(again.status,"unchanged");
  const box2=fixture();box2.snapshot.title="宿主又改回问题式";box2.snapshot.titleSource="generated";box2.snapshot.fingerprint="content-v1";
  const drift=await runNaming({backend:box2.backend,selection,state:{lastFingerprint:"content-v1",lastTitle:"🧩 旧标题｜已过时"},apply:true});
  assert.equal(drift.status,"renamed","指纹未变但标题被宿主改动，也应重新命名而非 unchanged");
});

test("生成期间宿主自动命名且内容未变，本轮直接写入候选并建立去重基线",async()=>{
  const box=fixture();box.snapshot.turnCount=1;box.snapshot.titleSource="first_input";
  const generate=box.backend.generate;
  box.backend.generate=async()=>{
    const result=await generate();
    box.snapshot.title="宿主首轮自动标题";box.snapshot.titleSource="generated";
    return result;
  };
  const result=await runNaming({backend:box.backend,selection,state:{},apply:true});
  assert.equal(result.status,"renamed");assert.equal(box.snapshot.title,candidate.title);
  assert.equal(box.generations,1);assert.equal(box.renames,1);
  assert.equal(box.state.lastTitle,candidate.title);assert.equal(box.state.lastFingerprint,"content-v1");
  assert.equal((await runNaming({backend:box.backend,selection,state:box.state,apply:true})).status,"unchanged");
  assert.equal(box.generations,1);assert.equal(box.renames,1);
});

test("候选沿用原标题时，仍能覆盖生成期间宿主写入的自动标题",async()=>{
  const box=fixture();box.snapshot.title=candidate.title;box.snapshot.context.current_title=candidate.title;
  const generate=box.backend.generate;
  box.backend.generate=async()=>{
    const result=await generate();
    box.snapshot.title="宿主自动标题";box.snapshot.titleSource="generated";
    return result;
  };
  const result=await runNaming({backend:box.backend,selection,state:{},apply:true});
  assert.equal(result.status,"renamed");assert.equal(box.snapshot.title,candidate.title);
  assert.equal(box.generations,1);assert.equal(box.renames,1);
  assert.equal(box.state.lastTitle,box.snapshot.title);
});

test("宿主生成标题已等于候选时不重复写入，保存实际标题作为基线",async()=>{
  const box=fixture(),generate=box.backend.generate;
  box.backend.generate=async()=>{
    const result=await generate();
    box.snapshot.title=candidate.title;box.snapshot.titleSource="generated";
    return result;
  };
  const result=await runNaming({backend:box.backend,selection,state:{},apply:true});
  assert.equal(result.status,"kept");assert.equal(result.title,candidate.title);
  assert.equal(box.generations,1);assert.equal(box.renames,0);
  assert.equal(box.state.lastTitle,box.snapshot.title);
  assert.equal(box.state.lastFingerprint,"content-v1");
});

test("自动命名竞争仍保留 keep、手动标题、新输入和会话状态保护",async t=>{
  const cases=[
    {name:"keep 不沿用原标题的判断",output:{action:"keep",title:"原名",reason:"原标题合适"},status:"stale_result",staleReason:"title"},
    {name:"custom 标题变化",change:{titleSource:"custom"},status:"stale_result",staleReason:"title"},
    {name:"来源未知的标题变化",change:{titleSource:null},status:"stale_result",staleReason:"title"},
    {name:"first_input 标题变化",change:{titleSource:"first_input"},status:"stale_result",staleReason:"title"},
    {name:"新输入",change:{fingerprint:"content-v2",latestUserId:"u4"},status:"stale_result",staleReason:"fingerprint"},
    {name:"会话继续运行",change:{running:true},status:"stale_result",staleReason:"running"},
    {name:"生成期间固定标题",change:{titlePolicy:{version:1,locked:true}},status:"locked"},
    {name:"生成期间归档",change:{archived:true},status:"archived"},
    {name:"生成期间删除",change:{deleted:true},status:"archived"}
  ];
  for(const item of cases)await t.test(item.name,async()=>{
    const box=fixture();
    box.backend.generate=async()=>{
      box.generations++;
      Object.assign(box.snapshot,{title:"生成期间的新标题",titleSource:"generated"},item.change);
      return{text:JSON.stringify(item.output??candidate),finishReason:"stop"};
    };
    const result=await runNaming({backend:box.backend,selection,state:{},apply:true});
    assert.equal(result.status,item.status);assert.equal(result.staleReason,item.staleReason);
    assert.equal(result.title,"生成期间的新标题");assert.equal(box.generations,1);
    assert.equal(box.renames,0);assert.deepEqual(box.state,{});
  });
});

test('MCP 显式不锁名称时非规范 keep 要纠正一次，并记录模型理由', async () => {
  const box = fixture();
  box.snapshot.titlePolicy = { version: 1, locked: false };
  box.backend.generate = async context => {
    box.generations++;
    assert.equal(context.title_format_required, true);
    return { text: JSON.stringify(box.generations === 1 ? { action: 'keep', title: '原名', reason: '信息不足' } : candidate), finishReason: 'stop' };
  };
  const result = await runNaming({ backend: box.backend, selection, apply: true,
    state: { lastFingerprint: 'content-v1', lastTitle: '原名', locked: true } });
  assert.equal(result.status, 'renamed');
  assert.equal(result.reason, candidate.reason);
  assert.equal(box.generations, 2);
  assert.equal(box.state.locked, undefined);
});

test('MCP 锁定策略阻止生成；持续返回不合规 keep 时失败而不记录成功基线', async () => {
  const box = fixture(); box.snapshot.titlePolicy = { version: 1, locked: true };
  assert.equal((await runNaming({ backend: box.backend, selection, apply: true })).status, 'locked');
  assert.equal(box.generations, 0);
  box.snapshot.titlePolicy.locked = false;
  box.backend.generate = async () => { box.generations++; return { text: JSON.stringify({ action: 'keep', title: '原名', reason: 'keep' }), finishReason: 'stop' }; };
  await assert.rejects(runNaming({ backend: box.backend, selection, apply: true }), /格式/);
  assert.equal(box.generations, 2);
  assert.deepEqual(box.state, {});
});

test('模型理由包含链接或凭据片段时拒绝，不将理由写入结果和状态', async () => {
  for (const reason of ['https://zcode.z.ai/remote/v4?sid=fixture&hash=fixture', 'hash=fixture-secret', '{"sid":"fixture"}', 'sk-fixture-secret', 'D:\\private\\fixture']) {
    const box = fixture();
    box.backend.generate = async () => ({ text: JSON.stringify({ ...candidate, reason }), finishReason: 'stop' });
    await assert.rejects(runNaming({ backend: box.backend, selection, apply: true }), e => /命名理由/.test(e.message) && !e.message.includes(reason));
    assert.deepEqual(box.state, {}); assert.equal(box.renames, 0);
  }
});

test('理由的普通英文词尾不误判成密钥或凭据字段', async () => {
  for (const reason of ['Task-based workflow matches the goal.', 'Work amid: ordinary context']) {
    const box = fixture();
    box.backend.generate = async () => ({ text: JSON.stringify({ ...candidate, reason }), finishReason: 'stop' });
    const result = await runNaming({ backend: box.backend, selection, apply: true });
    assert.equal(result.reason, reason); assert.equal(result.status, 'renamed');
  }
});

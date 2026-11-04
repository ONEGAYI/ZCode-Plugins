import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {dispatchStopEvent} from "../hook.mjs";
import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";

const pluginRoot="D:\\plugin";
test("原生 Hook 的事件与配置 JSON 错误分别记录固定诊断且不泄漏原文",()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-hook-json-")),config=join(root,"config.json"),hookPath=fileURLToPath(new URL("../hook.mjs",import.meta.url));
  const env={...process.env,OIL_ZCODE_TITLE_DATA:undefined,ZCODE_PLUGIN_DATA:root};
  try {
    writeFileSync(config,'{"enabled":true}');
    let run=spawnSync(process.execPath,[hookPath,"--config",config],{encoding:"utf8",input:'{"secret":"private-event-sentinel"',windowsHide:true,env});
    assert.equal(run.status,0);assert.match(run.stdout,/事件 JSON 格式无效/);assert.ok(!run.stdout.includes('private-event-sentinel'));
    writeFileSync(config,'{"secret":"private-config-sentinel"');
    run=spawnSync(process.execPath,[hookPath,"--config",config],{encoding:"utf8",input:JSON.stringify({session_id:"sess_x",cwd:"D:\\w"}),windowsHide:true,env});
    assert.equal(run.status,0);assert.match(run.stdout,/配置 JSON 格式无效/);assert.ok(!run.stdout.includes('private-config-sentinel'));
    const entries=readFileSync(join(root,"state","hook.log.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(entries.map(e=>e.error),["事件 JSON 格式无效","配置 JSON 格式无效"]);
  } finally {rmSync(root,{recursive:true});}
});
test("stop_hook_active 或无效负载直接跳过，不启动任何进程",async()=>{
  const calls=[];
  const spawnWorker=async()=>{calls.push(1);};
  const loadAuth=async()=>{calls.push(2);return "https://zcode.z.ai/remote/v4?sid=a&hash=b&mid=c";};
  assert.deepEqual(await dispatchStopEvent({payload:{session_id:"sess_x",cwd:"D:\\w",stop_hook_active:true},dataDir:"D",pluginRoot,loadAuth,spawnWorker}),{action:"skipped_stale"});
  assert.deepEqual(await dispatchStopEvent({payload:{bad:1},dataDir:"D",pluginRoot,loadAuth,spawnWorker}),{action:"ignored_invalid"});
  assert.deepEqual(await dispatchStopEvent({payload:{session_id:"nope",cwd:"D:\\w"},dataDir:"D",pluginRoot,loadAuth,spawnWorker}),{action:"ignored_invalid"});
  assert.equal(calls.length,0,"跳过路径不得读授权或建进程");
});
for (const sessionId of ['sess_x', 'session_316_fixture']) test(`网关模式 Stop 支持 ${sessionId.split('_')[0]} 前缀，仅传会话元数据`,async()=>{
  const calls=[];
  assert.deepEqual(await dispatchStopEvent({
    payload:{session_id:sessionId,cwd:"D:\\workspace"},dataDir:"D",pluginRoot,
    loadAuth:async()=>null,spawnWorker:async options=>{calls.push(options);},startDelayMs:0
  }),{action:"dispatched"});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].event,{session_id:sessionId,workspace_path:"D:\\workspace"});
});
test("有效事件后台派发：仅经 stdin 注入会话元数据",async()=>{
  const seen=[];
  await dispatchStopEvent({
    payload:{session_id:"sess_abc",cwd:"D:\\CODE\\Project\\x",hook_event_name:"Stop"},
    dataDir:"D:\\data",pluginRoot,configPath:"D:\\plugin\\config.local.json",
    loadAuth:async()=>"https://zcode.z.ai/remote/v4?sid=s&hash=h&mid=m",
    spawnWorker:async options=>seen.push(options),
    startDelayMs:0
  }).then(result=>{
    assert.deepEqual(result,{action:"dispatched"});
    assert.equal(seen.length,1);
    assert.deepEqual(seen[0].event,{session_id:"sess_abc",workspace_path:"D:\\CODE\\Project\\x"});
    assert.ok(seen[0].script.endsWith("cli.mjs"),"worker 必须走稳定 CLI 入口");
    assert.deepEqual(seen[0].args,["run","--apply","--config","D:\\plugin\\config.local.json"]);
  });
});
test("CLI 对 Stop 续跑静默退出且退出码为 0，并留日志",async()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-hook-"));
  try {
    const {spawnSync}=await import("node:child_process");
    const {fileURLToPath}=await import("node:url");
    const {readFileSync}=await import("node:fs");
    const hookPath=fileURLToPath(new URL("../hook.mjs",import.meta.url));
    const result=spawnSync(process.execPath,[hookPath,"--config",join(root,"none.json"),"--data-dir",join(root,"state")],{encoding:"utf8",input:JSON.stringify({session_id:"sess_x",cwd:"D:\\w",stop_hook_active:true}),windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    assert.ok(!result.stdout.startsWith("{"),"hook 输出不得以 { 开头以免被宿主误解析为 Hook JSON");
    const lines=readFileSync(join(root,"state","hook.log.jsonl"),"utf8").trim().split("\n");
    const entry=JSON.parse(lines[lines.length-1]);
    assert.equal(entry.action,"skipped_stale");
    assert.equal(entry.sessionId,"sess_x");
    assert.ok(entry.at,"日志必须带时间戳");
  } finally {rmSync(root,{recursive:true});}
});
test("worker 派发默认延迟 8 秒等宿主收尾，可注入归零",async()=>{
  const {dispatchStopEvent,WORKER_START_DELAY_MS}=await import("../hook.mjs");
  assert.equal(WORKER_START_DELAY_MS,8000,"Stop 触发瞬间宿主仍在持久化收尾，须让出窗口");
  let spawnedAt=0;
  const t0=Date.now();
  await dispatchStopEvent({
    payload:{session_id:"sess_delay",cwd:"D:\w"},dataDir:"D",pluginRoot,
    loadAuth:async()=>"https://zcode.z.ai/remote/v4?sid=s&hash=h&mid=m",
    spawnWorker:async()=>{spawnedAt=Date.now();},
    startDelayMs:30
  });
  assert.ok(spawnedAt-t0>=25,"派发必须发生在延迟之后");
});

test('原生 Hook 在配置缺失或尚未启用时直接跳过，不启动命名 worker',()=>{
  const root=mkdtempSync(join(tmpdir(),'z-title-native-hook-'));
  try {
    const preload=join(root,'deny-worker.mjs'),config=join(root,'config.json'),dataDir=join(root,'state');
    writeFileSync(preload,"import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.spawn=()=>{throw new Error('UNEXPECTED_WORKER');};syncBuiltinESMExports();global.setTimeout=()=>{throw new Error('UNEXPECTED_DELAY');};");
    for(const expected of ['not_configured','disabled']) {
      if(expected==='disabled')writeFileSync(config,'{"enabled":false}');
      const result=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('../hook.mjs',import.meta.url)),'--config',config],{encoding:'utf8',windowsHide:true,input:JSON.stringify({session_id:'sess_native_setup_fixture',cwd:'D:\\fixture'}),env:{...process.env,OIL_ZCODE_TITLE_DATA:undefined,ZCODE_PLUGIN_DATA:root}});
      assert.equal(result.status,0,result.stderr);
      const lines=readFileSync(join(dataDir,'hook.log.jsonl'),'utf8').trim().split('\n');
      assert.equal(JSON.parse(lines.at(-1)).action,expected);
    }
  } finally {rmSync(root,{recursive:true});}
});

test('原生 Stop 命令沿用外置配置的自定义状态目录',()=>{
  const root=mkdtempSync(join(tmpdir(),'z-title-native-custom-'));
  try {
    const titleRoot=fileURLToPath(new URL('../',import.meta.url));
    const spec=JSON.parse(readFileSync(new URL('../hooks/hooks.json',import.meta.url),'utf8')).hooks.Stop[0].hooks[0];
    writeFileSync(join(root,'config.json'),JSON.stringify({registration:'native',enabled:false,dataDir:'自定义 状态'}));
    const command=spec.command.replaceAll('${ZCODE_PLUGIN_ROOT}',titleRoot).replaceAll('${ZCODE_PLUGIN_DATA}',root);
    const result=spawnSync(command,{shell:true,encoding:'utf8',windowsHide:true,input:JSON.stringify({session_id:'sess_native_custom_fixture',cwd:root}),env:{...process.env,OIL_ZCODE_TITLE_DATA:undefined,ZCODE_PLUGIN_DATA:root}});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/disabled/);
    assert.equal(JSON.parse(readFileSync(join(root,'自定义 状态','hook.log.jsonl'),'utf8').trim()).action,'disabled');
    assert.equal(existsSync(join(root,'state')),false);
  } finally {rmSync(root,{recursive:true});}
});

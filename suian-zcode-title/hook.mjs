#!/usr/bin/env node
// ZCode Stop Hook 派发器：宿主 Stop 事件 → 静默校验 → 后台启动网关命名 worker。
// 约定（源码核实）：用户级 config.json 的 Stop hook 无信任门槛；async:true 后台执行不阻塞对话；
// stop_hook_active=true 表示本轮由 Stop 续跑产生，跳过以防重复命名；stdout 不得以 { 开头。
import {spawn} from "node:child_process";
import {join,dirname,resolve} from "node:path";
import {homedir} from "node:os";
import {readFile,appendFile} from "node:fs/promises";
import {fileURLToPath,pathToFileURL} from "node:url";

const pluginRoot=dirname(fileURLToPath(import.meta.url));

async function resolveDataDir(configPath) {
  let supplied={};
  try {supplied=JSON.parse(await readFile(configPath,"utf8"));}
  catch {}
  return resolve(dirname(configPath),process.env.OIL_ZCODE_TITLE_DATA??supplied.dataDir??join(homedir(),".zcode","suian-zcode-title"));
}

export const WORKER_START_DELAY_MS=8000;

export async function dispatchStopEvent({payload,dataDir,pluginRoot,configPath,spawnWorker=defaultSpawnWorker,startDelayMs=WORKER_START_DELAY_MS}) {
  if(!payload||typeof payload!=="object")return{action:"ignored_invalid"};
  if(payload.stop_hook_active===true)return{action:"skipped_stale"};
  const sessionId=payload.session_id??payload.sessionId;
  const workspacePath=payload.workspace_path??payload.cwd;
  if(!/^sess_[A-Za-z0-9_-]+$/.test(sessionId??"")||!workspacePath)return{action:"ignored_invalid"};
  // Stop 触发瞬间宿主仍在持久化 turn 边界与任务状态，立即读快照必然指纹漂移成 stale；
  // 让出收尾窗口后再派发，保证 worker 读到的基线与复查一致。
  if(startDelayMs>0)await new Promise(resolve=>setTimeout(resolve,startDelayMs));
  const args=["run","--apply"];
  if(configPath)args.push("--config",configPath);
  await spawnWorker({script:join(pluginRoot,"cli.mjs"),args,event:{session_id:sessionId,workspace_path:workspacePath},dataDir});
  return{action:"dispatched"};
}

function defaultSpawnWorker({script,args,event,dataDir}) {
  const child=spawn(process.execPath,[script,...args],{
    detached:true,stdio:["pipe","ignore","ignore"],windowsHide:true,
    env:{...process.env,OIL_ZCODE_TITLE_DATA:dataDir}
  });
  child.stdin.end(JSON.stringify(event));
  child.unref();
}

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(isMain) {
  let configPath=null,dataDirArg=null;
  for(let i=2;i<process.argv.length;i++) {
    if(process.argv[i]==="--config"&&process.argv[i+1])configPath=resolve(process.argv[++i]);
    else if(process.argv[i]==="--data-dir"&&process.argv[i+1])dataDirArg=resolve(process.argv[++i]);
  }
  if(!configPath) {
    const candidate=join(pluginRoot,"config.local.json");
    try {await readFile(candidate,"utf8");configPath=candidate;}catch{}
  }
  let raw="";
  for await(const chunk of process.stdin)raw+=chunk;
  let payload=null;
  try {payload=JSON.parse(raw);}catch {}
  const dataDir=dataDirArg??(configPath?await resolveDataDir(configPath):(process.env.OIL_ZCODE_TITLE_DATA??join(pluginRoot,".local")));
  const logHook=async entry=>{
    try {
      const {mkdir}=await import("node:fs/promises");
      await mkdir(dataDir,{recursive:true});
      await appendFile(join(dataDir,"hook.log.jsonl"),JSON.stringify({at:new Date().toISOString(),...entry})+"\n","utf8");
    }catch{}
  };
  try {
    const result=await dispatchStopEvent({payload,dataDir,pluginRoot,configPath});
    console.log("suian-zcode-title:",JSON.stringify(result));
    await logHook({event:payload?.hook_event_name??"Stop",action:result.action,sessionId:payload?.session_id??null,cwd:payload?.cwd??payload?.workspace_path??null,stopHookActive:payload?.stop_hook_active===true,error:null});
  } catch(error) {
    console.log("suian-zcode-title: hook-error",error.message);
    await logHook({event:payload?.hook_event_name??"Stop",action:"error",sessionId:payload?.session_id??null,cwd:payload?.cwd??payload?.workspace_path??null,error:String(error.message).slice(0,200)});
  }
  process.exit(0);
}

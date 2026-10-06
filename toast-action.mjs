#!/usr/bin/env node
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {writeFile,unlink,appendFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {homedir} from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import {buildFixPrompt} from "./toast.mjs";

export function parseActionUri(uri) {
  const match=/^suian-zcode-title:\/\/([a-z]+)$/i.exec(String(uri??""));
  return match?{action:match[1].toLowerCase()}:null;
}

export function encodeWorkspaceOpenUri(workspacePath) {
  return "zcode://workspace/open?path="+encodeURIComponent(workspacePath);
}

// 仅由用户点击 Toast 按钮触发的协议激活到达此处；打开动作指向用户自带的默认工作区
// （%USERPROFILE%\.zcode\workspace\default），会弹 ZCode 官方的外部工作区确认框（预期交互）。
// 自动化测试与验证脚本必须注入 openWorkspace，严禁使用真实默认实现，否则模态确认会无限阻塞无人值守流程。
export const defaultFixWorkspace=()=>join(homedir(),".zcode","workspace","default");
export async function runAction({uri,pluginRoot,dataDir,workspacePath=defaultFixWorkspace(),setClipboard=setClipboardViaTempFile,openWorkspace=openWorkspaceViaShell}) {
  const parsed=parseActionUri(uri);
  if(!parsed)return{ok:false,reason:"invalid_uri"};
  if(parsed.action!=="fix")return{ok:false,reason:"unknown_action"};
  await setClipboard(buildFixPrompt({pluginRoot,dataDir}),{dataDir});
  await openWorkspace(encodeWorkspaceOpenUri(workspacePath));
  return{ok:true,action:"fix"};
}

const powershell=async(script,env={})=>{
  const encoded=Buffer.from(script,"utf16le").toString("base64");
  return promisify(execFile)("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",encoded],{windowsHide:true,env:{...process.env,...env}});
};

async function readClipboardOnce() {
  const {stdout}=await powershell("[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::GetText()");
  return stdout.replace(/\r\n$/,"");
}

async function setClipboardViaTempFile(text,{dataDir}={}) {
  const temporary=join(dataDir??".","fix-prompt.tmp-"+process.pid);
  await writeFile(temporary,text,"utf8");
  try {
    // PS 5.1 剪贴板竞争时 Set 操作会抛出假失败（实际已写入），失败后必须回读核实
    let lastError=null;
    for(let attempt=0;attempt<3;attempt++) {
      if(attempt)await new Promise(r=>setTimeout(r,400*attempt));
      try {
        await powershell("Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::SetText([IO.File]::ReadAllText($env:OIL_CLIP_FILE,[Text.Encoding]::UTF8))",{OIL_CLIP_FILE:temporary});
        return;
      } catch(error) {lastError=error;}
      if(await readClipboardOnce().catch(()=>"")===text)return;
    }
    throw new Error("剪贴板写入未生效："+String(lastError?.message??"").slice(0,120));
  } finally {await unlink(temporary).catch(()=>{});}
}

async function openWorkspaceViaShell(uri) {
  await promisify(execFile)("cmd.exe",["/c","start","",uri],{windowsHide:true});
}

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(isMain) {
  const pluginRoot=dirname(fileURLToPath(import.meta.url));
  const dataDir=process.argv[3]??process.env.OIL_ZCODE_TITLE_DATA??join(homedir(),".zcode","suian-zcode-title");
  const logAction=entry=>appendFile(join(dataDir,"toast-action-log.jsonl"),JSON.stringify({at:new Date().toISOString(),...entry})+"\n","utf8").catch(()=>{});
  runAction({uri:process.argv[2],pluginRoot,dataDir})
    .then(async result=>{
      console.log(JSON.stringify(result));
      await logAction({uri:process.argv[2],ok:result.ok,reason:result.reason??null});
      process.exit(result.ok?0:1);
    })
    .catch(async error=>{
      console.log(JSON.stringify({ok:false,reason:"error",detail:error.message}));
      await logAction({uri:process.argv[2],ok:false,reason:"error",detail:String(error.message).slice(0,200)});
      process.exit(1);
    });
}

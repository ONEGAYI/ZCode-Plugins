import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {writeFile,unlink} from "node:fs/promises";
import {join} from "node:path";
import {homedir} from "node:os";
import {runPowerShell} from "./windows.mjs";

export function encodeWorkspaceOpenUri(workspacePath) {
  return "zcode://workspace/open?path="+encodeURIComponent(workspacePath);
}

// 仅由用户点击 Toast 按钮触发的协议激活到达此处；打开动作指向用户自带的默认工作区
// （%USERPROFILE%\.zcode\workspace\default），会弹 ZCode 官方的外部工作区确认框（预期交互）。
// 自动化测试与验证脚本必须注入 openWorkspace，严禁使用真实默认实现，否则模态确认会无限阻塞无人值守流程。
export const defaultFixWorkspace=()=>join(homedir(),".zcode","workspace","default");
export async function copyPromptAndOpenWorkspace({prompt,dataDir,workspacePath=defaultFixWorkspace(),executePowerShell=runPowerShell,setClipboard=(text,options)=>setClipboardViaTempFile(text,{...options,executePowerShell}),openWorkspace=openWorkspaceViaShell}) {
  await setClipboard(prompt,{dataDir});
  await openWorkspace(encodeWorkspaceOpenUri(workspacePath));
}

async function readClipboardOnce(executePowerShell) {
  const {stdout}=await executePowerShell("[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::GetText()");
  return stdout.replace(/\r\n$/,"");
}

async function setClipboardViaTempFile(text,{dataDir,executePowerShell}) {
  const temporary=join(dataDir??".","fix-prompt.tmp-"+process.pid);
  await writeFile(temporary,text,"utf8");
  try {
    // PS 5.1 剪贴板竞争时 Set 操作会抛出假失败（实际已写入），失败后必须回读核实
    let lastError=null;
    for(let attempt=0;attempt<3;attempt++) {
      if(attempt)await new Promise(r=>setTimeout(r,400*attempt));
      try {
        await executePowerShell("Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::SetText([IO.File]::ReadAllText($env:OIL_CLIP_FILE,[Text.Encoding]::UTF8))",{env:{OIL_CLIP_FILE:temporary}});
        return;
      } catch(error) {lastError=error;}
      try {if(await readClipboardOnce(executePowerShell)===text)return;}
      catch(error) {lastError=error;}
    }
    throw new Error("剪贴板写入未生效："+String(lastError?.message??"").slice(0,120));
  } finally {try {await unlink(temporary);} catch(error) {if(error.code!=="ENOENT")throw error;}}
}

async function openWorkspaceViaShell(uri) {
  await promisify(execFile)("cmd.exe",["/c","start","",uri],{windowsHide:true});
}

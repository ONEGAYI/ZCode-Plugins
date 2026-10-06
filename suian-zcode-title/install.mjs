#!/usr/bin/env node
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {writeFile,readFile,unlink,mkdir} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

export const PROTOCOL="suian-zcode-title";
export const AUMID="SUIAN.SuianZcodeTitle.Toast";
export const SKILL_ANCHOR="<!-- suian-zcode-title:plugin-root -->";
const SHORTCUT_NAME="ZCode 自动命名插件.lnk";

const powershell=async script=>{
  const encoded=Buffer.from(script,"utf16le").toString("base64");
  const {stderr}=await promisify(execFile)("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",encoded],{windowsHide:true});
  return stderr;
};

const defaultShell={
  run:(cmd,args)=>promisify(execFile)(cmd,args,{windowsHide:true}).then(r=>r.stdout),
  ps:powershell,
  writeText:(path,text)=>writeFile(path,text,"utf8"),
  readText:path=>readFile(path,"utf8"),
  remove:async path=>{try{await unlink(path);}catch{}},
  mkdir:async path=>{await mkdir(path,{recursive:true});}
};

// 技能副本部署：模板中的锚点注释替换为本机插件根绝对路径，
// 让 Agent 从技能文档直接定位执行程序，不必依赖克隆位置约定
export async function installSkill({pluginRoot,skillFile,shell=defaultShell,templateText}) {
  const template=templateText??await shell.readText(join(pluginRoot,"SKILL.md"));
  const deployed=template.split(SKILL_ANCHOR).join(`- **本机插件根**：\`${pluginRoot}\``);
  if(deployed.includes(SKILL_ANCHOR))throw new Error("SKILL.md 模板缺少插件根锚点");
  await shell.mkdir(dirname(skillFile));
  const existing=await shell.readText(skillFile).catch(()=>null);
  if(existing===deployed)return{action:"unchanged",skillFile};
  await shell.writeText(skillFile,deployed);
  return{action:"written",skillFile};
}

export async function removeSkill({skillFile,shell=defaultShell}) {
  await shell.remove(skillFile);
  return{action:"removed",skillFile};
}

export function buildVbsContent({nodeExe,toastActionPath,dataDir}) {
  return [
    `' ${PROTOCOL} 按钮激活桥（安装器生成，请勿手改）：隐藏窗口转发协议 URI`,
    "If WScript.Arguments.Count = 0 Then WScript.Quit 1",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """" & "${nodeExe}" & """ """ & "${toastActionPath}" & """ """ & WScript.Arguments(0) & """ """ & "${dataDir}" & """", 0, False`
  ].join("\r\n")+"\r\n";
}

export function buildProtocolCommand({vbsPath}) {
  return `wscript.exe "${vbsPath}" "%1"`;
}

// 设置 .lnk 的 System.AppUserModel.ID（Toast 通知身份）。外部进程借用 ZCode 的 AUMID 会被通知平台
// 静默丢弃（实测计数不增长），必须自建快捷方式并以此 AUMID 发送；通知来源显示为“ZCode 自动命名插件”。
const shortcutScript=({nodeExe,pluginRoot})=>[
  "$ErrorActionPreference='Stop'",
  `$lnkPath=Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\${SHORTCUT_NAME}'`,
  "$ws=New-Object -ComObject WScript.Shell",
  "$s=$ws.CreateShortcut($lnkPath)",
  `$s.TargetPath='${nodeExe.replace(/'/g,"''")}'`,
  "$s.Arguments=''",
  `$s.WorkingDirectory='${pluginRoot.replace(/'/g,"''")}'`,
  "$s.Description='ZCode Stop 自动命名（suian-zcode-title）'",
  "$s.Save()",
  "[System.Runtime.InteropServices.Marshal]::ReleaseComObject($s)|Out-Null",
  "[System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws)|Out-Null",
  "Start-Sleep -Milliseconds 500",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class AppUserModelId {",
  "  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }",
  "  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }",
  "  [ComImport, Guid(\"886d8eeb-8cf2-4446-8d02-cdba1dbdcf99\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
  "  interface IPropertyStore {",
  "    [PreserveSig] int GetCount(out uint count);",
  "    [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);",
  "    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);",
  "    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);",
  "    [PreserveSig] int Commit();",
  "  }",
  "  [DllImport(\"shell32.dll\", CharSet=CharSet.Unicode, PreserveSig=true)] static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bindContext, uint flags, ref Guid iid, out IPropertyStore store);",
  "  [DllImport(\"ole32.dll\")] static extern int PropVariantClear(ref PROPVARIANT variant);",
  "  static readonly Guid IID_IPropertyStore = new Guid(\"886d8eeb-8cf2-4446-8d02-cdba1dbdcf99\");",
  "  static readonly PROPERTYKEY PKEY_AppUserModel_ID = new PROPERTYKEY { fmtid = new Guid(\"9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3\"), pid = 5 };",
  "  public static void Set(string shortcutPath, string appId) {",
  "    IPropertyStore store;",
  "    Guid iid = IID_IPropertyStore;",
  "    int hr = SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, 2 /* GPS_READWRITE */, ref iid, out store);",
  "    if (hr != 0) Marshal.ThrowExceptionForHR(hr);",
  "    PROPERTYKEY key = PKEY_AppUserModel_ID;",
  "    PROPVARIANT value = new PROPVARIANT();",
  "    value.vt = 31;",
  "    value.pointer = Marshal.StringToCoTaskMemUni(appId);",
  "    try {",
  "      hr = store.SetValue(ref key, ref value);",
  "      if (hr != 0) Marshal.ThrowExceptionForHR(hr);",
  "      store.Commit();",
  "    } finally {",
  "      PropVariantClear(ref value);",
  "      Marshal.ReleaseComObject(store);",
  "    }",
  "  }",
  "}",
  "'@",
  `[AppUserModelId]::Set($lnkPath,'${AUMID}')`,
  "Write-Output AUMID_SET_OK"
].join("\n");

export async function ensureToastAppId({dataDir,shell=defaultShell}) {
  const cachePath=join(dataDir,"toast-appid.txt");
  try {
    const cached=(await shell.readText(cachePath)).trim();
    if(cached===AUMID)return cached;
  }catch{}
  await shell.writeText(cachePath,AUMID);
  return AUMID;
}

export async function installToastAssets({pluginRoot,dataDir,nodeExe=process.execPath,shell=defaultShell}) {
  const vbsPath=join(dataDir,"toast-launch.vbs");
  const desired=buildVbsContent({nodeExe,toastActionPath:join(pluginRoot,"toast-action.mjs"),dataDir});
  let current=null;
  try {current=await shell.readText(vbsPath);}catch{}
  let vbsAction;
  if(current===desired)vbsAction="unchanged";
  else {await shell.writeText(vbsPath,desired);vbsAction="written";}
  const command=buildProtocolCommand({vbsPath});
  await shell.run("reg.exe",["add",`HKCU\\Software\\Classes\\${PROTOCOL}`,"/ve","/d","URL:Oil ZCode Title Action","/f"]);
  await shell.run("reg.exe",["add",`HKCU\\Software\\Classes\\${PROTOCOL}`,"/v","URL Protocol","/d","","/f"]);
  await shell.run("reg.exe",["add",`HKCU\\Software\\Classes\\${PROTOCOL}\\shell\\open\\command`,"/ve","/d",command,"/f"]);
  await shell.ps(shortcutScript({nodeExe,pluginRoot}));
  const appId=await ensureToastAppId({dataDir,shell});
  return{ok:true,appId,actions:{vbs:vbsAction,protocol:"ensured",shortcut:"ensured",appId:"cached"}};
}

export async function removeToastAssets({dataDir,shell=defaultShell}) {
  await shell.run("reg.exe",["delete",`HKCU\\Software\\Classes\\${PROTOCOL}`,"/f"]);
  await shell.ps(["$ErrorActionPreference='Stop'",`Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\${SHORTCUT_NAME}') -ErrorAction SilentlyContinue`].join("\n"));
  await shell.remove(join(dataDir,"toast-launch.vbs"));
  await shell.remove(join(dataDir,"toast-appid.txt"));
  return{ok:true};
}

// ZCode 用户级 Stop Hook（~/.zcode/cli/config.json）。源码核实：用户级 hooks 无信任门槛、
// async:true 后台执行不阻塞对话；条目追加在既有 Stop 数组之后，不覆盖他人定义。
export function buildHookCommand({pluginRoot}) {
  const hookPath=join(pluginRoot,"hook.mjs");
  if(/\s/.test(hookPath))throw new Error("插件路径含空格，cmd.exe 命令行无法可靠引用："+hookPath);
  return `node ${hookPath}`;
}

export async function installStopHook({pluginRoot,configFile,shell=defaultShell}) {
  const command=buildHookCommand({pluginRoot});
  let config={};
  try {config=JSON.parse(await shell.readText(configFile));}catch{}
  config.hooks??={};
  config.hooks.events??={};
  const stop=config.hooks.events.Stop??[];
  if(stop.some(entry=>(entry.hooks??[]).some(h=>h.command===command)))return{action:"unchanged"};
  stop.push({hooks:[{type:"command",command,async:true,timeout:30}]});
  config.hooks.events.Stop=stop;
  config.hooks.enabled=true;
  await shell.writeText(configFile,JSON.stringify(config,null,2)+"\n");
  return{action:"written"};
}

export async function removeStopHook({pluginRoot,configFile,shell=defaultShell}) {
  const command=buildHookCommand({pluginRoot});
  let config={};
  try {config=JSON.parse(await shell.readText(configFile));}catch{return{action:"absent"};}
  const stop=config.hooks?.events?.Stop;
  if(!Array.isArray(stop))return{action:"absent"};
  const kept=stop.filter(entry=>!(entry.hooks??[]).some(h=>h.command===command));
  if(kept.length===stop.length)return{action:"absent"};
  if(kept.length)config.hooks.events.Stop=kept;
  else {
    delete config.hooks.events.Stop;
    if(!Object.keys(config.hooks.events).length) {
      delete config.hooks.events;
      if(Object.keys(config.hooks).every(key=>key==="enabled"))delete config.hooks;
    }
  }
  await shell.writeText(configFile,JSON.stringify(config,null,2)+"\n");
  return{action:"removed"};
}

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(isMain) {
  const {homedir}=await import("node:os");
  const pluginRoot=fileURLToPath(new URL(".",import.meta.url));
  const dataDir=process.argv[2];
  const remove=process.argv.includes("--remove");
  const configFile=join(homedir(),".zcode","cli","config.json");
  if(!dataDir) {console.error("用法：node install.mjs <dataDir> [--remove]");process.exit(2);}
  const run=remove
    ?async()=>{
      const hook=await removeStopHook({pluginRoot,configFile});
      const toast=await removeToastAssets({dataDir});
      const skill=await removeSkill({skillFile:join(homedir(),".zcode","skills",PROTOCOL,"SKILL.md")});
      return{ok:true,actions:{hook:hook.action,toast:"removed",skill:skill.action}};
    }
    :async()=>{
      const toast=await installToastAssets({pluginRoot,dataDir});
      const hook=await installStopHook({pluginRoot,configFile});
      const skill=await installSkill({pluginRoot,skillFile:join(homedir(),".zcode","skills",PROTOCOL,"SKILL.md")});
      return{ok:true,appId:toast.appId,actions:{...toast.actions,hook:hook.action,skill:skill.action}};
    };
  run()
    .then(result=>{console.log(JSON.stringify(result));})
    .catch(error=>{console.log(JSON.stringify({ok:false,error:error.message}));process.exit(1);});
}

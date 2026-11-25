#!/usr/bin/env node
// 安装与通知身份的共享实现（PKG-02 拆出）：cli / doctor / install 命令都从这里导入。
// 命令入口模块（cli.mjs、install.mjs、hook.mjs、toast-action.mjs）之间禁止互相导入——
// esbuild 内联会把入口的 ESM 主模块判定复制进其他 bundle，导致一个进程执行两份主逻辑。
// 本模块不包含任何主模块判定，可安全内联。
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { commonInstaller, commonRuntime, commonAnchorOptions, registryPathFromDataPath } from "./common-access.mjs";
import { deployToastTemplate, removeToastTemplate, TOAST_TEMPLATE_FILE } from "./toast.mjs";

export const PROTOCOL="suian-zcode-title";
export const AUMID="SUIAN.SuianZcodeTitle.Toast";
export const SKILL_ANCHOR="<!-- suian-zcode-title:plugin-root -->";
const SHORTCUT_NAME="ZCode 自动命名插件.lnk";

// 公共 fileShell 惰性解析：默认 shell 参数在首次真实调用时才经安装期入口加载公共实现。
const lazyFileShell=new Proxy({},{get(_target,method){return async (...args)=>{const {fileShell}=await commonInstaller();return fileShell[method](...args);};}});
export const defaultShell=lazyFileShell;

const notificationIdentity={protocol:PROTOCOL,appId:AUMID,shortcutName:SHORTCUT_NAME,description:"ZCode Stop 自动命名（suian-zcode-title）",templateFile:TOAST_TEMPLATE_FILE};
// 公共安装期入口（checkRuntime、Toast 资产与稳定运行时）经客户端契约按需加载。
export const installToastAssets=async options=>{const {installToastAssets:install}=await commonInstaller();return install({...options,...notificationIdentity});};
export const removeToastAssets=async options=>{const {removeToastAssets:remove}=await commonInstaller();return remove({...options,protocol:PROTOCOL,shortcutName:SHORTCUT_NAME});};
export const ensureToastAppId=async options=>{const {ensureToastAppId:ensure}=await commonInstaller();return ensure({...options,appId:AUMID});};
export {deployToastTemplate, removeToastTemplate, TOAST_TEMPLATE_FILE};

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

// ZCode 用户级 Stop Hook（~/.zcode/cli/config.json）。源码核实：用户级 hooks 无信任门槛、
// async:true 后台执行不阻塞对话；条目追加在既有 Stop 数组之后，不覆盖他人定义。
// entrySubdir 指向命令入口子目录：源码模式为空（插件根），发布模式为 dist。
export function buildHookCommand({pluginRoot,entrySubdir=""}) {
  const hookPath=join(pluginRoot,entrySubdir,"hook.mjs");
  if(/\s/.test(hookPath))throw new Error("插件路径含空格，cmd.exe 命令行无法可靠引用："+hookPath);
  return `node ${hookPath}`;
}

export async function installStopHook({pluginRoot,entrySubdir="",configFile,shell=defaultShell}) {
  const command=buildHookCommand({pluginRoot,entrySubdir});
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

export async function removeStopHook({pluginRoot,entrySubdir="",configFile,shell=defaultShell}) {
  const command=buildHookCommand({pluginRoot,entrySubdir});
  let config={};
  try {config=JSON.parse(await shell.readText(configFile));}catch(error){if(error.code==="ENOENT")return{action:"absent"};throw error;}
  const stop=config.hooks?.events?.Stop;
  if(!Array.isArray(stop))return{action:"absent"};
  let removed=false;
  const kept=stop.map(entry=>{
    const hooks=(entry.hooks??[]).filter(h=>{if(h.command===command){removed=true;return false;}return true;});
    return {...entry,hooks};
  }).filter(entry=>entry.hooks.length);
  if(!removed)return{action:"absent"};
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

export async function installPlugin({pluginRoot,entrySubdir="",dataDir,configPath,checkOnly=false,nativePlugin=false,sourceServer=false,legacyRoot,shell=defaultShell,commonRoot,installedPlugins,homeDir=homedir()}) {
  const activeConfigPath=configPath??(nativePlugin?join(dirname(dataDir),"config.json"):join(pluginRoot,"config.local.json"));
  // 远端尚未选模型时不派发 worker，需要提醒；enabled:false 保留给主动暂停。
  let config=nativePlugin&&!sourceServer?{enabled:false}:{};
  // 配置本身可能提供 common 锚点，读取它之前不能先加载依赖 common 的默认 shell。
  try {config=JSON.parse(await (shell===defaultShell?readFile(activeConfigPath,"utf8"):shell.readText(activeConfigPath)));}
  catch(error) {if(error.code!=="ENOENT"||(!nativePlugin&&configPath))throw error;}
  if(sourceServer)config={...config,transport:"source-server"};
  const headless=config.transport==="source-server";
  if(headless&&!nativePlugin)throw new Error("Source Server 安装需要 --native-plugin");
  // 安装期公共函数经客户端契约加载：显式位置优先，其次宿主注入，最后外置配置里的安装记录路径。
  const anchor=commonAnchorOptions({commonRoot,installedPlugins,config});
  const {checkRuntime}=await commonInstaller(anchor);
  const dependencies=await checkRuntime({sqliteBin:config.sqliteBin??process.env.SQLITE_BIN??"sqlite3",run:shell.run});
  if(headless&&typeof (await commonRuntime(anchor)).connectSourceServer!=="function")
    throw new Error("当前公共插件尚不支持 Source Server；请更新 common");
  if(checkOnly) {
    if(headless)return{ok:true,action:"checked",dependencies};
    // 安装检查报告 Toast 稳定部署、外置模板与实际协议目标，不凭 AppID 缓存判定健康。
    const {checkToastRuntime}=await commonInstaller(anchor);
    const toast=await checkToastRuntime({homeDir,protocols:[PROTOCOL],shell});
    return{ok:true,action:"checked",dependencies,toast};
  }
  const registryPath=installedPlugins?resolve(installedPlugins):process.env.ZCODE_PLUGIN_DATA?registryPathFromDataPath(process.env.ZCODE_PLUGIN_DATA):config.installedPluginsPath??null;
  if(nativePlugin) {
    config={...config,registration:"native",dataDir:config.dataDir??dataDir};
    // 把可用的安装记录路径写进外置配置，供无宿主注入的后续 CLI 定位 common（不硬编码 common 安装位置）。
    if(registryPath)config={...config,installedPluginsPath:resolve(registryPath)};
    await shell.mkdir(dirname(activeConfigPath));
    await shell.writeText(activeConfigPath,JSON.stringify(config,null,2)+"\n");
  }
  let notifications={};
  if(!headless) {
    const toastDataDir=nativePlugin?resolve(dirname(activeConfigPath),process.env.OIL_ZCODE_TITLE_DATA??config.dataDir):dataDir;
    const toast=await installToastAssets({dataDir:toastDataDir,pluginsFile:registryPath,shell,homeDir});
    const template=await deployToastTemplate({dataDir:toastDataDir,shell});
    notifications={appId:toast.appId,actions:{...toast.actions,template:template.action}};
  }
  const zcodeHome=headless?(process.env.ZCODE_DATA_BASE_DIR?.trim()||homeDir):homedir();
  const configFile=join(zcodeHome,".zcode","cli","config.json"),skillFile=join(zcodeHome,".zcode","skills",PROTOCOL,"SKILL.md");
  if(nativePlugin&&legacyRoot) {
    await removeStopHook({pluginRoot:legacyRoot,configFile,shell});
    let previous;
    try {previous=await shell.readText(skillFile);}catch(error) {if(error.code!=="ENOENT")throw error;}
    if(previous?.includes(`**本机插件根**：\`${legacyRoot}\``))await removeSkill({skillFile,shell});
  }
  const hook=nativePlugin?{action:"plugin_managed"}:await installStopHook({pluginRoot,entrySubdir,configFile,shell});
  const skill=nativePlugin?{action:"plugin_managed"}:await installSkill({pluginRoot,skillFile,shell});
  return{ok:true,...notifications,dependencies,actions:{...notifications.actions,hook:hook.action,skill:skill.action}};
}

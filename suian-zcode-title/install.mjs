#!/usr/bin/env node
import {join,dirname,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {homedir} from "node:os";
import {parseArgs} from "node:util";
import {checkRuntime} from "../suian-zcode-common/prerequisites.mjs";
import {fileShell as defaultShell} from "../suian-zcode-common/windows.mjs";
import {installToastAssets as installNotificationAssets,removeToastAssets as removeNotificationAssets,ensureToastAppId as ensureNotificationAppId} from "../suian-zcode-common/notification-install.mjs";

export const PROTOCOL="suian-zcode-title";
export const AUMID="SUIAN.SuianZcodeTitle.Toast";
export const SKILL_ANCHOR="<!-- suian-zcode-title:plugin-root -->";
const SHORTCUT_NAME="ZCode 自动命名插件.lnk";


const notificationIdentity={protocol:PROTOCOL,appId:AUMID,shortcutName:SHORTCUT_NAME,description:"ZCode Stop 自动命名（suian-zcode-title）"};
export const installToastAssets=options=>installNotificationAssets({...options,...notificationIdentity});
export const removeToastAssets=options=>removeNotificationAssets({...options,...notificationIdentity});
export const ensureToastAppId=options=>ensureNotificationAppId({...options,appId:AUMID});

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

export async function installPlugin({pluginRoot,dataDir,configPath,checkOnly=false,shell=defaultShell}) {
  let config={};
  try {config=JSON.parse(await shell.readText(configPath??join(pluginRoot,"config.local.json")));}
  catch(error) {if(error.code!=="ENOENT"||configPath)throw error;}
  const dependencies=await checkRuntime({sqliteBin:config.sqliteBin??process.env.SQLITE_BIN??"sqlite3",run:shell.run});
  if(checkOnly)return{ok:true,action:"checked",dependencies};
  const toast=await installToastAssets({pluginRoot,dataDir,shell});
  const hook=await installStopHook({pluginRoot,configFile:join(homedir(),".zcode","cli","config.json"),shell});
  const skill=await installSkill({pluginRoot,skillFile:join(homedir(),".zcode","skills",PROTOCOL,"SKILL.md"),shell});
  return{ok:true,appId:toast.appId,dependencies,actions:{...toast.actions,hook:hook.action,skill:skill.action}};
}

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(isMain) {
  const pluginRoot=fileURLToPath(new URL(".",import.meta.url));
  const {values,positionals}=parseArgs({allowPositionals:true,options:{remove:{type:"boolean"},config:{type:"string"},"check-only":{type:"boolean"}}});
  if(values.remove&&values["check-only"]) {console.error("--remove 与 --check-only 不能同时使用");process.exit(2);}
  const dataDir=positionals[0];
  const remove=values.remove;
  const configFile=join(homedir(),".zcode","cli","config.json");
  if(!dataDir||positionals.length!==1) {console.error("用法：node install.mjs <dataDir> [--config 文件] [--check-only | --remove]");process.exit(2);}
  const run=remove
    ?async()=>{
      const hook=await removeStopHook({pluginRoot,configFile});
      const toast=await removeToastAssets({dataDir});
      const skill=await removeSkill({skillFile:join(homedir(),".zcode","skills",PROTOCOL,"SKILL.md")});
      return{ok:true,actions:{hook:hook.action,toast:"removed",skill:skill.action}};
    }
    :()=>installPlugin({pluginRoot,dataDir,configPath:values.config?resolve(values.config):undefined,checkOnly:values["check-only"]});
  run()
    .then(result=>{console.log(JSON.stringify(result));})
    .catch(error=>{console.log(JSON.stringify({ok:false,error:error.name==="SyntaxError"?"配置 JSON 格式无效":error.message}));process.exit(1);});
}

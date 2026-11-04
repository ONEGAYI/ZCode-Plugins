import test from "node:test";
import assert from "node:assert/strict";
import {installToastAssets,removeToastAssets,ensureToastAppId,installStopHook,removeStopHook,buildHookCommand,installSkill,removeSkill,installPlugin,deployToastTemplate,removeToastTemplate,AUMID,PROTOCOL,TOAST_TEMPLATE_FILE} from "../installer.mjs";

import {buildVbsContent,buildProtocolCommand} from "../../suian-zcode-common/notification-install.mjs";
import {mkdtemp,mkdir,readFile,writeFile,stat,rm} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const makeShell=()=>{
  const state={files:new Map(),reg:[],ps:[],removed:[],runs:[]};
  return {
    mkdir:async()=>{},
    state,
    run:async(cmd,args)=>{state.runs.push({cmd,args});if(args[0]==="add")state.reg.push({cmd,args});return"";},
    ps:async script=>{state.ps.push(script);},
    writeText:async(path,text)=>{state.files.set(path,text);},
    readText:async path=>{if(!state.files.has(path))throw Object.assign(new Error("ENOENT"),{code:"ENOENT"});return state.files.get(path);},
    remove:async path=>{state.removed.push(path);state.files.delete(path);},
    rename:async(from,to)=>{if(!state.files.has(from))throw Object.assign(new Error("ENOENT"),{code:"ENOENT"});state.files.set(to,state.files.get(from));state.files.delete(from);},
    stat:async path=>state.files.has(path)?{isFile:true}:null
  };
};
test("CLI 原生卸载在无宿主注入时传递两种显式公共锚点",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"z-title-remove-anchor-"));
  t.after(()=>rm(dir,{recursive:true}));
  const commonRoot=join(dir,"common"),trace=join(dir,"trace.json"),registry=join(dir,"installed_plugins.json");
  await mkdir(commonRoot);
  await writeFile(join(commonRoot,"install.mjs"),`import {writeFile} from 'node:fs/promises';export const removeToastAssets=async options=>writeFile(${JSON.stringify(trace)},JSON.stringify(options));export const fileShell={remove:async()=>{}};`);
  await writeFile(join(commonRoot,"release.json"),JSON.stringify({formatVersion:1,pluginName:"suian-zcode-common",pluginVersion:"0.5.0",buildId:"fixture",commonApiVersion:1,entries:{"client-install":"install.mjs"},files:[]}));
  await writeFile(registry,JSON.stringify({version:1,plugins:[{id:"suian-zcode-common@suian-zcode-plugins",name:"suian-zcode-common",marketplace:"suian-zcode-plugins",installPath:commonRoot}]}));
  const cli=fileURLToPath(new URL("../install.mjs",import.meta.url)),dataDir=join(dir,"data");
  for(const flags of [["--common-root",commonRoot],["--installed-plugins",registry]]) {
    const {stdout}=await promisify(execFile)(process.execPath,[cli,dataDir,"--native-plugin","--remove",...flags],{windowsHide:true,env:{...process.env,ZCODE_PLUGIN_DATA:undefined,HOME:dir,USERPROFILE:dir}});
    assert.equal(JSON.parse(stdout).ok,true);
    assert.equal(JSON.parse(await readFile(trace,"utf8")).dataDir,dataDir);
  }
});
test("vbs 桥与协议命令行：调用方 vbs 只转发到稳定启动器，只放行本协议固定动作",()=>{
  const toastRoot=join("H:\\toast-home",".zcode","tools","suian-zcode-common","toast");
  const vbs=buildVbsContent({protocol:PROTOCOL,launcherPath:join(toastRoot,"launch.vbs")});
  assert.ok(vbs.includes(join(toastRoot,"launch.vbs")),"必须引用缓存外稳定启动器");
  assert.equal(vbs.split(/\r?\n/).find(line=>line.startsWith("If uri <>")),`If uri <> "${PROTOCOL}://fix" And uri <> "${PROTOCOL}://mute" And uri <> "${PROTOCOL}://prompt" Then WScript.Quit 1`,"只放行三个精确 URI，其他输入均被拒绝");
  assert.ok(vbs.includes("WScript.Arguments(0)"),"%1 传入的 URI 必须转发");
  assert.ok(vbs.includes(", 0, False"),"必须以隐藏窗口运行");
  assert.ok(!vbs.includes("toast-action.mjs"),"不得引用版本缓存内的命令入口");
  assert.ok(!vbs.includes("node.exe"),"转发桥不直接引用 Node 路径");
  assert.equal(buildProtocolCommand({vbsPath:"D:\\t\\.local\\toast-launch.vbs"}),'wscript.exe "D:\\t\\.local\\toast-launch.vbs" "%1"');
});
test("安装幂等：重复安装不重写一致的 vbs，AUMID 固定自建",async()=>{
  const shell=makeShell();
  const options={dataDir:"D:\\t\\.local",protocol:PROTOCOL,appId:AUMID,shortcutName:"ZCode 自动命名插件.lnk",description:"ZCode Stop 自动命名",homeDir:"H:\\toast-home",nodeExe:"C:\\node.exe",shell};
  const first=await installToastAssets(options);
  assert.equal(first.actions.vbs,"written");
  assert.equal(first.appId,AUMID);
  assert.ok(shell.state.ps[0].includes(AUMID),"快捷方式脚本必须设置自建 AUMID");
  assert.ok(shell.state.ps[0].includes("Start Menu"),"快捷方式必须落在开始菜单");
  assert.ok(shell.state.ps[0].includes("SHGetPropertyStoreFromParsingName"),"通过属性存储写入 AUMID");
  assert.ok(!shell.state.ps[0].includes("D:\\plugins"),"快捷方式工作目录不得指向版本缓存");
  const second=await installToastAssets(options);
  assert.equal(second.actions.vbs,"unchanged","内容一致时不得重写");
  assert.equal(second.appId,AUMID);
  assert.equal(shell.state.reg.length,6,"两次安装共 3 条注册表键 × 2 次");
  assert.equal(shell.state.runs.filter(run=>run.args[0]==="--check").length,1,"共享执行器只校验部署一次");
});
test("ensureToastAppId 恒定返回自建 AUMID 并落盘缓存",async()=>{
  const shell=makeShell();
  assert.equal(await ensureToastAppId({dataDir:"D:\\t\\.local",shell}),AUMID);
  assert.equal(shell.state.files.get("D:\\t\\.local\\toast-appid.txt"),AUMID);
  shell.state.files.set("D:\\t\\.local\\toast-appid.txt",AUMID+"\n");
  assert.equal(await ensureToastAppId({dataDir:"D:\\t\\.local",shell}),AUMID,"已有缓存直接复用");
});
test("Stop Hook 安装幂等且保留他人条目，卸载只删自己的",async()=>{
  const makeConfigShell=initial=>{
    const shell=makeShell();
    shell.state.files.set("C:\\u\\.zcode\\cli\\config.json",JSON.stringify(initial));
    return shell;
  };
  const readConfig=shell=>JSON.parse(shell.state.files.get("C:\\u\\.zcode\\cli\\config.json"));
  const pluginRoot="D:\\plugin";
  const command=buildHookCommand({pluginRoot});
  assert.equal(command,`node ${pluginRoot}\\hook.mjs`,"命令必须单参数无嵌套引号（cmd.exe 兼容）");
  const empty=makeConfigShell({});
  const first=await installStopHook({pluginRoot,configFile:"C:\\u\\.zcode\\cli\\config.json",shell:empty});
  assert.equal(first.action,"written");
  assert.equal(readConfig(empty).hooks.enabled,true);
  assert.equal(readConfig(empty).hooks.events.Stop[0].hooks[0].command,command);
  assert.equal(readConfig(empty).hooks.events.Stop[0].hooks[0].async,true,"必须后台执行不阻塞对话");
  assert.equal((await installStopHook({pluginRoot,configFile:"C:\\u\\.zcode\\cli\\config.json",shell:empty})).action,"unchanged");
  const others=makeConfigShell({hooks:{enabled:true,events:{Stop:[{matcher:"other",hooks:[{type:"command",command:"node other.mjs"}]}]}}});
  const merged=await installStopHook({pluginRoot,configFile:"C:\\u\\.zcode\\cli\\config.json",shell:others});
  assert.equal(merged.action,"written");
  const stopList=readConfig(others).hooks.events.Stop;
  assert.equal(stopList.length,2,"追加而非覆盖");
  assert.ok(stopList.some(e=>e.matcher==="other"),"他人条目原样保留");
  await removeStopHook({pluginRoot,configFile:"C:\\u\\.zcode\\cli\\config.json",shell:others});
  const after=readConfig(others).hooks.events.Stop;
  assert.equal(after.length,1);
  assert.equal(after[0].matcher,"other","卸载只移除自己的条目");
  await removeStopHook({pluginRoot,configFile:"C:\\u\\.zcode\\cli\\config.json",shell:empty});
  assert.equal(readConfig(empty).hooks,undefined,"清空后不残留空 hooks 对象");
});
test("卸载移除协议键、vbs、AUMID 缓存与开始菜单快捷方式",async()=>{
  const shell=makeShell();
  await removeToastAssets({dataDir:"D:\\t\\.local",protocol:PROTOCOL,shortcutName:"ZCode 自动命名插件.lnk",homeDir:"H:\\toast-home",shell});
  assert.ok(shell.state.removed.includes("D:\\t\\.local\\toast-launch.vbs"));
  assert.ok(shell.state.removed.includes("D:\\t\\.local\\toast-appid.txt"));
  assert.ok(shell.state.runs.some(r=>r.args[1]===`HKCU\\Software\\Classes\\${PROTOCOL}`&&r.args[0]==="delete"),"必须删除自有协议键");
  assert.ok(shell.state.ps.some(s=>s.includes("Remove-Item")),"必须删除开始菜单快捷方式");
});
test("技能副本由安装器部署：注入本机插件根，幂等，卸载清理",async()=>{
  const shell=makeShell();shell.mkdir=async()=>{};
  const template="# suian-zcode-title\n\n正文引用 <插件根> 占位。\n<!-- suian-zcode-title:plugin-root -->\n定位链说明。\n";
  const skillFile="C:\\u\\.zcode\\skills\\suian-zcode-title\\SKILL.md";
  const first=await installSkill({pluginRoot:"D:\\repo\\ZCode-Plugins\\suian-zcode-title",skillFile,shell,templateText:template});
  assert.equal(first.action,"written");
  const deployed=shell.state.files.get(skillFile);
  assert.ok(deployed.includes("**本机插件根**：`D:\\repo\\ZCode-Plugins\\suian-zcode-title`"),"必须注入绝对路径");
  assert.ok(!deployed.includes("suian-zcode-title:plugin-root"),"锚点注释必须被替换掉");
  assert.ok(deployed.includes("正文引用"),"模板其余内容原样保留");
  const second=await installSkill({pluginRoot:"D:\\repo\\ZCode-Plugins\\suian-zcode-title",skillFile,shell,templateText:template});
  assert.equal(second.action,"unchanged","内容一致不得重写");
  await removeSkill({skillFile,shell});
  assert.ok(shell.state.removed.includes(skillFile));
});

test('原生初始化只安装通知资产和外置配置，不重复写全局 Hook 或技能', async () => {
  const shell=makeShell(), pluginRoot='D:\\native\\title', dataDir='D:\\native-data\\state', configPath='D:\\native-data\\config.json';
  shell.run=async command=>command==='sqlite3'?'[{"ready":1}]':'';
  const configFile=join(homedir(),'.zcode','cli','config.json');
  shell.state.files.set(configFile,'{"hooks":{"events":{"Stop":[]}},"keep":1}');
  const before=shell.state.files.get(configFile);
  const result=await installPlugin({pluginRoot,dataDir,configPath,nativePlugin:true,shell});
  assert.equal(result.actions.hook,'plugin_managed');
  assert.equal(result.actions.skill,'plugin_managed');
  assert.equal(shell.state.files.get(configFile),before);
  const config=JSON.parse(shell.state.files.get(configPath));
  assert.equal(config.enabled,false,'首次初始化必须等待用户选择模型');
  assert.equal(config.registration,'native');
  assert.equal(config.dataDir,dataDir);
  assert.ok(shell.state.files.has(join(dataDir,TOAST_TEMPLATE_FILE)),'Toast 提示词模板必须外置部署到数据目录');
  await installPlugin({pluginRoot,dataDir,configPath,nativePlugin:true,shell});
  assert.equal(JSON.parse(shell.state.files.get(configPath)).enabled,false,'重复安装不能解除首次配置的暂停状态');
});

test('原生安装保留旧配置省略 enabled 时的默认启用状态，重复安装不改变模型和自定义字段', async () => {
  const shell=makeShell(),pluginRoot='D:\\native\\title',dataDir='D:\\native-data\\state',configPath='D:\\native-data\\config.json';
  shell.run=async command=>command==='sqlite3'?'[{"ready":1}]':'';
  const previous={selection:{providerId:'fixture-provider',modelId:'fixture-model',options:{reasoningLevel:'low'}},dataDir:'custom-state',timeoutMs:60000};
  shell.state.files.set(configPath,JSON.stringify(previous));
  for(let attempt=0;attempt<2;attempt++) {
    await installPlugin({pluginRoot,dataDir,configPath,nativePlugin:true,shell});
    const config=JSON.parse(shell.state.files.get(configPath));
    assert.equal(config.enabled!==false,true,'旧配置省略 enabled 时默认启用，不能被安装器暂停');
    assert.deepEqual(config.selection,previous.selection);
    assert.equal(config.dataDir,previous.dataDir);
    assert.equal(config.timeoutMs,previous.timeoutMs);
  }
});

test('原生重复安装保留已有配置的显式启用和暂停状态', async () => {
  for(const enabled of [true,false]) {
    const shell=makeShell(),pluginRoot='D:\\native\\title',dataDir='D:\\native-data\\state',configPath='D:\\native-data\\config.json';
    shell.run=async command=>command==='sqlite3'?'[{"ready":1}]':'';
    const previous={enabled,selection:{providerId:'fixture-provider',modelId:'fixture-model',options:{reasoningLevel:'low'}}};
    shell.state.files.set(configPath,JSON.stringify(previous));
    for(let attempt=0;attempt<2;attempt++) {
      await installPlugin({pluginRoot,dataDir,configPath,nativePlugin:true,shell});
      const config=JSON.parse(shell.state.files.get(configPath));
      assert.equal(config.enabled,enabled,'显式启用或暂停状态不被安装器改变');
      assert.deepEqual(config.selection,previous.selection);
      assert.equal(config.registration,'native');
      assert.equal(config.dataDir,dataDir);
      assert.ok(String(config.installedPluginsPath||'').endsWith('installed_plugins.json'),'原生安装把安装记录路径写入外置配置，供无宿主注入的 CLI 定位');
    }
  }
});

test('原生迁移只删除指定旧根的 Hook 与技能，同一匹配项内的他人 Hook 保留', async () => {
  const shell=makeShell(), legacyRoot='D:\\legacy\\title', pluginRoot='D:\\native\\title';
  shell.run=async command=>command==='sqlite3'?'[{"ready":1}]':'';
  const configFile=join(homedir(),'.zcode','cli','config.json'), configPath='D:\\native-data\\config.json';
  shell.state.files.set(configPath,'{"enabled":false}');
  shell.state.files.set(configFile,JSON.stringify({mcp:{servers:{other:{command:'keep'}}},hooks:{events:{Stop:[{matcher:'all',hooks:[{type:'command',command:buildHookCommand({pluginRoot:legacyRoot})},{type:'command',command:'node other.mjs'}]}]}}}));
  const skillFile=join(homedir(),'.zcode','skills',PROTOCOL,'SKILL.md');
  shell.state.files.set(skillFile,`**本机插件根**：\`${legacyRoot}\``);
  await installPlugin({pluginRoot,dataDir:'D:\\native-data\\state',configPath,nativePlugin:true,legacyRoot,shell});
  const user=JSON.parse(shell.state.files.get(configFile));
  assert.equal(user.hooks.events.Stop[0].hooks.length,1);
  assert.equal(user.hooks.events.Stop[0].hooks[0].command,'node other.mjs');
  assert.equal(user.mcp.servers.other.command,'keep');
  assert.equal(shell.state.files.has(skillFile),false);
});

test('原生通知安装沿用外置配置的自定义状态目录', async () => {
  const shell=makeShell(),pluginRoot='D:\\native\\title',configPath='D:\\native-data\\config.json';
  shell.run=async command=>command==='sqlite3'?'[{"ready":1}]':'';
  shell.state.files.set(configPath,JSON.stringify({enabled:false,dataDir:'custom-state'}));
  const homeDir='H:\\toast-home',installedPlugins='D:\\自定义 存储\\installed_plugins.json';
  await installPlugin({pluginRoot,dataDir:'D:\\native-data\\state',configPath,nativePlugin:true,shell,homeDir,installedPlugins});
  const identity=JSON.parse(shell.state.files.get(join(homeDir,'.zcode','tools','suian-zcode-common','toast','identities',PROTOCOL+'.json')));
  assert.equal(identity.pluginsFile,installedPlugins,'title 安装必须将实际清单传给缓存外身份');
  assert.equal(JSON.parse(shell.state.files.get(configPath)).dataDir,'custom-state');
  assert.ok(shell.state.files.has(join(resolve('D:\\native-data','custom-state'),'toast-launch.vbs')));
  assert.ok(shell.state.files.has(join(resolve('D:\\native-data','custom-state'),TOAST_TEMPLATE_FILE)),'模板与 vbs 同落在自定义状态目录');
  assert.equal(shell.state.files.has('D:\\native-data\\state\\toast-launch.vbs'),false);
});

test('模板部署幂等且内容保留占位，卸载移除外置模板',async()=>{
  const shell=makeShell();
  const dataDir='D:\\t\\.local';
  const first=await deployToastTemplate({dataDir,shell});
  assert.equal(first.action,'written');
  const deployed=shell.state.files.get(join(dataDir,TOAST_TEMPLATE_FILE));
  assert.ok(deployed.includes('{{plugin_root}}'),'外置模板保留占位，点击时才解析当前根');
  assert.equal((await deployToastTemplate({dataDir,shell})).action,'unchanged');
  await removeToastTemplate({dataDir,shell});
  assert.ok(shell.state.removed.includes(join(dataDir,TOAST_TEMPLATE_FILE)));
});

test("CLI 缺少 sqlite3 时先报依赖错误，不安装通知资产或 Hook",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"z-title-missing-sqlite-"));
  t.after(()=>rm(dir,{recursive:true}));
  const preload=join(dir,"deny-system.mjs"),config=join(dir,"config.json"),dataDir=join(dir,"data");
  // 旧安装器会先注册协议：禁止系统写入，让红灯复现也不会改用户环境。
  await writeFile(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const original=cp.execFile;cp.execFile=(command,...args)=>{if(command==='reg.exe'||command==='powershell.exe')throw new Error('UNEXPECTED_SYSTEM_MUTATION');return original(command,...args);};syncBuiltinESMExports();`);
  await writeFile(config,"{}");
  const cli=fileURLToPath(new URL("../install.mjs",import.meta.url));
  const missing=join(dir,"missing-sqlite3.exe");
  await assert.rejects(promisify(execFile)(process.execPath,["--import",pathToFileURL(preload).href,cli,dataDir,"--config",config],{windowsHide:true,env:{...process.env,SQLITE_BIN:missing}}),error=>{
    assert.equal(error.code,1);
    const result=JSON.parse(error.stdout);
    assert.equal(result.ok,false);
    assert.match(result.error,/sqlite3/);
    assert.match(result.error,/sqliteBin/);
    assert.match(result.error,/SQLITE_BIN/);
    assert.equal(result.error.includes("UNEXPECTED_SYSTEM_MUTATION"),false);
    return true;
  });
  await assert.rejects(stat(dataDir),{code:"ENOENT"});
});

test("CLI 拒绝把仅检查和卸载组合，不能执行系统变更",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"z-title-check-remove-"));
  t.after(()=>rm(dir,{recursive:true}));
  const preload=join(dir,"deny-system.mjs");
  await writeFile(preload,`import cp from 'node:child_process';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const original=fs.readFile;fs.readFile=(path,...args)=>String(path).endsWith('config.json')?Promise.resolve('{}'):original(path,...args);fs.writeFile=async()=>{throw new Error('UNEXPECTED_SYSTEM_MUTATION');};fs.unlink=async()=>{throw new Error('UNEXPECTED_SYSTEM_MUTATION');};cp.execFile=()=>{throw new Error('UNEXPECTED_SYSTEM_MUTATION');};syncBuiltinESMExports();`);
  const cli=fileURLToPath(new URL("../install.mjs",import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath,["--import",pathToFileURL(preload).href,cli,join(dir,"data"),"--check-only","--remove"],{windowsHide:true}),error=>{
    assert.equal(error.code,2);
    assert.match(error.stdout+error.stderr,/不能同时使用/);
    assert.equal((error.stdout+error.stderr).includes("UNEXPECTED_SYSTEM_MUTATION"),false);
    return true;
  });
});

test("CLI 检查配置中的 sqliteBin，失败不回退环境变量；仅检查不写资产",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"z-title-check-sqlite-"));
  t.after(()=>rm(dir,{recursive:true}));
  const config=join(dir,"config.json"),dataDir=join(dir,"data"),cli=fileURLToPath(new URL("../install.mjs",import.meta.url));
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3";
  await writeFile(config,JSON.stringify({sqliteBin}));
  const {stdout}=await promisify(execFile)(process.execPath,[cli,dataDir,"--config",config,"--check-only"],{windowsHide:true,env:{...process.env,SQLITE_BIN:join(dir,"missing-environment.exe")}});
  const result=JSON.parse(stdout);
  assert.equal(result.ok,true);
  assert.equal(result.action,"checked");
  assert.equal(result.dependencies.sqlite_bin,sqliteBin);
  await assert.rejects(stat(dataDir),{code:"ENOENT"});
  await writeFile(config,JSON.stringify({sqliteBin:join(dir,"missing-config.exe")}));
  await assert.rejects(promisify(execFile)(process.execPath,[cli,dataDir,"--config",config,"--check-only"],{windowsHide:true}),error=>{
    assert.match(JSON.parse(error.stdout).error,/sqlite3/);return true;
  });
});

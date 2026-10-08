import test from "node:test";
import assert from "node:assert/strict";
import {installToastAssets,removeToastAssets,ensureToastAppId,installStopHook,removeStopHook,buildHookCommand,installSkill,removeSkill,AUMID,PROTOCOL} from "../install.mjs";

import {buildVbsContent,buildProtocolCommand} from "../../suian-zcode-common/notification-install.mjs";
import {mkdtemp,writeFile,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const makeShell=()=>{
  const state={files:new Map(),reg:[],ps:[],removed:[]};
  return {
    mkdir:async()=>{},
    state,
    run:async(cmd,args)=>{state.reg.push({cmd,args});return"";},
    ps:async script=>{state.ps.push(script);},
    writeText:async(path,text)=>{state.files.set(path,text);},
    readText:async path=>{if(!state.files.has(path))throw Object.assign(new Error("ENOENT"),{code:"ENOENT"});return state.files.get(path);},
    remove:async path=>{state.removed.push(path);state.files.delete(path);}
  };
};
test("vbs 桥与协议命令行按路径参数生成",()=>{
  const vbs=buildVbsContent({nodeExe:"C:\\Program Files\\nodejs\\node.exe",toastActionPath:"D:\\t\\toast-action.mjs",dataDir:"D:\\t\\.local"});
  assert.ok(vbs.includes("C:\\Program Files\\nodejs\\node.exe"));
  assert.ok(vbs.includes("D:\\t\\toast-action.mjs"));
  assert.ok(vbs.includes("D:\\t\\.local"));
  assert.ok(vbs.includes("WScript.Arguments(0)"),"%1 传入的 URI 必须转发");
  assert.ok(vbs.includes(", 0, False"),"必须以隐藏窗口运行");
  assert.equal(buildProtocolCommand({vbsPath:"D:\\t\\.local\\toast-launch.vbs"}),'wscript.exe "D:\\t\\.local\\toast-launch.vbs" "%1"');
});
test("安装幂等：重复安装不重写一致的 vbs，AUMID 固定自建",async()=>{
  const shell=makeShell();
  const options={pluginRoot:"D:\\t",dataDir:"D:\\t\\.local",nodeExe:"C:\\node.exe",shell};
  const first=await installToastAssets(options);
  assert.equal(first.actions.vbs,"written");
  assert.equal(first.appId,AUMID);
  assert.ok(shell.state.ps[0].includes(AUMID),"快捷方式脚本必须设置自建 AUMID");
  assert.ok(shell.state.ps[0].includes("Start Menu"),"快捷方式必须落在开始菜单");
  assert.ok(shell.state.ps[0].includes("SHGetPropertyStoreFromParsingName"),"通过属性存储写入 AUMID");
  const second=await installToastAssets(options);
  assert.equal(second.actions.vbs,"unchanged","内容一致时不得重写");
  assert.equal(second.appId,AUMID);
  assert.equal(shell.state.reg.length,6,"两次安装共 3 条注册表键 × 2 次");
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
  await removeToastAssets({dataDir:"D:\\t\\.local",shell});
  assert.ok(shell.state.removed.includes("D:\\t\\.local\\toast-launch.vbs"));
  assert.ok(shell.state.removed.includes("D:\\t\\.local\\toast-appid.txt"));
  assert.ok(shell.state.reg.some(r=>r.args[1]===`HKCU\\Software\\Classes\\${PROTOCOL}`&&r.args[0]==="delete"),"必须删除自有协议键");
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

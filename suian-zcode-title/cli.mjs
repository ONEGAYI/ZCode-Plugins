#!/usr/bin/env node
import {readFile,mkdir,open,writeFile,rename,unlink,appendFile,stat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {homedir} from "node:os";
import {resolve,dirname,join} from "node:path";
import {randomUUID} from "node:crypto";
import {createBackend} from "./backend.mjs";
import {runNaming} from "./naming.mjs";
import {commonRuntime,commonAnchorOptions} from "./common-access.mjs";
import {resolvePluginLayout} from "./release-layout.mjs";
import {toastBodyFor} from "./toast.mjs";
import {ensureToastAppId,PROTOCOL} from "./installer.mjs";
import {runDoctor} from "./doctor.mjs";

const args=process.argv.slice(2);
if(args.includes("--help")||!args.length) {
   console.log("用法：node cli.mjs run [--apply] [--config 文件]\n      node cli.mjs doctor|models|probe|status|enable|disable|auth|unauth [--config 文件]\n      node cli.mjs lock|unlock|policy [--config 文件]（固定/解除固定/查询会话标题策略；先校验目标会话存在）\nstdin JSON：session_id、workspace_path（或 cwd）、可选 user_message_id。\n原 Host 调用统一走公共网关；请先按公共 skill 安装或重载。auth / unauth 保留为旧凭据管理入口，不参与网关调用。\n网关类失败弹原生 Toast（2 小时冷却），设 OIL_ZCODE_TITLE_DISABLE_TOAST=1 静音。");
} else {
  let backend,lease,leasePath,dataDir,command,event;
  const startedAt=Date.now();
  try {
    command=args[0];
    if(!["run","doctor","models","probe","status","enable","disable","auth","unauth","lock","unlock","policy"].includes(command))throw new Error("未知命令");
    let configPath,apply=false,commonRootArg=null,installedPluginsArg=null;
    for(let i=1;i<args.length;i++) {
      if(args[i]==="--apply"&&command==="run")apply=true;
      else if(args[i]==="--config"&&args[i+1])configPath=resolve(args[++i]);
      else if(args[i]==="--common-root"&&args[i+1])commonRootArg=resolve(args[++i]);
      else if(args[i]==="--installed-plugins"&&args[i+1])installedPluginsArg=resolve(args[++i]);
      else throw new Error("未知参数");
    }
    let raw="";for await(const chunk of process.stdin)raw+=chunk;
    event=JSON.parse(raw);raw="";
    if(!event||typeof event!=="object"||Array.isArray(event))throw new Error("stdin 必须为会话事件对象");
    const supplied=configPath?JSON.parse(await readFile(configPath,"utf8")):{};
    const config={
      sessionDb:join(homedir(),".zcode","cli","db","db.sqlite"),
      indexDb:join(homedir(),".zcode","v2","tasks-index.sqlite"),
      timeoutMs:120000,maxOutputTokens:2048,
      ...supplied,
      sqliteBin:supplied.sqliteBin??process.env.SQLITE_BIN??"sqlite3"
    };
    if(!Number.isInteger(config.timeoutMs)||config.timeoutMs<1000||config.timeoutMs>300000)throw new Error("timeoutMs 应在 1000–300000 范围内");
    dataDir=resolve(configPath?dirname(configPath):process.cwd(),process.env.OIL_ZCODE_TITLE_DATA??config.dataDir??join(homedir(),".zcode","suian-zcode-title"));
    // 锚点：显式 --common-root / --installed-plugins 优先，宿主注入交给定位器，否则回退配置记录。
    const anchor=commonAnchorOptions({commonRoot:commonRootArg,installedPlugins:installedPluginsArg,config:supplied});
    // 提示词从明确的发布根读取，不用 bundle 所在目录解释源码相对路径。
    const prompt=await readFile(join(resolvePluginLayout().root,"prompt.md"),"utf8");
    const statePath=join(dataDir,event.session_id+".json");
    backend=createBackend({
      event,config,prompt,
      saveState:async state=>{
        const temporary=statePath+".tmp-"+randomUUID();
        await writeFile(temporary,JSON.stringify(state,null,2)+"\n","utf8");
        await rename(temporary,statePath);
      }
    });
    if(command==="run"&&config.enabled===false)console.log(JSON.stringify({status:"disabled"}));
    else {
      // 公共定位失败必须先于 mkdir、建锁等本地副作用；enable/disable 是纯本地命令不依赖 common。
      if(command!=="enable"&&command!=="disable")await commonRuntime(anchor);
      await mkdir(dataDir,{recursive:true});
      const requestedLeasePath=join(dataDir,"worker.lock");
      try {lease=await open(requestedLeasePath,"wx");leasePath=requestedLeasePath;}
      catch(error) {if(error.code==="EEXIST")throw new Error("busy：另一个命名进程持有共享远控连接");throw error;}
      await lease.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
      let result;
      if(command==="models") {
        const view=await backend.models();
        result={status:"models",providers:view.providers.map(p=>({
          providerId:p.providerId,models:p.models.map(m=>({modelId:m.modelId,reasoningLevels:m.config.optionSpecs.reasoningLevel.values}))
        }))};
      } else if(command==="auth") {
        const url=event.authorization_url??process.env.OIL_ZCODE_REMOTE_URL;
        if(!url)throw new Error("auth 需要 stdin.authorization_url 提供授权链接");
        const {saveAuthorization:storeAuthorization}=await commonRuntime();
        await storeAuthorization({dataDir,url});
        result={status:"auth_saved"};
      } else if(command==="unauth") {
        const {clearAuthorization}=await commonRuntime();
        await clearAuthorization({dataDir});
        result={status:"auth_cleared"};
      } else if(command==="status") {
        const legacyAuthorizationFilePresent=await stat(join(dataDir,"remote.blob")).then(info=>info.isFile(),error=>{if(error.code==="ENOENT")return false;throw error;});
        const vbsInstalled=await stat(join(dataDir,"toast-launch.vbs")).then(()=>true,()=>false);
        let protocolRegistered=false;
        try {protocolRegistered=(await promisify(execFile)("reg.exe",["query",`HKCU\\Software\\Classes\\${PROTOCOL}\\shell\\open\\command`,"/ve"],{windowsHide:true})).stdout.includes("wscript.exe");}
        catch {}
        const {shouldNotify}=await commonRuntime();
        const cooldown=await shouldNotify({dataDir});
        let lastUsage=null;
        try {
          const lines=(await readFile(join(dataDir,"usage.jsonl"),"utf8")).trim().split("\n");
          if(lines.length)lastUsage=JSON.parse(lines[lines.length-1]);
        }catch{}
        result={status:"status",enabled:config.enabled!==false,selection:config.selection??null,dataDir,transport:"gateway",
          legacyAuthorizationFilePresent,
          toast:{appId:await ensureToastAppId({dataDir}).catch(()=>null),vbsInstalled,protocolRegistered,cooldownActive:!cooldown.allowed,cooldownUntil:cooldown.nextAllowedAt?new Date(cooldown.nextAllowedAt).toISOString():null},
          lastUsage:{status:lastUsage?.status??null,at:lastUsage?.at??null,title:lastUsage?.title??null}};
      } else if(command==="enable"||command==="disable") {
        if(!configPath)throw new Error("enable/disable 需要 --config 指定配置文件");
        const current=JSON.parse(await readFile(configPath,"utf8"));
        current.enabled=command==="enable";
        const temporary=configPath+".tmp-"+randomUUID();
        await writeFile(temporary,JSON.stringify(current,null,2)+"\n","utf8");
        await rename(temporary,configPath);
        result={status:command==="enable"?"enabled_writing":"disabled_writing",enabled:current.enabled};
      } else if(command==="probe") {
        const {probeHost}=await commonRuntime();
        const probed=await probeHost({workspacePath:event.workspace_path??event.cwd,sessionId:event.session_id,gatewayConfigPath:config.gatewayConfigPath,timeoutMs:config.probeTimeoutMs??8000});
        result={status:probed.ok?"probe_ok":"probe_failed",...probed};
      } else if(command==="doctor") {
        result=await runDoctor({backend,event,config});
      } else if(command==="lock"||command==="unlock"||command==="policy") {
        const {readTitlePolicy,writeTitlePolicy}=await commonRuntime();
        if(!await backend.sessionExists())throw new Error("目标会话在索引与会话库中均不存在");
        const policyDirectory=config.titlePolicyDirectory||undefined;
        if(command==="policy") {
          result={status:"policy",sessionId:event.session_id,policy:await readTitlePolicy({sessionId:event.session_id,directory:policyDirectory})};
        } else {
          const locked=command==="lock";
          const previous=await readTitlePolicy({sessionId:event.session_id,directory:policyDirectory});
          await writeTitlePolicy({sessionId:event.session_id,locked,directory:policyDirectory});
          const policy=await readTitlePolicy({sessionId:event.session_id,directory:policyDirectory});
          if(policy?.locked!==locked)throw new Error("标题策略写后复核不一致");
          result={status:locked?"locked":"unlocked",sessionId:event.session_id,previous,policy};
        }
      } else {
        let state={};
        try {state=JSON.parse(await readFile(statePath,"utf8"));}
        catch(error) {if(error.code!=="ENOENT")throw error;}
        result=await runNaming({backend,selection:config.selection,state,apply,eventUserId:event.user_message_id});
        result.sessionId=event.session_id;
        result.selection=config.selection;
        await appendFile(join(dataDir,"usage.jsonl"),JSON.stringify({at:new Date().toISOString(),...result})+"\n","utf8");
      }
      console.log(JSON.stringify(result));
      await appendFile(join(dataDir,"runner.log.jsonl"),JSON.stringify({at:new Date().toISOString(),command,sessionId:event.sessionId??event.session_id,status:result.status,stage:result.stage,diagnostic:result.diagnostic,reasonCode:result.reasonCode??null,title:result.title??null,durationMs:Date.now()-startedAt})+"\n","utf8").catch(error=>console.error(JSON.stringify({at:new Date().toISOString(),event:"runner_log_failed",command,causeName:error.name,code:error.code})));
    }
  } catch(error) {
    const failure={status:"failed",error:error.name==="SyntaxError"?"JSON 格式无效":error.message};
    // 定位器错误（缺锚点、common 未装、API 不兼容等）透出错误码供诊断，与网关 reasonCode 区分
    if(typeof error.code==="string"&&error.stage)failure.locator=error.code;
    // 本地数据类校验失败无 stage，也须透出 reasonCode 供日志与诊断（不触发远控失败的 Toast 路径）
    if(error.reasonCode)failure.reasonCode=error.reasonCode;
    if(error.diagnostic)failure.diagnostic=error.diagnostic;
    if(error.stage) {
      failure.stage=error.stage;
      failure.reasonCode=error.reasonCode??"unknown";
      // 链接被 relay 拒绝即已失效：立即清除密文，避免此后每次 Stop 继续撞击 relay
      if(error.reasonCode==="auth_link_rejected"&&dataDir) {
        try {await (await commonRuntime()).clearAuthorization({dataDir});failure.authCleared=true;}catch{}
      }
      if(command==="run"&&dataDir) {
        if(process.env.OIL_ZCODE_TITLE_DISABLE_TOAST==="1")failure.toast="disabled";
        else {
          try {
            await mkdir(dataDir,{recursive:true});
            const appId=await ensureToastAppId({dataDir});
            const {notifyOnce}=await commonRuntime();
            const outcome=await notifyOnce({dataDir,title:"ZCode 自动命名暂停",message:toastBodyFor(failure.reasonCode),reasonCode:failure.reasonCode,appId,actionUri:"suian-zcode-title://fix"});
            failure.toast=outcome.shown?"shown":(outcome.reason??"suppressed");
          } catch(toastError) {failure.toast="unavailable:"+String(toastError.message).slice(0,80);}
        }
      }
    }
    console.log(JSON.stringify(failure));
    if(dataDir)await appendFile(join(dataDir,"runner.log.jsonl"),JSON.stringify({at:new Date().toISOString(),command,sessionId:event?.session_id??null,status:"failed",stage:failure.stage,diagnostic:failure.diagnostic,reasonCode:failure.reasonCode??null,error:String(failure.error).slice(0,200),durationMs:Date.now()-startedAt})+"\n","utf8").catch(error=>console.error(JSON.stringify({at:new Date().toISOString(),event:"runner_log_failed",command,causeName:error.name,code:error.code})));
    process.exitCode=1;
  } finally {
    backend?.close();
    if(lease) {await lease.close();await unlink(leasePath);}
  }
}



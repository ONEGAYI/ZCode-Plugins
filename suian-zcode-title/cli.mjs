#!/usr/bin/env node
import {readFile,mkdir,open,writeFile,rename,unlink,appendFile,stat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {homedir} from "node:os";
import {resolve,dirname,join} from "node:path";
import {randomUUID} from "node:crypto";
import {createBackend} from "./backend.mjs";
import {runNaming} from "./naming.mjs";
import {probeHost} from "../suian-zcode-common/remote.mjs";
import {toastBodyFor} from "./toast.mjs";
import {notifyOnce} from "../suian-zcode-common/notifications.mjs";
import {ensureToastAppId,PROTOCOL} from "./install.mjs";
import {shouldNotify} from "../suian-zcode-common/cooldown.mjs";
import {saveAuthorization as storeAuthorization,clearAuthorization} from "../suian-zcode-common/auth-store.mjs";
import {runDoctor} from "./doctor.mjs";

const args=process.argv.slice(2);
if(args.includes("--help")||!args.length) {
   console.log("用法：node cli.mjs run [--apply] [--config 文件]\n      node cli.mjs doctor|models|probe|status|enable|disable|auth|unauth [--config 文件]\nstdin JSON：session_id、workspace_path（或 cwd）、可选 user_message_id。\n原 Host 调用统一走公共网关；请先按公共 skill 安装或重载。auth / unauth 保留为旧凭据管理入口，不参与网关调用。\n网关类失败弹原生 Toast（2 小时冷却），设 OIL_ZCODE_TITLE_DISABLE_TOAST=1 静音。");
} else {
  let backend,lease,leasePath,dataDir,command,event;
  const startedAt=Date.now();
  try {
    command=args[0];
    if(!["run","doctor","models","probe","status","enable","disable","auth","unauth"].includes(command))throw new Error("未知命令");
    let configPath,apply=false;
    for(let i=1;i<args.length;i++) {
      if(args[i]==="--apply"&&command==="run")apply=true;
      else if(args[i]==="--config"&&args[i+1])configPath=resolve(args[++i]);
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
    const prompt=await readFile(new URL("./prompt.md",import.meta.url),"utf8");
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
        await storeAuthorization({dataDir,url});
        result={status:"auth_saved"};
      } else if(command==="unauth") {
        await clearAuthorization({dataDir});
        result={status:"auth_cleared"};
      } else if(command==="status") {
        const legacyAuthorizationFilePresent=await stat(join(dataDir,"remote.blob")).then(info=>info.isFile(),error=>{if(error.code==="ENOENT")return false;throw error;});
        const vbsInstalled=await stat(join(dataDir,"toast-launch.vbs")).then(()=>true,()=>false);
        let protocolRegistered=false;
        try {protocolRegistered=(await promisify(execFile)("reg.exe",["query",`HKCU\\Software\\Classes\\${PROTOCOL}\\shell\\open\\command`,"/ve"],{windowsHide:true})).stdout.includes("wscript.exe");}
        catch {}
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
        const probed=await probeHost({workspacePath:event.workspace_path??event.cwd,sessionId:event.session_id,gatewayConfigPath:config.gatewayConfigPath,timeoutMs:config.probeTimeoutMs??8000});
        result={status:probed.ok?"probe_ok":"probe_failed",...probed};
      } else if(command==="doctor") {
        result=await runDoctor({backend,event,config});
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
      await appendFile(join(dataDir,"runner.log.jsonl"),JSON.stringify({at:new Date().toISOString(),command,sessionId:event.sessionId??event.session_id,status:result.status,reasonCode:result.reasonCode??null,title:result.title??null,durationMs:Date.now()-startedAt})+"\n","utf8").catch(()=>{});
    }
  } catch(error) {
    const failure={status:"failed",error:error.name==="SyntaxError"?"JSON 格式无效":error.message};
    if(error.stage) {
      failure.stage=error.stage;
      failure.reasonCode=error.reasonCode??"unknown";
      // 链接被 relay 拒绝即已失效：立即清除密文，避免此后每次 Stop 继续撞击 relay
      if(error.reasonCode==="auth_link_rejected"&&dataDir) {
        try {await clearAuthorization({dataDir});failure.authCleared=true;}catch{}
      }
      if(command==="run"&&dataDir) {
        if(process.env.OIL_ZCODE_TITLE_DISABLE_TOAST==="1")failure.toast="disabled";
        else {
          try {
            await mkdir(dataDir,{recursive:true});
            const appId=await ensureToastAppId({dataDir});
            const outcome=await notifyOnce({dataDir,title:"ZCode 自动命名暂停",message:toastBodyFor(failure.reasonCode),reasonCode:failure.reasonCode,appId,actionUri:"suian-zcode-title://fix"});
            failure.toast=outcome.shown?"shown":(outcome.reason??"suppressed");
          } catch(toastError) {failure.toast="unavailable:"+String(toastError.message).slice(0,80);}
        }
      }
    }
    console.log(JSON.stringify(failure));
    if(dataDir)await appendFile(join(dataDir,"runner.log.jsonl"),JSON.stringify({at:new Date().toISOString(),command,sessionId:event?.session_id??null,status:"failed",reasonCode:failure.reasonCode??null,error:String(failure.error).slice(0,200),durationMs:Date.now()-startedAt})+"\n","utf8").catch(()=>{});
    process.exitCode=1;
  } finally {
    backend?.close();
    if(lease) {await lease.close();await unlink(leasePath);}
  }
}



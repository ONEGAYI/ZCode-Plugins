import {createHmac,randomUUID} from "node:crypto";
import {win32} from "node:path";
import {ChannelClient} from "./vendor/channelClient.js";
import {Emitter} from "./vendor/foundation.js";
import {VSBuffer} from "./vendor/buffer.js";
import {Hs as encode,Bs as Assembler,Ws as parse,S as workspaceKey} from "./vendor/remote-shared.js";
export { connectHost, probeHost } from './gateway-client.mjs';

const samePath=(a,b)=>win32.normalize(String(a)).toLowerCase()===win32.normalize(String(b)).toLowerCase();
const relayErrorClass={AUTH_FAILED:"auth_failed",DEVICE_OFFLINE:"device_offline",KICKED:"kicked"};
const classified=(message,stage,reasonCode)=>Object.assign(new Error(message),{stage,reasonCode});

function parseAuthorizationUrl(authorizationUrl) {
  let auth;
  try {auth=new URL(authorizationUrl);}
  catch {throw classified("需要官方远控授权链接","config","invalid_url");}
  if(auth.origin!=="https://zcode.z.ai"||!auth.pathname.startsWith("/remote/"))throw classified("需要官方远控授权链接","config","invalid_url");
  const sid=auth.searchParams.get("sid"),hash=auth.searchParams.get("hash"),mid=auth.searchParams.get("mid");
  if(!sid||!hash||!mid)throw classified("远控链接缺少 sid/hash/mid","config","invalid_url");
  return {auth,sid,hash,mid};
}

export function startRelay({authorizationUrl,timeoutMs=120000,handshakeTimeoutMs=timeoutMs,WebSocketImpl=WebSocket,onPairWaiting,onData}) {
  const {auth,sid,hash,mid}=parseAuthorizationUrl(authorizationUrl);
  const relay=new URL("wss://zcode.z.ai/ws");relay.searchParams.set("mid",mid);
  const paired=Promise.withResolvers(),fault=Promise.withResolvers();
  const pairWatchers=new Set();
  let closing=false,heartbeat,pairedDone=false;
  const socket=new WebSocketImpl(relay.href);
  const timeoutError=()=>classified("远控执行超时","network","network_timeout");
  let deadlineTimer=setTimeout(()=>fault.reject(timeoutError()),handshakeTimeoutMs);
  const extendDeadline=ms=>{clearTimeout(deadlineTimer);deadlineTimer=setTimeout(()=>fault.reject(timeoutError()),ms);};
  const close=()=>{closing=true;clearTimeout(deadlineTimer);clearInterval(heartbeat);socket.close();};
  socket.addEventListener("open",()=>socket.send(JSON.stringify({
    type:"auth_init",role:"terminal",device_sid:sid,meta:{platform:"web",version:auth.searchParams.get("app_version")??"3.14.4",name:"suian-zcode-common"},client_ts:Date.now()
  })));
  socket.addEventListener("error",()=>{
    if(pairedDone)fault.reject(classified("远控 WebSocket 连接失败","network","network_error"));
  });
  socket.addEventListener("close",e=>{
    if(closing)return;
    // 认证完成前被服务端断开（1006）：relay 拒绝该 sid，链接大概率已失效而非网络问题
    fault.reject(pairedDone
      ?classified("远控连接已关闭："+e.code,"network","network_error")
      :classified("远控链接被服务端拒绝（很可能已失效，请重新获取）","auth","auth_link_rejected"));
  });
  socket.addEventListener("message",event=>{
    try {
      const m=JSON.parse(event.data);
      if(m.type==="auth_challenge") {
        const proof=createHmac("sha256",hash).update(m.nonce+"|terminal|"+sid).digest("base64url");
        socket.send(JSON.stringify({type:"auth_response",device_sid:sid,proof,client_ts:Date.now()}));
      } else if(m.type==="error") {
        const reasonCode=relayErrorClass[m.code];
        fault.reject(classified("远控鉴权/连接错误："+m.code,reasonCode==="auth_failed"?"auth":"pair",reasonCode??"relay_rejected"));
      } else if(m.type==="auth_ack"||m.type==="pair_status_ack") {
        for(const watch of pairWatchers)watch(m.pair_status);
        if(m.pair_status==="matched") {
          pairedDone=true;
          if(!heartbeat)heartbeat=setInterval(()=>socket.send(JSON.stringify({type:"pair_status_query",device_sid:sid,client_ts:Date.now()})),10000);
          paired.resolve();
        } else {
          const verdict=onPairWaiting?.();
          if(verdict)fault.reject(classified(verdict.message,verdict.stage,verdict.reasonCode));
          else if(heartbeat)throw new Error("远控配对已断开");
        }
      } else if(m.type==="data")onData?.(m.payload);
    } catch(error) {fault.reject(error);}
  });
  return {
    socket,sid,paired,fault,pairWatchers,close,extendDeadline,
    isClosing:()=>closing,
    sendData:payload=>socket.send(JSON.stringify({type:"data",payload,client_ts:Date.now()}))
  };
}

export async function connectRemote({authorizationUrl,workspacePath,sessionId,timeoutMs=120000,handshakeTimeoutMs,WebSocketImpl=WebSocket}) {
  if(!workspacePath)throw new Error("缺少工作区标识");
  const bootstrap=Promise.withResolvers(),ready=Promise.withResolvers();
  const bootstrapId=randomUUID(),bridgeId=randomUUID(),bridgeSessionId=randomUUID();
  const emitter=new Emitter();
  let client,assembler,identity,physicalSeq=1,messageSeq=1;
  let bridgeWorkspacePath=workspacePath;
  const relay=startRelay({
    authorizationUrl,timeoutMs,handshakeTimeoutMs,WebSocketImpl,
    onData:p=>{
      if(p.zcode_type==="bootstrap-response"&&p.requestId===bootstrapId)bootstrap.resolve(p);
      else if(p.zcode_type==="workspace-bridge-ready"&&p.requestId===bridgeId) {
        const b=p.bridge;
        if(b.bridgeSessionId!==bridgeSessionId||b.bridgeGeneration!==1||b.workspaceKey!==bridgeWorkspacePath||b.workspacePath!==bridgeWorkspacePath||(sessionId!==undefined&&b.initialTaskId!==sessionId)||b.kind!=="local")throw new Error("远控工作区或会话不匹配");
        identity={bridgeSessionId:b.bridgeSessionId,bridgeGeneration:b.bridgeGeneration,...b.recoveryId?{recoveryId:b.recoveryId}:{}};
        assembler=new Assembler({identity});
        client=new ChannelClient({
          onMessage:emitter.event,
          send:buffer=>{
            const frames=encode(buffer.buffer,{...identity,firstPhysicalSeq:physicalSeq,messageSeq});
            physicalSeq+=frames.length;messageSeq++;
            for(const frame of frames)relay.sendData(frame);
          },
          drain:()=>Promise.resolve()
        });
        ready.resolve();
      }
      else if(["app-error","workspace-bridge-error","bridge-degraded"].includes(p.zcode_type))throw new Error("原 Host 附着失败："+p.reason);
      else if(p.zcode_type==="rpc-frame"||p.zcode_type==="rpc-frame-ack") {
        const f=parse(p);
        if(!f)throw new Error("无效 RPC 帧");
        if(!identity||f.bridgeSessionId!==identity.bridgeSessionId||f.bridgeGeneration!==identity.bridgeGeneration||f.recoveryId!==identity.recoveryId)throw new Error("RPC 身份不匹配");
        if(f.zcode_type==="rpc-frame") {
          const assembled=assembler.accept(f);
          if(assembled.kind==="fault")throw new Error(assembled.fault.reasonCode);
          if(assembled.kind==="complete")emitter.fire(VSBuffer.wrap(assembled.bytes));
          const ack=assembled.kind==="complete"?assembled.messageSeq:assembled.kind==="duplicate"?assembled.ackMessageSeq:null;
          if(ack)relay.sendData({zcode_type:"rpc-frame-ack",...identity,ackMessageSeq:ack});
        }
      }
    }
  });
  const close=()=>{relay.close();client?.dispose();emitter.dispose();};
  try {
    await Promise.race([relay.paired.promise,relay.fault.promise]);
    relay.sendData({zcode_type:"bootstrap-request",requestId:bootstrapId});
    const b=await Promise.race([bootstrap.promise,relay.fault.promise]);
    if(!b.success)throw new Error("原窗口 bootstrap 失败");
    const workspace=b.result.workspaces.find(w=>w.kind==="local"&&samePath(workspaceKey(w),workspacePath));
    if(!workspace)throw new Error("原窗口没有打开目标本地工作区");
    bridgeWorkspacePath=workspace.workspacePath;
    if(sessionId!==undefined&&!b.result.tasks.some(t=>t.taskId===sessionId&&samePath(t.workspacePath,workspacePath)))throw new Error("原窗口没有目标会话");
    relay.sendData({zcode_type:"workspace-bridge-open",requestId:bridgeId,bridgeSessionId,bridgeGeneration:1,workspaceKey:bridgeWorkspacePath,...sessionId!==undefined?{taskId:sessionId}:{}});
    await Promise.race([ready.promise,relay.fault.promise]);
    relay.extendDeadline(timeoutMs);
    return {
      bootstrap:b.result,
      workspacePath:bridgeWorkspacePath,
      call:(channel,method,args=[])=>Promise.race([client.getChannel(channel).call(method,args),relay.fault.promise]),
      probe:({ackTimeoutMs=5000}={})=>{
        if(relay.isClosing()||relay.socket.readyState!==1)return Promise.resolve({ok:false,stage:"pair",reasonCode:"connection_closed",paired:false,message:"远控连接已关闭"});
        return new Promise(resolve=>{
          let done=false;
          const finish=result=>{if(done)return;done=true;relay.pairWatchers.delete(watch);clearTimeout(timer);resolve(result);};
          const watch=status=>finish(status==="matched"
            ?{ok:true,stage:"pair",reasonCode:"matched",paired:true}
            :{ok:false,stage:"pair",reasonCode:"pair_waiting",paired:false,message:"移动端尚未完成配对"});
          const timer=setTimeout(()=>finish({ok:false,stage:"pair",reasonCode:"pair_ack_timeout",paired:false,message:"配对状态确认超时"}),ackTimeoutMs);
          relay.pairWatchers.add(watch);
          relay.socket.send(JSON.stringify({type:"pair_status_query",device_sid:relay.sid,client_ts:Date.now()}));
        });
      },
      close
    };
  } catch(error) {close();throw error;}
}

export async function probeRemote({authorizationUrl,workspacePath,sessionId,timeoutMs=8000,WebSocketImpl=WebSocket}) {
  if(!workspacePath||!sessionId)return{ok:false,stage:"config",reasonCode:"missing_target",paired:false,message:"缺少工作区或会话标识"};
  const bootstrap=Promise.withResolvers(),bootstrapId=randomUUID();
  let relay=null;
  try {
    relay=startRelay({
      authorizationUrl,timeoutMs,WebSocketImpl,
      onPairWaiting:()=>({stage:"pair",reasonCode:"pair_waiting",message:"移动端尚未完成配对"}),
      onData:p=>{
        if(p.zcode_type==="bootstrap-response"&&p.requestId===bootstrapId)bootstrap.resolve(p);
        else if(["app-error","workspace-bridge-error","bridge-degraded"].includes(p.zcode_type))
          relay?.fault.reject(classified("原 Host 附着失败："+p.reason,"host","host_unreachable"));
      }
    });
    await Promise.race([relay.paired.promise,relay.fault.promise]);
    relay.sendData({zcode_type:"bootstrap-request",requestId:bootstrapId});
    const b=await Promise.race([bootstrap.promise,relay.fault.promise]);
    if(!b.success)return{ok:false,stage:"host",reasonCode:"host_unreachable",paired:true,hostReachable:false,message:"原窗口 bootstrap 失败"};
    if(!b.result.workspaces.some(w=>w.kind==="local"&&samePath(workspaceKey(w),workspacePath)))return{ok:false,stage:"workspace",reasonCode:"workspace_missing",paired:true,hostReachable:true,workspaceFound:false};
    if(!b.result.tasks.some(t=>t.taskId===sessionId&&samePath(t.workspacePath,workspacePath)))return{ok:false,stage:"session",reasonCode:"session_missing",paired:true,hostReachable:true,workspaceFound:true,sessionFound:false};
    return{ok:true,paired:true,hostReachable:true,workspaceFound:true,sessionFound:true};
  } catch(error) {
    return{ok:false,stage:error.stage??"network",reasonCode:error.reasonCode??"network_error",paired:false,message:error.message};
  } finally {relay?.close();}
}

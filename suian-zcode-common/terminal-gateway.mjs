import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {startTerminalRelay} from './terminal-relay.mjs';
import {createRpcBroker} from './rpc-broker.mjs';
import {gatewayBuild} from './gateway-build.mjs';

// 仅提供本机 RPC；不接收或代理 Desktop 的 relay 连接。
export async function startTerminalGateway({port,instanceId,controlToken,upstreamUrl,deviceSid,deviceMid,getToken,bridgeTimeoutMs,WebSocketImpl,onError}) {
  if(typeof controlToken!=='string'||!controlToken||typeof deviceMid!=='string'||!deviceMid)throw new Error('终端网关需要本机 control token 和目标设备 MID');
  let relay,paired=false,lastError,closing=false;
  const clients=new Set(),pending=new Map();
  const broker=createRpcBroker({bridgeTimeoutMs,bootstrap:()=>bootstrap(),onError,sendDesktop:p=>relay.sendData(p),sendPhone:()=>{throw new Error('终端网关不代理手机连接');}});
  const failed=error=>{
    paired=false;lastError=error.reasonCode??'terminal_failed';
    for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();
    broker.close(error);relay.close();onError(error);
  };
  function bootstrap({timeoutMs=bridgeTimeoutMs}={}) {
    if(!paired)throw new Error('终端尚未与 Desktop 配对');
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('bootstrap 超时'));},timeoutMs);
      pending.set(requestId,{resolve,reject,timer});
      relay.sendData({zcode_type:'bootstrap-request',requestId});
    });
  }
  const http=createServer(async(request,response)=>{
    if(request.headers.origin!==undefined){response.writeHead(403).end();return;}
    if(request.method==='GET'&&request.url==='/health'){
      response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({service:'suian-zcode-gateway',version:1,build:gatewayBuild,instance_id:instanceId,mode:'terminal',connection_role:'terminal',desktop_connected:paired,desktop_ready:paired,upstream_connected:relay.socket.readyState===1,paired,upstream_paired:paired,local_clients:clients.size,rpc_protocol_version:1,...lastError?{last_error:lastError}:{}}));return;
    }
    if(request.method==='POST'&&request.url==='/shutdown'){
      if(request.headers.authorization!==`Bearer ${controlToken}`){response.writeHead(401).end();return;}
      if(clients.size){response.writeHead(409).end('Disconnect local RPC clients first');return;}
      response.writeHead(200,{'Content-Type':'application/json',Connection:'close'}).end('{"ok":true}');await close();return;
    }
    response.writeHead(404).end();
  });
  const rpc=new WebSocketServer({noServer:true});
  http.on('upgrade',(request,socket,head)=>{
    if(request.headers.origin!==undefined||request.headers.authorization!==`Bearer ${controlToken}`){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    if(request.url!=='/rpc'){socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');return;}
    rpc.handleUpgrade(request,socket,head,ws=>rpc.emit('connection',ws));
  });
  rpc.on('connection',socket=>{
    if(!paired){socket.close(1013,'Desktop is not paired');return;}
    clients.add(socket);socket.on('close',()=>clients.delete(socket));socket.on('error',onError);broker.acceptLocal(socket);
  });
  relay=await startTerminalRelay({deviceSid,deviceMid,getToken,relayUrl:upstreamUrl,timeoutMs:bridgeTimeoutMs,WebSocketImpl,onPairStatus:status=>{paired=status==='matched';if(!paired&&clients.size)failed(Object.assign(new Error('Desktop 配对已断开'),{reasonCode:'desktop_unpaired'}));},onData:payload=>{
    if(payload.zcode_type==='bootstrap-response'){
      const item=pending.get(payload.requestId);if(item){clearTimeout(item.timer);pending.delete(payload.requestId);item.resolve(payload);}return;
    }
    broker.desktopPayload(payload);
  }});
  try {await Promise.race([relay.paired.promise,relay.fault.promise]);}
  catch(error){relay.close();throw error;}
  relay.fault.promise.catch(failed);
  http.listen(port,'127.0.0.1');await once(http,'listening');
  async function close(){
    if(closing)return;closing=true;
    paired=false;relay.close();
    const error=new Error('终端网关已关闭');
    for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();
    broker.close(error);for(const socket of clients)socket.terminate();
    await Promise.all([new Promise(resolve=>rpc.close(resolve)),new Promise((resolve,reject)=>http.close(e=>e?reject(e):resolve()))]);
  }
  return {url:`ws://127.0.0.1:${http.address().port}/rpc`,healthUrl:`http://127.0.0.1:${http.address().port}/health`,bootstrap,close};
}

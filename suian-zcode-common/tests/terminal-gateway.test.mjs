import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {startGateway} from '../gateway.mjs';
import {connectHost} from '../gateway-client.mjs';
import {Hs as encode,Bs as Assembler,Ws as parse} from '../vendor/remote-shared.js';
import {BufferReader,BufferWriter,deserialize,serialize} from '../vendor/serialization.js';
import {VSBuffer} from '../vendor/buffer.js';

test('3.16 网关作为独立终端连接官方 relay，多个本地客户端共用桥并验证会话', {timeout:5000}, async t=>{
  const relay=new WebSocketServer({host:'127.0.0.1',port:0});
  await once(relay,'listening');
  t.after(()=>{for(const s of relay.clients)s.terminate();relay.close();});
  let connections=0,opens=0;
  const errors=[],pendingCall=Promise.withResolvers();
  const workspace='D:\\fixture316';
  relay.on('connection',socket=>{
    connections++;
    let identity,assembler,physical=1,message=1;
    const respond=(header,body)=>{
      const writer=new BufferWriter();serialize(writer,header);serialize(writer,body);
      const frames=encode(writer.buffer.buffer,{...identity,firstPhysicalSeq:physical,messageSeq:message++});physical+=frames.length;
      for(const payload of frames)socket.send(JSON.stringify({type:'data',payload}));
    };
    socket.on('message',data=>{
      const m=JSON.parse(data);
      if(m.type==='auth_init'){socket.send(JSON.stringify({type:'auth_ack',device_sid:'d_fixture',pair_status:'matched'}));return;}
      const p=m.payload;
      if(p?.zcode_type==='bootstrap-request')socket.send(JSON.stringify({type:'data',payload:{zcode_type:'bootstrap-response',requestId:p.requestId,success:true,result:{desktopAppVersion:'3.16.1',windowControlSessionId:'window-test',workspaces:[{kind:'local',workspacePath:workspace}]}}}));
      if(p?.zcode_type==='workspace-bridge-open'){
        opens++;identity={bridgeSessionId:p.bridgeSessionId,bridgeGeneration:p.bridgeGeneration};assembler=new Assembler({identity});
        socket.send(JSON.stringify({type:'data',payload:{zcode_type:'workspace-bridge-ready',requestId:p.requestId,bridge:{...identity,kind:'local',workspaceKey:workspace,workspacePath:workspace}}}));
        respond([200]);
      }
      if(p?.zcode_type==='rpc-frame'){
        const result=assembler.accept(parse(p));
        if(result.kind!=='complete')return;
        const reader=new BufferReader(VSBuffer.wrap(result.bytes)),header=deserialize(reader),args=deserialize(reader);
        if(header[3]==='noAck'){pendingCall.resolve();return;}
        if(header[0]===100)respond([201,header[1]],header[3]==='getTaskMeta'?(args[0].taskId==='session-test'?{taskId:'session-test',workspacePath:workspace}:null):args[0]);
      }
    });
  });
  const gateway=await startGateway({mode:'terminal',deviceSid:'d_fixture',deviceMid:'mid_fixture',getToken:async()=>'fixture-token',upstreamUrl:`ws://127.0.0.1:${relay.address().port}/api/v1/remote/ws2`,controlToken:'local-token',WebSocketImpl:WebSocket,onError:error=>errors.push(error)});
  t.after(()=>gateway.close());
  assert.equal((await fetch(gateway.healthUrl,{headers:{Origin:'https://example.test'}})).status,403);
  for(const headers of [{Authorization:'Bearer wrong'},{Authorization:'Bearer local-token',Origin:'https://example.test'}]){
    const rejected=new WebSocket(gateway.url,{headers});
    const [error]=await once(rejected,'error');assert.match(error.message,/403/);
  }
  assert.equal((await fetch(gateway.healthUrl.replace('/health','/ws'))).status,404);
  const dir=await mkdtemp(join(tmpdir(),'zcode-terminal-'));
  t.after(()=>rm(dir,{recursive:true}));
  const gatewayConfigPath=join(dir,'config.json');
  await writeFile(gatewayConfigPath,JSON.stringify({version:1,port:Number(new URL(gateway.url).port),control_token:'local-token'}));
  const a=await connectHost({workspacePath:workspace,sessionId:'session-test',gatewayConfigPath});t.after(()=>a.close());
  const b=await connectHost({workspacePath:workspace,sessionId:'session-test',gatewayConfigPath});t.after(()=>b.close());
  assert.deepEqual(await Promise.all([a.call('fixture','echo',['A']),b.call('fixture','echo',['B'])]),['A','B']);
  await assert.rejects(connectHost({workspacePath:workspace,sessionId:'missing',gatewayConfigPath}),/Session is not present/);
  const health=await(await fetch(gateway.healthUrl)).json();
  assert.equal(health.mode,'terminal');
  assert.equal(health.desktop_ready,true);
  assert.equal(connections,1);assert.equal(opens,1);
  const failed=assert.rejects(a.call('fixture','noAck'),error=>{
    assert.equal(error.diagnostic.mode,'terminal');
    assert.equal(error.diagnostic.relayProtocolVersion,2);
    assert.match(error.diagnostic.gatewayBuildId,/^[a-f0-9]{64}$/);
    assert.equal(error.diagnostic.id,errors.at(-1).diagnostic.id);
    assert.equal(errors.at(-1).diagnostic.reasonCode,'relay_connection_closed');
    return true;
  });
  await pendingCall.promise;
  for(const socket of relay.clients)socket.terminate();
  await failed;
});

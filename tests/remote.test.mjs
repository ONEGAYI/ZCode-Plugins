import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {connectRemote} from "../remote.mjs";
import {Hs as encode, Ws as parse} from "../vendor/remote-shared.js";
import {BufferReader,BufferWriter,serialize,deserialize} from "../vendor/serialization.js";
import {VSBuffer} from "../vendor/buffer.js";

const workspacePath="D:\\fixture",sessionId="sess_fixture";
class RelayFixture {
  listeners=new Map();serverSeq=1;serverMessage=1;calls=[];acks=[];
  constructor() { RelayFixture.latest=this;queueMicrotask(()=>this.emit("open",{})); }
  addEventListener(name,fn) {this.listeners.set(name,fn);}
  emit(name,data) {this.listeners.get(name)?.(data);}
  reply(message) {queueMicrotask(()=>this.emit("message",{data:JSON.stringify(message)}));}
  frame(header,body) {
    const writer=new BufferWriter();serialize(writer,header);serialize(writer,body);
    for(const f of encode(writer.buffer.buffer,{...this.identity,firstPhysicalSeq:this.serverSeq,messageSeq:this.serverMessage})) {
      this.serverSeq++;this.reply({type:"data",payload:f});
    }this.serverMessage++;
  }
  send(raw) {
    const m=JSON.parse(raw);
    if(m.type==="auth_init")this.reply({type:"auth_challenge",nonce:"fixture-nonce"});
    else if(m.type==="auth_response") {
      this.proof=m.proof;this.reply({type:"auth_ack",pair_status:"matched"});
    } else if(m.type==="data") {
      const p=m.payload;
      if(p.zcode_type==="bootstrap-request")this.reply({type:"data",payload:{zcode_type:"bootstrap-response",requestId:p.requestId,success:true,result:{workspaces:[{kind:"local",workspacePath}],tasks:[{taskId:sessionId,workspacePath,title:"原名"}]}}});
      else if(p.zcode_type==="workspace-bridge-open") {
        this.identity={bridgeSessionId:p.bridgeSessionId,bridgeGeneration:p.bridgeGeneration};
        this.reply({type:"data",payload:{zcode_type:"workspace-bridge-ready",requestId:p.requestId,bridge:{...this.identity,kind:"local",workspaceKey:workspacePath,workspacePath,initialTaskId:sessionId}}});
        this.frame([200],undefined);
      } else if(p.zcode_type==="rpc-frame-ack")this.acks.push(p.ackMessageSeq);
      else if(p.zcode_type==="rpc-frame") {
        const frame=parse(p);const reader=new BufferReader(VSBuffer.wrap(Buffer.from(frame.dataBase64,"base64")));
        const header=deserialize(reader),body=deserialize(reader);
        this.calls.push({header,body});
        this.frame([201,header[1]],{taskId:sessionId,workspacePath,title:"原名"});
      }
    }
  }
  close() {this.closed=true;}
}
test("授权外部连接等待 Initialize 并以数组参数调用原 Host",async()=>{
  const remote=await connectRemote({authorizationUrl:"https://zcode.z.ai/remote/v4?sid=fixture-sid&hash=fixture-key&mid=fixture-mid",workspacePath,sessionId,WebSocketImpl:RelayFixture,timeoutMs:1000});
  try {
    const result=await remote.call("zcode-task","getTaskMeta",[{taskId:sessionId,workspacePath}]);
    assert.equal(result.title,"原名");
    assert.equal(RelayFixture.latest.proof,createHmac("sha256","fixture-key").update("fixture-nonce|terminal|fixture-sid").digest("base64url"));
    assert.deepEqual(RelayFixture.latest.calls[0],{header:[100,0,"zcode-task","getTaskMeta"],body:[{taskId:sessionId,workspacePath}]});
    assert.ok(RelayFixture.latest.acks.includes(1));
  } finally {remote.close();}
  assert.equal(RelayFixture.latest.closed,true);
});


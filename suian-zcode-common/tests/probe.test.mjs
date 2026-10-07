import test from "node:test";
import assert from "node:assert/strict";
import {connectRemote,probeRemote} from "../remote.mjs";
import {Hs as encode, Ws as parse} from "../vendor/remote-shared.js";
import {BufferReader,BufferWriter,serialize,deserialize} from "../vendor/serialization.js";
import {VSBuffer} from "../vendor/buffer.js";

const authorizationUrl="https://zcode.z.ai/remote/v4?sid=fixture-sid&hash=fixture-key&mid=fixture-mid";
const workspacePath="D:\\fixture",sessionId="sess_fixture";
class RelaySim {
  listeners=new Map();serverSeq=1;serverMessage=1;calls=[];acks=[];pairQueries=[];
  identity=null;readyState=1;
  constructor(behavior={}) {this.behavior=behavior;RelaySim.latest=this;queueMicrotask(()=>{if(!this.behavior.neverOpen)this.emit("open",{});});}
  addEventListener(name,fn) {this.listeners.set(name,fn);}
  emit(name,data) {this.listeners.get(name)?.(data);}
  reply(message) {queueMicrotask(()=>this.emit("message",{data:JSON.stringify(message)}));}
  frame(header,body) {
    const writer=new BufferWriter();serialize(writer,header);serialize(writer,body);
    for(const f of encode(writer.buffer.buffer,{...this.identity,firstPhysicalSeq:this.serverSeq,messageSeq:this.serverMessage})) {this.serverSeq++;this.reply({type:"data",payload:f});}
    this.serverMessage++;
  }
  send(raw) {
    const m=JSON.parse(raw);
    if(m.type==="auth_init") {
      if(this.behavior.authError)this.reply({type:"error",code:this.behavior.authError});
      else this.reply({type:"auth_challenge",nonce:"fixture-nonce"});
    } else if(m.type==="auth_response") {
      this.proof=m.proof;this.reply({type:"auth_ack",pair_status:this.behavior.authPairStatus??"matched"});
    } else if(m.type==="pair_status_query") {
      this.pairQueries.push(m.client_ts);
      if(this.behavior.pairAck)this.reply({type:"pair_status_ack",pair_status:this.behavior.pairAck});
    } else if(m.type==="data") {
      const p=m.payload;
      if(p.zcode_type==="bootstrap-request")this.reply({type:"data",payload:{zcode_type:"bootstrap-response",requestId:p.requestId,success:this.behavior.bootstrapSuccess!==false,result:{workspaces:this.behavior.workspaces??[{kind:"local",workspacePath}],tasks:this.behavior.tasks??[{taskId:sessionId,workspacePath,title:"原名"}]}}});
      else if(p.zcode_type==="workspace-bridge-open") {
        this.identity={bridgeSessionId:p.bridgeSessionId,bridgeGeneration:p.bridgeGeneration};
        this.reply({type:"data",payload:{zcode_type:"workspace-bridge-ready",requestId:p.requestId,bridge:{...this.identity,kind:"local",workspaceKey:workspacePath,workspacePath,initialTaskId:sessionId}}});
        this.frame([200],undefined);
      }
      else if(p.zcode_type==="rpc-frame-ack")this.acks.push(p.ackMessageSeq);
      else if(p.zcode_type==="rpc-frame") {
        const frame=parse(p);const reader=new BufferReader(VSBuffer.wrap(Buffer.from(frame.dataBase64,"base64")));
        const header=deserialize(reader),body=deserialize(reader);
        this.calls.push({header,body});
        this.frame([201,header[1]],{taskId:sessionId,workspacePath,title:"原名"});
      }
    }
  }
  close() {this.readyState=3;this.closed=true;}
}
test("有效授权探活通过并立即关闭连接",async()=>{
  const probed=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:RelaySim,timeoutMs:2000});
  assert.deepEqual(probed,{ok:true,paired:true,hostReachable:true,workspaceFound:true,sessionFound:true});
  assert.equal(RelaySim.latest.closed,true);
});
test("配对等待立即返回 pair_waiting，不等待整个超时",async()=>{
  const started=Date.now();
  const probed=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({authPairStatus:"waiting"});}},timeoutMs:5000});
  assert.deepEqual(probed,{ok:false,stage:"pair",reasonCode:"pair_waiting",paired:false,message:"移动端尚未完成配对"});
  assert.ok(Date.now()-started<2000);
});
test("AUTH_FAILED 映射为授权层错误",async()=>{
  const probed=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({authError:"AUTH_FAILED"});}},timeoutMs:2000});
  assert.deepEqual(probed,{ok:false,stage:"auth",reasonCode:"auth_failed",paired:false,message:"远控鉴权/连接错误：AUTH_FAILED"});
});
test("DEVICE_OFFLINE 与 KICKED 映射为配对层错误",async()=>{
  const offline=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({authError:"DEVICE_OFFLINE"});}},timeoutMs:2000});
  assert.deepEqual(offline,{ok:false,stage:"pair",reasonCode:"device_offline",paired:false,message:"远控鉴权/连接错误：DEVICE_OFFLINE"});
  const kicked=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({authError:"KICKED"});}},timeoutMs:2000});
  assert.deepEqual(kicked,{ok:false,stage:"pair",reasonCode:"kicked",paired:false,message:"远控鉴权/连接错误：KICKED"});
});
test("网络无响应在短超时内返回 network_timeout",async()=>{
  const probed=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({neverOpen:true});}},timeoutMs:150});
  assert.deepEqual(probed,{ok:false,stage:"network",reasonCode:"network_timeout",paired:false,message:"远控执行超时"});
});
test("bootstrap 失败映射为原 Host 层错误",async()=>{
  const probed=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({bootstrapSuccess:false});}},timeoutMs:2000});
  assert.deepEqual(probed,{ok:false,stage:"host",reasonCode:"host_unreachable",paired:true,hostReachable:false,message:"原窗口 bootstrap 失败"});
});
test("目标工作区缺失映射为 workspace_missing",async()=>{
  const probed=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({workspaces:[]});}},timeoutMs:2000});
  assert.deepEqual(probed,{ok:false,stage:"workspace",reasonCode:"workspace_missing",paired:true,hostReachable:true,workspaceFound:false});
});
test("目标会话缺失映射为 session_missing",async()=>{
  const probed=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({tasks:[]});}},timeoutMs:2000});
  assert.deepEqual(probed,{ok:false,stage:"session",reasonCode:"session_missing",paired:true,hostReachable:true,workspaceFound:true,sessionFound:false});
});
test("无效授权链接映射为配置层错误且不建立连接",async()=>{
  const probed=await probeRemote({authorizationUrl:"https://example.com/remote?sid=x",workspacePath,sessionId,WebSocketImpl:RelaySim,timeoutMs:2000});
  assert.deepEqual(probed,{ok:false,stage:"config",reasonCode:"invalid_url",paired:false,message:"需要官方远控授权链接"});
});
test("认证前被服务端断开归类为链接失效而非网络错误",async()=>{
  const probed=await probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{
    constructor(){super({});}
    send(raw){
      const m=JSON.parse(raw);
      if(m.type==="auth_response"){queueMicrotask(()=>this.emit("close",{code:1006}));return;}
      super.send(raw);
    }
  },timeoutMs:2000});
  assert.deepEqual(probed,{ok:false,stage:"auth",reasonCode:"auth_link_rejected",paired:false,message:"远控链接被服务端拒绝（很可能已失效，请重新获取）"});
});
test('工作区与会话路径匹配不分正反斜杠与大小写',async()=>{
  const probed=await probeRemote({authorizationUrl,workspacePath:'d:/fixture',sessionId,WebSocketImpl:RelaySim,timeoutMs:2000});
  assert.deepEqual(probed,{ok:true,paired:true,hostReachable:true,workspaceFound:true,sessionFound:true});
});
test("探活失败结果不回显授权凭据",async()=>{
  const failures=await Promise.all([
    probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({authError:"AUTH_FAILED"});}},timeoutMs:2000}),
    probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({authPairStatus:"waiting"});}},timeoutMs:2000}),
    probeRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({tasks:[]});}},timeoutMs:2000})
  ]);
  const dumped=JSON.stringify(failures);
  for(const secret of ["fixture-sid","fixture-key","fixture-mid","authorizationUrl","proof"])
    assert.ok(!dumped.includes(secret),`探活结果不应包含 ${secret}`);
});
test("已连接探活等待本次查询之后的新 ACK",async()=>{
  const remote=await connectRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({pairAck:"matched"});}},timeoutMs:2000});
  try {
    const probed=await remote.probe({ackTimeoutMs:1000});
    assert.deepEqual(probed,{ok:true,stage:"pair",reasonCode:"matched",paired:true});
    assert.ok(RelaySim.latest.pairQueries.length>=1,"探活应主动发送 pair_status_query");
  } finally {remote.close();}
});
test("已连接探活 ACK 超时返回 pair_ack_timeout",async()=>{
  const remote=await connectRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({pairAck:null});}},timeoutMs:2000});
  try {
    const probed=await remote.probe({ackTimeoutMs:80});
    assert.deepEqual(probed,{ok:false,stage:"pair",reasonCode:"pair_ack_timeout",paired:false,message:"配对状态确认超时"});
  } finally {remote.close();}
});
test("已连接探活收到 waiting 返回 pair_waiting",async()=>{
  const remote=await connectRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:class extends RelaySim{constructor(){super({pairAck:"waiting"});}},timeoutMs:2000});
  try {
    const probed=await remote.probe({ackTimeoutMs:1000});
    assert.deepEqual(probed,{ok:false,stage:"pair",reasonCode:"pair_waiting",paired:false,message:"移动端尚未完成配对"});
  } finally {remote.close();}
});
test("关闭后的连接探活返回 connection_closed",async()=>{
  const remote=await connectRemote({authorizationUrl,workspacePath,sessionId,WebSocketImpl:RelaySim,timeoutMs:2000});
  remote.close();
  const probed=await remote.probe({ackTimeoutMs:1000});
  assert.deepEqual(probed,{ok:false,stage:"pair",reasonCode:"connection_closed",paired:false,message:"远控连接已关闭"});
});

import test from "node:test";
import assert from "node:assert/strict";
import {createBackend} from "../backend.mjs";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
for (const sessionId of ['sess_fixture', 'session_316_fixture']) test(`命名后端兼容 ${sessionId.split('_')[0]} 前缀，读双库、辅助生成和原 Host 改名核验`,async()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-backend-")),sessionDb=join(root,"session.sqlite"),indexDb=join(root,"index.sqlite");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3",workspacePath="D:\\fixture";
  execFileSync(sqliteBin,[sessionDb,[
    "CREATE TABLE session(id,title,directory,path,revert,title_source);",
    "CREATE TABLE message(id,session_id,time_created,time_updated,data,sequence);",
    "CREATE TABLE part(id,message_id,session_id,time_created,time_updated,data,sequence);",
    "INSERT INTO session VALUES('sess_fixture','原名','D:\\fixture',NULL,NULL,'custom');",
    "INSERT INTO message VALUES('u1','sess_fixture',1,1,'"+JSON.stringify({role:"user"})+"',1);",
    "INSERT INTO part VALUES('p1','u1','sess_fixture',1,1,'"+JSON.stringify({type:"text",text:"改进编辑体验"})+"',1);"
  ].join("\n").replaceAll('sess_fixture',sessionId)]);
  execFileSync(sqliteBin,[indexDb,"CREATE TABLE tasks(task_id,workspace_path,title,archived,deleted,task_status);INSERT INTO tasks VALUES('sess_fixture','D:\\fixture','原名',0,0,'completed');".replaceAll('sess_fixture',sessionId)]);
  execFileSync(sqliteBin,[indexDb,"ALTER TABLE tasks ADD COLUMN project_id; ALTER TABLE tasks ADD COLUMN execution_directories; UPDATE tasks SET project_id='project_fixture',execution_directories='[\"D:/other\"]';"]);
  const selection={providerId:"fixture-provider",modelId:"fixture-model",options:{reasoningLevel:"low"}},calls=[];
  const remote={
    call:async(channel,method,args)=>{
      calls.push({channel,method,args});
      if(method==="getView")return{providers:[{providerId:"fixture-provider",models:[{modelId:"fixture-model",config:{optionSpecs:{reasoningLevel:{values:["low"]}}}}]}]};
      if(method==="getTaskMeta")return{taskId:sessionId,workspacePath,title:execFileSync(sqliteBin,["-readonly",indexDb,"SELECT title FROM tasks;"],{encoding:"utf8"}).trim()};
      if(method==="generateWorkspaceText")return{text:"{}",finishReason:"stop"};
      if(method==="renameTask") {
        execFileSync(sqliteBin,[sessionDb,"UPDATE session SET title='新名称';"]);
        execFileSync(sqliteBin,[indexDb,"UPDATE tasks SET title='新名称';"]);
        return{title:"新名称"};
      }
      throw Error("unexpected fixture method");
    },close:()=>{}
  };
  try {
    const backend=createBackend({event:{session_id:sessionId,cwd:"D:/other"},config:{sessionDb,indexDb,sqliteBin},connect:async args=>{
      assert.equal(args.workspacePath,workspacePath,"浏览附加目录不改变会话的远控附着目录");return remote;
    },saveState:async()=>{},prompt:"命名规则"});
    const before=await backend.read();
    assert.equal(before.turnCount,1);assert.equal(before.archived,false);
    await backend.generate(before.context,selection);
    const gen=calls.find(c=>c.method==="generateWorkspaceText");
    assert.deepEqual(gen.args[0].selection,selection);
    assert.equal(gen.args[0].querySource,"session_title_external");
    assert.deepEqual(gen.args[0].tools,[]);
    assert.equal(gen.args[0].messages[0].role,"system");
    assert.equal(calls.some(c=>["setModel","sendText","sendSession"].includes(c.method)),false);
    await backend.rename("新名称");
    assert.equal(calls.find(c=>c.method==="renameTask").args[0].workspacePath,workspacePath);
    assert.equal((await backend.read()).title,"新名称");
    await assert.rejects(backend.generate(before.context,{...selection,options:{reasoningLevel:"invalid"}}),/档位/);
    backend.close();
  } finally {rmSync(root,{recursive:true});}
});

test("索引标题分裂时按会话内 CronCreate 冻结证据放行，无证据则维持 mismatch 失败",async()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-backend3-")),sessionDb=join(root,"session.sqlite"),indexDb=join(root,"index.sqlite");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3",frozenTitle="PR 轮询任务标题（每5分钟）";
  const cronCall=JSON.stringify({type:"tool",callID:"call_fixture",tool:"CronCreate",state:{status:"completed",input:{cron:"*/5 * * * *",title:frozenTitle,prompt:"轮询"}}});
  const cronUpdate=JSON.stringify({type:"tool",callID:"call_fixture2",tool:"CronUpdate",state:{status:"completed",input:{id:"automation-fixture",title:"更新后的任务标题"}}});
  execFileSync(sqliteBin,[sessionDb,[
    "CREATE TABLE session(id,title,directory,path,revert,title_source);",
    "CREATE TABLE message(id,session_id,time_created,time_updated,data,sequence);",
    "CREATE TABLE part(id,message_id,session_id,time_created,time_updated,data,sequence);",
    "INSERT INTO session VALUES('sess_frozen','"+frozenTitle+"','D:\\belongs\\frozen',NULL,NULL,'custom');",
    "INSERT INTO message VALUES('u1','sess_frozen',1,1,'"+JSON.stringify({role:"user"})+"',1);",
    "INSERT INTO part VALUES('p1','u1','sess_frozen',1,1,'"+cronCall+"',1);",
    "INSERT INTO part VALUES('p2','u1','sess_frozen',1,1,'"+cronUpdate+"',2);",
    "INSERT INTO part VALUES('p3','u1','sess_frozen',1,1,'"+JSON.stringify({type:"text",text:"改进编辑体验"})+"',3);",
    "INSERT INTO session VALUES('sess_plain','他方改写','D:\\\\belongs\\\\plain',NULL,NULL,'custom');",
    "INSERT INTO message VALUES('u2','sess_plain',1,1,'"+JSON.stringify({role:"user"})+"',1);",
    "INSERT INTO part VALUES('p4','u2','sess_plain',1,1,'"+JSON.stringify({type:"text",text:"普通会话内容"})+"',1);",
    // 失败的 CronCreate 不构成冻结证据（宿主只在创建成功后冻结）
    "INSERT INTO part VALUES('p5','u2','sess_plain',1,1,'"+JSON.stringify({type:"tool",callID:"call_failed",tool:"CronCreate",state:{status:"failed",input:{cron:"*/5 * * * *",title:"他方改写",prompt:"x"}}})+"',2);",
    "INSERT INTO session VALUES('sess_noindex','"+frozenTitle+"','D:\\\\belongs\\\\noindex',NULL,NULL,'custom');",
    "INSERT INTO message VALUES('u3','sess_noindex',1,1,'"+JSON.stringify({role:"user"})+"',1);",
    "INSERT INTO part VALUES('p6','u3','sess_noindex',1,1,'"+cronCall+"',1);",
    "INSERT INTO part VALUES('p7','u3','sess_noindex',1,1,'"+JSON.stringify({type:"text",text:"索引行缺失的冻结会话"})+"',2);",
    // 双库一致 + custom：改名通道产物，不是冻结分裂，不得加载证据（否则用户手动改回历史 cron 标题时锁被误豁免）
    "INSERT INTO session VALUES('sess_synced','"+frozenTitle+"','D:\\\\belongs\\\\synced',NULL,NULL,'custom');",
    "INSERT INTO message VALUES('u4','sess_synced',1,1,'"+JSON.stringify({role:"user"})+"',1);",
    "INSERT INTO part VALUES('p8','u4','sess_synced',1,1,'"+cronCall+"',1);",
    "INSERT INTO part VALUES('p9','u4','sess_synced',1,1,'"+JSON.stringify({type:"text",text:"双库一致的改名会话"})+"',2);"
  ].join("\n")]);
  execFileSync(sqliteBin,[indexDb,["CREATE TABLE tasks(task_id,workspace_path,title,archived,deleted,task_status);",
    "INSERT INTO tasks VALUES('sess_frozen','D:\\\\belongs\\\\frozen','🧩 旧标题｜索引残留',0,0,'completed');",
    "INSERT INTO tasks VALUES('sess_plain','D:\\\\belongs\\\\plain','🧩 旧标题｜索引残留',0,0,'completed');"].join("\n")]);
  const config={sessionDb,indexDb,sqliteBin};
  const selection={providerId:"fixture-provider",modelId:"fixture-model",options:{reasoningLevel:"low"}};
  try {
    const frozen=createBackend({event:{session_id:"sess_frozen",cwd:"D:\\anywhere"},config,connect:async()=>({
      call:async(channel,method)=>{
        if(method==="getView")return{providers:[{providerId:"fixture-provider",models:[{modelId:"fixture-model",config:{optionSpecs:{reasoningLevel:{values:["low"]}}}}]}]};
        // 宿主任务元仍挂索引旧标题：freeze 路径不更新索引/overlay，分裂是预期状态
        if(method==="getTaskMeta")return{taskId:"sess_frozen",workspacePath:"D:\\belongs\\frozen",title:"🧩 旧标题｜索引残留"};
        if(method==="generateWorkspaceText")return{text:"{}",finishReason:"stop"};
        throw Error("unexpected fixture method");
      },close:()=>{}
    }),saveState:async()=>{},prompt:"规则"});
    const snap=await frozen.read();
    assert.equal(snap.title,frozenTitle,"冻结证据命中时以会话库标题为准放行");
    assert.deepEqual(snap.freezeTitles,[frozenTitle],"只取 CronCreate 的 input.title，不含 CronUpdate");
    assert.equal(snap.turnCount,1);
    await frozen.generate(snap.context,selection);
    // apply 流程里 generate 之后还会复读：remote 已挂载，host 校验必须同样容忍冻结分裂
    const fresh=await frozen.read();
    assert.equal(fresh.title,frozenTitle);
    frozen.close();
    const plain=createBackend({event:{session_id:"sess_plain",cwd:"D:\\anywhere"},config,connect:async()=>{throw Error("read 不应连远控");},saveState:async()=>{},prompt:"规则"});
    await assert.rejects(plain.read(),/任务索引与 CLI 会话标题不一致/);
    // 索引行缺失 + custom：锁豁免用途的证据仍需加载，否则冻结被误判手动改名而永久锁死
    const noindex=createBackend({event:{session_id:"sess_noindex",cwd:"D:\\anywhere"},config,connect:async()=>{throw Error("read 不应连远控");},saveState:async()=>{},prompt:"规则"});
    const nosnap=await noindex.read();
    assert.equal(nosnap.title,frozenTitle);
    assert.deepEqual(nosnap.freezeTitles,[frozenTitle],"custom 标题必须加载冻结证据，与索引是否分裂无关");
    // 双库一致的 custom：手动改名通道产物，证据集合必须为空以保留手动锁语义
    execFileSync(sqliteBin,[indexDb,"INSERT INTO tasks VALUES('sess_synced','D:\\\\belongs\\\\synced','"+frozenTitle+"',0,0,'completed');"]);
    const synced=createBackend({event:{session_id:"sess_synced",cwd:"D:\\anywhere"},config,connect:async()=>{throw Error("read 不应连远控");},saveState:async()=>{},prompt:"规则"});
    const syncsnap=await synced.read();
    assert.deepEqual(syncsnap.freezeTitles,[],"一致双库不加载冻结证据，防止历史 cron 标题旁路手动锁");
    // 双库一致的冻结由锁定前二次查证兜底：现查会话历史 CronCreate 记录，不依赖分裂信号（#125）
    assert.equal(await synced.confirmFreezeTitle(frozenTitle),true,"锁定前二次查证可命中双库一致的冻结");
    assert.equal(await synced.confirmFreezeTitle("用户手改的标题"),false,"二次查证不命中的标题不豁免");
  } finally {rmSync(root,{recursive:true});}
});

test("payload cwd 与会话归属不一致时以 session.directory 为准；索引缺行也能读取并透传 titleSource",async()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-backend2-")),sessionDb=join(root,"session.sqlite"),indexDb=join(root,"index.sqlite");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3";
  execFileSync(sqliteBin,[sessionDb,[
    "CREATE TABLE session(id,title,directory,path,revert,title_source);",
    "CREATE TABLE message(id,session_id,time_created,time_updated,data,sequence);",
    "CREATE TABLE part(id,message_id,session_id,time_created,time_updated,data,sequence);",
    "INSERT INTO session VALUES('sess_moved','宿主新标题','D:\\\\belongs\\\\here',NULL,NULL,'generated');",
    "INSERT INTO message VALUES('u1','sess_moved',1,1,'"+JSON.stringify({role:"user"})+"',1);",
    "INSERT INTO part VALUES('p1','u1','sess_moved',1,1,'"+JSON.stringify({type:"text",text:"更新仓库标签"})+"',1);",
    "INSERT INTO session VALUES('sess_fresh','原名','D:\\\\belongs\\\\fresh',NULL,NULL,'custom');",
    "INSERT INTO message VALUES('u2','sess_fresh',1,1,'"+JSON.stringify({role:"user"})+"',1);",
    "INSERT INTO part VALUES('p2','u2','sess_fresh',1,1,'"+JSON.stringify({type:"text",text:"首轮内容"})+"',1);"
  ].join("\n")]);
  execFileSync(sqliteBin,[indexDb,"CREATE TABLE tasks(task_id,workspace_path,title,archived,deleted,task_status);INSERT INTO tasks VALUES('sess_moved','D:\\\\CODE\\\\Project','宿主新标题',0,0,'completed');"]);
  try {
    // 窗口 cwd 与会话归属（索引行也写着别的）都不一致：以 session.directory 为准
    const backend=createBackend({event:{session_id:"sess_moved",cwd:"D:\\\\CODE\\\\Project\\\\_CLITools\\\\ripwire"},config:{sessionDb,indexDb,sqliteBin},authorizationUrl:"fixture",connect:async()=>{throw Error("read 不应连远控");},saveState:async()=>{},prompt:"规则"});
    const snap=await backend.read();
    assert.equal(snap.title,"宿主新标题");
    assert.equal(snap.titleSource,"generated");
    assert.equal(snap.context.project_hint,"here","远控与历史都应以归属工作区为准");
    // 新会话首轮：索引还没写入行，session.directory 已可查——不再因索引缺行失败
    const fresh=createBackend({event:{session_id:"sess_fresh",cwd:"D:\\\\anywhere"},config:{sessionDb,indexDb,sqliteBin},authorizationUrl:"fixture",connect:async()=>{throw Error("read 不应连远控");},saveState:async()=>{},prompt:"规则"});
    const snap2=await fresh.read();
    assert.equal(snap2.title,"原名");assert.equal(snap2.archived,false);assert.equal(snap2.turnCount,1);
  } finally {rmSync(root,{recursive:true});}
});

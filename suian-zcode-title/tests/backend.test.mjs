import test from "node:test";
import assert from "node:assert/strict";
import {createBackend} from "../backend.mjs";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
test("后端读取双库状态，指定模型辅助生成，原 Host 改名后校验读回",async()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-backend-")),sessionDb=join(root,"session.sqlite"),indexDb=join(root,"index.sqlite");
  const sqliteBin=process.env.SQLITE_BIN||"sqlite3",workspacePath="D:\\fixture",sessionId="sess_fixture";
  execFileSync(sqliteBin,[sessionDb,[
    "CREATE TABLE session(id,title,directory,path,revert,title_source);",
    "CREATE TABLE message(id,session_id,time_created,time_updated,data,sequence);",
    "CREATE TABLE part(id,message_id,session_id,time_created,time_updated,data,sequence);",
    "INSERT INTO session VALUES('sess_fixture','原名','D:\\fixture',NULL,NULL,'custom');",
    "INSERT INTO message VALUES('u1','sess_fixture',1,1,'"+JSON.stringify({role:"user"})+"',1);",
    "INSERT INTO part VALUES('p1','u1','sess_fixture',1,1,'"+JSON.stringify({type:"text",text:"改进编辑体验"})+"',1);"
  ].join("\n")]);
  execFileSync(sqliteBin,[indexDb,"CREATE TABLE tasks(task_id,workspace_path,title,archived,deleted,task_status);INSERT INTO tasks VALUES('sess_fixture','D:\\fixture','原名',0,0,'completed');"]);
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
    const backend=createBackend({event:{session_id:sessionId,workspace_path:workspacePath},config:{sessionDb,indexDb,sqliteBin},authorizationUrl:"fixture",connect:async()=>remote,saveState:async()=>{},prompt:"命名规则"});
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
    assert.equal((await backend.read()).title,"新名称");
    await assert.rejects(backend.generate(before.context,{...selection,options:{reasoningLevel:"invalid"}}),/档位/);
    backend.close();
  } finally {rmSync(root,{recursive:true});}
});


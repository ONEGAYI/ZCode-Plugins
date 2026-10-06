import test from "node:test";
import assert from "node:assert/strict";
import {recentSnapshot,readHistory} from "../history.mjs";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const m=(id,role,text,parentID,extra={})=>({info:{id,role,parentID,...extra},parts:[{type:"text",text},{type:"reasoning",text:"不交给命名模型"}]});
test("按真实用户输入合并多条助手，取三轮并排除内部提醒与旧回退分支",()=>{
  const messages=[m("u0","user","最早需求"),m("a0","assistant","最早回答","u0"),m("u1","user","第一轮"),m("a1","assistant","回复一","u1"),m("a2","assistant","回复二","u1"),m("bad","user","已回退内容"),m("aBad","assistant","旧分支","bad"),m("notice","user","Conversation rewind applied.",null,{synthetic:true,source:"rewind"}),m("u2","user","第二轮"),m("sys","user","内部提醒",null,{semantics:{origin:"agent_runtime",uiVisibility:"hidden"}}),m("a3","assistant","第二轮回答","u2"),m("u3","user","第三轮"),m("a4","assistant","第三轮回答","u3")];
  const session={title:"原名",revert:{targetMessageID:"bad",createdMessageID:"notice",keptMessageIDs:["u0","a0","u1","a1","a2"]}};
  const snap=recentSnapshot({session,messages},"D:\\测试工程");
  assert.deepEqual(snap.context.recent_turns.map(t=>({id:t.id,messages:t.messages})),[
    {id:"u1",messages:[{role:"user",text:"第一轮"},{role:"assistant",text:"回复一\n回复二"}]},
    {id:"u2",messages:[{role:"user",text:"第二轮"},{role:"assistant",text:"第二轮回答"}]},
    {id:"u3",messages:[{role:"user",text:"第三轮"},{role:"assistant",text:"第三轮回答"}]}
  ]);
  assert.equal(snap.context.original_goal,"最早需求");
  assert.ok(!JSON.stringify(snap.context).includes("不交给命名模型"));
  const changed=recentSnapshot({session,messages:[...messages,m("u4","user","后续输入")]},"D:\\测试工程");
  assert.notEqual(changed.fingerprint,snap.fingerprint);
});
test("SQLite 只读读取按 sequence 重建文本分片，工作区不匹配时拒绝",async()=>{
  const root=mkdtempSync(join(tmpdir(),"z-title-fixture-")),db=join(root,"fixture.sqlite"),sqliteBin=process.env.SQLITE_BIN||"sqlite3";
  try {
    const sql=[
      "CREATE TABLE session(id,title,directory,path,revert,title_source);",
      "CREATE TABLE message(id,session_id,time_created,time_updated,data,sequence);",
      "CREATE TABLE part(id,message_id,session_id,time_created,time_updated,data,sequence);",
      "INSERT INTO session VALUES('sess_fixture','原名','D:\\fixture',NULL,NULL,'custom');",
      "INSERT INTO message VALUES('u1','sess_fixture',1,1,'"+JSON.stringify({role:"user"})+"',1);",
      "INSERT INTO part VALUES('p2','u1','sess_fixture',1,1,'"+JSON.stringify({type:"text",text:"第二段"})+"',2);",
      "INSERT INTO part VALUES('p1','u1','sess_fixture',2,2,'"+JSON.stringify({type:"text",text:"第一段"})+"',1);"
    ].join("\n");
    execFileSync(sqliteBin,[db,sql]);
    const result=await readHistory({dbPath:db,sqliteBin,sessionId:"sess_fixture",workspacePath:"D:\\fixture"});
    assert.equal(result.messages[0].info.id,"u1");
    assert.deepEqual(result.messages[0].parts.map(p=>p.text),["第一段","第二段"]);
    await assert.rejects(readHistory({dbPath:db,sqliteBin,sessionId:"sess_fixture",workspacePath:"D:\\other"}),/工作区/);
    assert.equal(execFileSync(sqliteBin,["-readonly",db,"SELECT count(*) FROM part;"],{encoding:"utf8"}).trim(),"2");
  } finally {rmSync(root,{recursive:true});}
});


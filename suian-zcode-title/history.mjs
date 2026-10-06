import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {win32} from "node:path";
import {createHash} from "node:crypto";
import {getConversationMessageProjectionPolicy} from "./vendor/projection.js";

export async function readHistory({dbPath,sessionId,workspacePath,sqliteBin="sqlite3"}) {
  if(!/^sess_[A-Za-z0-9_-]+$/.test(sessionId))throw new Error("无效会话 ID");
  const quoted="'"+sessionId+"'";
  const sql=[
    "PRAGMA query_only=ON; BEGIN;",
    "SELECT 'session' kind,id,'' message_id,0 missing_seq,0 sequence,0 time_created,id sort_key,json_object('id',id,'title',title,'directory',coalesce(path,directory),'revert',json(revert),'titleSource',title_source) data FROM session WHERE id="+quoted,
    "UNION ALL SELECT 'message',id,'',sequence IS NULL,sequence,time_created,rowid,json_remove(data,'$.contextSnapshot') FROM message WHERE session_id="+quoted,
    "UNION ALL SELECT 'part',id,message_id,sequence IS NULL,sequence,time_created,id,CASE WHEN json_extract(data,'$.type')='text' THEN data ELSE json_object('type',json_extract(data,'$.type'),'synthetic',json_extract(data,'$.synthetic'),'metadata',json_extract(data,'$.metadata')) END FROM part WHERE session_id="+quoted,
    "ORDER BY kind,message_id,missing_seq,sequence,time_created,sort_key; COMMIT;"
  ].join("\n");
  const {stdout}=await promisify(execFile)(sqliteBin,["-readonly","-json",dbPath,sql],{encoding:"utf8",windowsHide:true,maxBuffer:32*1024*1024});
  const rows=JSON.parse(stdout),sessionRow=rows.find(r=>r.kind==="session");
  if(!sessionRow)throw new Error("会话不在指定 SQLite 库中");
  const session=JSON.parse(sessionRow.data);
  if(win32.normalize(session.directory).toLowerCase()!==win32.normalize(workspacePath).toLowerCase())throw new Error("会话数据库的工作区不匹配");
  const parts=new Map();
  for(const row of rows.filter(r=>r.kind==="part")) {
    const list=parts.get(row.message_id)??[];
    list.push({...JSON.parse(row.data),id:row.id,sessionID:sessionId,messageID:row.message_id});
    parts.set(row.message_id,list);
  }
  return {session,messages:rows.filter(r=>r.kind==="message").map(r=>({
    info:{...JSON.parse(r.data),id:r.id,sessionID:sessionId},
    parts:parts.get(r.id)??[]
  }))};
}

export function recentSnapshot({session,messages},workspacePath) {
  let active=messages;
  const revert=session.revert;
  if(revert?.targetMessageID) {
    const ids=new Map(messages.map(m=>[m.info.id,m]));
    const targetIndex=messages.findIndex(m=>m.info.id===revert.targetMessageID);
    if(!revert.keptMessageIDs&&targetIndex<0)throw new Error("回退目标不在持久化历史中");
    const kept=revert.keptMessageIDs?revert.keptMessageIDs.map(id=>ids.get(id)).filter(Boolean):messages.slice(0,targetIndex);
    const createdIndex=messages.findIndex(m=>m.info.id===revert.createdMessageID);
    active=createdIndex>=0?[...kept,...messages.slice(createdIndex)]:kept;
  }
  const users=[],byUser=new Map();
  for(const message of active) {
    const policy=getConversationMessageProjectionPolicy(message);
    const text=message.parts.filter(p=>p.type==="text"&&!p.ignored&&!p.synthetic).map(p=>p.text).join("").trim();
    if(message.info.role==="user"&&policy==="realUserInput") {
      const turn={id:message.info.id,user:text,assistant:[]};users.push(turn);byUser.set(turn.id,turn);
    } else if(message.info.role==="assistant"&&policy==="visibleAssistant"&&text) {
      const parent=message.info.parentID;
      if(parent===revert?.createdMessageID&&text.endsWith("Rewound conversation to before message "+revert.targetMessageID+"."))continue;
      const turn=byUser.get(parent);
      if(turn)turn.assistant.push(text);
    }
  }
  const effective=users.filter(t=>t.user),selected=effective.slice(-3);
  const recent=selected.map(t=>({id:t.id,messages:[
    {role:"user",text:t.user.slice(0,1200)},
    ...t.assistant.length?[{role:"assistant",text:t.assistant.join("\n").slice(0,1500)}]:[]
  ]}));
  const signature={policy:1,activeIds:active.map(m=>m.info.id),originalGoal:effective[0]?.user??"",recent:selected};
  return {
    title:session.title,
    fingerprint:createHash("sha256").update(JSON.stringify(signature)).digest("hex"),
    latestUserId:effective.at(-1)?.id,
    turnCount:effective.length,
    context:{current_title:session.title,project_hint:win32.basename(workspacePath),original_goal:effective[0]?.user.slice(0,800)??"",recent_turns:recent}
  };
}



const emoji=["🎬","🧩","🧪","📋","🔎","📝","📅","🎨","⚙️","💬"];
function candidateFrom(result,currentTitle) {
  if(result.finishReason!=="stop")throw new Error("模型结束原因不是正常完成");
  if(result.toolCalls?.length)throw new Error("命名模型返回了工具调用");
  const value=JSON.parse(result.text);
  if(Object.keys(value).sort().join(",")!=="action,reason,title"||!["keep","rename"].includes(value.action)||typeof value.title!=="string"||typeof value.reason!=="string")throw new Error("命名输出字段无效");
  if(value.action==="keep")return{...value,title:currentTitle};
  const title=value.title,count=[...title].length,prefix=emoji.find(e=>title.startsWith(e+" "));
  if(!prefix||title!==title.trim()||count<4||count>48)throw new Error("标题长度或类别格式无效");
  const body=title.slice(prefix.length+1),pieces=body.split("｜");
  if(pieces.length!==2||pieces.some(p=>!p||p!==p.trim()))throw new Error("标题必须采用对象｜目标结构");
  if(/[\p{Cc}\p{Cf}\u0060|@]|\p{Extended_Pictographic}/u.test(body)||/[A-Za-z]:[\\/]|\\\\|https?:\/\/|\/Users\/|sk-/i.test(title))throw new Error("标题包含不允许的格式或私人信息");
  return value;
}

export async function runNaming({backend,selection,state={},apply=false,eventUserId}) {
  const before=await backend.read();
  if(before.archived||before.deleted)return{status:"archived",title:before.title};
  if(before.running)return{status:"running",title:before.title};
  if(!before.turnCount)return{status:"empty",title:before.title};
  if(eventUserId&&eventUserId!==before.latestUserId)return{status:"outdated_event",title:before.title};
  state={...state};
  if(state.pendingTitle===before.title) {
    state.lastTitle=before.title;state.lastFingerprint=state.pendingFingerprint;
    delete state.pendingTitle;delete state.pendingFingerprint;
    if(apply)await backend.saveState(state);
  }
  if(state.locked)return{status:"locked",title:before.title};
  // 标题变化且非宿主自动生成（generated）才视为用户手动改名并锁定；
  // 宿主自带的首轮/后续自动命名与我们存在竞争，视为待覆盖的旧标题
  if(state.lastFingerprint&&state.lastTitle!==before.title&&before.titleSource!=="generated") {
    if(apply)await backend.saveState({...state,locked:true,lastTitle:before.title});
    return{status:"manual_title",title:before.title};
  }
  if(state.lastFingerprint===before.fingerprint&&state.lastTitle===before.title)return{status:"unchanged",title:before.title};
  const generated=await backend.generate(before.context,selection);
  const candidate=candidateFrom(generated,before.title);
  const result={status:"preview",action:candidate.action,title:candidate.title,usage:generated.usage,selectedTurns:before.context.recent_turns.length};
  if(!apply)return result;
  const fresh=await backend.read();
  if(fresh.archived||fresh.deleted)return{status:"archived",title:fresh.title,usage:generated.usage};
  const staleReason=fresh.running?"running":fresh.fingerprint!==before.fingerprint?"fingerprint":fresh.title!==before.title?"title":null;
  if(staleReason)return{status:"stale_result",staleReason,title:fresh.title,usage:generated.usage};
  if(candidate.action==="rename"&&candidate.title!==before.title) {
    await backend.saveState({...state,pendingTitle:candidate.title,pendingFingerprint:before.fingerprint});
    await backend.rename(candidate.title);
    const verified=await backend.read();
    if(verified.title!==candidate.title)throw new Error("原 Host 改名后读回不一致");
    result.status="renamed";
  }else result.status="kept";
  await backend.saveState({...state,lastFingerprint:before.fingerprint,lastTitle:candidate.title,lastUserId:before.latestUserId,updatedAt:new Date().toISOString()});
  return result;
}



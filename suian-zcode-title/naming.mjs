const emoji=["🎬","🧩","🧪","📋","🔎","📝","📅","🎨","⚙️","💬"];
function titleFormatError(title) {
  const count=[...title].length,prefix=emoji.find(e=>title.startsWith(e+" "));
  if(!prefix||title!==title.trim()||count<4||count>48)return "标题长度或类别格式无效";
  const body=title.slice(prefix.length+1),pieces=body.split("｜");
  if(pieces.length!==2||pieces.some(p=>!p||p!==p.trim()))return "标题必须采用对象｜目标格式";
  if(/[\p{Cc}\p{Cf}\u0060|@]|\p{Extended_Pictographic}/u.test(body)||/[A-Za-z]:[\\/]|\\\\|https?:\/\/|\/Users\/|sk-/i.test(title))return "标题包含不允许的格式或私人信息";
  return null;
}
function candidateFrom(result,currentTitle,requireFormat=false) {
  if(result.finishReason!=="stop")throw new Error("模型结束原因不是正常完成");
  if(result.toolCalls?.length)throw new Error("命名模型返回了工具调用");
  const value=JSON.parse(result.text);
  if(Object.keys(value).sort().join(",")!=="action,reason,title"||!["keep","rename"].includes(value.action)||typeof value.title!=="string"||typeof value.reason!=="string")throw new Error("命名输出字段无效");
  if(/https?:\/\/|\b(?:device_)?(?:sid|hash|mid)["']?\s*[=:]|\bsk-|[A-Za-z]:[\\/]|\\\\|\/Users\//i.test(value.reason))throw new Error("命名理由包含不允许的链接、凭据或私人路径");
  if(value.action==="keep"&&!requireFormat)return{...value,title:currentTitle};
  const title=value.action==="keep"?currentTitle:value.title;
  const invalid=titleFormatError(title);
  if(invalid)throw Object.assign(new Error(invalid),{code:value.action==="keep"?"invalid_keep_title":"invalid_title"});
  return {...value,title};
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
  if(before.titlePolicy?.locked)return{status:"locked",title:before.title};
  if(before.titlePolicy)delete state.locked;
  if(state.locked)return{status:"locked",title:before.title};
  // 标题变化且非宿主自动生成（generated）才视为用户手动改名并锁定；
  // 宿主自带的首轮/后续自动命名与我们存在竞争，视为待覆盖的旧标题
  if(!before.titlePolicy&&state.lastFingerprint&&state.lastTitle!==before.title&&before.titleSource!=="generated") {
    if(apply)await backend.saveState({...state,locked:true,lastTitle:before.title});
    return{status:"manual_title",title:before.title};
  }
  const requireFormat=before.titlePolicy?.locked===false;
  if(state.lastFingerprint===before.fingerprint&&state.lastTitle===before.title&&(!requireFormat||!titleFormatError(before.title)))return{status:"unchanged",title:before.title};
  const context=requireFormat?{...before.context,title_format_required:true}:before.context;
  let generated=await backend.generate(context,selection),candidate;
  try {candidate=candidateFrom(generated,before.title,requireFormat);}
  catch(error) {
    if(error.code!=="invalid_keep_title")throw error;
    const firstUsage=generated.usage;
    generated=await backend.generate({...context,title_format_feedback:"原标题不符合规范，不能 keep；请返回 rename 与合法的类别 对象｜目标标题"},selection);
    if(firstUsage&&generated.usage)generated.usage=Object.fromEntries(Object.keys(generated.usage).map(key=>[key,(firstUsage[key]??0)+generated.usage[key]]));
    candidate=candidateFrom(generated,before.title,true);
  }
  const result={status:"preview",action:candidate.action,title:candidate.title,reason:candidate.reason,usage:generated.usage,selectedTurns:before.context.recent_turns.length};
  if(!apply)return result;
  const fresh=await backend.read();
  if(fresh.titlePolicy?.locked)return{status:"locked",title:fresh.title,usage:generated.usage};
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



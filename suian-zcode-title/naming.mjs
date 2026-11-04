const unsafe=/https?:\/\/|\b(?:(?:device_)?(?:sid|hash|mid)|control_token|api[_-]?key|access[_-]?token)["']?\s*[=:]|\bsk-|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root)\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
function invalid(message) {return Object.assign(new Error(message),{code:"invalid_model_output"});}
function candidateFrom(result,currentTitle) {
  if(result.finishReason!=="stop")throw Object.assign(new Error("模型结束原因不是正常完成"),{stage:"model_generation",reasonCode:"naming_model_incomplete"});
  if(result.toolCalls?.length)throw Object.assign(new Error("命名模型返回了工具调用"),{stage:"model_generation",reasonCode:"naming_model_tool_call"});
  let value;
  try {value=JSON.parse(result.text);}catch {throw invalid("模型输出不是有效 JSON");}
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="action,reason,title"||!["keep","rename"].includes(value.action)||typeof value.title!=="string"||typeof value.reason!=="string")throw invalid("命名输出字段无效");
  if(unsafe.test(value.reason))throw invalid("命名理由包含不允许的链接、凭据或私人路径");
  if(!value.title.trim())throw invalid("命名标题不能为空");
  if(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value.title))throw invalid("命名标题包含控制字符");
  if(unsafe.test(value.title))throw invalid("命名标题包含不允许的链接、凭据或私人路径");
  if(value.action==="keep")return{...value,title:currentTitle};
  return value;
}

export async function runNaming({backend,selection,state={},apply=false,eventUserId,timeoutMs=120000}) {
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
    // 宿主在会话内 CronCreate 成功后会把标题冻结为任务标题（custom）；
    // 命中冻结证据（backend 从会话内 CronCreate 调用记录提取的 input.title）时接管命名，不作为用户意志锁定。
    // 一次证据按两库分裂条件加载（防历史 cron 标题旁路手动锁），宿主 3.16+ 冻结会同步任务索引、
    // 双库一致时一次证据为空，锁定前再现查一次 CronCreate 记录兜底（#125）
    if(!before.freezeTitles?.includes(before.title)&&!await backend.confirmFreezeTitle?.(before.title)) {
      if(apply)await backend.saveState({...state,locked:true,lastTitle:before.title});
      return{status:"manual_title",title:before.title};
    }
  }
  if(state.lastFingerprint===before.fingerprint&&state.lastTitle===before.title)return{status:"unchanged",title:before.title};
  const deadline=Date.now()+timeoutMs;
  const controller=new AbortController();
  let generated,candidate,feedback,usage;
  for(let attempt=0;attempt<3;attempt++) {
    const remaining=deadline-Date.now();
    if(remaining<=0)throw Object.assign(new Error("命名模型生成预算已耗尽，本轮失败"),{stage:"model_generation",reasonCode:"naming_model_timeout",usage});
    let timer;
    try {
      generated=await Promise.race([
        backend.generate(feedback?{...before.context,title_format_feedback:feedback}:before.context,selection,{timeoutMs:remaining,deadline,signal:controller.signal}),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error("命名模型生成预算已耗尽，本轮失败"),{stage:"model_generation",reasonCode:"naming_model_timeout"}));},remaining);})
      ]);
    } catch(error) {
      const safe=error instanceof Error?error:Object.assign(new Error("公共网关 RPC 调用失败"),{stage:"gateway",reasonCode:"gateway_rpc_failed"});
      if(usage)safe.usage=usage;throw safe;
    }
    finally {clearTimeout(timer);}
    if(generated.usage) {
      usage??={};
      for(const [key,value] of Object.entries(generated.usage))if(typeof value==="number")usage[key]=(usage[key]??0)+value;
    }
    try {candidate=candidateFrom(generated,before.title);break;}
    catch(error) {
      if(error.code!=="invalid_model_output") {if(usage)error.usage=usage;throw error;}
      feedback=error.message;
      if(attempt===2)throw Object.assign(error,{stage:"model_generation",reasonCode:"naming_invalid_output",usage});
    }
  }
  generated.usage=usage;
  const result={status:"preview",action:candidate.action,title:candidate.title,reason:candidate.reason,usage:generated.usage,selectedTurns:before.context.recent_turns.length};
  if(!apply)return result;
  const fresh=await backend.read();
  if(fresh.titlePolicy?.locked)return{status:"locked",title:fresh.title,usage:generated.usage};
  if(fresh.archived||fresh.deleted)return{status:"archived",title:fresh.title,usage:generated.usage};
  // 宿主自动命名只改变标题时可继续 rename；keep 仍基于原标题，不能沿用。
  const canReplaceGeneratedTitle=fresh.titleSource==="generated"&&candidate.action==="rename";
  const staleReason=fresh.running?"running":fresh.fingerprint!==before.fingerprint?"fingerprint":fresh.title!==before.title&&!canReplaceGeneratedTitle?"title":null;
  if(staleReason)return{status:"stale_result",staleReason,title:fresh.title,usage:generated.usage};
  if(candidate.action==="rename"&&candidate.title!==fresh.title) {
    await backend.saveState({...state,pendingTitle:candidate.title,pendingFingerprint:before.fingerprint});
    await backend.rename(candidate.title);
    const verified=await backend.read();
    if(verified.title!==candidate.title)throw new Error("原 Host 改名后读回不一致");
    result.status="renamed";
  }else result.status="kept";
  await backend.saveState({...state,lastFingerprint:before.fingerprint,lastTitle:candidate.title,lastUserId:before.latestUserId,updatedAt:new Date().toISOString()});
  return result;
}



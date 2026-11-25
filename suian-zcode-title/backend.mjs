import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {win32} from "node:path";
import {commonRuntime} from "./common-access.mjs";
import {readHistory,recentSnapshot} from "./history.mjs";

const SESSION_ID_RE=/^sess(?:ion)?_[A-Za-z0-9_-]+$/;
// Windows Host 回收进程树最多用 3.25 秒，给释放回执留余量，不增加模型预算。
const GENERATION_DISPOSAL_GRACE_MS=5000;

let cachedCommon;
// 只有显式 Source Server 模式使用新入口，旧 common 仍可服务桌面模式。
export const connectNamingHost=async ({transport,...options})=>{
  const common=cachedCommon??=await commonRuntime();
  if(transport!=="source-server")return common.connectHost(options);
  if(typeof common.connectSourceServer!=="function")
    throw Object.assign(new Error("当前公共插件尚不支持 Source Server；请更新 common"),{stage:"config",reasonCode:"source_server_common_upgrade_required"});
  return common.connectSourceServer(options);
};
const defaultReadTitlePolicy=async options=>((cachedCommon??=await commonRuntime()),cachedCommon.readTitlePolicy(options));

export function namingSelectionConfigured(selection) {
  return [selection?.providerId,selection?.modelId,selection?.options?.reasoningLevel].every(value=>typeof value==="string"&&value.trim());
}

export function namingModelIssue(view,selection) {
  const model=view.providers.find(p=>p.providerId===selection?.providerId)?.models.find(m=>m.modelId===selection?.modelId);
  if(!model)return "指定模型不在原 Host 的可用目录中";
  if(!model.config.optionSpecs.reasoningLevel.values.includes(selection.options?.reasoningLevel))return "指定思考档位不可用";
  return null;
}

export function sameSourceTask(left,right) {
  return left?.taskId===right?.taskId&&left?.workspacePath===right?.workspacePath&&left?.workspaceIdentity===right?.workspaceIdentity;
}

export function createBackend({event,config,saveState,prompt,connect=connectNamingHost,readTitlePolicy=defaultReadTitlePolicy}) {
  const sessionId=event.session_id;
  if(!SESSION_ID_RE.test(sessionId??""))throw new Error("输入需要有效 session_id");
  const sourceServer=config.transport==="source-server";
  let remote,closed=false,releaseGeneration;
  const disconnect=()=>{remote?.close();remote=null;};
  const timeoutError=()=>Object.assign(new Error("命名模型生成预算已耗尽，本轮失败"),{stage:"model_generation",reasonCode:"naming_model_timeout"});
  const checkGeneration=(signal,deadline)=>{if(closed||signal?.aborted||deadline!==undefined&&Date.now()>=deadline)throw timeoutError();};
  // 桌面普通会话用 CLI 目录，受管工作树和 Source Server 按任务索引路由。
  let resolvedWorkspace=null;
  const queryJson=async(db,sql)=> {
    const {stdout}=await promisify(execFile)(config.sqliteBin??"sqlite3",["-readonly","-json",db,sql],{encoding:"utf8",windowsHide:true,maxBuffer:256*1024*1024});
    return stdout.trim()?JSON.parse(stdout):[];
  };
  // 索引行每次现查：rename 前后 title 会变化，不能缓存
  const loadIndexRow=async()=> {
    try {
      const rows=await queryJson(config.indexDb,`SELECT * FROM tasks WHERE task_id='${sessionId}';`);
      if(sourceServer&&rows.length>1)
        throw Object.assign(new Error("同一会话在 Source Server 任务索引中有多个工作区身份"),{reasonCode:"source_task_ambiguous"});
      return rows[0]??null;
    }
    catch(error){if(sourceServer)throw error;return null;}
  };
  // Source Server 查任务用索引主键，兼容投影列 workspace_identity 可能为空或陈旧。
  const sourceTaskFromRow=row=>row?.workspace_path&&row.workspace_key?.startsWith("remote:")
    ?{taskId:sessionId,workspacePath:row.workspace_path,workspaceIdentity:row.workspace_key}:null;
  // 宿主在会话内 CronCreate 成功后会把会话标题冻结为任务标题（setCustomSessionTitle），
  // 该路径只写会话库不同步任务索引；冻结证据取会话历史中 CronCreate 调用记录的 input.title，
  // 只认 create 成功（宿主只在创建成功后冻结），不含 CronUpdate 的事后改名。查询失败按无证据处理，维持护栏。
  const loadFreezeTitles=async()=> {
    try {
      return (await queryJson(config.sessionDb,`SELECT DISTINCT json_extract(data,'$.state.input.title') title FROM part WHERE session_id='${sessionId}' AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='CronCreate' AND json_extract(data,'$.state.status')='completed' AND json_extract(data,'$.state.input.title') IS NOT NULL;`)).map(row=>row.title);
    }catch{return [];}
  };
  const resolveWorkspace=async row=> {
    if(resolvedWorkspace&&!sourceServer)return resolvedWorkspace;
    if(row===undefined)row=await loadIndexRow();
    let cwd;
    try {
      const rows=await queryJson(config.sessionDb,`SELECT directory FROM session WHERE id='${sessionId}';`);
      cwd=rows[0]?.directory;
    }catch(error){if(sourceServer)throw error;}
    const managed=!sourceServer&&row?.host_id==="local"&&row.worktree_root!=null;
    if(managed&&(typeof row.workspace_path!=="string"||!win32.isAbsolute(row.workspace_path)))
      throw new Error("受管工作树缺少有效的原 Host 归属目录");
    cwd ||= (managed?row.root_path:row?.workspace_path) || (event.workspace_path??event.cwd);
    if(!cwd)throw new Error("任务索引与 CLI 库中都没有目标会话，且事件未携带工作区");
    const task=sourceServer
      ?sourceTaskFromRow(row)
      :{taskId:sessionId,workspacePath:managed?row.workspace_path:cwd};
    resolvedWorkspace={cwd,task};
    return resolvedWorkspace;
  };
  const requireTask=async expected=>{
    if(!sourceServer)return (await resolveWorkspace()).task;
    const current=sourceTaskFromRow(await loadIndexRow());
    if(!expected||!sameSourceTask(expected,current))
      throw Object.assign(new Error("远端任务工作区身份已变化"),{reasonCode:"source_task_changed"});
    return expected;
  };
  const attach=async(signal,deadline)=>{
    checkGeneration(signal,deadline);
    if(!remote) {
      const route=sourceServer?{transport:"source-server"}:{
        workspacePath:(await resolveWorkspace()).task.workspacePath,sessionId,gatewayConfigPath:config.gatewayConfigPath,
      };
      checkGeneration(signal,deadline);
      const timeoutMs=config.timeoutMs??120000;
      const connection=await connect({...route,
        timeoutMs:timeoutMs+(deadline===undefined?0:GENERATION_DISPOSAL_GRACE_MS),
        handshakeTimeoutMs:config.probeTimeoutMs??Math.min(timeoutMs,8000)});
      if(closed||signal?.aborted||deadline!==undefined&&Date.now()>=deadline) {connection.close();throw timeoutError();}
      remote=connection;
    }
    return remote;
  };
  return {
    async read() {
      const row=await loadIndexRow();
      const {cwd,task}=await resolveWorkspace(row);
      // 缺索引时仍可读历史；只有桌面模式可直接用 CLI 目录定位任务。
      const history=await readHistory({dbPath:config.sessionDb,sqliteBin:config.sqliteBin,sessionId,workspacePath:cwd});
      // 冻结证据承担两个用途：解释索引分裂（mismatch 护栏）与豁免命名层手动改名锁。
      // 前者只在分裂时需要；后者在索引行缺失 + custom（冻结只写 custom）时就需要。
      // 双库一致的 custom 是改名通道产物，不加载证据——否则用户手动改回历史 cron 标题会旁路手动锁。
      const freezeTitles=row&&row.title!==history.session.title||!row&&history.session.titleSource==="custom"?await loadFreezeTitles():[];
      if(row&&row.title!==history.session.title&&!freezeTitles.includes(history.session.title)){const mismatch=new Error("任务索引与 CLI 会话标题不一致");mismatch.reasonCode="index_title_mismatch";throw mismatch;}
      if(remote&&task) {
        const meta=await remote.call("zcode-task","getTaskMeta",[task]);
        // 冻结分裂下宿主任务元（索引/overlay）仍是旧标题属预期状态，与 generate 的漂移校验同口径
        if(meta?.taskId!==sessionId||meta.workspacePath!==task.workspacePath||meta.title!==history.session.title&&!freezeTitles.includes(history.session.title)){const mismatch=new Error("原 Host 与持久化标题不一致");mismatch.reasonCode="host_title_mismatch";throw mismatch;}
      }
      return{...recentSnapshot(history,cwd,config),freezeTitles,titleSource:history.session.titleSource??null,titlePolicy:await readTitlePolicy({sessionId}),archived:!!row?.archived,deleted:!!row?.deleted,running:row?.task_status==="running",
        ...(sourceServer?(task?{sourceTask:task}:{sourceTaskMissing:true}):{})};
    },
    // 存在性校验与 resolveWorkspace 的容错链不同：查询异常不吞、不兜底，避免把"查不了"静默当"不存在"
    async sessionExists() {
      const inSessionDb=(await queryJson(config.sessionDb,`SELECT id FROM session WHERE id='${sessionId}' LIMIT 1;`)).length>0;
      if(inSessionDb)return true;
      return (await queryJson(config.indexDb,`SELECT task_id FROM tasks WHERE task_id='${sessionId}' LIMIT 1;`)).length>0;
    },
    async models() {return(await attach()).call("model-selection","getView",[]);},
    async generate(context,selection,{timeoutMs=config.timeoutMs??120000,deadline=Date.now()+timeoutMs,signal,sourceTask}={}) {
      const abort=Promise.withResolvers();
      const onAbort=()=>{closed=true;if(releaseGeneration)abort.reject(timeoutError());else disconnect();};
      signal?.addEventListener("abort",onAbort,{once:true});
      try {
      const connection=await attach(signal,deadline);
      checkGeneration(signal,deadline);
      const view=await connection.call("model-selection","getView",[]);
      checkGeneration(signal,deadline);
      const issue=namingModelIssue(view,selection);
      if(issue) {
        const error=new Error(issue);
        error.stage="model_selection";error.reasonCode="naming_model_unavailable";throw error;
      }
      const task=await requireTask(sourceTask);
      const ws=task.workspacePath;
      checkGeneration(signal,deadline);
      const meta=await connection.call("zcode-task","getTaskMeta",[task]);
      checkGeneration(signal,deadline);
      if(!meta||sourceServer&&(meta.taskId!==sessionId||meta.workspacePath!==ws))
        throw Object.assign(new Error("原 Host 未确认目标会话"),{reasonCode:"host_title_mismatch"});
      // 冻结分裂下宿主任务元（索引/overlay）仍是旧标题属预期状态；非冻结场景维持漂移护栏
      if(meta.title!==context.current_title&&!(await loadFreezeTitles()).includes(context.current_title))throw new Error("模型请求前目标标题已经变化");
      checkGeneration(signal,deadline);
      // 宿主按 workspace key 复用首个会话 runtime。命名使用独立 key，保留真实目录与 Host。
      const target={workspacePath:ws,workspaceIdentity:`suian-zcode-title:${ws}`};
      let disposal;
      releaseGeneration=()=>disposal??=connection.call("zcode-agent","disposeWorkspace",[target]);
      try {
        return await Promise.race([connection.call("zcode-agent","generateWorkspaceText",[{
          ...target,selection,messages:[{role:"system",content:prompt},{role:"user",content:JSON.stringify(context)}],
          tools:[],querySource:"session_title_external",maxOutputTokens:config.maxOutputTokens??2048,
          requestTimeoutMs:Math.max(1,Math.min(timeoutMs,deadline-Date.now()))
        }]),abort.promise]);
      } finally {
        try {await releaseGeneration();}
        finally {releaseGeneration=undefined;if(signal?.aborted)disconnect();}
      }
      } finally {signal?.removeEventListener("abort",onAbort);}
    },
    async rename(title,sourceTask) {
      const connection=await attach();
      const task=await requireTask(sourceTask);
      const result=await connection.call("zcode-task","renameTask",[{...task,title}]);
      if(result.taskId&&result.taskId!==sessionId)throw new Error("改名返回了不同会话");
      if(result.title!==title)throw new Error("原 Host 改名响应不一致");
    },
    // 锁定前二次查证（#125）：不依赖两库分裂条件，现查会话历史 CronCreate 记录判断标题是否冻结
    async confirmFreezeTitle(title) {return (await loadFreezeTitles()).includes(title);},
    saveState,
    async close() {
      closed=true;
      // runNaming 超时后可能先返回，给释放请求留出应答时间再关连接。
      try {await releaseGeneration?.();} finally {disconnect();}
    }
  };
}



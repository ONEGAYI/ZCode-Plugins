import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {win32} from "node:path";
import {connectHost} from "../suian-zcode-common/remote.mjs";
import {readHistory,recentSnapshot} from "./history.mjs";
import {readTitlePolicy as loadTitlePolicy} from "../suian-zcode-common/title-policy.mjs";

const SESSION_ID_RE=/^sess_[A-Za-z0-9_-]+$/;

export function createBackend({event,config,saveState,prompt,connect=connectHost,readTitlePolicy=loadTitlePolicy}) {
  const sessionId=event.session_id;
  if(!SESSION_ID_RE.test(sessionId??""))throw new Error("输入需要有效 session_id");
  let remote;
  // 会话归属工作区以 session.directory 为权威：宿主 Stop 事件的 cwd 是窗口当前目录，
  // 换过工作区/目录的会话两者不一致；索引行 workspace_path 作次选，payload 最后兜底。
  let resolvedWorkspace=null;
  const queryJson=async(db,sql)=> {
    const {stdout}=await promisify(execFile)(config.sqliteBin??"sqlite3",["-readonly","-json",db,sql],{encoding:"utf8",windowsHide:true});
    return stdout.trim()?JSON.parse(stdout):[];
  };
  // 索引行每次现查：rename 前后 title 会变化，不能缓存
  const loadIndexRow=async()=> {
    try {return (await queryJson(config.indexDb,`SELECT task_id,workspace_path,title,archived,deleted,task_status FROM tasks WHERE task_id='${sessionId}';`))[0]??null;}catch{return null;}
  };
  const resolveWorkspace=async()=> {
    if(resolvedWorkspace)return resolvedWorkspace;
    try {
      const rows=await queryJson(config.sessionDb,`SELECT directory FROM session WHERE id='${sessionId}';`);
      if(rows[0]?.directory){resolvedWorkspace=rows[0].directory;return resolvedWorkspace;}
    }catch{}
    const row=await loadIndexRow();
    if(row?.workspace_path){resolvedWorkspace=row.workspace_path;return resolvedWorkspace;}
    const fallback=event.workspace_path??event.cwd;
    if(!fallback)throw new Error("任务索引与 CLI 库中都没有目标会话，且事件未携带工作区");
    resolvedWorkspace=fallback;
    return resolvedWorkspace;
  };
  const workspacePath=async()=> {
    const value=await resolveWorkspace();
    // 远控 bridge 的 workspaceKey 校验要求与会话归属一致
    return value;
  };
  const attach=async()=>{
    if(!remote) {
      remote=await connect({workspacePath:await workspacePath(),sessionId,gatewayConfigPath:config.gatewayConfigPath,timeoutMs:config.timeoutMs??120000,handshakeTimeoutMs:config.probeTimeoutMs??Math.min(config.timeoutMs??120000,8000)});
    }
    return remote;
  };
  return {
    async read() {
      const ws=await workspacePath();
      const row=await loadIndexRow();
      // 新会话首轮索引行可能尚未写入：session.directory 已足以定位，不因缺行失败
      const history=await readHistory({dbPath:config.sessionDb,sqliteBin:config.sqliteBin,sessionId,workspacePath:ws});
      if(row&&row.title!==history.session.title)throw new Error("任务索引与 CLI 会话标题不一致");
      if(remote) {
        const meta=await remote.call("zcode-task","getTaskMeta",[{taskId:sessionId,workspacePath:ws}]);
        if(meta.taskId!==sessionId||meta.workspacePath!==ws||meta.title!==history.session.title)throw new Error("原 Host 与持久化标题不一致");
      }
      return{...recentSnapshot(history,ws),titleSource:history.session.titleSource??null,titlePolicy:await readTitlePolicy({sessionId}),archived:!!row?.archived,deleted:!!row?.deleted,running:row?.task_status==="running"};
    },
    // 存在性校验与 resolveWorkspace 的容错链不同：查询异常不吞、不兜底，避免把"查不了"静默当"不存在"
    async sessionExists() {
      const inSessionDb=(await queryJson(config.sessionDb,`SELECT id FROM session WHERE id='${sessionId}' LIMIT 1;`)).length>0;
      if(inSessionDb)return true;
      return (await queryJson(config.indexDb,`SELECT task_id FROM tasks WHERE task_id='${sessionId}' LIMIT 1;`)).length>0;
    },
    async models() {return(await attach()).call("model-selection","getView",[]);},
    async generate(context,selection) {
      const connection=await attach();
      const view=await connection.call("model-selection","getView",[]);
      const model=view.providers.find(p=>p.providerId===selection?.providerId)?.models.find(m=>m.modelId===selection?.modelId);
      if(!model)throw new Error("指定模型不在原 Host 的可用目录中");
      if(!model.config.optionSpecs.reasoningLevel.values.includes(selection.options?.reasoningLevel))throw new Error("指定思考档位不可用");
      const ws=await workspacePath();
      const meta=await connection.call("zcode-task","getTaskMeta",[{taskId:sessionId,workspacePath:ws}]);
      if(meta.title!==context.current_title)throw new Error("模型请求前目标标题已经变化");
      return connection.call("zcode-agent","generateWorkspaceText",[{
        workspacePath:ws,selection,messages:[{role:"system",content:prompt},{role:"user",content:JSON.stringify(context)}],
        tools:[],querySource:"session_title_external",maxOutputTokens:config.maxOutputTokens??2048,
        requestTimeoutMs:(config.timeoutMs??120000)+10000
      }]);
    },
    async rename(title) {
      const ws=await workspacePath();
      const result=await(await attach()).call("zcode-task","renameTask",[{taskId:sessionId,workspacePath:ws,title}]);
      if(result.taskId&&result.taskId!==sessionId)throw new Error("改名返回了不同会话");
      if(result.title!==title)throw new Error("原 Host 改名响应不一致");
    },
    saveState,
    close() {remote?.close();}
  };
}



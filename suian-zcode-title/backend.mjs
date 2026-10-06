import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {win32} from "node:path";
import {connectRemote} from "./remote.mjs";
import {readHistory,recentSnapshot} from "./history.mjs";

export function createBackend({event,config,authorizationUrl,saveState,prompt,connect=connectRemote}) {
  const sessionId=event.session_id,workspacePath=event.workspace_path??event.cwd;
  if(!/^sess_[A-Za-z0-9_-]+$/.test(sessionId??"")||!workspacePath)throw new Error("输入需要有效 session_id 与 workspace_path/cwd");
  let remote;
  const attach=async()=>{
    if(!remote) {
      if(!authorizationUrl)throw Object.assign(new Error("需要当前窗口的远控授权链接，使用 stdin.authorization_url 或 OIL_ZCODE_REMOTE_URL"),{stage:"config",reasonCode:"missing_authorization"});
      remote=await connect({authorizationUrl,workspacePath,sessionId,timeoutMs:config.timeoutMs??120000,handshakeTimeoutMs:config.probeTimeoutMs??Math.min(config.timeoutMs??120000,8000)});
    }
    return remote;
  };
  return {
    async read() {
      const {stdout}=await promisify(execFile)(config.sqliteBin??"sqlite3",["-readonly","-json",config.indexDb,"PRAGMA query_only=ON; SELECT task_id,workspace_path,title,archived,deleted,task_status FROM tasks WHERE task_id='"+sessionId+"';"],{encoding:"utf8",windowsHide:true});
      const row=(stdout.trim()?JSON.parse(stdout):[]).find(r=>win32.normalize(r.workspace_path).toLowerCase()===win32.normalize(workspacePath).toLowerCase());
      if(!row)throw new Error("任务索引中没有目标工作区的会话");
      const history=await readHistory({dbPath:config.sessionDb,sqliteBin:config.sqliteBin,sessionId,workspacePath});
      if(row.title!==history.session.title)throw new Error("任务索引与 CLI 会话标题不一致");
      if(remote) {
        const meta=await remote.call("zcode-task","getTaskMeta",[{taskId:sessionId,workspacePath}]);
        if(meta.taskId!==sessionId||meta.workspacePath!==workspacePath||meta.title!==row.title)throw new Error("原 Host 与持久化标题不一致");
      }
      return{...recentSnapshot(history,workspacePath),archived:!!row.archived,deleted:!!row.deleted,running:row.task_status==="running"};
    },
    async models() {return(await attach()).call("model-selection","getView",[]);},
    async generate(context,selection) {
      const connection=await attach();
      const view=await connection.call("model-selection","getView",[]);
      const model=view.providers.find(p=>p.providerId===selection?.providerId)?.models.find(m=>m.modelId===selection?.modelId);
      if(!model)throw new Error("指定模型不在原 Host 的可用目录中");
      if(!model.config.optionSpecs.reasoningLevel.values.includes(selection.options?.reasoningLevel))throw new Error("指定思考档位不可用");
      const meta=await connection.call("zcode-task","getTaskMeta",[{taskId:sessionId,workspacePath}]);
      if(meta.title!==context.current_title)throw new Error("模型请求前目标标题已经变化");
      return connection.call("zcode-agent","generateWorkspaceText",[{
        workspacePath,selection,messages:[{role:"system",content:prompt},{role:"user",content:JSON.stringify(context)}],
        tools:[],querySource:"session_title_external",maxOutputTokens:config.maxOutputTokens??2048,
        requestTimeoutMs:(config.timeoutMs??120000)+10000
      }]);
    },
    async rename(title) {
      const result=await(await attach()).call("zcode-task","renameTask",[{taskId:sessionId,workspacePath,title}]);
      if(result.taskId&&result.taskId!==sessionId)throw new Error("改名返回了不同会话");
      if(result.title!==title)throw new Error("原 Host 改名响应不一致");
    },
    saveState,
    close() {remote?.close();}
  };
}



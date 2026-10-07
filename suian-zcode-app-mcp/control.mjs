import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { connectRemote } from '../suian-zcode-common/remote.mjs';
import { loadAuthorization as loadStoredAuthorization } from '../suian-zcode-common/auth-store.mjs';
import { writeTitlePolicy } from '../suian-zcode-common/title-policy.mjs';
import { getGlmBalance, resetGlmQuota } from './glm.mjs';

export function deliveredMessage(content) {
  return `<delivered-by-other-session>\n<notice>\nThe message in this block was delivered by other zcode session or the system, instead of the user.\n</notice>\n${content}\n</delivered-by-other-session>`;
}

function archiveActivity(snapshot, sessionId) {
  const runtime = snapshot?.runtime;
  if (snapshot?.meta?.taskId !== sessionId || !runtime || !['running', 'completed', 'error'].includes(snapshot.meta.status) ||
      !Array.isArray(runtime.backgroundBashJobs) || !(runtime.plan === null || Array.isArray(runtime.plan)) ||
      !Array.isArray(runtime.pendingCommands) || !Array.isArray(runtime.pendingPermissions)) throw new Error('activity_unknown: Host 未提供完整运行态，未归档');
  const reasons = [];
  if (snapshot.meta.status === 'running' || runtime.activeTurnKind || runtime.apiRetry) reasons.push({ code: 'main_agent_active' });
  for (const job of runtime.backgroundBashJobs) {
    if (!['pending', 'running', 'completed', 'failed', 'killed', 'lost'].includes(job.status) || !['agent', 'bash'].includes(job.taskKind)) throw new Error('activity_unknown: 未识别的后台任务状态');
    if (['pending', 'running', 'lost'].includes(job.status)) reasons.push({ code: job.taskKind === 'agent' ? 'subagent_attached' : 'background_task_attached', job_id: job.jobId, status: job.status });
  }
  for (const todo of runtime.plan ?? []) {
    if (!['pending', 'in_progress', 'completed'].includes(todo.status)) throw new Error('activity_unknown: 未识别的任务状态');
    if (todo.status !== 'completed') reasons.push({ code: 'unfinished_task', task_id: todo.id, status: todo.status });
  }
  if (snapshot.meta.target && snapshot.meta.target.status !== 'complete') reasons.push({ code: 'unfinished_goal', status: snapshot.meta.target.status });
  if (runtime.pendingCommands.length) reasons.push({ code: 'pending_commands', count: runtime.pendingCommands.length });
  if (runtime.pendingPermissions.length || runtime.pendingElicitations?.length || snapshot.meta.pendingInteraction) reasons.push({ code: 'pending_interaction' });
  return reasons;
}

export function createSessionController({ reader, authDataDir = join(homedir(), '.zcode', 'tools', 'suian-zcode-app-mcp'), connect = connectRemote, loadAuthorization = () => loadStoredAuthorization({ dataDir: authDataDir }), setTitlePolicy = writeTitlePolicy, now = Date.now }) {
  let busy = false;
  const glmAttempts = new Map();
  const targetOf = args => ({ sessionId: args.session_id,
    workspacePath: args.workspace_path ?? reader.readSession({ session_id: args.session_id, workspace_key: args.workspace_key, limit: 1 }).session.workspace_path });
  const attached = async (target, run, timeoutMs = 120000) => {
    if (busy) throw new Error('remote_busy: 本 MCP 正在使用远控连接，请等待当前调用结束');
    busy = true;
    try {
      const authorizationUrl = await loadAuthorization();
      if (!authorizationUrl) throw new Error('authorization_required: 写工具需要当前窗口的远控授权，请按 skill 配置');
      const remote = await connect({ ...target, authorizationUrl, timeoutMs, handshakeTimeoutMs: 8000 });
      try { return await run(remote); }
      finally { remote.close(); }
    } finally { busy = false; }
  };
  const send = async (remote, session_id, message) => {
    const input_id = randomUUID();
    await remote.call('zcode-task', 'sendPrompt', [{ taskId: session_id, traceId: input_id, content: deliveredMessage(message) }]);
    return { input_id, delivery_status: 'accepted' };
  };
  const archiveResult = (args, remote, archived) => {
    const rows = reader.listSessions({ query: args.session_id, workspace_path: remote.workspacePath, include_archived: true, limit: 200 }).sessions
      .filter(row => row.session_id === args.session_id && (args.workspace_key === undefined || row.workspace_key === args.workspace_key));
    if (rows.length !== 1 || rows[0].archived !== archived) throw new Error('archive_not_confirmed: 索引读回未确认归档状态，请检查后再操作');
    return { source: 'original_host', session_id: args.session_id, workspace_path: remote.workspacePath, archived };
  };
  return {
    async getGlmBalance({ workspace_path }) {
      return attached({ workspacePath: workspace_path }, remote => getGlmBalance(remote, { now }));
    },
    async resetGlmQuota(args, { requestConfirmation, signal } = {}) {
      // 180 秒用户确认，加上确认前后额度读取、提交与刷新；其他工具保持 120 秒。
      return attached({ workspacePath: args.workspace_path }, remote => resetGlmQuota(remote, args, { requestConfirmation, attempts: glmAttempts, now, signal }), 360000);
    },
    async renameSession(args) {
      const target = targetOf(args);
      return attached(target, async remote => {
        const params = { taskId: args.session_id, workspacePath: remote.workspacePath, title: args.title };
        await remote.call('zcode-task', 'renameTask', [params]);
        const meta = await remote.call('zcode-task', 'getTaskMeta', [{ taskId: args.session_id, workspacePath: remote.workspacePath }]);
        if (!meta || meta.taskId !== args.session_id || meta.title !== args.title) throw new Error('rename_not_confirmed: 原 Host 改名读回不一致');
        return { source: 'original_host', session_id: args.session_id, workspace_path: meta.workspacePath, title: meta.title };
      });
    },
    async startSession({ workspace_path, title, message, model, lock_title = false }) {
      return attached({ workspacePath: workspace_path }, async remote => {
        let modelSelection;
        if (model) {
          const view = await remote.call('model-selection', 'getView', []);
          const entry = view.providers.find(p => p.providerId === model.provider_id)?.models.find(m => m.modelId === model.model_id);
          if (!entry) throw new Error('model_not_available: 指定 provider/model 不在当前 Host 模型目录中');
          if (model.reasoning_level && !entry.config.optionSpecs.reasoningLevel?.values.includes(model.reasoning_level)) throw new Error('reasoning_not_available: 指定思考档位不可用');
          modelSelection = { providerId: model.provider_id, modelId: model.model_id,
            ...(model.reasoning_level ? { options: { reasoningLevel: model.reasoning_level } } : {}) };
        }
        const meta = await remote.call('zcode-task', 'createTask', [{ workspacePath: remote.workspacePath,
          ...(modelSelection ? { modelSelection } : {}), deferPersistenceUntilFirstPrompt: true }]);
        if (!meta.taskId) throw new Error('create_not_confirmed: 原 Host 创建响应缺少 taskId');
        const result = { source: 'original_host', session_id: meta.taskId, workspace_path: meta.workspacePath, title: meta.title };
        try {
          if (title !== undefined) {
            const renamed = await remote.call('zcode-task', 'renameTask', [{ taskId: meta.taskId, workspacePath: meta.workspacePath, title }]);
            if (renamed.taskId !== meta.taskId || renamed.title !== title) throw new Error('rename_not_confirmed: 原 Host 创建后命名响应不一致');
            result.title = renamed.title;
          }
          await setTitlePolicy({ sessionId: meta.taskId, locked: lock_title });
          result.lock_title = lock_title;
          return { ...result, ...await send(remote, meta.taskId, message) };
        } catch (error) {
          error.partial_result = { ...result, delivery_status: 'unknown' };
          throw error;
        }
      });
    },
    async sendMessage(args) {
      const target = targetOf(args);
      return attached(target, async remote => {
        const params = { taskId: args.session_id, workspacePath: remote.workspacePath };
        const meta = await remote.call('zcode-task', 'getTaskMeta', [params]);
        if (!meta || meta.taskId !== args.session_id) throw new Error('session_not_found: 原 Host 未确认目标会话');
        await remote.call('zcode-task', 'resumeTask', [params]);
        return { source: 'original_host', session_id: args.session_id, workspace_path: remote.workspacePath, ...await send(remote, args.session_id, args.message) };
      });
    },
    async archiveSession(args) {
      return attached(targetOf(args), async remote => {
        const params = { taskId: args.session_id, workspacePath: remote.workspacePath };
        const check = async () => archiveActivity(await remote.call('zcode-task', 'getTaskSnapshot', [{ ...params, messageLimit: 1 }]), args.session_id);
        const blocked = reasons => ({ source: 'original_host', session_id: args.session_id, status: 'confirmation_required', requires_confirmation: true, active_reasons: reasons });
        let reasons = await check();
        if (reasons.length && !args.force) return blocked(reasons);
        const latest = await check();
        if (latest.length && !args.force) return blocked(latest);
        reasons = latest;
        await remote.call('zcode-task', 'archiveTask', [params]);
        return { ...archiveResult(args, remote, true), forced: args.force === true, active_reasons: reasons };
      });
    },
    async restoreSession(args) {
      return attached(targetOf(args), async remote => {
        await remote.call('zcode-task', 'unarchiveTask', [{ taskId: args.session_id, workspacePath: remote.workspacePath }]);
        return archiveResult(args, remote, false);
      });
    }
  };
}

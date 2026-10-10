import { randomUUID } from 'node:crypto';
import { connectHost } from '../suian-zcode-common/remote.mjs';
import { writeTitlePolicy } from '../suian-zcode-common/title-policy.mjs';
import { getGlmBalance, resetGlmQuota } from './glm.mjs';

const xmlAttribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function sourceNotice(role, warning) {
  if (!warning) return '';
  const candidates = JSON.stringify(warning.possible_session_ids).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `\nThe ${role} session could not be confirmed.${warning.possible_session_ids.length ? ` Possible ${role} session IDs (unverified): ${candidates}.` : ''}`;
}

export function deliveredMessage(content, deliverer, warning) {
  const attribute = deliverer === undefined ? '' : ` deliverer="${xmlAttribute(deliverer)}"`;
  return `<delivered-by-other-session${attribute}>\n<notice>\nThe message in this block was delivered by other zcode session or the system, instead of the user.${sourceNotice('deliverer', warning)}\n</notice>\n${content}\n</delivered-by-other-session>`;
}

function createdMessage(content, creator, warning) {
  const attribute = creator === undefined ? '' : ` creator="${xmlAttribute(creator)}"`;
  return `<created-by-other-session${attribute}>\n<notice>\nYou are a new zcode session created by another zcode session or the system, instead of directly by the user.${sourceNotice('creator', warning)}\n</notice>\n${content}\n</created-by-other-session>`;
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

export function createSessionController({ reader, gatewayConfigPath, connect = connectHost, setTitlePolicy = writeTitlePolicy, now = Date.now,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false;
  const glmAttempts = new Map();
  const deliveryClientId = `suian-zcode-app-mcp-${randomUUID()}`;
  const targetOf = args => ({ sessionId: args.session_id,
    workspacePath: args.workspace_path ?? reader.readSession({ session_id: args.session_id, workspace_key: args.workspace_key, limit: 1 }).session.workspace_path });
  const attached = async (target, run, timeoutMs = 120000) => {
    if (busy) throw new Error('remote_busy: 本 MCP 正在使用远控连接，请等待当前调用结束');
    busy = true;
    try {
      const remote = await connect({ ...target, gatewayConfigPath, timeoutMs, handshakeTimeoutMs: 8000 });
      try { return await run(remote); }
      finally { remote.close(); }
    } finally { busy = false; }
  };
  const send = async (remote, session_id, content) => {
    const input_id = randomUUID();
    await remote.call('zcode-task', 'sendPrompt', [{ taskId: session_id, traceId: input_id, content }]);
    return { input_id, delivery_status: 'accepted' };
  };
  // 官方 renameTask 写任务索引后向宿主发 v4 renameSession 同步 CLI 会话库，失败仅记 warn、RPC 仍返回成功；
  // deferred 会话首发前 CLI 库无行，startSession 等首发落库后才改名。写后读回复核两库，
  // 分叉时以 warnings 暴露（对齐命名插件"写后读回核验"的纪律），不阻断 RPC 成功路径。探测异常（库缺失/繁忙）
  // 视为无法核实：不告警、不外溢为工具错误；attempts<=0 时不探测。
  const confirmTitleSync = async (session_id, title, attempts) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await delay(300);
      let session_title;
      try { ({ session_title } = reader.sessionTitle?.({ session_id }) ?? {}); }
      catch { return []; }
      if (session_title === undefined || session_title === null) return [];
      if (session_title === title) return [];
      if (attempt === attempts - 1) return [{ code: 'title_store_diverged',
        message: `标题已写入任务索引，但 CLI 会话库仍为「${session_title}」；两库不一致期间自动命名会跳过该会话，重新改名或手动改一次标题以对齐` }];
    }
    return [];
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
        const warnings = await confirmTitleSync(args.session_id, args.title, 3);
        return { source: 'original_host', session_id: args.session_id, workspace_path: meta.workspacePath, title: meta.title,
          ...(warnings.length ? { warnings } : {}) };
      });
    },
    async startSession({ workspace_path, title, message, model, lock_title = false, creator, originWarning, permissionMode, permissionWarning }) {
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
          ...(modelSelection ? { modelSelection } : {}), ...(permissionMode ? { mode: permissionMode } : {}), deferPersistenceUntilFirstPrompt: true }]);
        if (!meta.taskId) throw new Error('create_not_confirmed: 原 Host 创建响应缺少 taskId');
        const result = { source: 'original_host', session_id: meta.taskId, workspace_path: meta.workspacePath, title: meta.title,
          ...(creator === undefined ? {} : { creator }) };
        // 来源警告在 try 外构造：部分失败的 partial_result 也要携带（PR #15 契约），复核警告只在成功路径合并
        const warnings = [...(originWarning ? [originWarning] : []), ...(permissionWarning ? [permissionWarning] : [])];
        try {
          await setTitlePolicy({ sessionId: meta.taskId, locked: lock_title });
          result.lock_title = lock_title;
          Object.assign(result, await send(remote, meta.taskId, createdMessage(message, creator, originWarning)));
          // deferred 会话首发后才落库；继承、确认与回执统一读取 CLI session.permission.mode。
          // createTask 的 meta.mode 来自状态投影，首发前可能仍是默认 build，不能作为权限信源。
          let reading;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await delay(300);
            reading = reader.sessionMode({ session_id: meta.taskId });
            if (reading.mode !== null) break;
          }
          if (reading.mode === null) warnings.push({ code: 'permission_unverified', message: '开局已提交，CLI 会话库尚无可读权限，未确认生效模式' });
          else {
            result.permission_mode = reading.mode;
            if (permissionMode !== undefined && reading.mode !== permissionMode)
              throw new Error(`permission_not_confirmed: CLI 会话库权限与请求不一致（请求 ${permissionMode}，读回 ${reading.mode}），开局已提交，请勿重复派发`);
          }
          if (title !== undefined) {
            // sessionMode.observed 为空表示 CLI 库无行；权限为 null 的既有行仍可改名。
            if (!reading.observed.length) throw new Error('session_not_persisted: 开局已提交，CLI 会话库尚无会话记录，未改名，请勿重复派发');
            const renamed = await remote.call('zcode-task', 'renameTask', [{ taskId: meta.taskId, workspacePath: meta.workspacePath, title }]);
            if (renamed.taskId !== meta.taskId || renamed.title !== title) throw new Error('rename_not_confirmed: 原 Host 创建后命名响应不一致');
            result.title = renamed.title;
            warnings.push(...await confirmTitleSync(meta.taskId, title, 2));
          }
          return { ...result, ...(warnings.length ? { warnings } : {}) };
        } catch (error) {
          error.partial_result = { ...result, ...(warnings.length ? { warnings } : {}), delivery_status: result.delivery_status ?? 'unknown' };
          throw error;
        }
      });
    },
    async sendMessage(args) {
      const target = targetOf(args);
      return attached(target, async remote => {
        const hello = await remote.call('zcode-agent', 'helloConversationV4');
        if (hello.protocolVersion !== 3) throw new Error('conversation_protocol_unsupported: Host 的会话协议版本不受支持');
        await remote.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: 3,
          clientId: deliveryClientId, clientKind: hello.clientMode === 'desktop-continuous' ? 'desktop' : 'web', appVersion: '0.1.0' }]);
        const params = { taskId: args.session_id, workspacePath: remote.workspacePath };
        const meta = await remote.call('zcode-task', 'getTaskMeta', [params]);
        if (!meta || meta.taskId !== args.session_id) throw new Error('session_not_found: 原 Host 未确认目标会话');
        await remote.call('zcode-task', 'resumeTask', [params]);
        const input_id = randomUUID();
        const result = { source: 'original_host', session_id: args.session_id, workspace_path: remote.workspacePath, input_id,
          requested_delivery_mode: args.delivery_mode ?? 'host_default',
          ...(args.deliverer === undefined ? {} : { deliverer: args.deliverer }), ...(args.originWarning ? { warnings: [args.originWarning] } : {}),
        };
        let ack;
        try {
          ack = await remote.call('zcode-agent', 'sendConversationCommandV4', [{ workspacePath: remote.workspacePath,
            envelope: { commandId: input_id, clientId: deliveryClientId, sessionId: args.session_id, type: 'sendText', issuedAt: now(),
              payload: { text: deliveredMessage(args.message, args.deliverer, args.originWarning), heldQueueDisposition: 'keepQueueAndSend',
                ...(args.delivery_mode === undefined ? {} : { requestedDelivery: args.delivery_mode }) } } }]);
        } catch (error) {
          error.partial_result = { ...result, delivery_status: 'unknown' };
          throw error;
        }
        if (ack?.commandId !== input_id)
          throw Object.assign(new Error('delivery_not_confirmed: 原 Host 未返回本次输入的有效投递回执'),
            { partial_result: { ...result, delivery_status: 'unknown' } });
        if (!['accepted', 'duplicate'].includes(ack.status))
          throw Object.assign(new Error(`send_not_accepted: ${ack.reasonCode ?? ack.status}${ack.message ? ': ' + ack.message : ''}`),
            { partial_result: { ...result, delivery_status: 'rejected' } });
        if (ack.result?.type !== 'inputAccepted' || ack.result.inputId !== input_id ||
            !['startNow', 'queue', 'guide'].includes(ack.result.delivery))
          throw Object.assign(new Error('delivery_not_confirmed: 原 Host 未返回本次输入的有效投递回执'),
            { partial_result: { ...result, delivery_status: 'unknown' } });
        return { ...result, delivery_status: 'accepted', admitted_delivery: ack.result.delivery };
      });
    },
    async compactSession(args) {
      return attached(targetOf(args), async remote => {
        const hello = await remote.call('zcode-agent', 'helloConversationV4');
        if (hello.protocolVersion !== 3) throw new Error('conversation_protocol_unsupported: Host 的会话协议版本不受支持');
        await remote.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: 3,
          clientId: deliveryClientId, clientKind: hello.clientMode === 'desktop-continuous' ? 'desktop' : 'web', appVersion: '0.1.0' }]);
        const params = { taskId: args.session_id, workspacePath: remote.workspacePath };
        const meta = await remote.call('zcode-task', 'getTaskMeta', [params]);
        if (!meta || meta.taskId !== args.session_id) throw new Error('session_not_found: 原 Host 未确认目标会话');
        await remote.call('zcode-task', 'resumeTask', [params]);
        const command_id = randomUUID();
        const result = { source: 'original_host', session_id: args.session_id, workspace_path: remote.workspacePath, command_id };
        let ack;
        try {
          ack = await remote.call('zcode-agent', 'sendConversationCommandV4', [{ workspacePath: remote.workspacePath,
            envelope: { commandId: command_id, clientId: deliveryClientId, sessionId: args.session_id, type: 'compact', issuedAt: now(), payload: {} } }]);
        } catch (error) {
          error.partial_result = { ...result, command_status: 'unknown' };
          throw error;
        }
        if (ack?.commandId !== command_id || !['accepted', 'duplicate', 'rejected', 'stale', 'noop', 'failed'].includes(ack.status))
          throw Object.assign(new Error('compact_not_confirmed: 原 Host 未返回本次命令的有效受理回执'),
            { partial_result: { ...result, command_status: 'unknown' } });
        if (!['accepted', 'duplicate'].includes(ack.status))
          throw Object.assign(new Error(`compact_not_accepted: ${ack.reasonCode ?? ack.status}${ack.message ? ': ' + ack.message : ''}`),
            { partial_result: { ...result, command_status: ack.status, ...(ack.reasonCode ? { reason_code: ack.reasonCode } : {}) } });
        return { ...result, command_status: ack.status };
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

import { randomUUID } from 'node:crypto';
import { connectHost } from 'suian-zcode-common/remote.mjs';
import { writeTitlePolicy } from 'suian-zcode-common/title-policy.mjs';
import { getGlmBalance, resetGlmQuota } from './glm.mjs';
import packageMetadata from './package.json' with { type: 'json' };

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

// 定时任务触发的自动化轮内官方 Cron 写工具会被剥离，实测恢复的关键动作是结束轮而非发消息
// （同轮注入不换工具面），因此唤醒文本必须携带结束本轮指令；instruction 覆盖默认文本时同样拼接注入。
const RESET_TURN_INSTRUCTION = '收到回执后立即结束本轮';
const RESET_DEFAULT_MESSAGE = `本消息由本会话的 reset_cron_tools_visibility 工具发出：定时任务触发的自动化轮内，官方 Cron 写工具（CronCreate/CronUpdate/CronDelete）能看见但调不动。${RESET_TURN_INSTRUCTION}，本轮内不要再尝试 Cron 写操作；下一轮（人工轮）官方 Cron 工具恢复可用，请按既定计划继续处理定时任务（CronList 定位，CronDelete/CronCreate 完成删除或重建）。`;

function resetWakeMessage(instruction) {
  return instruction === undefined ? RESET_DEFAULT_MESSAGE : `${instruction.trim()}\n\n${RESET_TURN_INSTRUCTION}。`;
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
  let resetting = false;
  const glmAttempts = new Map();
  const deliveryClientId = `suian-zcode-app-mcp-${randomUUID()}`;
  const targetOf = args => ({ sessionId: args.session_id,
    workspacePath: args.workspace_path ?? reader.readSession({ session_id: args.session_id, workspace_key: args.workspace_key, limit: 1 }).session.workspace_path });
  // 写调用允许并发：网关为每个本地连接维护独立 RPC ID 空间并共享同一 Host 桥，
  // 一步工具轮的批量归档等写操作各自建立连接，不再互相拒绝。
  const attached = async (target, run, timeoutMs = 120000) => {
    const remote = await connect({ ...target, gatewayConfigPath, timeoutMs, handshakeTimeoutMs: 8000 });
    try { return await run(remote); }
    finally { remote.close(); }
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
  // 读回按 task_id 精确定位（含归档行），不受列表子串查询与前 200 条截断影响；
  // 与 pinnedResult 同一精确路径，归档状态与置顶分别确认
  const archiveResult = (args, remote, archived) => {
    const rows = reader.listSessionStates({ session_id: args.session_id, workspace_path: remote.workspacePath,
      ...(args.workspace_key === undefined ? {} : { workspace_key: args.workspace_key }) });
    if (rows.length !== 1 || rows[0].archived !== archived) throw new Error('archive_not_confirmed: 索引读回未确认归档状态，请检查后再操作');
    return { source: 'original_host', session_id: args.session_id, workspace_path: remote.workspacePath, archived };
  };
  // 置顶与归档正交：读回按 task_id 精确定位（含归档行），只确认 pinned 位，不把归档当失败
  const pinnedResult = (args, remote, pinned) => {
    const rows = reader.listSessionStates({ session_id: args.session_id, workspace_path: remote.workspacePath,
      ...(args.workspace_key === undefined ? {} : { workspace_key: args.workspace_key }) });
    if (rows.length !== 1 || rows[0].pinned !== pinned) throw new Error('pin_not_confirmed: 索引读回未确认置顶状态，请检查后再操作');
    return { source: 'original_host', session_id: args.session_id, workspace_path: remote.workspacePath, pinned };
  };
  const api = {
    async getSessionStatus(args) {
      return attached(targetOf(args), async remote => {
        const snapshot = await remote.call('zcode-task', 'getTaskSnapshot', [{ taskId: args.session_id, workspacePath: remote.workspacePath, messageLimit: 1 }]);
        const meta = snapshot?.meta;
        if (meta?.taskId !== args.session_id || !['running', 'completed', 'error'].includes(meta.status))
          throw new Error('status_not_confirmed: 原 Host 没有返回目标会话的有效状态');
        return { source: 'original_host', session_id: meta.taskId, title: meta.title, workspace_path: remote.workspacePath,
          status: meta.status, created_at: meta.createdAt ?? null, updated_at: meta.updatedAt ?? null,
          pending_interaction: Boolean(meta.pendingInteraction || snapshot.runtime?.pendingPermissions?.length || snapshot.runtime?.pendingElicitations?.length),
          queried_at: now() };
      });
    },
    async getGlmBalance({ workspace_path }) {
      return attached({ workspacePath: workspace_path }, remote => getGlmBalance(remote, { now }));
    },
    async resetGlmQuota(args, { requestConfirmation, signal } = {}) {
      // 重置在用户确认前后对账卡片列表，并发重置会双双通过对账并双烧卡，保持单飞拒绝；其余写调用可并发。
      if (resetting) throw new Error('remote_busy: 本 MCP 正在执行额度重置，请等待当前调用结束');
      resetting = true;
      try {
        // 180 秒用户确认，加上确认前后额度读取、提交与刷新；其他工具保持 120 秒。
        return await attached({ workspacePath: args.workspace_path }, remote => resetGlmQuota(remote, args, { requestConfirmation, attempts: glmAttempts, now, signal }), 360000);
      } finally { resetting = false; }
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
    async startSession({ workspace_path, title, message, model, project_id, additional_directories, lock_title = false, creator, originWarning, permissionMode, permissionWarning, onCreated }) {
      return attached({ workspacePath: workspace_path }, async remote => {
        if (project_id !== undefined || additional_directories !== undefined) {
          const [major, minor] = (remote.bootstrap.desktopAppVersion ?? '').split('.').map(Number);
          if (!(major > 3 || major === 3 && minor >= 16))
            throw new Error('project_host_unsupported: 项目与附加目录需要 ZCode Desktop 3.16 或更新版本，尚未创建会话');
        }
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
          ...(project_id === undefined ? {} : { projectId: project_id }),
          ...(additional_directories === undefined ? {} : { additionalDirectories: additional_directories }),
          ...(modelSelection ? { modelSelection } : {}), ...(permissionMode ? { mode: permissionMode } : {}), deferPersistenceUntilFirstPrompt: true }]);
        if (!meta.taskId) throw new Error('create_not_confirmed: 原 Host 创建响应缺少 taskId');
        const result = { source: 'original_host', session_id: meta.taskId, workspace_path: meta.workspacePath, title: meta.title,
          ...(creator === undefined ? {} : { creator }) };
        // 来源警告在 try 外构造：部分失败的 partial_result 也要携带（PR #15 契约），复核警告只在成功路径合并
        const warnings = [...(originWarning ? [originWarning] : []), ...(permissionWarning ? [permissionWarning] : [])];
        try {
          await onCreated?.(result);
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
          // 项目归属写后读回（#126）：按 task_id 精确读回任务索引的 project_id 与请求核对
          //（null === null 的未归类亦通过）；行未落库或读库异常按未核实告警，防无效 id 静默落未归类
          if (project_id !== undefined) {
            let observed;
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt) await delay(300);
              try { observed = reader.sessionProjectId?.({ session_id: meta.taskId }); } catch { observed = undefined; }
              if (observed !== undefined) break;
            }
            if (observed === undefined) warnings.push({ code: 'project_unverified', message: '开局已提交，任务索引尚无可读的项目归属，未确认生效项目' });
            else if (observed !== project_id)
              throw new Error(`project_not_confirmed: CLI 任务索引项目归属与请求不一致（请求 ${project_id}，读回 ${observed}），开局已提交，请勿重复派发`);
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
          clientId: deliveryClientId, clientKind: hello.clientMode === 'desktop-continuous' ? 'desktop' : 'web', appVersion: packageMetadata.version }]);
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
    // 语法糖（issue #95）：复用 sendMessage 的 v4 投递，目标固定当前会话、投递固定 queue；
    // 唤醒文本由 resetWakeMessage 组合，保证默认与覆盖文本都携带结束本轮指令。
    // 服务层负责从 MCP 请求定位会话（不接受手填目标），这里只收 session_id 与来源信息。
    async resetCronToolsVisibility(args) {
      return api.sendMessage({ session_id: args.session_id, message: resetWakeMessage(args.instruction), delivery_mode: 'queue',
        deliverer: args.deliverer, originWarning: args.originWarning });
    },
    async compactSession(args) {
      return attached(targetOf(args), async remote => {
        const hello = await remote.call('zcode-agent', 'helloConversationV4');
        if (hello.protocolVersion !== 3) throw new Error('conversation_protocol_unsupported: Host 的会话协议版本不受支持');
        await remote.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: 3,
          clientId: deliveryClientId, clientKind: hello.clientMode === 'desktop-continuous' ? 'desktop' : 'web', appVersion: packageMetadata.version }]);
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
    },
    async pinSession(args) {
      return attached(targetOf(args), async remote => {
        await remote.call('zcode-task', 'setTaskPinned', [{ taskId: args.session_id, workspacePath: remote.workspacePath, pinned: true }]);
        return pinnedResult(args, remote, true);
      });
    },
    async unpinSession(args) {
      return attached(targetOf(args), async remote => {
        await remote.call('zcode-task', 'setTaskPinned', [{ taskId: args.session_id, workspacePath: remote.workspacePath, pinned: false }]);
        return pinnedResult(args, remote, false);
      });
    },
    // 定时任务启停：官方会话内工具面禁改 enabled（CronUpdate 权限边界），经 zcode-agent 通道直达 Host。
    // enabled=false → lifecycle paused、调度器停止认领派发；true → active、按原计划继续；id、历史与会话绑定不变。
    // 官方 setAutomationEnabled 返回 void 且 UPDATE 零行不报错（automation_id 不存在或 workspace_key
    // 不匹配都静默成功），不能回显请求值：写后用同 scope listAutomations 读回，未找到或状态不符
    // 按结构化错误返回且不自动重试；已处于目标状态视为幂等确认。
    async setAutomationEnabled(args) {
      return attached({ workspacePath: args.workspace_path }, async remote => {
        const identity = args.workspace_key === undefined ? {} : { workspaceIdentity: args.workspace_key };
        await remote.call('zcode-agent', 'setAutomationEnabled', [{ automationId: args.automation_id, enabled: args.enabled,
          workspacePath: remote.workspacePath, ...identity }]);
        const listed = await remote.call('zcode-agent', 'listAutomations', [{ workspacePath: remote.workspacePath, ...identity }]);
        const current = Array.isArray(listed) ? listed.find(item => item?.automationId === args.automation_id) : undefined;
        if (!current) throw new Error(`automation_not_found_or_wrong_scope: 写后同 scope 读回未找到 ${args.automation_id}，启停未生效（任务不存在或不属于该工作区）`);
        if (current.enabled !== args.enabled) throw new Error(`automation_update_unconfirmed: 写后读回 enabled=${current.enabled} 与请求 ${args.enabled} 不符，启停未确认生效，不自动重试`);
        return { source: 'original_host', automation_id: args.automation_id, workspace_path: remote.workspacePath, enabled: current.enabled };
      });
    }
  };
  return api;
}

import { randomUUID } from 'node:crypto';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { commonClient } from './common-client.mjs';

const busyReason = '主对话正在处理输入，为避免新增评论被本次发送清理，暂时不能添加评论；处理结束后恢复。这是尽力保护，禁用窗口可能覆盖模型回复，发送边界仍有残余风险。';
function acceptedBatches(context, bodies) {
  const batches = new Map();
  for (const body of bodies) for (const match of body.matchAll(/文本编辑器选区评论（[^\r\n]*）\r?\n(\{[^\r\n]+\})/g)) {
    try {
      const data = JSON.parse(match[1]);
      if (data.schemaVersion !== 1 || typeof data.batchId !== 'string' || !Array.isArray(data.comments) || !data.comments.length ||
          !data.comments.every(comment => comment.sessionId === context.sessionId && comment.workspacePath === context.workspacePath)) continue;
      batches.set(data.batchId, { batchId: data.batchId, serialized: match[1] });
    } catch { /* 普通用户正文和不完整 JSON 都不是受理证据。 */ }
  }
  return [...batches.values()];
}
function rememberBatches(entry, bodies) {
  for (const batch of acceptedBatches(entry.context, bodies)) entry.accepted.set(batch.serialized, batch);
}

// 每次只取得一份新快照，不维护第二份 V4 队列或增量投影。
async function readConversation(host, entry, active, workspacePath) {
  const { sessionId } = entry.context, topic = `conversation/${sessionId}`;
  const { TopicWireFrameAssembler, conversationTopicFrameSchema, PROTOCOL_V4_LIMITS, measureTopicNotificationEnvelopeBytes } = await commonClient();
  const hello = await host.call('zcode-agent', 'helloConversationV4', []);
  if (!active(entry)) return;
  if (hello?.protocolVersion !== 3) throw new Error('主对话公开帧协议版本不兼容');
  await host.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: hello.protocolVersion,
    clientId: randomUUID(), clientKind: 'web', appVersion: 'suian-side-editor',
    ...(hello.capabilities?.workflowRunDeltas === true ? { capabilities: { workflowRunDeltas: true } } : {}) }]);
  if (!active(entry)) return;
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema), waiting = Promise.withResolvers(), early = [];
  let subscriptionId, subscribing, listener, finished = false, earlyBytes = 0, earlyError, failed = false;
  const cancel = () => waiting.resolve({ error: new Error('评论状态资源已释放') }); entry.cancelRead = cancel;
  const timer = setTimeout(() => waiting.resolve({ error: new Error('主对话公开快照读取超时') }), 5000);
  const accept = wire => { try {
    if (finished || !active(entry) || wire?.topic !== topic) return;
    if (!subscriptionId) {
      earlyBytes += measureTopicNotificationEnvelopeBytes(wire).maxBytes;
      if (early.length >= PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments || earlyBytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxStagedBytes) earlyError = new Error('主对话ACK前快照缓存超过公开协议预算');
      else early.push(wire);
      return;
    }
    if (wire.subscriptionId !== subscriptionId) return;
    for (const event of assembler.accept(wire)) {
      if (event.kind === 'fault') waiting.resolve({ error: new Error(`主对话公开帧校验失败：${event.fault.reasonCode}`) });
      else if (event.frame.payload.kind === 'snapshot') {
        if (event.frame.fromSeq !== 0 || event.frame.toSeq !== event.frame.payload.snapshot.seq) waiting.resolve({ error: new Error('主对话公开快照帧水位无效') });
        else waiting.resolve({ snapshot: event.frame.payload.snapshot });
      }
    }
  } catch (error) { waiting.resolve({ error }); } };
  const release = async id => {
    try { await host.call('zcode-agent', 'unsubscribeConversationV4', [{ workspacePath, subscriptionId: id, runtimePolicy: 'existing-only' }]); }
    catch (error) { console.error(`主对话公开快照退订失败：${error.message}`); if (active(entry) && !failed) throw error; }
  };
  try {
    listener = host.listen('zcode-agent', 'onDynamicConversationFrame', { workspacePath })(accept);
    subscribing = host.call('zcode-agent', 'subscribeConversationV4', [{ workspacePath, sessionId, visibility: 'background' }]);
    const result = await Promise.race([subscribing, waiting.promise]);
    if (result.error) throw result.error;
    subscriptionId = result.ack?.subscriptionId;
    if (typeof subscriptionId !== 'string' || !subscriptionId || result.ack.mode !== 'snapshot') throw new Error('主对话公开快照订阅回执无效');
    if (!active(entry)) return;
    if (earlyError) throw earlyError;
    for (const wire of early.splice(0)) accept(wire);
    const outcome = await waiting.promise;
    if (outcome.error) throw outcome.error;
    if (!active(entry)) return;
    if (outcome.snapshot.sessionId !== sessionId || outcome.snapshot.logEpoch !== result.ack.logEpoch) throw new Error('主对话公开快照归属或日志世代不一致');
    // 一份已完整校验的自有快照是独立证据，不随随后历史分页或退订失败撤销。
    rememberBatches(entry, [...outcome.snapshot.queue.items.filter(item => item.kind === 'sendText').map(item => item.text),
      ...outcome.snapshot.rows.window.filter(row => row.kind === 'userInput').map(row => row.text)]);
    return outcome.snapshot;
  } catch (error) { failed = true; throw error; }
  finally {
    finished = true; clearTimeout(timer); listener?.dispose(); assembler.clear();
    try {
      // ChannelClient.close 会拒绝尚未返回的 ACK；取消资源先停止观察，在既有 RPC 时限内取回自有 ID。
      if (!subscriptionId && subscribing) {
        try { subscriptionId = (await subscribing)?.ack?.subscriptionId; }
        catch (error) { console.error(`主对话公开快照订阅未确认，无法取得退订标识：${error.message}`); }
      }
      if (typeof subscriptionId === 'string' && subscriptionId) await release(subscriptionId);
    } finally { entry.cancelRead = undefined; }
  }
}

async function conversationBodies(host, entry, active, workspacePath) {
  const snapshot = await readConversation(host, entry, active, workspacePath);
  if (!active(entry)) return;
  const { v4ConversationRowsRangeResultSchema } = await commonClient();
  const bodies = snapshot.queue.items.filter(item => item.kind === 'sendText').map(item => item.text);
  // 快照只携带尾窗；完整当前分支按公开游标逐页读取，不能按固定尾窗反证受理。
  let beforeRowId;
  do {
    const page = v4ConversationRowsRangeResultSchema.parse(await host.call('zcode-agent', 'conversationRowsRangeV4', [{ workspacePath,
      sessionId: entry.context.sessionId, limit: 200, ...(beforeRowId === undefined ? {} : { beforeRowId }) }]));
    if (!active(entry)) return;
    if (page.atSeq !== snapshot.seq || page.atRevision !== snapshot.revision || page.atLogEpoch !== snapshot.logEpoch) throw new Error('主对话历史与公开快照水位不一致，评论受理暂不可确认');
    if (page.rows.some((row, index) => !Number.isInteger(row.rowId) || row.rowId < 1 || (beforeRowId !== undefined && row.rowId >= beforeRowId) || (index > 0 && row.rowId <= page.rows[index - 1].rowId))) throw new Error('主对话历史行游标无效');
    bodies.push(...page.rows.filter(row => row.kind === 'userInput').map(row => row.text));
    if (!page.hasMore) return { snapshot, bodies };
    if (!page.rows.length) throw new Error('主对话历史空页仍声明有更多记录');
    beforeRowId = page.rows[0].rowId;
  } while (active(entry));
}

// 只服务本插件评论业务。资源归属来自一次受审工具，不从 URI/页面参数猜身份。
export function installCommentState(server, { hostConnector = (...args) => commonClient().then(common => common.connectHost(...args)), gatewayConfigPath } = {}) {
  const entries = new Map();
  let closed = false;
  const active = entry => !closed && entries.get(entry.uri) === entry;
  function lookup(uri) {
    const entry = entries.get(uri);
    if (!entry) throw new McpError(ErrorCode.InvalidParams, '评论状态资源未登记，请重新打开编辑器');
    return entry;
  }
  function refresh(entry) {
    entry.reading = entry.reading.then(async () => {
      if (!active(entry)) return false;
      let host, snapshot;
      try {
        const workspacePath = entry.context.hostWorkspacePath ?? entry.context.workspacePath;
        host = await hostConnector({ workspacePath, sessionId: entry.context.sessionId,
          ...(gatewayConfigPath ? { gatewayConfigPath } : {}), timeoutMs: 6000, handshakeTimeoutMs: 3000 });
        if (!active(entry)) return false;
        entry.connection = host;
        const nativeWorktree = Boolean(entry.context.hostWorkspacePath);
        let data;
        if (!nativeWorktree) {
          data = await host.call('zcode-task', 'getTaskSnapshot', [{ taskId: entry.context.sessionId, workspacePath, messageLimit: 20, byteBudget: 200000 }]);
          if (!active(entry)) return false;
          if (data?.meta?.taskId && data.meta.taskId !== entry.context.sessionId) throw new Error('网关返回了其他会话，评论状态不可确认');
        }
        // subscribe 可能启动/恢复该可信会话 runtime；不是发送 pending 或原子受理信号。
        const conversation = await conversationBodies(host, entry, active, workspacePath);
        if (!active(entry)) return false;
        const accepted = new Map(entry.accepted);
        for (const batch of acceptedBatches(entry.context, conversation.bodies)) accepted.set(batch.serialized, batch);
        // 3.18 的旧 getTaskSnapshot 会按检出目录查 runtime；原生工作树使用已校验的 V4 快照。
        const { control, pendingInteractions } = conversation.snapshot;
        const status = nativeWorktree ? control.phase : data?.meta?.status ?? null;
        const activeTurnKind = nativeWorktree ? control.activeWorks[0]?.kind ?? null : data?.runtime?.activeTurnKind ?? null;
        const busy = nativeWorktree
          ? status === 'prewarming' || status === 'running' || control.stopState === 'stopping' || Boolean(activeTurnKind) || pendingInteractions.length > 0
          : status === 'running' || Boolean(activeTurnKind);
        const ended = nativeWorktree ? control.sessionEnded : status === 'completed';
        const state = busy ? 'busy' : ended ? 'idle' : 'unknown';
        snapshot = { state, reason: busy ? busyReason : state === 'unknown' ? '尚未取得可确认的主对话状态，暂时不能添加评论' : '',
          source: nativeWorktree ? 'conversation-snapshot-v4' : 'task-snapshot', status, activeTurnKind, acceptedBatches: [...accepted.values()] };
        // 读取与解析全部完成后才提交批次记忆；通知后的再次读取仍保留证据。
        entry.accepted = accepted;
      } catch (error) { if (!active(entry)) return false; snapshot = { state: 'unknown', reason: `评论状态不可用：${error.message}`, code: error.reasonCode ?? error.code ?? 'comment_state_unavailable', acceptedBatches: [...entry.accepted.values()] }; }
      finally { host?.close(); entry.connection = undefined; }
      const changed = JSON.stringify(snapshot) !== JSON.stringify(entry.snapshot); entry.snapshot = snapshot; return changed;
    });
    return entry.reading;
  }
  function monitor(entry) {
    entry.timer = setTimeout(async () => {
      try {
        const changed = await refresh(entry);
        if (!entries.has(entry.uri) || !entry.subscribed) return;
        if (changed) await server.server.sendResourceUpdated({ uri: entry.uri });
        if (entries.has(entry.uri) && entry.subscribed) monitor(entry);
      } catch (error) { entry.timer = undefined; console.error(`评论状态通知失败，监测已停止：${error.message}`); }
    }, 1000); entry.timer.unref();
  }
  server.registerResource('comment-state', new ResourceTemplate('ui://suian-side-editor/comment-state/{id}', {}),
    { title: '当前绑定会话的只读评论状态', mimeType: 'application/json' }, async uri => {
      const entry = lookup(uri.href), changed = await refresh(entry);
      if (changed && entry.subscribed && entries.has(entry.uri)) await server.server.sendResourceUpdated({ uri: entry.uri });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(entry.snapshot) }] };
    });
  return {
    has: uri => entries.has(uri),
    async register(context) {
      if (closed) throw new McpError(ErrorCode.InvalidRequest, '评论状态连接已关闭');
      let entry = [...entries.values()].find(item => item.context.sessionId === context.sessionId && item.context.workspacePath === context.workspacePath);
      if (!entry) { const uri = `ui://suian-side-editor/comment-state/${randomUUID()}`; entry = { uri, context, accepted: new Map(), reading: Promise.resolve() }; entries.set(uri, entry); }
      await refresh(entry); lookup(entry.uri); return { ...entry.snapshot, resourceUri: entry.uri };
    },
    async subscribe(uri) { const entry = lookup(uri); await refresh(entry); if (!entries.has(uri)) return; entry.subscribed = true; if (!entry.timer) monitor(entry); return {}; },
    unsubscribe(uri) { const entry = lookup(uri); entries.delete(uri); entry.subscribed = false; clearTimeout(entry.timer); if (entry.cancelRead) entry.cancelRead(); else entry.connection?.close(); return {}; },
    close() { closed = true; for (const entry of entries.values()) { entry.subscribed = false; clearTimeout(entry.timer); if (entry.cancelRead) entry.cancelRead(); else entry.connection?.close(); } entries.clear(); }
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';

const workspace = 'D:\\fixture';
const model = { provider_id: 'fixture', model_id: 'flash', reasoning_level: 'low' };
const wrapped = text => `<delivered-by-other-session>\n<notice>\nThe message in this block was delivered by other zcode session or the system, instead of the user.\n</notice>\n${text}\n</delivered-by-other-session>`;
const opening = text => `<created-by-other-session>\n<notice>\nYou are a new zcode session created by another zcode session or the system, instead of directly by the user.\n</notice>\n${text}\n</created-by-other-session>`;
async function fixture(overrides = {}) {
  const calls = [], connections = [], policies = []; let archived = false, persistedMode = 'build';
  const { createSessionController } = await import('../control.mjs');
  const controller = createSessionController({
    reader: { readSession: () => ({ session: { workspace_path: workspace } }), listSessions: () => ({ sessions: [{ session_id: 'sess_new', archived }] }),
      sessionMode: args => overrides.sessionMode ? overrides.sessionMode(args) : { mode: persistedMode, observed: [persistedMode] } },
    loadAuthorization: async () => { throw new Error('网关调用不得读取旧远控凭据'); },
    setTitlePolicy: async args => { policies.push(args); },
    delay: async () => {},
    connect: async args => {
      const connection = { args, closed: false }; connections.push(connection);
      let helloIssued = false, boundClientId;
      return { workspacePath: workspace, close: () => { connection.closed = true; }, call: async (channel, method, params) => {
        calls.push({ channel, method, params });
        if (method === 'helloConversationV4') {
          helloIssued = true;
          return overrides[method] ? overrides[method](params) : { kind: 'hello', protocolVersion: 3, clientMode: 'web-remote-replayable' };
        }
        if (method === 'initializeConversationV4') {
          if (!helloIssued) throw new Error('fault.connection.helloRequired');
          if (boundClientId !== undefined && boundClientId !== params[0].clientId) throw new Error('fault.connection.clientChanged');
          assert.equal(params[0].kind, 'clientHello');
          assert.equal(params[0].protocolVersion, 3);
          if (overrides[method]) return overrides[method](params);
          boundClientId = params[0].clientId;
          return;
        }
        if (method === 'sendConversationCommandV4') {
          if (boundClientId === undefined) throw new Error('fault.connection.handshakeRequired');
          if (params[0].envelope.clientId !== boundClientId) throw new Error('fault.command.clientMismatch');
        }
        if (method === 'createTask') persistedMode = params[0].mode ?? 'build';
        if (overrides[method]) return overrides[method](params);
        if (method === 'getView') return { providers: [{ providerId: 'fixture', models: [{ modelId: 'flash', config: { optionSpecs: { reasoningLevel: { values: ['low'] } } } }] }] };
        if (method === 'createTask') return { taskId: 'sess_new', workspacePath: workspace, title: '默认标题', mode: params[0].mode ?? 'build' };
        if (method === 'getTaskMeta') return { taskId: params[0].taskId, workspacePath: workspace, title: '新标题' };
        if (method === 'renameTask') return { taskId: params[0].taskId, workspacePath: workspace, title: params[0].title };
        if (method === 'getTaskSnapshot') return { meta: { taskId: 'sess_new', status: 'completed' }, runtime: { plan: null, backgroundBashJobs: [], pendingCommands: [], pendingPermissions: [] } };
        if (method === 'archiveTask' || method === 'unarchiveTask') { archived = method === 'archiveTask'; return { taskId: params[0].taskId }; }
        if (method === 'sendConversationCommandV4') return { commandId: params[0].envelope.commandId, status: 'accepted', revisionAtDecision: 1,
          result: { type: 'inputAccepted', inputId: params[0].envelope.commandId, delivery: 'startNow' } };
      } };
    }
  });
  return { controller, calls, connections, policies };
}

test('创建使用指定模型，首发并确认落库后命名；发信与改名可使用返回 ID', async () => {
  const f = await fixture();
  const created = await f.controller.startSession({ workspace_path: workspace, title: '新标题', message: '测试开局', model });
  assert.equal(created.session_id, 'sess_new');
  assert.equal(created.delivery_status, 'accepted');
  assert.equal(created.lock_title, false);
  assert.deepEqual(f.policies, [{ sessionId: 'sess_new', locked: false }]);
  assert.deepEqual(f.calls.map(c => c.method), ['getView', 'createTask', 'sendPrompt', 'renameTask']);
  assert.deepEqual(f.calls[1].params, [{ workspacePath: workspace, modelSelection: { providerId: 'fixture', modelId: 'flash', options: { reasoningLevel: 'low' } }, deferPersistenceUntilFirstPrompt: true }]);
  assert.equal(f.calls[2].params[0].content, opening('测试开局'));
  assert.equal(f.calls[2].params[0].traceId, created.input_id);
  assert.equal(f.connections[0].args.sessionId, undefined);
  const sent = await f.controller.sendMessage({ session_id: created.session_id, message: '第二次测试' });
  assert.notEqual(sent.input_id, created.input_id);
  assert.equal(f.calls.at(-1).params[0].envelope.payload.text, wrapped('第二次测试'));
  assert.deepEqual(f.calls.slice(-3).map(c => c.method), ['getTaskMeta', 'resumeTask', 'sendConversationCommandV4']);
  const renamed = await f.controller.renameSession({ session_id: created.session_id, title: '新标题' });
  assert.equal(renamed.title, '新标题');
  assert.deepEqual(f.calls.slice(-2).map(c => c.method), ['renameTask', 'getTaskMeta']);
  assert.ok(f.connections.every(c => c.closed));
});

test('compact 提交指定会话的 V4 维护命令，接受没有 delivery 的 ACK 后返回并释放连接', async () => {
  const f = await fixture({ sendConversationCommandV4: ([{ workspacePath, envelope }]) => {
    assert.equal(workspacePath, workspace);
    assert.equal(envelope.type, 'compact');
    assert.equal(envelope.sessionId, 'sess_working');
    assert.deepEqual(envelope.payload, {});
    assert.equal(Object.hasOwn(envelope, 'baseRevision'), false);
    return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 7 };
  } });
  const result = await f.controller.compactSession({ session_id: 'sess_working', workspace_path: 'D:/FIXTURE' });
  assert.deepEqual(result, { source: 'original_host', session_id: 'sess_working', workspace_path: workspace,
    command_id: f.calls.at(-1).params[0].envelope.commandId, command_status: 'accepted' });
  assert.ok(result.command_id);
  assert.deepEqual(f.calls.map(c => c.method), ['helloConversationV4', 'initializeConversationV4', 'getTaskMeta', 'resumeTask', 'sendConversationCommandV4']);
  assert.equal(f.connections[0].closed, true);
});

test('compact 拒绝或回执未知时保留命令 ID，不重发并释放互斥', async () => {
  for (const [makeAck, pattern, status] of [
    [() => undefined, /compact_not_confirmed/, 'unknown'],
    [() => ({ commandId: 'wrong-command', status: 'accepted' }), /compact_not_confirmed/, 'unknown'],
    [envelope => ({ commandId: envelope.commandId, status: 'unexpected' }), /compact_not_confirmed/, 'unknown'],
    ...['rejected', 'stale', 'noop', 'failed'].map(status => [envelope => ({ commandId: envelope.commandId, status,
      reasonCode: 'compactOperationLock', message: 'Compact is already running or queued' }), /compact_not_accepted: compactOperationLock/, status])
  ]) {
    const f = await fixture({ sendConversationCommandV4: ([{ envelope }]) => makeAck(envelope) });
    await assert.rejects(f.controller.compactSession({ session_id: 'sess_working' }), error => {
      assert.match(error.message, pattern);
      assert.equal(error.partial_result.command_id, f.calls.at(-1).params[0].envelope.commandId);
      assert.equal(error.partial_result.session_id, 'sess_working');
      assert.equal(error.partial_result.command_status, status);
      if (status !== 'unknown') assert.equal(error.partial_result.reason_code, 'compactOperationLock');
      return true;
    });
    assert.equal(f.calls.filter(c => c.method === 'sendConversationCommandV4').length, 1);
    assert.equal(f.connections[0].closed, true);
    await f.controller.renameSession({ session_id: 'sess_new', title: '新标题' });
  }
  const f = await fixture({ sendConversationCommandV4: () => { throw new Error('fixture RPC timeout'); } });
  await assert.rejects(f.controller.compactSession({ session_id: 'sess_working' }), error => {
    assert.match(error.message, /fixture RPC timeout/);
    assert.equal(error.partial_result.command_status, 'unknown');
    assert.equal(error.partial_result.command_id, f.calls.at(-1).params[0].envelope.commandId);
    return true;
  });
  assert.equal(f.calls.filter(c => c.method === 'sendConversationCommandV4').length, 1);
  assert.equal(f.connections[0].closed, true);
  await f.controller.renameSession({ session_id: 'sess_new', title: '新标题' });
});

test('compact 仅等待 ACK，duplicate 不代表完成；回执后可继续发信', { timeout: 2000 }, async () => {
  const submitted = Promise.withResolvers(), ackGate = Promise.withResolvers();
  const f = await fixture({ sendConversationCommandV4: async ([{ envelope }]) => {
    if (envelope.type === 'compact') {
      submitted.resolve(); await ackGate.promise;
      return { commandId: envelope.commandId, status: 'duplicate', revisionAtDecision: 9 };
    }
    return { commandId: envelope.commandId, status: 'accepted',
      result: { type: 'inputAccepted', inputId: envelope.commandId, delivery: 'queue' } };
  } });
  let received = false;
  const compacting = f.controller.compactSession({ session_id: 'sess_working' }).then(result => { received = true; return result; });
  await submitted.promise;
  assert.equal(received, false);
  await assert.rejects(f.controller.sendMessage({ session_id: 'sess_working', message: '更新' }), /remote_busy/);
  assert.equal(f.connections.length, 1);
  ackGate.resolve();
  const result = await compacting;
  assert.equal(result.command_status, 'duplicate');
  assert.equal(f.connections[0].closed, true);
  assert.equal((await f.controller.sendMessage({ session_id: 'sess_working', message: '更新' })).delivery_status, 'accepted');
});

test('v4 握手失败或协议不支持时释放连接，不恢复会话或提交消息', async () => {
  for (const overrides of [
    { helloConversationV4: () => ({ protocolVersion: 99 }) },
    { initializeConversationV4: () => { throw new Error('fixture handshake failed'); } }
  ]) {
    const f = await fixture(overrides);
    await assert.rejects(f.controller.sendMessage({ session_id: 'sess_new', message: '短指令' }), /conversation_protocol_unsupported|fixture handshake failed/);
    assert.equal(f.calls.filter(c => ['resumeTask', 'sendConversationCommandV4'].includes(c.method)).length, 0);
    assert.equal(f.connections[0].closed, true);
  }
});

test('发信策略可缺省跟随宿主或显式 guide/queue，回执报告 Host 实际接收方式', async () => {
  for (const deliveryMode of [undefined, 'guide', 'queue']) {
    const f = await fixture({ sendConversationCommandV4: ([{ envelope }]) => ({
      commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 1,
      result: { type: 'inputAccepted', inputId: envelope.commandId, delivery: 'queue' }
    }) });
    const result = await f.controller.sendMessage({ session_id: 'sess_working', message: '状态更新',
      ...(deliveryMode === undefined ? {} : { delivery_mode: deliveryMode }) });
    const submitted = f.calls.at(-1);
    assert.equal(submitted.channel, 'zcode-agent');
    assert.equal(submitted.method, 'sendConversationCommandV4');
    const { envelope } = submitted.params[0];
    assert.equal(envelope.type, 'sendText');
    assert.equal(envelope.sessionId, 'sess_working');
    assert.equal(envelope.commandId, result.input_id);
    assert.equal(envelope.payload.text, wrapped('状态更新'));
    assert.equal(envelope.payload.heldQueueDisposition, 'keepQueueAndSend');
    assert.equal(envelope.payload.requestedDelivery, deliveryMode);
    assert.equal(Object.hasOwn(envelope.payload, 'requestedDelivery'), deliveryMode !== undefined);
    assert.equal(result.requested_delivery_mode, deliveryMode ?? 'host_default');
    assert.equal(result.admitted_delivery, 'queue');
    assert.equal(result.delivery_status, 'accepted');
    assert.equal(f.connections[0].closed, true);
  }
});

test('发信等待 Host ACK 后即回执，不等待工作中接收方结束或回复', { timeout: 2000 }, async () => {
  const submitted = Promise.withResolvers(), ackGate = Promise.withResolvers();
  const f = await fixture({
    getTaskMeta: () => ({ taskId: 'sess_working', workspacePath: workspace, status: 'running' }),
    sendConversationCommandV4: async ([{ envelope }]) => {
      submitted.resolve(); await ackGate.promise;
      return { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 1,
        result: { type: 'inputAccepted', inputId: envelope.commandId, delivery: 'queue' } };
    }
  });
  let received = false;
  const sending = f.controller.sendMessage({ session_id: 'sess_working', message: '报告' }).then(result => { received = true; return result; });
  await submitted.promise;
  assert.equal(received, false);
  ackGate.resolve();
  const receipt = await sending;
  assert.equal(receipt.delivery_status, 'accepted');
  assert.equal(receipt.admitted_delivery, 'queue');
  assert.deepEqual(f.calls.map(c => c.method), ['helloConversationV4', 'initializeConversationV4', 'getTaskMeta', 'resumeTask', 'sendConversationCommandV4']);
  assert.equal(f.connections[0].closed, true);
});

test('Host 拒绝、回执缺失或串号时不报告 accepted，保留本次输入标识且不重发', async () => {
  for (const [makeAck, pattern, deliveryStatus] of [
    [() => undefined, /delivery_not_confirmed/, 'unknown'],
    [envelope => ({ commandId: envelope.commandId, status: 'rejected', reasonCode: 'fixture.blocked' }), /send_not_accepted/, 'rejected'],
    [envelope => ({ commandId: envelope.commandId, status: 'accepted' }), /delivery_not_confirmed/, 'unknown'],
    [envelope => ({ commandId: envelope.commandId, status: 'accepted', result: { type: 'inputAccepted', inputId: 'wrong-input', delivery: 'queue' } }), /delivery_not_confirmed/, 'unknown']
  ]) {
    const f = await fixture({ sendConversationCommandV4: ([{ envelope }]) => makeAck(envelope) });
    await assert.rejects(f.controller.sendMessage({ session_id: 'sess_new', message: 'hello' }), error => {
      assert.match(error.message, pattern);
      assert.equal(error.partial_result.input_id, f.calls.at(-1).params[0].envelope.commandId);
      assert.equal(error.partial_result.session_id, 'sess_new');
      assert.equal(error.partial_result.delivery_status, deliveryStatus);
      return true;
    });
    assert.equal(f.calls.filter(c => c.method === 'sendConversationCommandV4').length, 1);
    assert.equal(f.connections[0].closed, true);
  }
  const f = await fixture({ sendConversationCommandV4: () => { throw new Error('fixture disconnected'); } });
  await assert.rejects(f.controller.sendMessage({ session_id: 'sess_new', message: 'hello' }), error => {
    assert.match(error.message, /fixture disconnected/);
    assert.equal(error.partial_result.input_id, f.calls.at(-1).params[0].envelope.commandId);
    assert.equal(error.partial_result.delivery_status, 'unknown');
    return true;
  });
  assert.equal(f.connections[0].closed, true);
});

test('开局标明 creator，后续信息标明 deliverer，来源与接收方 ID 分开', async () => {
  const f = await fixture();
  const created = await f.controller.startSession({ workspace_path: workspace, creator: 'sess_parent', message: '开局正文' });
  assert.equal(created.creator, 'sess_parent');
  assert.equal(created.session_id, 'sess_new');
  assert.equal(f.calls.at(-1).params[0].taskId, 'sess_new');
  assert.equal(f.calls.at(-1).params[0].content, '<created-by-other-session creator="sess_parent">\n<notice>\nYou are a new zcode session created by another zcode session or the system, instead of directly by the user.\n</notice>\n开局正文\n</created-by-other-session>');
  const sent = await f.controller.sendMessage({ session_id: created.session_id, deliverer: 'sess_sender', message: '后续正文' });
  assert.equal(sent.deliverer, 'sess_sender');
  assert.equal(sent.session_id, 'sess_new');
  assert.equal(f.calls.at(-1).params[0].envelope.sessionId, 'sess_new');
  assert.equal(f.calls.at(-1).params[0].envelope.payload.text, '<delivered-by-other-session deliverer="sess_sender">\n<notice>\nThe message in this block was delivered by other zcode session or the system, instead of the user.\n</notice>\n后续正文\n</delivered-by-other-session>');
});

test('来源 ID 在 XML 属性中转义，正文原样保留；不提供 ID 时省略属性和回执字段', async () => {
  const f = await fixture(), origin = 'sess_"<&>', body = '正文\n<raw>& text';
  const created = await f.controller.startSession({ workspace_path: workspace, creator: origin, message: body });
  assert.equal(created.creator, origin);
  assert.ok(f.calls.at(-1).params[0].content.startsWith('<created-by-other-session creator="sess_&quot;&lt;&amp;&gt;">'));
  assert.ok(f.calls.at(-1).params[0].content.includes('</notice>\n' + body + '\n</created-by-other-session>'));
  await f.controller.sendMessage({ session_id: created.session_id, deliverer: origin, message: body });
  assert.ok(f.calls.at(-1).params[0].envelope.payload.text.startsWith('<delivered-by-other-session deliverer="sess_&quot;&lt;&amp;&gt;">'));
  const anonymous = await f.controller.startSession({ workspace_path: workspace, message: body });
  assert.equal(Object.hasOwn(anonymous, 'creator'), false);
  assert.equal(f.calls.at(-1).params[0].content, opening(body));
  const sent = await f.controller.sendMessage({ session_id: anonymous.session_id, message: body });
  assert.equal(Object.hasOwn(sent, 'deliverer'), false);
  assert.equal(f.calls.at(-1).params[0].envelope.payload.text, wrapped(body));
});

test('归档检测主代理、后台/子代理、未完成任务及待交互，默认阻止且 force 后才写入', async () => {
  for (const patch of [
    s => { s.meta.status = 'running'; },
    s => { s.runtime.backgroundBashJobs = [{ jobId: 'job1', taskKind: 'bash', status: 'running' }]; },
    s => { s.runtime.backgroundBashJobs = [{ jobId: 'agent1', taskKind: 'agent', status: 'pending' }]; },
    s => { s.runtime.plan = [{ id: 'todo1', status: 'pending' }]; },
    s => { s.meta.target = { status: 'paused' }; },
    s => { s.runtime.pendingPermissions = [{ requestId: 'permission1' }]; }
  ]) {
    const f = await fixture({ getTaskSnapshot: () => {
      const s = { meta: { taskId: 'sess_new', status: 'completed' }, runtime: { plan: null, backgroundBashJobs: [], pendingCommands: [], pendingPermissions: [] } };
      patch(s); return s;
    } });
    const blocked = await f.controller.archiveSession({ session_id: 'sess_new' });
    assert.equal(blocked.status, 'confirmation_required');
    assert.equal(blocked.requires_confirmation, true);
    assert.ok(blocked.active_reasons.length);
    assert.equal(f.calls.filter(c => c.method === 'archiveTask').length, 0);
    const forced = await f.controller.archiveSession({ session_id: 'sess_new', force: true });
    assert.equal(forced.archived, true);
    assert.equal(forced.forced, true);
  }
});

test('闲置归档与复原读回索引；二次检查出现活动时拒绝归档', async () => {
  const f = await fixture();
  assert.equal((await f.controller.archiveSession({ session_id: 'sess_new' })).archived, true);
  assert.equal((await f.controller.restoreSession({ session_id: 'sess_new' })).archived, false);
  assert.equal(f.calls.filter(c => c.method === 'getTaskSnapshot').length, 2);
  let reads = 0;
  const raced = await fixture({ getTaskSnapshot: () => ({ meta: { taskId: 'sess_new', status: ++reads === 1 ? 'completed' : 'running' }, runtime: { plan: null, backgroundBashJobs: [], pendingCommands: [], pendingPermissions: [] } }) });
  assert.equal((await raced.controller.archiveSession({ session_id: 'sess_new' })).requires_confirmation, true);
  assert.equal(raced.calls.filter(c => c.method === 'archiveTask').length, 0);
});

test('缺少运行态不能猜闲置，即使 force 也不在未完成检查时写入', async () => {
  const f = await fixture({ getTaskSnapshot: () => ({ meta: { taskId: 'sess_new', status: 'completed' } }) });
  await assert.rejects(f.controller.archiveSession({ session_id: 'sess_new', force: true }), /activity_unknown/);
  assert.equal(f.calls.filter(c => c.method === 'archiveTask').length, 0);
});

test('锁名称是独立创建参数，true 在开局前写入公共策略', async () => {
  const f = await fixture();
  const result = await f.controller.startSession({ workspace_path: workspace, title: '固定名称', message: 'hello', lock_title: true });
  assert.equal(result.lock_title, true);
  assert.deepEqual(f.policies, [{ sessionId: 'sess_new', locked: true }]);
});

test('创建权限以首发后的 CLI 库为准，忽略创建响应中的陈旧 mode', async () => {
  let persisted = false;
  const f = await fixture({
    createTask: () => ({ taskId: 'sess_new', workspacePath: workspace, title: '默认标题', mode: 'build' }),
    sendPrompt: () => { persisted = true; },
    sessionMode: ({ session_id }) => {
      assert.equal(session_id, 'sess_new');
      assert.equal(persisted, true, '首次开局持久化后才读取 CLI 权限');
      return { mode: 'yolo', observed: ['yolo'] };
    }
  });
  const created = await f.controller.startSession({ workspace_path: workspace, message: 'hello', permissionMode: 'yolo' });
  assert.equal(created.permission_mode, 'yolo');
  assert.equal(created.delivery_status, 'accepted');
  assert.equal(f.calls.filter(c => c.method === 'sendPrompt').length, 1);
});

test('显式权限模式透传 createTask 并读回确认，继承警告随回执透出', async () => {
  const f = await fixture();
  const created = await f.controller.startSession({ workspace_path: workspace, message: 'hello', permissionMode: 'yolo' });
  assert.equal(created.permission_mode, 'yolo');
  assert.equal(f.calls[0].params[0].mode, 'yolo');
  const originWarning = { code: 'caller_context_conflict', message: '来源冲突', possible_session_ids: [] };
  const warned = await f.controller.startSession({ workspace_path: workspace, message: 'hello', permissionMode: 'plan',
    originWarning, permissionWarning: { code: 'permission_not_inherited', message: '不可继承' } });
  assert.deepEqual(warned.warnings, [originWarning, { code: 'permission_not_inherited', message: '不可继承' }]);
  assert.equal(warned.permission_mode, 'plan');
});

test('未决权限不向 createTask 添加 mode 字段，读回值如实返回', async () => {
  const f = await fixture();
  const created = await f.controller.startSession({ workspace_path: workspace, message: 'hello' });
  assert.equal(Object.hasOwn(f.calls[0].params[0], 'mode'), false);
  assert.equal(created.permission_mode, 'build');
  assert.equal(Object.hasOwn(created, 'warnings'), false);
});

test('CLI 权限读回不一致时报 permission_not_confirmed，保留已提交回执且不重发', async () => {
  const f = await fixture({ sessionMode: () => ({ mode: 'build', observed: ['build'] }) });
  await assert.rejects(f.controller.startSession({ workspace_path: workspace, message: 'hello', permissionMode: 'yolo' }),
    e => /permission_not_confirmed/.test(e.message) && e.partial_result.session_id === 'sess_new' &&
      e.partial_result.permission_mode === 'build' && e.partial_result.delivery_status === 'accepted' && !!e.partial_result.input_id);
  assert.equal(f.calls.filter(c => c.method === 'sendPrompt').length, 1);
});

test('创建响应缺少 mode 不影响 CLI 权限确认', async () => {
  const f = await fixture({ createTask: () => ({ taskId: 'sess_new', workspacePath: workspace, title: '默认标题' }) });
  const created = await f.controller.startSession({ workspace_path: workspace, message: 'hello', permissionMode: 'yolo' });
  assert.equal(created.delivery_status, 'accepted');
  assert.equal(created.permission_mode, 'yolo');
  assert.equal(Object.hasOwn(created, 'warnings'), false);
});

test('CLI 权限尚未落库时只重读不重发，最终缺失附未核实警告且不借用 meta.mode', async () => {
  for (const persistedAfter of [2, Infinity]) {
    let reads = 0;
    const f = await fixture({ sessionMode: () => ++reads >= persistedAfter ? { mode: 'yolo', observed: ['yolo'] } : { mode: null, observed: [] } });
    const created = await f.controller.startSession({ workspace_path: workspace, message: 'hello', permissionMode: 'yolo' });
    assert.equal(created.delivery_status, 'accepted');
    assert.equal(f.calls.filter(c => c.method === 'sendPrompt').length, 1);
    assert.equal(reads, persistedAfter === 2 ? 2 : 3);
    if (persistedAfter === 2) {
      assert.equal(created.permission_mode, 'yolo');
      assert.equal(Object.hasOwn(created, 'warnings'), false);
    } else {
      assert.deepEqual(created.warnings.map(w => w.code), ['permission_unverified']);
      assert.equal(Object.hasOwn(created, 'permission_mode'), false);
    }
  }
});

test('CLI 权限读取异常明确外溢，仍保留已提交信息且不重发', async () => {
  const f = await fixture({ sessionMode: () => { throw new Error('fixture database busy'); } });
  await assert.rejects(f.controller.startSession({ workspace_path: workspace, message: 'hello', permissionMode: 'yolo' }),
    e => /fixture database busy/.test(e.message) && e.partial_result.delivery_status === 'accepted' && !!e.partial_result.input_id &&
      !Object.hasOwn(e.partial_result, 'permission_mode'));
  assert.equal(f.calls.filter(c => c.method === 'sendPrompt').length, 1);
});

test('带名称创建未确认落库时保留提交信息，不改名不重发；权限缺失不等于行不存在', async () => {
  for (const persisted of [false, true]) {
    let reads = 0;
    const f = await fixture({ sessionMode: () => { reads++; return { mode: null, observed: persisted ? [null] : [] }; } });
    const request = f.controller.startSession({ workspace_path: workspace, message: 'hello', title: '指定名称' });
    if (!persisted) {
      await assert.rejects(request, error => {
        assert.match(error.message, /session_not_persisted/);
        assert.equal(error.partial_result.session_id, 'sess_new');
        assert.equal(error.partial_result.title, '默认标题');
        assert.equal(error.partial_result.delivery_status, 'accepted');
        assert.ok(error.partial_result.input_id);
        assert.deepEqual(error.partial_result.warnings.map(w => w.code), ['permission_unverified']);
        return true;
      });
      assert.equal(f.calls.filter(c => c.method === 'renameTask').length, 0);
    } else {
      const result = await request;
      assert.equal(result.title, '指定名称');
      assert.equal(result.delivery_status, 'accepted');
      assert.deepEqual(result.warnings.map(w => w.code), ['permission_unverified']);
      assert.equal(f.calls.filter(c => c.method === 'renameTask').length, 1);
    }
    assert.equal(reads, 3);
    assert.equal(f.calls.filter(c => c.method === 'sendPrompt').length, 1);
    assert.ok(f.connections.every(c => c.closed));
  }
});

test('省略名称和模型使用 Host 默认，RPC 参数不擅自添加选项', async () => {
  const f = await fixture();
  const result = await f.controller.startSession({ workspace_path: workspace, message: 'hello' });
  assert.equal(result.title, '默认标题');
  assert.deepEqual(f.calls.map(c => c.method), ['createTask', 'sendPrompt']);
  assert.deepEqual(f.calls[0].params, [{ workspacePath: workspace, deferPersistenceUntilFirstPrompt: true }]);
});

test('原 Host RPC 使用 bridge 的实际工作区路径，不使用调用方的别名形式', async () => {
  const f = await fixture();
  await f.controller.startSession({ workspace_path: 'D:/FIXTURE', message: 'hello' });
  assert.equal(f.calls[0].params[0].workspacePath, workspace);
  await f.controller.sendMessage({ workspace_path: 'D:/FIXTURE', session_id: 'sess_new', message: 'next' });
  assert.equal(f.calls.find(c => c.method === 'getTaskMeta').params[0].workspacePath, workspace);
});

test('无效模型在创建前拒绝；创建后的发送失败保留会话标识，不隐式重试', async () => {
  const f = await fixture({ sendPrompt: () => { throw new Error('fixture failed'); } });
  await assert.rejects(f.controller.startSession({ workspace_path: workspace, message: 'hello', model: { ...model, model_id: 'missing' } }), /model_not_available/);
  assert.equal(f.calls.filter(c => c.method === 'createTask').length, 0);
  await assert.rejects(f.controller.startSession({ workspace_path: workspace, creator: 'sess_parent', message: 'hello' }), e => e.partial_result.session_id === 'sess_new' && e.partial_result.creator === 'sess_parent' && /fixture failed/.test(e.message));
  assert.equal(f.calls.filter(c => c.method === 'sendPrompt').length, 1);
  assert.ok(f.connections.every(c => c.closed));
});

test('改名读回不一致与 RPC 失败明确报错，并释放连接', async () => {
  const f = await fixture();
  await assert.rejects(f.controller.renameSession({ session_id: 'sess_new', title: '与读回不一致' }), /rename_not_confirmed/);
  assert.ok(f.connections.every(c => c.closed));
});

test('创建后名称未确认保留首发提交回执，不重发并释放连接', async () => {
  const f = await fixture({ renameTask: () => ({ taskId: 'sess_new', title: '错误名称' }) });
  await assert.rejects(f.controller.startSession({ workspace_path: workspace, message: 'hello', title: '指定名称' }),
    e => /rename_not_confirmed/.test(e.message) && e.partial_result.session_id === 'sess_new' &&
      e.partial_result.delivery_status === 'accepted' && !!e.partial_result.input_id && e.partial_result.title === '默认标题');
  assert.equal(f.calls.filter(c => c.method === 'sendPrompt').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'renameTask').length, 1);
  assert.ok(f.connections.every(c => c.closed));
});

test('同一 MCP 的并发写请求明确拒绝，不建立争用席位的第二条连接', async () => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  const f = await fixture({ sendPrompt: async () => { started.resolve(); await gate.promise; } });
  const first = f.controller.startSession({ workspace_path: workspace, message: 'hello' });
  await started.promise;
  await assert.rejects(f.controller.startSession({ workspace_path: workspace, message: 'again' }), /remote_busy/);
  assert.equal(f.connections.length, 1);
  gate.resolve(); await first;
});

import test from 'node:test';
import assert from 'node:assert/strict';

const workspace = 'D:\\fixture';
const model = { provider_id: 'fixture', model_id: 'flash', reasoning_level: 'low' };
const wrapped = text => `<delivered-by-other-session>\n<notice>\nThe message in this block was delivered by other zcode session or the system, instead of the user.\n</notice>\n${text}\n</delivered-by-other-session>`;
async function fixture(overrides = {}) {
  const calls = [], connections = [], policies = []; let archived = false;
  const { createSessionController } = await import('../control.mjs');
  const controller = createSessionController({
    reader: { readSession: () => ({ session: { workspace_path: workspace } }), listSessions: () => ({ sessions: [{ session_id: 'sess_new', archived }] }) },
    loadAuthorization: async () => 'fixture-secret',
    setTitlePolicy: async args => { policies.push(args); },
    connect: async args => {
      const connection = { args, closed: false }; connections.push(connection);
      return { workspacePath: workspace, close: () => { connection.closed = true; }, call: async (channel, method, params) => {
        calls.push({ channel, method, params });
        if (overrides[method]) return overrides[method](params);
        if (method === 'getView') return { providers: [{ providerId: 'fixture', models: [{ modelId: 'flash', config: { optionSpecs: { reasoningLevel: { values: ['low'] } } } }] }] };
        if (method === 'createTask') return { taskId: 'sess_new', workspacePath: workspace, title: '默认标题' };
        if (method === 'getTaskMeta') return { taskId: params[0].taskId, workspacePath: workspace, title: '新标题' };
        if (method === 'renameTask') return { taskId: params[0].taskId, workspacePath: workspace, title: params[0].title };
        if (method === 'getTaskSnapshot') return { meta: { taskId: 'sess_new', status: 'completed' }, runtime: { plan: null, backgroundBashJobs: [], pendingCommands: [], pendingPermissions: [] } };
        if (method === 'archiveTask' || method === 'unarchiveTask') { archived = method === 'archiveTask'; return { taskId: params[0].taskId }; }
      } };
    }
  });
  return { controller, calls, connections, policies };
}

test('创建使用指定模型，先命名后发送带来源标识的开局信息；发信与改名可使用返回 ID', async () => {
  const f = await fixture();
  const created = await f.controller.startSession({ workspace_path: workspace, title: '新标题', message: '测试开局', model });
  assert.equal(created.session_id, 'sess_new');
  assert.equal(created.delivery_status, 'accepted');
  assert.equal(created.lock_title, false);
  assert.deepEqual(f.policies, [{ sessionId: 'sess_new', locked: false }]);
  assert.deepEqual(f.calls.map(c => c.method), ['getView', 'createTask', 'renameTask', 'sendPrompt']);
  assert.deepEqual(f.calls[1].params, [{ workspacePath: workspace, modelSelection: { providerId: 'fixture', modelId: 'flash', options: { reasoningLevel: 'low' } }, deferPersistenceUntilFirstPrompt: true }]);
  assert.equal(f.calls[3].params[0].content, wrapped('测试开局'));
  assert.equal(f.calls[3].params[0].traceId, created.input_id);
  assert.equal(f.connections[0].args.sessionId, undefined);
  const sent = await f.controller.sendMessage({ session_id: created.session_id, message: '第二次测试' });
  assert.notEqual(sent.input_id, created.input_id);
  assert.equal(f.calls.at(-1).params[0].content, wrapped('第二次测试'));
  assert.deepEqual(f.calls.slice(-3).map(c => c.method), ['getTaskMeta', 'resumeTask', 'sendPrompt']);
  const renamed = await f.controller.renameSession({ session_id: created.session_id, title: '新标题' });
  assert.equal(renamed.title, '新标题');
  assert.deepEqual(f.calls.slice(-2).map(c => c.method), ['renameTask', 'getTaskMeta']);
  assert.ok(f.connections.every(c => c.closed));
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
  await assert.rejects(f.controller.startSession({ workspace_path: workspace, message: 'hello' }), e => e.partial_result.session_id === 'sess_new' && /fixture failed/.test(e.message));
  assert.equal(f.calls.filter(c => c.method === 'sendPrompt').length, 1);
  assert.ok(f.connections.every(c => c.closed));
});

test('改名读回不一致与 RPC 失败明确报错，并释放连接', async () => {
  const f = await fixture();
  await assert.rejects(f.controller.renameSession({ session_id: 'sess_new', title: '与读回不一致' }), /rename_not_confirmed/);
  assert.ok(f.connections.every(c => c.closed));
});

test('创建时名称未确认则不发送开局，部分结果说明会话已经存在', async () => {
  const f = await fixture({ renameTask: () => ({ taskId: 'sess_new', title: '错误名称' }) });
  await assert.rejects(f.controller.startSession({ workspace_path: workspace, message: 'hello', title: '指定名称' }), e => /rename_not_confirmed/.test(e.message) && e.partial_result.session_id === 'sess_new');
  assert.equal(f.calls.filter(c => c.method === 'sendPrompt').length, 0);
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

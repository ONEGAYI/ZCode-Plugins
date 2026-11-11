import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from './fixtures.mjs';
import { commentHost, channelCommentHost, v4Snapshot, userRow, queueItem } from './comment-host-fixture.mjs';

test('原生工作树侧栏只写检出目录，评论按原项目路由并接受 3.18 工作树标记', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'comment-worktree-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = join(dir, 'project'), cwd = join(dir, 'worktree'), sessionId = 'session_worktree';
  for (const path of [host, cwd]) { await mkdir(path); await writeFile(join(path, 'same.txt'), path); }
  const indexDbPath = join(dir, 'index.sqlite'), db = new DatabaseSync(indexDbPath);
  db.exec(`CREATE TABLE tasks (task_id TEXT, workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT, root_path TEXT, worktree_root TEXT, host_id TEXT, project_id TEXT, execution_directories TEXT, deleted INTEGER);
    CREATE TABLE projects (project_id TEXT, host_id TEXT, name TEXT, deleted INTEGER);
    CREATE TABLE project_roots (project_id TEXT, root_path TEXT, position INTEGER);
    INSERT INTO projects VALUES ('p', 'local', 'Project', 0);`);
  db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('p', host, 0);
  db.prepare("INSERT INTO tasks VALUES (?,?,?,NULL,?,?,'local','p','[]',0)").run(sessionId, host, host, cwd, cwd);
  db.close();
  const batch = JSON.stringify({ schemaVersion: 1, batchId: 'worktree-batch', comments: [{ sessionId, workspacePath: cwd }] });
  const { text: _text, origin: _origin, ...base } = userRow('worktree');
  const marker = { ...base, kind: 'timelineMarker', marker: { type: 'worktreeCreated', path: cwd, sha: 'a'.repeat(40), ref: null, output: '' } };
  const rows = [marker, userRow(`文本编辑器选区评论（1 条）\n${batch}`, 2)];
  let phase = 'completedSuccess';
  const client = await connect(t, { workspaceRoot: cwd, indexDbPath, hostConnector: async options => {
    assert.equal(options.workspacePath, host);
    assert.equal(options.sessionId, sessionId);
    return commentHost({ options, rows: () => rows, snapshot() {
      const snapshot = v4Snapshot({ sessionId, rows });
      return { ...snapshot, control: { ...snapshot.control, phase, sessionEnded: phase === 'completedSuccess' } };
    }, onCall({ method, args }) {
      if (method === 'getTaskSnapshot') throw new Error('ZCode Agent runtime is not running.');
      if (['subscribeConversationV4', 'unsubscribeConversationV4', 'conversationRowsRangeV4'].includes(method))
        assert.equal(args[0].workspacePath, host);
    } });
  } });
  const call = (name, args = {}) => client.callTool({ name, arguments: args, _meta: { session_id: sessionId } });
  const context = (await call('get_editor_context')).structuredContent;
  assert.deepEqual(context.workspaceRoots, [cwd]);
  assert.equal((await call('read_editor_text', { path: 'same.txt', workspace_root: host })).structuredContent.code, 'workspace_not_allowed');
  const file = (await call('read_editor_text', { path: 'same.txt' })).structuredContent;
  assert.equal(file.text, cwd);
  assert.equal((await call('save_editor_text', { path: 'same.txt', text: 'edited', baseVersion: file.version })).isError, undefined);
  assert.equal(await readFile(join(cwd, 'same.txt'), 'utf8'), 'edited');
  assert.equal(await readFile(join(host, 'same.txt'), 'utf8'), host);
  const state = (await call('get_editor_comment_state')).structuredContent;
  assert.equal(state.state, 'idle', state.reason);
  assert.deepEqual(state.acceptedBatches, [{ batchId: 'worktree-batch', serialized: batch }]);
  phase = 'running';
  const busy = JSON.parse((await client.readResource({ uri: state.resourceUri })).contents[0].text);
  assert.equal(busy.state, 'busy', busy.reason);
});

test('评论状态通过公开V4读取ACK前自有快照，严格旧事件失败不妨碍完整受理', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-v4-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const sessionId = 'v4-fixture', calls = [], listeners = [], clients = [];
  let listener, disposed = 0, closed = 0;
  const client = await connect(t, { workspaceRoot, hostConnector: async options => ({
    listen(channel, event, args) {
      assert.equal(channel, 'zcode-agent'); assert.equal(event, 'onDynamicConversationFrame'); assert.deepEqual(args, { workspacePath: workspaceRoot });
      listeners.push(args); return callback => { listener = callback; return { dispose() { disposed++; listener = undefined; } }; };
    },
    async call(channel, method, args) {
      calls.push({ options, channel, method, args });
      if (method === 'getTaskSnapshot') return { meta: { taskId: sessionId, status: 'completed' }, runtime: {}, messages: [] };
      if (method === 'readSessionEvents') throw new Error('strict payload: Unrecognized key fullAccessSupported');
      if (method === 'helloConversationV4') { assert.deepEqual(args, []); return { protocolVersion: 3, clientMode: 'web-remote-replayable', capabilities: {} }; }
      if (method === 'initializeConversationV4') {
        const [hello] = args; assert.equal(hello.kind, 'clientHello'); assert.equal(hello.protocolVersion, 3); assert.equal(hello.clientKind, 'web');
        assert.equal(typeof hello.appVersion, 'string'); assert.match(hello.clientId, /^[a-f0-9-]{36}$/); assert.ok(!clients.includes(hello.clientId)); clients.push(hello.clientId); return {};
      }
      if (method === 'subscribeConversationV4') {
        assert.deepEqual(args, [{ workspacePath: workspaceRoot, sessionId, visibility: 'background' }]); assert.equal(typeof listener, 'function');
        listener({ wireVersion: 3, kind: 'complete', deliveryKind: 'initial', logicalFrameId: 'initial', logicalFrameOrdinal: 1,
          topic: `conversation/${sessionId}`, subscriptionId: 'owned-sub', frame: { topic: `conversation/${sessionId}`, subscriptionId: 'owned-sub', sentAt: 1, fromSeq: 0, toSeq: 7,
            payload: { kind: 'snapshot', snapshot: v4Snapshot({ sessionId, logEpoch: 'epoch', seq: 7, revision: 2 }) } } });
        return { ack: { subscriptionId: 'owned-sub', mode: 'snapshot', logEpoch: 'epoch' } };
      }
      if (method === 'conversationRowsRangeV4') return { rows: [], atSeq: 7, atRevision: 2, atLogEpoch: 'epoch', hasMore: false };
      if (method === 'unsubscribeConversationV4') { assert.deepEqual(args, [{ workspacePath: workspaceRoot, subscriptionId: 'owned-sub', runtimePolicy: 'existing-only' }]); return {}; }
      assert.fail(`未核公开方法：${method}`);
    }, close() { closed++; }
  }) });
  const result = (await client.callTool({ name: 'get_editor_comment_state', arguments: {}, _meta: { session_id: sessionId } })).structuredContent;
  assert.equal(result.state, 'idle', result.reason);
  assert.ok(!calls.some(call => call.method === 'readSessionEvents'), '不能继续调用严格拒绝新增字段的旧事件读取');
  assert.equal(listeners.length, 1); assert.equal(disposed, 1); assert.equal(closed, 1);
  assert.deepEqual(calls.filter(call => call.channel === 'zcode-agent').map(call => call.method), ['helloConversationV4', 'initializeConversationV4', 'subscribeConversationV4', 'unsubscribeConversationV4', 'conversationRowsRangeV4']);
});

test('公开V4官方分片完整组装，ACK前超过128片仍按自有队列完整正文确认', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-v4-fragments-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const sessionId = 'fragment-fixture', batch = { schemaVersion: 1, batchId: 'fragment-batch', comments: [{ sessionId, workspacePath: workspaceRoot, selectedText: '汉🙂'.repeat(20000), comment: '完整A' }] };
  const serialized = JSON.stringify(batch), input = `文本编辑器选区评论（1 条）\n${serialized}`, calls = [];
  const client = await connect(t, { workspaceRoot, hostConnector: async options => commentHost({ options, snapshot: () => v4Snapshot({ sessionId, queue: [queueItem(input), { ...queueItem(input.replace('fragment-batch', 'compact-batch')), kind: 'compact' }] }), maxPhysicalFrameBytes: 2500,
    onCall: call => calls.push(call), beforeAck(listener, frames) {
      assert.ok(frames.length > 128); assert.ok(frames.every(frame => frame.kind === 'fragment'));
      listener({ ...frames[0], subscriptionId: 'other-sub', fragmentCount: -1 });
      [...frames].reverse().forEach(listener); listener(frames[0]);
    } }) });
  const result = (await client.callTool({ name: 'get_editor_comment_state', arguments: {}, _meta: { session_id: sessionId } })).structuredContent;
  assert.equal(result.state, 'idle', result.reason); assert.deepEqual(result.acceptedBatches, [{ batchId: batch.batchId, serialized }]);
  assert.ok(!calls.some(call => call.method === 'readSessionEvents'));
});

test('公开V4坏分片不留证据，完整快照证明独立于随后失败的半份历史', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-v4-fault-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const sessionId = 'fault-fixture', batch = { schemaVersion: 1, batchId: 'fault-batch', comments: [{ sessionId, workspacePath: workspaceRoot, comment: '大正文'.repeat(5000) }] };
  const serialized = JSON.stringify(batch), input = `文本编辑器选区评论（1 条）\n${serialized}`;
  const historyOnly = input.replace('fault-batch', 'history-only-batch');
  let corrupt = true, failOlder = false; const rows = Array.from({ length: 201 }, (_, i) => userRow(i === 200 ? input : i === 1 ? historyOnly : `ordinary ${i}`, i + 1));
  const client = await connect(t, { workspaceRoot, hostConnector: async options => commentHost({ options, rows: () => rows, maxPhysicalFrameBytes: 2500,
    beforeAck(listener, frames) { frames.forEach(frame => listener(corrupt ? { ...frame, checksum: { ...frame.checksum, value: '00000000' } } : frame)); },
    page(query, snapshot) {
      if (failOlder && query.beforeRowId !== undefined) throw new Error('更早历史页读取失败');
      const selected = rows.filter(row => query.beforeRowId === undefined || row.rowId < query.beforeRowId);
      return { rows: selected.slice(-200), atSeq: snapshot.seq, atRevision: snapshot.revision, atLogEpoch: snapshot.logEpoch, hasMore: selected.length > 200 };
    } }) });
  const registration = (await client.callTool({ name: 'get_editor_comment_state', arguments: {}, _meta: { session_id: sessionId } })).structuredContent;
  assert.equal(registration.state, 'unknown'); assert.match(registration.reason, /公开帧校验失败/); assert.deepEqual(registration.acceptedBatches, []);
  const read = async () => JSON.parse((await client.readResource({ uri: registration.resourceUri })).contents[0].text);
  corrupt = false; failOlder = true; const partial = await read(); assert.equal(partial.state, 'unknown'); assert.match(partial.reason, /更早历史页读取失败/);
  assert.deepEqual(partial.acceptedBatches, [{ batchId: batch.batchId, serialized }], '完整权威快照中的A已经独立受理，半份历史的另一个批次不提交');
  rows.splice(0); failOlder = false; assert.deepEqual((await read()).acceptedBatches, partial.acceptedBatches, '只保留曾经完整校验的独立快照证明');
});

for (const lifecycle of ['unsubscribe', 'close']) test(`评论资源${lifecycle}时真实ChannelClient须保留载体直到迟到ACK退订`, async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-v4-late-ack-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const arrived = Promise.withResolvers(), release = Promise.withResolvers(), closed = Promise.withResolvers();
  let delayed = false, disposed = 0, remoteSubscribed = false, unsubscribes = 0; const calls = [];
  const client = await connect(t, { workspaceRoot, hostConnector: async options => {
    const late = delayed;
    return channelCommentHost({ options, onCall: ({ method }) => { if (late) { calls.push(method); if (method === 'unsubscribeConversationV4') { remoteSubscribed = false; unsubscribes++; } } },
      onClose: () => { if (late) closed.resolve(); }, onDispose: () => { if (late) disposed++; },
      beforeAck: late ? async (listener, frames) => { remoteSubscribed = true; frames.forEach(listener); arrived.resolve(); await release.promise; } : undefined });
  } });
  const uri = (await client.callTool({ name: 'get_editor_comment_state', arguments: {}, _meta: { session_id: 'late-ack' } })).structuredContent.resourceUri;
  delayed = true; const pending = client.readResource({ uri }).then(data => ({ data }), error => ({ error })); await arrived.promise;
  if (lifecycle === 'unsubscribe') await client.unsubscribeResource({ uri }); else await client.close();
  await new Promise(resolve => setImmediate(resolve)); release.resolve(); await closed.promise; const outcome = await pending;
  if (outcome.error) { assert.equal(lifecycle, 'close'); assert.match(outcome.error.message, /closed/i); }
  assert.equal(disposed, 1); assert.equal(unsubscribes, 1, '真实dispose拒绝在途RPC之前必须完成自有ACK与退订'); assert.equal(remoteSubscribed, false);
  assert.ok(!calls.includes('conversationRowsRangeV4'), '已释放资源的迟到订阅不得触发后续历史读取');
});

for (const failure of ['watermark', 'page-error']) test(`独立完整快照中的受理批次不因历史${failure}丢失`, async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-snapshot-proof-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const sessionId = 'snapshot-proof', batch = { schemaVersion: 1, batchId: 'known-batch', comments: [{ sessionId, workspacePath: workspaceRoot, comment: 'A' }] }, serialized = JSON.stringify(batch);
  let queue = [], broken = false; const client = await connect(t, { workspaceRoot, hostConnector: async options => commentHost({ options, queue: () => queue, page(_query, snapshot) {
    if (broken) { broken = false; queue = []; if (failure === 'page-error') throw new Error('确定性历史读取失败'); return { rows: [], atSeq: snapshot.seq + 1, atRevision: snapshot.revision + 1, atLogEpoch: snapshot.logEpoch, hasMore: false }; }
    return { rows: [], atSeq: snapshot.seq, atRevision: snapshot.revision, atLogEpoch: snapshot.logEpoch, hasMore: false };
  } }) });
  const uri = (await client.callTool({ name: 'get_editor_comment_state', arguments: {}, _meta: { session_id: sessionId } })).structuredContent.resourceUri;
  queue = [queueItem(`文本编辑器选区评论（1 条）\n${serialized}`)]; broken = true;
  const read = async () => JSON.parse((await client.readResource({ uri })).contents[0].text);
  const unknown = await read(); assert.equal(unknown.state, 'unknown'); assert.deepEqual(unknown.acceptedBatches, [{ batchId: batch.batchId, serialized }], '完整权威快照是独立受理证明，unknown仍须传递');
  const recovered = await read(); assert.equal(recovered.state, 'idle'); assert.deepEqual(recovered.acceptedBatches, unknown.acceptedBatches);
});

for (const reasonCode of ['gateway_timeout', 'gateway_connection_closed']) test(`等待自有ACK时${reasonCode}必须报告无法确认退订并结束载体`, async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-v4-carrier-fault-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const arrived = Promise.withResolvers(), release = Promise.withResolvers(), closed = Promise.withResolvers();
  const diagnostics = []; t.mock.method(console, 'error', message => diagnostics.push(message));
  let delayed = false, carrier, remoteSubscribed = false, unsubscribes = 0;
  const client = await connect(t, { workspaceRoot, hostConnector: async options => {
    assert.equal(options.timeoutMs, 6000, '载体沿用公共连接已有的整体RPC时限');
    const late = delayed, host = channelCommentHost({ options, onCall: ({ method }) => { if (late && method === 'unsubscribeConversationV4') { remoteSubscribed = false; unsubscribes++; } },
      onClose: () => { if (late) closed.resolve(); }, beforeAck: late ? async (listener, frames) => { remoteSubscribed = true; frames.forEach(listener); arrived.resolve(); await release.promise; } : undefined });
    if (late) carrier = host; return host;
  } });
  const uri = (await client.callTool({ name: 'get_editor_comment_state', arguments: {}, _meta: { session_id: 'carrier-fault' } })).structuredContent.resourceUri;
  delayed = true; const pending = client.readResource({ uri }).then(data => ({ data }), error => ({ error })); await arrived.promise;
  await client.unsubscribeResource({ uri });
  carrier.fail(Object.assign(new Error(reasonCode === 'gateway_timeout' ? '既有整体RPC时限已到' : '连接真实断开'), { reasonCode }));
  await closed.promise; await pending;
  assert.ok(diagnostics.some(message => message.includes('订阅未确认') && message.includes('无法取得退订标识') && message.includes(reasonCode === 'gateway_timeout' ? '时限已到' : '断开')));
  assert.equal(unsubscribes, 0); assert.equal(remoteSubscribed, true, '没有ACK就不能声称已清理Host订阅');
  assert.ok(carrier.requests.some(header => header[0] === 103), '失败后仍释放自身原事件监听');
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(carrier.call('zcode-agent', 'unsubscribeConversationV4', [{ subscriptionId: 'guessed' }]), /disposed|时限|断开/);
  console.log(JSON.stringify({ reasonCode, closed: true, unsubscribes, remoteSubscriptionConfirmedReleased: false, diagnostic: diagnostics[0] }));
});

test('可信登记的评论状态与文本可同时订阅，独立退订和会话隔离', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-state-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(join(workspaceRoot, 'a.txt'), 'original');
  const calls = [], state = { meta: { status: 'completed' }, runtime: {}, messages: [] };
  const client = await connect(t, { workspaceRoot, hostConnector: async options => commentHost({ options, state, onCall: call => calls.push(call) }) });
  const request = (name, session) => client.callTool({ name, arguments: name === 'read_editor_text' ? { path: 'a.txt' } : {}, _meta: { session_id: session } });
  const a = (await request('get_editor_comment_state', 'A')).structuredContent;
  assert.equal(a.state, 'idle');
  assert.match(a.resourceUri, /^ui:\/\/suian-side-editor\/comment-state\/[a-f0-9-]+$/);
  const b = (await request('get_editor_comment_state', 'B')).structuredContent;
  assert.notEqual(a.resourceUri, b.resourceUri);
  const text = (await request('read_editor_text', 'A')).structuredContent;
  await client.subscribeResource({ uri: a.resourceUri }); await client.subscribeResource({ uri: text.resourceUri });
  assert.equal(JSON.parse((await client.readResource({ uri: text.resourceUri })).contents[0].text).text, 'original');
  state.meta.status = 'running'; state.runtime.activeTurnKind = 'regular';
  assert.equal(JSON.parse((await client.readResource({ uri: a.resourceUri })).contents[0].text).state, 'busy');
  await client.unsubscribeResource({ uri: a.resourceUri });
  await assert.rejects(client.readResource({ uri: a.resourceUri }), /未登记/);
  assert.equal(JSON.parse((await client.readResource({ uri: text.resourceUri })).contents[0].text).text, 'original');
  await client.unsubscribeResource({ uri: text.resourceUri });
  await assert.rejects(client.readResource({ uri: text.resourceUri }), /未登记/);
  assert.equal(JSON.parse((await client.readResource({ uri: b.resourceUri })).contents[0].text).state, 'busy');
  assert.ok(calls.every(call => call.options.workspacePath === workspaceRoot));
  assert.ok(calls.some(call => call.options.sessionId === 'A') && calls.some(call => call.options.sessionId === 'B'));
});

test('评论工具拒绝伪造身份，网关未知不冒充空闲且状态资源不泄露聊天正文', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-context-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  let reachable = false, calls = 0;
  const client = await connect(t, { workspaceRoot, hostConnector: async options => {
    calls++; if (!reachable) throw Object.assign(new Error('公共网关尚未配置'), { reasonCode: 'gateway_not_configured' });
    return commentHost({ options, state: { meta: { status: 'paused' }, runtime: {}, messages: [{ role: 'user', content: '私密普通用户正文' }] } });
  } });
  const request = args => client.callTool({ name: 'get_editor_comment_state', arguments: args, _meta: { session_id: 'real' } });
  assert.equal((await request({ sessionId: 'other' })).isError, true); assert.equal(calls, 0);
  const missing = await client.callTool({ name: 'get_editor_comment_state', arguments: {} }); assert.equal(missing.structuredContent.code, 'session_binding_unavailable'); assert.equal(calls, 0);
  const unknown = (await request({})).structuredContent; assert.equal(unknown.state, 'unknown'); assert.match(unknown.reason, /公共网关尚未配置/);
  reachable = true;
  const snapshot = JSON.parse((await client.readResource({ uri: unknown.resourceUri })).contents[0].text);
  assert.equal(snapshot.state, 'unknown'); assert.doesNotMatch(JSON.stringify(snapshot), /私密普通用户正文/);
  await assert.rejects(client.readResource({ uri: 'ui://suian-side-editor/comment-state/guessed-session' }), /未登记/);
});

test('MCP连接关闭同时停止评论与文本订阅，不再读取Host', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-close-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(join(workspaceRoot, 'a.txt'), 'text'); let calls = 0;
  const client = await connect(t, { workspaceRoot, hostConnector: async options => commentHost({ options, onCall: () => { calls++; } }) });
  const request = (name, args = {}) => client.callTool({ name, arguments: args, _meta: { session_id: 'close' } });
  const comment = (await request('get_editor_comment_state')).structuredContent, text = (await request('read_editor_text', { path: 'a.txt' })).structuredContent;
  await client.subscribeResource({ uri: comment.resourceUri }); await client.subscribeResource({ uri: text.resourceUri });
  await client.close(); const atClose = calls; await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(calls, atClose);
});

for (const lifecycle of ['unsubscribe', 'close']) test(`评论状态${lifecycle}后握手迟到与已排队刷新不得读取Host`, async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-late-host-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const arrived = Promise.withResolvers(), release = Promise.withResolvers(), lateClosed = Promise.withResolvers();
  const calls = []; let delayed = false, lateConnections = 0;
  const client = await connect(t, { workspaceRoot, hostConnector: async options => {
    const late = delayed;
    if (late) { lateConnections++; arrived.resolve(); await release.promise; }
    return commentHost({ options, onCall: ({ method }) => { if (late) calls.push(method); }, onClose: () => { if (late) lateClosed.resolve(); } });
  } });
  const uri = (await client.callTool({ name: 'get_editor_comment_state', arguments: {}, _meta: { session_id: 'late' } })).structuredContent.resourceUri;
  delayed = true;
  const pending = Promise.allSettled([client.readResource({ uri }), client.readResource({ uri })]);
  await arrived.promise;
  if (lifecycle === 'unsubscribe') await client.unsubscribeResource({ uri }); else await client.close();
  release.resolve(); await lateClosed.promise; await pending; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [], '失效资源的迟到连接必须立即关闭，不读取会话或启动事件读取服务');
  assert.equal(lateConnections, 1, '已排队刷新不得在资源失效后重新握手');
});

test('评论状态退订后快照回执迟到不得继续开始V4订阅', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-late-snapshot-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const arrived = Promise.withResolvers(), release = Promise.withResolvers(); let delayed = false; const lateCalls = [];
  const client = await connect(t, { workspaceRoot, hostConnector: async options => commentHost({ options, onCall: async ({ method }) => {
    if (delayed) { lateCalls.push(method); if (method === 'getTaskSnapshot') { arrived.resolve(); await release.promise; } }
  } }) });
  const uri = (await client.callTool({ name: 'get_editor_comment_state', arguments: {}, _meta: { session_id: 'late' } })).structuredContent.resourceUri;
  delayed = true; const pending = client.readResource({ uri }); await arrived.promise;
  await client.unsubscribeResource({ uri }); release.resolve(); await pending;
  assert.deepEqual(lateCalls, ['getTaskSnapshot'], '正在执行的快照无法撤回，但退订后的V4初始化与订阅不能开始');
});

test('评论公开历史分页补齐超尾窗缺口，失败不提交证据，识别批次保留到资源释放', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'comment-event-cursor-')); t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const sessionId = 'cursor-fixture', rows = [userRow('baseline')], queries = [];
  let failPage = false, invalidWatermark = false;
  const client = await connect(t, { workspaceRoot, hostConnector: async options => commentHost({ options, rows: () => rows, page(query, snapshot) {
    queries.push(query);
    if (failPage) throw new Error('历史分页读取确定性失败');
    const selected = rows.filter(row => query.beforeRowId === undefined || row.rowId < query.beforeRowId);
    return { rows: selected.slice(-query.limit), atSeq: snapshot.seq, atRevision: snapshot.revision + (invalidWatermark ? 1 : 0), atLogEpoch: snapshot.logEpoch, hasMore: selected.length > query.limit };
  } }) });
  const register = () => client.callTool({ name: 'get_editor_comment_state', arguments: {}, _meta: { session_id: sessionId } });
  const uri = (await register()).structuredContent.resourceUri;
  const batch = { schemaVersion: 1, batchId: 'batch-A', comments: [{ commentId: 'comment-A', sessionId, workspacePath: workspaceRoot, path: join(workspaceRoot, 'a.txt'), title: 'a.txt', startLine: 1, endLine: 1, selectedText: 'selected', comment: 'A', unsaved: true }] };
  const serialized = JSON.stringify(batch), input = `文本编辑器选区评论（1 条）\n${serialized}`;
  rows.push(userRow(input, 2));
  for (let i = 0; i < 201; i++) rows.push(userRow(`ordinary ${i}`, i + 3));
  const read = async () => JSON.parse((await client.readResource({ uri })).contents[0].text);
  failPage = true; assert.equal((await read()).state, 'unknown');
  failPage = false; invalidWatermark = true; assert.equal((await read()).state, 'unknown', '不一致水位不能混成消费证明');
  invalidWatermark = false; const recovered = await read();
  assert.equal(recovered.state, 'idle'); assert.deepEqual(recovered.acceptedBatches, [{ batchId: 'batch-A', serialized }]);
  assert.equal(queries.at(-1).beforeRowId, 4, '下一页必须使用上一页最早rowId'); assert.equal(queries.at(-1).limit, 200);
  rows.splice(0); const notifiedThenRead = await read(); assert.deepEqual(notifiedThenRead.acceptedBatches, recovered.acceptedBatches, '后续快照没有旧行仍保留已经识别的受理证据');
  await client.unsubscribeResource({ uri }); await assert.rejects(client.readResource({ uri }), /未登记/);
  const fresh = (await register()).structuredContent; assert.notEqual(fresh.resourceUri, uri); assert.deepEqual(fresh.acceptedBatches, [], '退订释放旧资源的记忆，新资源只取其首次基线');
});

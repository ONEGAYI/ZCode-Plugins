import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fixture } from './fixtures.mjs';

test('MCP 握手公布九个工具，三个查询工具保持只读', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha', title: 'MCP 工具' });
  f.session({ id: 'sess_alpha', title: 'MCP 工具' });
  f.message({ id: 'msg_user', sequence: 0, parts: [{ type: 'text', text: '实现只读工具' }] });
  const { createMcpServer } = await import('../server.mjs');
  const server = createMcpServer(f);
  const client = new Client({ name: 'contract-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ['list_sessions', 'read_session', 'rename_session', 'start_session', 'send_message', 'archive_session', 'restore_session', 'get_glm_balance', 'reset_glm_quota']);
  for (const tool of listed.tools) assert.equal(tool.annotations.readOnlyHint, ['list_sessions', 'read_session', 'get_glm_balance'].includes(tool.name));
  assert.equal(listed.tools.at(-1).annotations.destructiveHint, true);
  assert.equal(listed.tools.at(-1).annotations.idempotentHint, false);
  const list = await client.callTool({ name: 'list_sessions', arguments: { query: 'MCP', limit: 1 } });
  assert.equal(list.structuredContent.sessions[0].session_id, 'sess_alpha');
  assert.deepEqual(JSON.parse(list.content[0].text), list.structuredContent);
  const chat = await client.callTool({ name: 'read_session', arguments: { session_id: 'sess_alpha' } });
  assert.equal(chat.structuredContent.messages[0].text, '实现只读工具');
});

test('创建和发信自动读取每次 MCP 请求的来源会话，接口不接受手填来源 ID', async t => {
  const f = fixture(t), calls = [];
  const { createMcpServer } = await import('../server.mjs');
  const controller = Object.fromEntries(['startSession', 'sendMessage'].map(method => [method, async args => {
    calls.push({ method, args });
    return { session_id: 'sess_child', ...args };
  }]));
  const server = createMcpServer(f, { controller });
  const client = new Client({ name: 'origin-contract', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const listed = await client.listTools();
  assert.equal(Object.hasOwn(listed.tools.find(tool => tool.name === 'start_session').inputSchema.properties, 'creator'), false);
  assert.equal(Object.hasOwn(listed.tools.find(tool => tool.name === 'send_message').inputSchema.properties, 'deliverer'), false);
  const created = await client.callTool({ name: 'start_session', arguments: { workspace_path: 'D:/fixture', message: 'hello' },
    _meta: { 'com.zcode/request-context': { session_id: 'sess_parent' } } });
  assert.equal(created.isError, undefined);
  assert.equal(calls[0].args.creator, 'sess_parent');
  const sent = await client.callTool({ name: 'send_message', arguments: { session_id: 'sess_child', message: 'next' },
    _meta: { session_id: 'sess_subagent_sender' } });
  assert.equal(sent.isError, undefined);
  assert.equal(calls[1].args.deliverer, 'sess_subagent_sender');
  assert.equal(calls[1].args.session_id, 'sess_child');
  for (const [name, args] of [
    ['start_session', { workspace_path: 'D:/fixture', message: 'hello', creator: 'sess_forged' }],
    ['send_message', { session_id: 'sess_child', message: 'next', deliverer: 'sess_forged' }]
  ]) assert.equal((await client.callTool({ name, arguments: args, _meta: { session_id: 'sess_parent' } })).isError, true);
  assert.equal(calls.length, 2);
});

test('请求缺少会话 ID 时按 trace_id 和工具名从本地调用记录精确定位来源', async t => {
  const f = fixture(t), calls = [];
  f.history.exec(`CREATE TABLE tool_usage (session_id TEXT, trace_id TEXT, tool_name TEXT);
    INSERT INTO tool_usage VALUES ('sess_parent', 'trace_create', 'mcp__fixture__start_session');
    INSERT INTO tool_usage VALUES ('sess_parent', 'trace_create', 'mcp__fixture__start_session');
    INSERT INTO tool_usage VALUES ('sess_wrong', 'trace_create', 'mcp__fixture__read_session');
    INSERT INTO tool_usage VALUES ('sess_sender', 'trace_send', 'mcp__fixture__send_message');`);
  const { createMcpServer } = await import('../server.mjs');
  const controller = Object.fromEntries(['startSession', 'sendMessage'].map(method => [method, async args => {
    calls.push({ method, args }); return args;
  }]));
  const server = createMcpServer(f, { controller });
  const client = new Client({ name: 'trace-contract', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const created = await client.callTool({ name: 'start_session', arguments: { workspace_path: 'D:/fixture', message: 'hello' },
    _meta: { trace_id: 'trace_create' } });
  assert.equal(created.isError, undefined);
  assert.equal(calls[0].args.creator, 'sess_parent');
  const sent = await client.callTool({ name: 'send_message', arguments: { session_id: 'sess_child', message: 'next' },
    _meta: { 'com.zcode/request-context': { trace_id: 'trace_send' } } });
  assert.equal(sent.isError, undefined);
  assert.equal(calls[1].args.deliverer, 'sess_sender');
  assert.equal(f.history.prepare('SELECT COUNT(*) n FROM tool_usage').get().n, 4);
});

test('来源缺失或元数据损坏时在创建和发信前报错', async t => {
  const f = fixture(t), calls = [];
  f.history.exec(`CREATE TABLE tool_usage (session_id TEXT, trace_id TEXT, tool_name TEXT);
    INSERT INTO tool_usage VALUES ('sess_a', 'trace_shared', 'mcp__fixture__start_session');
    INSERT INTO tool_usage VALUES ('sess_b', 'trace_shared', 'mcp__fixture__start_session');
    INSERT INTO tool_usage VALUES ('sess_a', 'trace_shared', 'mcp__fixture__send_message');
    INSERT INTO tool_usage VALUES ('sess_b', 'trace_shared', 'mcp__fixture__send_message');`);
  const { createMcpServer } = await import('../server.mjs');
  const controller = Object.fromEntries(['startSession', 'sendMessage'].map(method => [method, async args => {
    calls.push({ method, args }); return args;
  }]));
  const server = createMcpServer(f, { controller });
  const client = new Client({ name: 'unknown-origin-contract', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  for (const [meta, error] of [
    [undefined, 'caller_unknown'],
    [{ session_id: ' ' }, 'caller_context_invalid'],
    [{ session_id: 42 }, 'caller_context_invalid'],
    [{ 'com.zcode/request-context': null }, 'caller_context_invalid'],
    [{ trace_id: 'trace_not_recorded' }, 'caller_unknown'],
  ]) for (const [name, args] of [
    ['start_session', { workspace_path: 'D:/fixture', message: 'hello' }],
    ['send_message', { session_id: 'sess_child', message: 'next' }]
  ]) {
    const response = await client.callTool({ name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });
    assert.equal(response.isError, true);
    assert.ok(response.structuredContent.error.startsWith(error + ':'), response.structuredContent.error);
    assert.equal(response.structuredContent.session_id, undefined);
  }
  assert.equal(calls.length, 0);
});

test('来源冲突降级为警告并继续创建和发信，候选来源仅作为未确认信息写入 notice', async t => {
  const f = fixture(t), prompts = [];
  f.history.exec(`CREATE TABLE tool_usage (session_id TEXT, trace_id TEXT, tool_name TEXT);
    INSERT INTO tool_usage VALUES ('sess_a', 'trace_shared', 'mcp__fixture__start_session');
    INSERT INTO tool_usage VALUES ('sess_b', 'trace_shared', 'mcp__fixture__start_session');
    INSERT INTO tool_usage VALUES ('sess_a', 'trace_shared', 'mcp__fixture__send_message');
    INSERT INTO tool_usage VALUES ('sess_b', 'trace_shared', 'mcp__fixture__send_message');`);
  const { createSessionController } = await import('../control.mjs');
  const { createMcpServer } = await import('../server.mjs');
  const controller = createSessionController({ reader: { readSession: () => ({ session: { workspace_path: 'D:/fixture' } }) },
    setTitlePolicy: async () => {},
    connect: async () => ({ workspacePath: 'D:/fixture', close() {}, call: async (channel, method, params) => {
      if (method === 'createTask' || method === 'getTaskMeta') return { taskId: 'sess_child', workspacePath: 'D:/fixture', title: '默认标题' };
      if (method === 'sendPrompt') prompts.push(params[0]);
    } }) });
  const server = createMcpServer(f, { controller });
  const client = new Client({ name: 'conflicting-origin-contract', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  for (const [meta, code, candidates] of [
    [{ session_id: 'sess_a', 'com.zcode/request-context': { session_id: 'sess_b' } }, 'caller_context_conflict', ['sess_a', 'sess_b']],
    [{ trace_id: 'trace_shared' }, 'caller_ambiguous', ['sess_a', 'sess_b']],
    [{ trace_id: 'trace_a', 'com.zcode/request-context': { trace_id: 'trace_b' } }, 'caller_context_conflict', []]
  ]) for (const [name, args, role] of [
    ['start_session', { workspace_path: 'D:/fixture', message: 'hello' }, 'creator'],
    ['send_message', { session_id: 'sess_child', message: 'next' }, 'deliverer']
  ]) {
    const response = await client.callTool({ name, arguments: args, _meta: meta });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.delivery_status, 'accepted');
    assert.equal(response.structuredContent[role], undefined);
    assert.equal(response.structuredContent.warnings[0].code, code);
    assert.deepEqual(response.structuredContent.warnings[0].possible_session_ids, candidates);
    assert.ok(!prompts.at(-1).content.includes(` ${role}="`));
    assert.ok(prompts.at(-1).content.includes('session could not be confirmed'));
    if (candidates.length) assert.ok(prompts.at(-1).content.includes(`Possible ${role} session IDs (unverified): ["sess_a","sess_b"]`));
  }
  assert.equal(prompts.length, 6);
});

test('本地调用记录中的 NULL 或空白来源 ID 在进入写流程前报告损坏', async t => {
  const f = fixture(t), calls = [];
  f.history.exec(`CREATE TABLE tool_usage (session_id TEXT, trace_id TEXT, tool_name TEXT);
    INSERT INTO tool_usage VALUES (NULL, 'trace_null', 'mcp__fixture__start_session');
    INSERT INTO tool_usage VALUES (' ', 'trace_blank', 'mcp__fixture__start_session');
    INSERT INTO tool_usage VALUES (NULL, 'trace_null', 'mcp__fixture__send_message');
    INSERT INTO tool_usage VALUES ('', 'trace_empty', 'mcp__fixture__send_message');`);
  const { createMcpServer } = await import('../server.mjs');
  const controller = Object.fromEntries(['startSession', 'sendMessage'].map(method => [method, async args => {
    calls.push({ method, args }); return args;
  }]));
  const server = createMcpServer(f, { controller });
  const client = new Client({ name: 'corrupt-history-origin-contract', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  for (const [name, args, trace] of [
    ['start_session', { workspace_path: 'D:/fixture', message: 'hello' }, 'trace_null'],
    ['start_session', { workspace_path: 'D:/fixture', message: 'hello' }, 'trace_blank'],
    ['send_message', { session_id: 'sess_child', message: 'next' }, 'trace_null'],
    ['send_message', { session_id: 'sess_child', message: 'next' }, 'trace_empty']
  ]) {
    const response = await client.callTool({ name, arguments: args, _meta: { trace_id: trace } });
    assert.equal(response.isError, true);
    assert.match(response.structuredContent.error, /^caller_context_invalid:/);
  }
  assert.equal(calls.length, 0);
});

test('自动定位的 ID 进入开局和后续消息 XML 及回执，不混入接收方 ID', async t => {
  const f = fixture(t), prompts = [];
  const { createSessionController } = await import('../control.mjs');
  const { createMcpServer } = await import('../server.mjs');
  const controller = createSessionController({ reader: { readSession: () => ({ session: { workspace_path: 'D:/fixture' } }) },
    setTitlePolicy: async () => {},
    connect: async () => ({ workspacePath: 'D:/fixture', close() {}, call: async (channel, method, params) => {
      if (method === 'createTask' || method === 'getTaskMeta') return { taskId: 'sess_child', workspacePath: 'D:/fixture', title: '默认标题' };
      if (method === 'sendPrompt') prompts.push(params[0]);
    } }) });
  const server = createMcpServer(f, { controller });
  const client = new Client({ name: 'origin-message-contract', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const created = await client.callTool({ name: 'start_session', arguments: { workspace_path: 'D:/fixture', message: '开局正文' },
    _meta: { session_id: 'sess_parent', 'com.zcode/request-context': { session_id: 'sess_parent' } } });
  assert.equal(created.structuredContent.creator, 'sess_parent');
  assert.equal(created.structuredContent.session_id, 'sess_child');
  assert.equal(prompts[0].taskId, 'sess_child');
  assert.equal(prompts[0].content, '<created-by-other-session creator="sess_parent">\n<notice>\nYou are a new zcode session created by another zcode session or the system, instead of directly by the user.\n</notice>\n开局正文\n</created-by-other-session>');
  const sent = await client.callTool({ name: 'send_message', arguments: { session_id: 'sess_child', message: '后续正文' },
    _meta: { session_id: 'sess_sender' } });
  assert.equal(sent.structuredContent.deliverer, 'sess_sender');
  assert.equal(sent.structuredContent.session_id, 'sess_child');
  assert.equal(prompts[1].taskId, 'sess_child');
  assert.equal(prompts[1].content, '<delivered-by-other-session deliverer="sess_sender">\n<notice>\nThe message in this block was delivered by other zcode session or the system, instead of the user.\n</notice>\n后续正文\n</delivered-by-other-session>');
});

test('MCP 额度查询路由与重置表单确认；不支持确认或自行填 confirmed 字段时拒绝', async t => {
  const f = fixture(t), prompts = [], resetCalls = [];
  const { createMcpServer } = await import('../server.mjs');
  const controller = { getGlmBalance: async args => ({ source: 'fixture', workspace_path: args.workspace_path }),
    resetGlmQuota: async (args, { requestConfirmation }) => {
      resetCalls.push(args);
      const decision = await requestConfirmation({ account: 'fixture***', reset_type: args.reset_type, available_cards: 3, earliest_expires_at: '2027-01-15T09:00:00Z', remaining_percent: 16, retry: false });
      return { used: decision.action === 'accept' && decision.content.confirm === true };
    } };
  const server = createMcpServer(f, { controller });
  const client = new Client({ name: 'confirmation-client', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => { prompts.push(request.params); return { action: 'accept', content: { confirm: true } }; });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const args = { workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' };
  assert.equal((await client.callTool({ name: 'get_glm_balance', arguments: { workspace_path: 'D:/fixture' } })).structuredContent.source, 'fixture');
  assert.equal((await client.callTool({ name: 'reset_glm_quota', arguments: { ...args, confirmed: true } })).isError, true);
  assert.equal((await client.callTool({ name: 'reset_glm_quota', arguments: { ...args, reset_type: 'MONTH' } })).isError, true);
  assert.equal(resetCalls.length, 0);
  assert.equal((await client.callTool({ name: 'reset_glm_quota', arguments: args })).structuredContent.used, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].requestedSchema.properties.confirm.default, false);
  assert.match(prompts[0].message, /一张/);
  const plainServer = createMcpServer(f, { controller });
  const plainClient = new Client({ name: 'no-confirmation', version: '1.0.0' });
  const [pct, pst] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await plainClient.close(); await plainServer.close(); });
  await plainServer.connect(pst); await plainClient.connect(pct);
  const blocked = await plainClient.callTool({ name: 'reset_glm_quota', arguments: args });
  assert.equal(blocked.isError, true);
  assert.match(blocked.structuredContent.error, /confirmation_unavailable/);
  assert.equal(resetCalls.length, 1);
});

test('三个写工具转交已验证参数，拒绝空开局和未知字段，部分创建错误返回会话 ID', async t => {
  const f = fixture(t), calls = [];
  const { createMcpServer } = await import('../server.mjs');
  const controller = Object.fromEntries(['renameSession', 'startSession', 'sendMessage'].map(method => [method, async args => {
    calls.push({ method, args });
    if (args.message === 'fail') throw Object.assign(new Error('send failed'), { partial_result: { session_id: 'sess_created' } });
    return { session_id: 'sess_created', title: args.title ?? '默认标题' };
  }]));
  const server = createMcpServer(f, { controller });
  const client = new Client({ name: 'write-contract', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  for (const [name, args] of [
    ['start_session', { workspace_path: 'D:/fixture', message: 'hello', model: { provider_id: 'fixture', model_id: 'flash', reasoning_level: 'low' } }],
    ['send_message', { session_id: 'sess_created', message: 'next' }],
    ['rename_session', { session_id: 'sess_created', title: '测试' }]
  ]) assert.equal((await client.callTool({ name, arguments: args, _meta: { session_id: name === 'send_message' ? 'sess_sender' : 'sess_parent' } })).structuredContent.session_id, 'sess_created');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].args.creator, 'sess_parent');
  assert.equal(calls[1].args.deliverer, 'sess_sender');
  assert.equal((await client.callTool({ name: 'start_session', arguments: { workspace_path: 'D:/fixture', message: 'hello', creator: ' ' } })).isError, true);
  assert.equal((await client.callTool({ name: 'send_message', arguments: { session_id: 'sess_created', message: 'hello', deliverer: ' ' } })).isError, true);
  assert.equal((await client.callTool({ name: 'start_session', arguments: { workspace_path: 'D:/fixture', message: 'hello', deliverer: 'sess_sender' } })).isError, true);
  assert.equal((await client.callTool({ name: 'send_message', arguments: { session_id: 'sess_created', message: 'hello', creator: 'sess_parent' } })).isError, true);
  assert.equal((await client.callTool({ name: 'start_session', arguments: { workspace_path: 'D:/fixture', message: ' ' } })).isError, true);
  assert.equal((await client.callTool({ name: 'send_message', arguments: { session_id: 'sess_created', message: 'hello', sql: 'write' } })).isError, true);
  assert.equal(calls.length, 3);
  const failed = await client.callTool({ name: 'start_session', arguments: { workspace_path: 'D:/fixture', message: 'fail' }, _meta: { session_id: 'sess_parent' } });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.session_id, 'sess_created');
});

test('renameSession 写后复核：CLI 会话库持续不一致时暴露 title_store_diverged，同步后无警告', async () => {
  const { createSessionController } = await import('../control.mjs');
  const probes = [];
  const make = sessionTitle => createSessionController({
    reader: { readSession: () => ({ session: { workspace_path: 'D:/fixture' } }),
      sessionTitle: ({ session_id }) => { probes.push(session_id); return { index_title: '新标题', session_title: sessionTitle }; } },
    connect: async () => ({ workspacePath: 'D:/fixture', close() {}, call: async (channel, method) => {
      if (method === 'renameTask') return { taskId: 'sess_x', title: '新标题' };
      if (method === 'getTaskMeta') return { taskId: 'sess_x', workspacePath: 'D:/fixture', title: '新标题' };
    } }),
    delay: async () => {}
  });
  const diverged = await make('旧标题').renameSession({ workspace_path: 'D:/fixture', session_id: 'sess_x', title: '新标题' });
  assert.equal(diverged.title, '新标题', 'RPC 成功路径不受复核影响');
  assert.equal(diverged.warnings.length, 1);
  assert.equal(diverged.warnings[0].code, 'title_store_diverged');
  assert.equal(diverged.warnings[0].message.includes('旧标题'), true, '告警须带 CLI 库实际标题且用 message 字段（与来源警告一致）');
  assert.equal(probes.length, 3, '持续不一致时重试 3 次');
  const synced = await make('新标题').renameSession({ workspace_path: 'D:/fixture', session_id: 'sess_x', title: '新标题' });
  assert.equal(synced.warnings, undefined, '两库一致时不产生警告');
  assert.equal(probes.length, 4, '一致时只探测一次');
});

test('reader 复核探测抛错时视为无法核实：不告警、不把成功的 RPC 变成工具错误', async () => {
  const { createSessionController } = await import('../control.mjs');
  const controller = createSessionController({
    reader: { readSession: () => ({ session: { workspace_path: 'D:/fixture' } }),
      sessionTitle: () => { throw new Error('SQLITE_BUSY fixture'); } },
    connect: async () => ({ workspacePath: 'D:/fixture', close() {}, call: async (channel, method) => {
      if (method === 'renameTask') return { taskId: 'sess_x', title: '新标题' };
      if (method === 'getTaskMeta') return { taskId: 'sess_x', workspacePath: 'D:/fixture', title: '新标题' };
    } }),
    delay: async () => {}
  });
  const result = await controller.renameSession({ workspace_path: 'D:/fixture', session_id: 'sess_x', title: '新标题' });
  assert.equal(result.title, '新标题');
  assert.equal(result.warnings, undefined, '探测异常不得外溢为错误，也不得误告警');
});

test('startSession 部分失败时 partial_result 保留来源警告，复核不阻断开局消息投递', async () => {
  const { createSessionController } = await import('../control.mjs');
  const originWarning = { code: 'caller_ambiguous', message: 'fixture 来源歧义', possible_session_ids: ['sess_a', 'sess_b'] };
  const controller = createSessionController({
    reader: { readSession: () => ({ session: { workspace_path: 'D:/fixture' } }),
      sessionTitle: () => ({ index_title: '初始标题', session_title: '初始标题' }) },
    setTitlePolicy: async () => {},
    connect: async () => ({ workspacePath: 'D:/fixture', close() {}, call: async (channel, method) => {
      if (method === 'createTask') return { taskId: 'sess_child', workspacePath: 'D:/fixture', title: '默认标题' };
      if (method === 'renameTask') return { taskId: 'sess_child', title: '不匹配的响应' };
    } }),
    delay: async () => {}
  });
  await assert.rejects(controller.startSession({ workspace_path: 'D:/fixture', title: '初始标题', message: '调研', originWarning }),
    error => {
      assert.equal(error.partial_result.warnings.length, 1);
      assert.equal(error.partial_result.warnings[0].code, 'caller_ambiguous');
      assert.equal(error.partial_result.delivery_status, 'unknown');
      return true;
    });
});

test('startSession 创建后复核：CLI 库有行但标题不符暴露分叉；行未落库或旧版 reader 不告警', async () => {
  const { createSessionController } = await import('../control.mjs');
  const prompts = [];
  const make = sessionTitle => createSessionController({
    reader: { readSession: () => ({ session: { workspace_path: 'D:/fixture' } }),
      ...(sessionTitle === 'absent' ? {} : { sessionTitle: () => ({ index_title: '初始标题', session_title: sessionTitle }) }) },
    setTitlePolicy: async () => {},
    connect: async () => ({ workspacePath: 'D:/fixture', close() {}, call: async (channel, method, params) => {
      if (method === 'createTask') return { taskId: 'sess_child', workspacePath: 'D:/fixture', title: '默认标题' };
      if (method === 'renameTask') return { taskId: 'sess_child', title: '初始标题' };
      if (method === 'sendPrompt') prompts.push(params[0]);
    } }),
    delay: async () => {}
  });
  const diverged = await make('宿主生成标题').startSession({ workspace_path: 'D:/fixture', title: '初始标题', message: '调研' });
  assert.deepEqual(diverged.warnings.map(w => w.code), ['title_store_diverged'], '官方 v4 同步丢失时当场暴露分叉');
  const notPersisted = await make(null).startSession({ workspace_path: 'D:/fixture', title: '初始标题', message: '调研' });
  assert.equal(notPersisted.warnings, undefined, 'CLI 库尚无会话行时无法判定，不告警');
  const legacy = await make('absent').startSession({ workspace_path: 'D:/fixture', title: '初始标题', message: '调研' });
  assert.equal(legacy.warnings, undefined, '旧版 reader 无 sessionTitle 能力时不阻塞不误报');
  const untitled = await make('任意值').startSession({ workspace_path: 'D:/fixture', message: '调研' });
  assert.equal(untitled.warnings, undefined, '未指定标题时不复核');
  assert.equal(prompts.length, 4, '复核不改变消息投递行为');
});

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
  ]) assert.equal((await client.callTool({ name, arguments: args })).structuredContent.session_id, 'sess_created');
  assert.equal(calls.length, 3);
  assert.equal((await client.callTool({ name: 'start_session', arguments: { workspace_path: 'D:/fixture', message: ' ' } })).isError, true);
  assert.equal((await client.callTool({ name: 'send_message', arguments: { session_id: 'sess_created', message: 'hello', sql: 'write' } })).isError, true);
  assert.equal(calls.length, 3);
  const failed = await client.callTool({ name: 'start_session', arguments: { workspace_path: 'D:/fixture', message: 'fail' } });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.session_id, 'sess_created');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fixture } from './fixtures.mjs';

test('MCP 握手公布七个工具，原两个读取工具保持只读', async t => {
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
  assert.deepEqual(listed.tools.map(tool => tool.name), ['list_sessions', 'read_session', 'rename_session', 'start_session', 'send_message', 'archive_session', 'restore_session']);
  for (const tool of listed.tools.slice(0, 2)) assert.equal(tool.annotations.readOnlyHint, true);
  for (const tool of listed.tools.slice(2)) assert.equal(tool.annotations.readOnlyHint, false);
  const list = await client.callTool({ name: 'list_sessions', arguments: { query: 'MCP', limit: 1 } });
  assert.equal(list.structuredContent.sessions[0].session_id, 'sess_alpha');
  assert.deepEqual(JSON.parse(list.content[0].text), list.structuredContent);
  const chat = await client.callTool({ name: 'read_session', arguments: { session_id: 'sess_alpha' } });
  assert.equal(chat.structuredContent.messages[0].text, '实现只读工具');
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

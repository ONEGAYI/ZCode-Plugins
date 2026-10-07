import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fixture } from './fixtures.mjs';

test('MCP 握手后只公布两个只读工具，客户端可查询列表和读取正文', async t => {
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
  assert.deepEqual(listed.tools.map(tool => tool.name), ['list_sessions', 'read_session']);
  for (const tool of listed.tools) assert.equal(tool.annotations.readOnlyHint, true);
  const list = await client.callTool({ name: 'list_sessions', arguments: { query: 'MCP', limit: 1 } });
  assert.equal(list.structuredContent.sessions[0].session_id, 'sess_alpha');
  assert.deepEqual(JSON.parse(list.content[0].text), list.structuredContent);
  const chat = await client.callTool({ name: 'read_session', arguments: { session_id: 'sess_alpha' } });
  assert.equal(chat.structuredContent.messages[0].text, '实现只读工具');
});

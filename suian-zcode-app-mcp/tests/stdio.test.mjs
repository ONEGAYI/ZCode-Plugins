import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { fixture } from './fixtures.mjs';

test('独立 stdio 进程完成握手、分页、消息读取与错误反馈，双库字节不变', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha', updated: 10 }); f.session({ id: 'sess_alpha' });
  f.task({ id: 'sess_beta', workspace: 'D:\\work\\beta', updated: 20 });
  f.message({ id: 'msg_user', sequence: 0, parts: [{ type: 'text', text: '读取目标' }] });
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const before = [digest(f.indexDbPath), digest(f.sessionDbPath)];
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../cli.mjs', import.meta.url)), '--index-db', f.indexDbPath, '--session-db', f.sessionDbPath, '--auth-data-dir', join(dirname(f.indexDbPath), 'auth')],
    stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'stdio-contract', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 7);
  const first = (await client.callTool({ name: 'list_sessions', arguments: { limit: 1 } })).structuredContent;
  assert.equal(first.sessions[0].session_id, 'sess_beta');
  const second = (await client.callTool({ name: 'list_sessions', arguments: { limit: 1, offset: first.next_offset } })).structuredContent;
  assert.equal(second.sessions[0].session_id, 'sess_alpha');
  const chat = await client.callTool({ name: 'read_session', arguments: { session_id: 'sess_alpha' } });
  assert.equal(chat.structuredContent.messages[0].text, '读取目标');
  const missing = await client.callTool({ name: 'read_session', arguments: { session_id: 'sess_missing' } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /session_not_found/);
  const invalid = await client.callTool({ name: 'list_sessions', arguments: { limit: -1 } });
  assert.equal(invalid.isError, true);
  const extra = await client.callTool({ name: 'read_session', arguments: { session_id: 'sess_alpha', sql: 'DROP TABLE session' } });
  assert.equal(extra.isError, true);
  const unauthorized = await client.callTool({ name: 'send_message', arguments: { session_id: 'sess_alpha', message: 'hello', workspace_path: 'D:/fixture' } });
  assert.equal(unauthorized.isError, true);
  assert.match(unauthorized.content[0].text, /authorization_required/);
  assert.deepEqual([digest(f.indexDbPath), digest(f.sessionDbPath)], before);
  await client.close();
  assert.equal(stderr, '');
});

test('授权配置入口从 stdin 保存当前用户 DPAPI 密文，不启动 MCP、不输出链接', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), dir = join(dirname(f.indexDbPath), 'auth');
  const secret = 'https://zcode.z.ai/remote/v4?sid=fixture&hash=fixture-hash&mid=fixture-mid';
  const child = execFile(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), '--save-authorization', '--auth-data-dir', dir], { windowsHide: true });
  child.stdin.end(JSON.stringify({ authorization_url: secret }));
  const completed = await new Promise((resolve, reject) => {
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error('save auth exit ' + code)));
  });
  assert.deepEqual(JSON.parse(completed), { ok: true, authorization: 'saved' });
  assert.ok(!completed.includes(secret));
  const { loadAuthorization } = await import('../../suian-zcode-common/auth-store.mjs');
  assert.equal(await loadAuthorization({ dataDir: dir }), secret);
  assert.ok(!readFileSync(join(dir, 'remote.blob'), 'utf8').includes('fixture-hash'));
});

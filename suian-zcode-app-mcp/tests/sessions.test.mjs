import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';

test('按更新时间跨工作区列出最近 N 条，包含置顶但排除删除与归档项', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_old', updated: 10 });
  f.task({ id: 'sess_pinned', updated: 20, pinned: 1 });
  f.task({ id: 'sess_latest', workspace: 'D:\\work\\beta', updated: 30 });
  f.task({ id: 'sess_archived', updated: 40, archived: 1 });
  f.task({ id: 'sess_deleted', updated: 50, deleted: 1 });
  const { createSessionReader } = await import('../sessions.mjs');
  const result = createSessionReader(f).listSessions({ limit: 2 });
  assert.deepEqual(result.sessions.map(s => s.session_id), ['sess_latest', 'sess_pinned']);
  assert.equal(result.sessions[1].pinned, true);
  assert.equal(result.total, 3);
  assert.equal(result.next_offset, 2);
  assert.equal(result.source, 'local_tasks_index');
  assert.equal(f.index.prepare('SELECT COUNT(*) n FROM tasks').get().n, 5);
});

test('没有回退时正常返回未记录父标识的可见助手消息', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha' }); f.session({ id: 'sess_alpha' });
  f.message({ id: 'msg_reply', role: 'assistant', sequence: 0, parts: [{ type: 'text', text: '历史回复' }] });
  const { createSessionReader } = await import('../sessions.mjs');
  const page = createSessionReader(f).readSession({ session_id: 'sess_alpha' });
  assert.equal(page.messages[0].text, '历史回复');
  assert.equal(page.messages[0].parent_message_id, null);
  assert.equal(page.branch, 'persisted');
});

test('非正文 part 的布尔合成标记仍参与官方可见性判断', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha' }); f.session({ id: 'sess_alpha' });
  f.message({ id: 'msg_visible', sequence: 0 });
  f.message({ id: 'msg_hidden_part', sequence: 1, parts: [
    { type: 'text', text: '内部材料' }, { type: 'file', synthetic: true, filename: 'internal.txt' }
  ] });
  const { createSessionReader } = await import('../sessions.mjs');
  const result = createSessionReader(f).readSession({ session_id: 'sess_alpha' });
  assert.deepEqual(result.messages.map(m => m.message_id), ['msg_visible']);
});

test('不存在、已删除、远端或重复 ID 明确报错，不用空聊天掩盖失败', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_deleted', deleted: 1 });
  f.session({ id: 'sess_deleted' });
  f.task({ id: 'sess_remote', identity: 'ssh:example', key: 'ssh:example/work' });
  f.task({ id: 'sess_duplicate', key: 'local-a' });
  f.task({ id: 'sess_duplicate', key: 'local-b' });
  f.session({ id: 'sess_duplicate' });
  f.task({ id: 'sess_no_history' });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  assert.throws(() => reader.readSession({ session_id: 'sess_deleted' }), /session_not_found/);
  assert.throws(() => reader.readSession({ session_id: 'sess_unknown' }), /session_not_found/);
  assert.throws(() => reader.readSession({ session_id: 'sess_remote' }), /remote_history_unavailable/);
  assert.throws(() => reader.readSession({ session_id: 'sess_duplicate' }), /ambiguous_session/);
  assert.throws(() => reader.readSession({ session_id: 'sess_no_history' }), /history_not_found/);
  assert.equal(reader.readSession({ session_id: 'sess_duplicate', workspace_key: 'local-a' }).messages.length, 0);
  assert.equal(f.index.prepare('SELECT COUNT(*) n FROM tasks').get().n, 5);
});

test('持久化回退分支与可见规则排除废弃、合成、压缩和隐藏消息', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha' });
  f.session({ id: 'sess_alpha', revert: { targetMessageID: 'msg_discard', keptMessageIDs: ['msg_kept'], createdMessageID: 'msg_new' } });
  f.message({ id: 'msg_kept', sequence: 0 });
  f.message({ id: 'msg_discard', sequence: 1 });
  f.message({ id: 'msg_hidden', sequence: 2, info: { visibility: 'model-only' } });
  f.message({ id: 'msg_new', sequence: 3 });
  f.message({ id: 'msg_notice', role: 'assistant', parent: 'msg_new', sequence: 4,
    parts: [{ type: 'text', text: 'Rewound conversation to before message msg_discard.' }] });
  f.message({ id: 'msg_summary', role: 'assistant', sequence: 5, info: { summary: true } });
  f.message({ id: 'msg_goal', sequence: 6, info: { synthetic: true, source: 'goal-continuation' } });
  f.message({ id: 'msg_reply', role: 'assistant', parent: 'msg_new', sequence: 7,
    parts: [{ type: 'text', text: '正确回复' }, { type: 'text', text: '忽略正文', ignored: true }, { type: 'tool', output: '机密工具输出' }] });
  f.message({ id: 'msg_file', sequence: 8, parts: [{ type: 'file', filename: 'example.png', mime: 'image/png', url: 'data:secret' }] });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  const page = reader.readSession({ session_id: 'sess_alpha' });
  assert.deepEqual(page.messages.map(m => m.message_id), ['msg_kept', 'msg_new', 'msg_reply', 'msg_file']);
  assert.equal(page.messages[2].text, '正确回复');
  assert.deepEqual(page.messages[3].attachments, [{ filename: 'example.png', mime: 'image/png' }]);
  assert.equal(page.branch, 'persisted_revert');
  assert.equal(JSON.stringify(page).includes('secret'), false);
  assert.throws(() => reader.readSession({ session_id: 'sess_alpha', before_message_id: 'msg_discard' }), /游标/);
  f.history.prepare('UPDATE session SET revert=? WHERE id=?').run(JSON.stringify({ targetMessageID: 'msg_discard', createdMessageID: 'msg_new' }), 'sess_alpha');
  assert.deepEqual(reader.readSession({ session_id: 'sess_alpha' }).messages.map(m => m.message_id), ['msg_kept', 'msg_new', 'msg_reply', 'msg_file']);
});

test('读取最近消息保留完整正文，按持久化 sequence 排序并返回更早页游标', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha', title: 'MCP 设计' });
  f.session({ id: 'sess_alpha', title: 'MCP 设计' });
  f.message({ id: 'msg_user', sequence: 0, time: 100, parts: [{ type: 'text', text: '目标' }] });
  f.message({ id: 'msg_later', sequence: 2, time: 1, role: 'assistant', parent: 'msg_user',
    parts: [{ type: 'text', text: '完整正文'.repeat(1000) }] });
  f.message({ id: 'msg_middle', sequence: 1, time: 200, role: 'assistant', parent: 'msg_user',
    parts: [{ type: 'text', text: '中间回复' }] });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  assert.equal(typeof reader.readSession, 'function');
  const page = reader.readSession({ session_id: 'sess_alpha', limit: 2 });
  assert.deepEqual(page.messages.map(m => m.message_id), ['msg_middle', 'msg_later']);
  assert.equal(page.messages[1].text, '完整正文'.repeat(1000));
  assert.equal(page.messages[1].parent_message_id, 'msg_user');
  assert.equal(page.source, 'local_cli_sqlite');
  assert.equal(page.total, 3);
  assert.equal(page.next_before_message_id, 'msg_middle');
  assert.equal(page.session.title, 'MCP 设计');
  const earlier = reader.readSession({ session_id: 'sess_alpha', before_message_id: page.next_before_message_id });
  assert.deepEqual(earlier.messages.map(m => m.message_id), ['msg_user']);
  assert.equal(earlier.next_before_message_id, null);
});

test('按工作区、名字或 ID 搜索，分页稳定且通配符按字面匹配', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha', title: '设计 MCP', updated: 30 });
  f.task({ id: 'sess_beta', title: '实现 MCP', updated: 30 });
  f.task({ id: 'sess_other', title: 'MCP', workspace: 'D:\\work\\beta', updated: 40 });
  f.task({ id: 'sess_percent', title: '100% 完成', updated: 20, archived: 1 });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  const first = reader.listSessions({ workspace_path: 'd:/WORK/alpha/', query: 'mcp', limit: 1 });
  assert.deepEqual(first.sessions.map(s => s.session_id), ['sess_alpha']);
  assert.equal(first.total, 2);
  assert.equal(first.next_offset, 1);
  const second = reader.listSessions({ workspace_path: 'D:\\work\\alpha', query: 'MCP', limit: 1, offset: 1 });
  assert.deepEqual(second.sessions.map(s => s.session_id), ['sess_beta']);
  assert.equal(second.next_offset, null);
  assert.equal(reader.listSessions({ query: 'sess_beta' }).sessions[0].title, '实现 MCP');
  assert.equal(reader.listSessions({ query: '%', include_archived: true }).sessions[0].session_id, 'sess_percent');
  assert.equal(reader.listSessions({ query: "' OR 1=1 --" }).total, 0);
  assert.equal(reader.listSessions({ workspace_path: 'D:\\missing' }).total, 0);
});

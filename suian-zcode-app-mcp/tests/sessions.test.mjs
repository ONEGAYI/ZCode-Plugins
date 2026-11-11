import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';

test('原生工作树历史按执行目录校验，会话控制仍附着原项目', async t => {
  const f = fixture(t);
  const host = 'D:/work/alpha', cwd = 'D:/worktrees/alpha/packages/ui', id = 'session_worktree';
  f.task({ id, workspace: host, pinned: 1 });
  f.session({ id, directory: cwd });
  f.index.exec('ALTER TABLE tasks ADD COLUMN project_id TEXT; ALTER TABLE tasks ADD COLUMN host_id TEXT; ALTER TABLE tasks ADD COLUMN root_path TEXT; ALTER TABLE tasks ADD COLUMN worktree_root TEXT; ALTER TABLE tasks ADD COLUMN execution_directories TEXT;');
  f.index.exec("CREATE TABLE projects (project_id TEXT, host_id TEXT, name TEXT, deleted INTEGER); CREATE TABLE project_roots (project_id TEXT, root_path TEXT, position INTEGER); INSERT INTO projects VALUES ('project','local','Project',0);");
  f.index.prepare('INSERT INTO project_roots VALUES (?,?,0)').run('project', host);
  f.index.prepare("UPDATE tasks SET host_id='local', project_id='project', execution_directories='[]', root_path=?, worktree_root=?").run(cwd, 'D:/worktrees/alpha');
  const { createSessionReader } = await import('../sessions.mjs');
  const { createSessionController } = await import('../control.mjs');
  const reader = createSessionReader(f);
  const page = await reader.readSession({ session_id: id });
  assert.equal(page.session.workspace_path, cwd);
  assert.equal(page.session.host_workspace_path, host);
  assert.equal(reader.listSessionStates({ session_id: id, workspace_path: host })[0].host_workspace_path, host);
  const overview = await reader.sessionOverview({ session_id: id });
  assert.equal(overview.workspace_path, cwd);
  assert.equal(overview.host_workspace_path, host);
  for (const list of ['listSessions', 'listPinnedSessions']) {
    const { sessions } = reader[list]({ workspace_path: cwd });
    assert.deepEqual(sessions.map(s => [s.session_id, s.workspace_path, s.host_workspace_path]), [[id, cwd, host]]);
    assert.equal(reader[list]({ workspace_path: host }).total, 0, '路径筛选只匹配执行目录，项目归属用 project_id');
  }
  assert.equal(reader.listSessions({ project_id: 'project', query: cwd }).total, 1);
  const controller = createSessionController({ reader, connect: async options => {
    assert.equal(options.workspacePath, host);
    assert.equal(options.sessionId, id);
    return { workspacePath: host, close() {}, async call(channel, method, [args]) {
      assert.equal(channel, 'zcode-task');
      assert.equal(method, 'getTaskSnapshot');
      assert.equal(args.workspacePath, host);
      return { meta: { taskId: id, status: 'completed' } };
    } };
  } });
  assert.equal((await controller.getSessionStatus({ session_id: id })).status, 'completed');
  f.history.prepare('UPDATE session SET directory=?').run(host);
  await assert.rejects(reader.readSession({ session_id: id }), /workspace_mismatch/);
  f.history.prepare('UPDATE session SET directory=?').run(cwd);
  f.index.exec('UPDATE tasks SET worktree_root=NULL');
  await assert.rejects(reader.readSession({ session_id: id }), /workspace_mismatch/);
});

test('list_sessions 置顶优先，置顶内部与非置顶各自按更新时间排序，排除删除与归档项', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_old', updated: 10 });
  f.task({ id: 'sess_pinned', updated: 20, pinned: 1 });
  f.task({ id: 'sess_pinned_older', updated: 15, pinned: 1 });
  f.task({ id: 'sess_latest', workspace: 'D:\\work\\beta', updated: 30 });
  f.task({ id: 'sess_archived', updated: 40, archived: 1 });
  f.task({ id: 'sess_deleted', updated: 50, deleted: 1 });
  const { createSessionReader } = await import('../sessions.mjs');
  const result = createSessionReader(f).listSessions({ limit: 3 });
  // 置顶区在前且内部 mtime 优先（20>15），最新的非置顶会话排在置顶区之后
  assert.deepEqual(result.sessions.map(s => s.session_id), ['sess_pinned', 'sess_pinned_older', 'sess_latest']);
  assert.equal(result.sessions[0].pinned, true);
  assert.equal(result.sessions[2].pinned, false);
  assert.equal(result.total, 4);
  assert.equal(result.next_offset, 3);
  assert.equal(result.source, 'local_tasks_index');
  assert.equal(f.index.prepare('SELECT COUNT(*) n FROM tasks').get().n, 6);
});

test('listPinnedSessions 只列置顶行，默认排除归档与删除，可显式含归档置顶并分页', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_pinned_a', updated: 10, pinned: 1 });
  f.task({ id: 'sess_pinned_b', workspace: 'D:\\work\\beta', updated: 30, pinned: 1 });
  f.task({ id: 'sess_pinned_archived', updated: 40, pinned: 1, archived: 1 });
  f.task({ id: 'sess_normal', updated: 50 });
  f.task({ id: 'sess_pinned_deleted', updated: 60, pinned: 1, deleted: 1 });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  const result = reader.listPinnedSessions({});
  assert.deepEqual(result.sessions.map(s => s.session_id), ['sess_pinned_b', 'sess_pinned_a']);
  assert.equal(result.total, 2);
  assert.equal(result.next_offset, null);
  assert.ok(result.sessions.every(s => s.pinned === true));
  assert.equal(result.source, 'local_tasks_index');
  const withArchived = reader.listPinnedSessions({ include_archived: true });
  assert.deepEqual(withArchived.sessions.map(s => s.session_id), ['sess_pinned_archived', 'sess_pinned_b', 'sess_pinned_a']);
  assert.equal(withArchived.total, 3);
  assert.equal(withArchived.next_offset, null);
  const scoped = reader.listPinnedSessions({ workspace_path: 'D:/work/beta/' });
  assert.deepEqual(scoped.sessions.map(s => s.session_id), ['sess_pinned_b']);
  const paged = reader.listPinnedSessions({ include_archived: true, limit: 2 });
  assert.deepEqual(paged.sessions.map(s => s.session_id), ['sess_pinned_archived', 'sess_pinned_b']);
  assert.equal(paged.next_offset, 2);
});

test('listSessionStates 按 task_id 精确定位写后读回行，含归档、排除删除并支持工作区消歧', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_target', updated: 10, pinned: 1, archived: 1 });
  f.task({ id: 'sess_target', workspace: 'D:\\work\\beta', key: 'kb', updated: 20, pinned: 0 });
  f.task({ id: 'sess_target_substring_sess_target_x', updated: 30 });
  f.task({ id: 'sess_target_deleted', updated: 40, deleted: 1, pinned: 1 });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  // 子串命中行与目标行无关：精确定位不受子串/分页干扰，归档行参与、删除行排除
  const both = reader.listSessionStates({ session_id: 'sess_target' });
  assert.equal(both.length, 2);
  assert.deepEqual(both.map(row => [row.session_id, row.pinned, row.archived]),
    [['sess_target', true, true], ['sess_target', false, false]]);
  const byKey = reader.listSessionStates({ session_id: 'sess_target', workspace_key: 'kb' });
  assert.equal(byKey.length, 1);
  assert.equal(byKey[0].archived, false);
  const byPath = reader.listSessionStates({ session_id: 'sess_target', workspace_path: 'd:/work/beta' });
  assert.equal(byPath.length, 1);
  assert.equal(byPath[0].pinned, false);
  assert.equal(reader.listSessionStates({ session_id: 'sess_missing' }).length, 0);
});

test('列表与读取带 permission_mode，sessionMode 供继承发起者权限', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha', mode: 'yolo' });
  f.task({ id: 'sess_beta', mode: 'plan' });
  f.session({ id: 'sess_alpha', permission: { mode: 'yolo' } });
  f.message({ id: 'msg_user', session: 'sess_alpha', sequence: 0 });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  assert.deepEqual(reader.listSessions({}).sessions.map(s => [s.session_id, s.permission_mode]),
    [['sess_alpha', 'yolo'], ['sess_beta', 'plan']]);
  assert.equal((await reader.readSession({ session_id: 'sess_alpha' })).session.permission_mode, 'yolo');
  assert.equal(reader.sessionMode({ session_id: 'sess_alpha' }).mode, 'yolo');
  assert.deepEqual(reader.sessionMode({ session_id: 'sess_alpha' }).observed, ['yolo']);
  assert.equal(reader.sessionMode({ session_id: 'sess_missing' }).mode, null);
  assert.deepEqual(reader.sessionMode({ session_id: 'sess_missing' }).observed, []);
  f.task({ id: 'sess_deleted', mode: 'yolo', deleted: 1 });
  assert.equal(reader.sessionMode({ session_id: 'sess_deleted' }).mode, null);
});

test('sessionMode 只读取 CLI 权限，任务索引分叉或缺失不影响结果', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_dupe', mode: 'build' });
  f.task({ id: 'sess_dupe', workspace: 'D:\\work\\beta', mode: 'yolo' });
  f.session({ id: 'sess_dupe', permission: { mode: 'edit' } });
  f.session({ id: 'sess_without_index', permission: { mode: 'plan' } });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  assert.deepEqual(reader.sessionMode({ session_id: 'sess_dupe' }), { mode: 'edit', observed: ['edit'] });
  assert.deepEqual(reader.sessionMode({ session_id: 'sess_without_index' }), { mode: 'plan', observed: ['plan'] });
});

test('sessionMode 不用索引补齐缺失的 CLI 权限，损坏 JSON 明确报错', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_null', mode: 'yolo' });
  f.session({ id: 'sess_null' });
  f.session({ id: 'sess_no_mode', permission: {} });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  for (const id of ['sess_null', 'sess_no_mode'])
    assert.deepEqual(reader.sessionMode({ session_id: id }), { mode: null, observed: [null] });
  f.history.prepare('UPDATE session SET permission=? WHERE id=?').run('{broken', 'sess_null');
  assert.throws(() => reader.sessionMode({ session_id: 'sess_null' }), /malformed JSON/);
});

test('损坏的消息角色或 text 数据形状明确报错，不能当作空聊天', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha' }); f.session({ id: 'sess_alpha' });
  f.message({ id: 'msg_user', sequence: 0 });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  f.history.prepare('UPDATE message SET data=? WHERE id=?').run('null', 'msg_user');
  await assert.rejects(() => reader.readSession({ session_id: 'sess_alpha' }), /history_format_error/);
  f.history.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify({ role: 'system' }), 'msg_user');
  await assert.rejects(() => reader.readSession({ session_id: 'sess_alpha' }), /history_format_error/);
  f.history.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify({ role: 'user' }), 'msg_user');
  f.history.prepare('UPDATE part SET data=? WHERE message_id=?').run(JSON.stringify({ type: 'text' }), 'msg_user');
  await assert.rejects(() => reader.readSession({ session_id: 'sess_alpha' }), /history_format_error/);
  f.history.prepare('UPDATE part SET data=? WHERE message_id=?').run('null', 'msg_user');
  await assert.rejects(() => reader.readSession({ session_id: 'sess_alpha' }), /history_format_error/);
});

test('当前 branchCutAfterMessageID 回退保留后续新消息，优先于旧 created 标记', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha' });
  f.session({ id: 'sess_alpha', revert: { kind: 'conversation_rewind', branchGeneration: 1,
    targetMessageID: 'msg_discard', keptMessageIDs: ['msg_kept'], branchCutAfterMessageID: 'msg_old_reply' } });
  f.message({ id: 'msg_kept', sequence: 0 });
  f.message({ id: 'msg_discard', sequence: 1 });
  f.message({ id: 'msg_old_reply', sequence: 2, role: 'assistant', parent: 'msg_discard' });
  f.message({ id: 'msg_new', sequence: 3 });
  f.message({ id: 'msg_new_reply', sequence: 4, role: 'assistant', parent: 'msg_new' });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  const page = await reader.readSession({ session_id: 'sess_alpha', limit: 2 });
  assert.deepEqual(page.messages.map(m => m.message_id), ['msg_new', 'msg_new_reply']);
  assert.equal(page.total, 3);
  assert.equal(page.next_before_message_id, 'msg_new');
  assert.deepEqual((await reader.readSession({ session_id: 'sess_alpha', before_message_id: 'msg_new' })).messages.map(m => m.message_id), ['msg_kept']);
  const revert = JSON.parse(f.history.prepare('SELECT revert FROM session WHERE id=?').get('sess_alpha').revert);
  f.history.prepare('UPDATE session SET revert=? WHERE id=?').run(JSON.stringify({ ...revert, createdMessageID: 'msg_discard' }), 'sess_alpha');
  assert.deepEqual((await reader.readSession({ session_id: 'sess_alpha' })).messages.map(m => m.message_id), ['msg_kept', 'msg_new', 'msg_new_reply']);
});

test('没有回退时正常返回未记录父标识的可见助手消息', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_alpha' }); f.session({ id: 'sess_alpha' });
  f.message({ id: 'msg_reply', role: 'assistant', sequence: 0, parts: [{ type: 'text', text: '历史回复' }] });
  const { createSessionReader } = await import('../sessions.mjs');
  const page = await createSessionReader(f).readSession({ session_id: 'sess_alpha' });
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
  const result = await createSessionReader(f).readSession({ session_id: 'sess_alpha' });
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
  await assert.rejects(() => reader.readSession({ session_id: 'sess_deleted' }), /session_not_found/);
  await assert.rejects(() => reader.readSession({ session_id: 'sess_unknown' }), /session_not_found/);
  await assert.rejects(() => reader.readSession({ session_id: 'sess_remote' }), /remote_history_unavailable/);
  await assert.rejects(() => reader.readSession({ session_id: 'sess_duplicate' }), /ambiguous_session/);
  await assert.rejects(() => reader.readSession({ session_id: 'sess_no_history' }), /history_not_found/);
  assert.equal((await reader.readSession({ session_id: 'sess_duplicate', workspace_key: 'local-a' })).messages.length, 0);
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
  const page = await reader.readSession({ session_id: 'sess_alpha' });
  assert.deepEqual(page.messages.map(m => m.message_id), ['msg_kept', 'msg_new', 'msg_reply', 'msg_file']);
  assert.equal(page.messages[2].text, '正确回复');
  assert.deepEqual(page.messages[3].attachments, [{ filename: 'example.png', mime: 'image/png' }]);
  assert.equal(page.branch, 'persisted_revert');
  assert.equal(JSON.stringify(page).includes('secret'), false);
  await assert.rejects(() => reader.readSession({ session_id: 'sess_alpha', before_message_id: 'msg_discard' }), /游标/);
  f.history.prepare('UPDATE session SET revert=? WHERE id=?').run(JSON.stringify({ targetMessageID: 'msg_discard', createdMessageID: 'msg_new' }), 'sess_alpha');
  assert.deepEqual((await reader.readSession({ session_id: 'sess_alpha' })).messages.map(m => m.message_id), ['msg_kept', 'msg_new', 'msg_reply', 'msg_file']);
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
  const page = await reader.readSession({ session_id: 'sess_alpha', limit: 2 });
  assert.deepEqual(page.messages.map(m => m.message_id), ['msg_middle', 'msg_later']);
  assert.equal(page.messages[1].text, '完整正文'.repeat(1000));
  assert.equal(page.messages[1].parent_message_id, 'msg_user');
  assert.equal(page.source, 'local_cli_sqlite');
  assert.equal(page.total, 3);
  assert.equal(page.next_before_message_id, 'msg_middle');
  assert.equal(page.session.title, 'MCP 设计');
  const earlier = await reader.readSession({ session_id: 'sess_alpha', before_message_id: page.next_before_message_id });
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

test('sessionTitle 轻量读取双库标题，行缺失返回 null', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_both', title: '索引标题' }); f.session({ id: 'sess_both', title: 'CLI 标题' });
  f.task({ id: 'sess_index_only', title: '只有索引' });
  f.session({ id: 'sess_cli_only', title: '只有会话库' });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  assert.deepEqual(reader.sessionTitle({ session_id: 'sess_both' }), { index_title: '索引标题', session_title: 'CLI 标题' });
  assert.deepEqual(reader.sessionTitle({ session_id: 'sess_index_only' }), { index_title: '只有索引', session_title: null });
  assert.deepEqual(reader.sessionTitle({ session_id: 'sess_cli_only' }), { index_title: null, session_title: '只有会话库' });
  assert.deepEqual(reader.sessionTitle({ session_id: 'sess_none' }), { index_title: null, session_title: null });
});

test('listAutomations 全量按创建时间倒序返回 camelCase 投影，脏 scheduleRule 不拖垮列表', async t => {
  const f = fixture(t);
  f.automation({ id: 'automation-alpha', title: '[pr-babysit] org/repo#1', cron: '*/30 * * * *',
    target: 'sess_bound', runCount: 3, nextRunAt: 200, lastRunAt: 150, created: 100,
    scheduleRule: JSON.stringify({ kind: 'weekly', daysOfWeek: [3] }) });
  f.automation({ id: 'automation-beta', title: '暂停的巡查', workspace: 'D:\\work\\beta', key: 'kb',
    cron: '0 9 * * *', recurring: 0, maxRuns: 1, enabled: 0, lifecycle: 'paused', created: 300 });
  f.automation({ id: 'automation-dirty', title: '历史脏数据', created: 200, scheduleRule: '{broken' });
  const { createSessionReader } = await import('../sessions.mjs');
  const result = createSessionReader(f).listAutomations({});
  assert.equal(result.source, 'local_tasks_index');
  assert.equal(result.total, 3);
  assert.deepEqual(result.automations.map(a => a.automationId), ['automation-beta', 'automation-dirty', 'automation-alpha']);
  // 完整投影以独立字面量核对：布尔真实化、可空字段为 null、scheduleRule 解析为对象
  assert.deepEqual(result.automations[0], { automationId: 'automation-beta', title: '暂停的巡查',
    cronExpr: '0 9 * * *', enabled: false, lifecycleStatus: 'paused', nextRunAt: null, lastRunAt: null,
    runCount: 0, recurring: false, maxRuns: 1, scheduleRule: null, workspaceKey: 'kb',
    workspacePath: 'D:\\work\\beta', targetTaskId: null });
  const alpha = result.automations[2];
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.recurring, true);
  assert.equal(alpha.maxRuns, null);
  assert.deepEqual(alpha.scheduleRule, { kind: 'weekly', daysOfWeek: [3] });
  assert.equal(alpha.targetTaskId, 'sess_bound');
  assert.equal(alpha.nextRunAt, 200);
  assert.equal(alpha.lastRunAt, 150);
  assert.equal(alpha.runCount, 3);
  assert.equal(alpha.lifecycleStatus, 'active');
  // 单条 scheduleRule 脏数据按未配置处理，列表整体不受影响
  assert.equal(result.automations[1].scheduleRule, null);
  assert.equal(result.automations[1].title, '历史脏数据');
});

test('listAutomations 支持 workspace_path 规范化匹配与 workspace_key 精确过滤，空表返回空列表', async t => {
  const f = fixture(t);
  f.automation({ id: 'automation-alpha', created: 100 });
  f.automation({ id: 'automation-beta', workspace: 'D:\\work\\beta', key: 'kb', created: 300 });
  const { createSessionReader } = await import('../sessions.mjs');
  const reader = createSessionReader(f);
  // Windows 路径统一分隔符、大小写与尾部分隔符后匹配
  assert.deepEqual(reader.listAutomations({ workspace_path: 'd:/WORK/beta/' }).automations.map(a => a.automationId), ['automation-beta']);
  assert.deepEqual(reader.listAutomations({ workspace_key: 'kb' }).automations.map(a => a.automationId), ['automation-beta']);
  // 两个过滤条件同时给出时按 AND 收窄
  assert.deepEqual(reader.listAutomations({ workspace_path: 'D:\\work\\beta', workspace_key: 'kb' }).automations.map(a => a.automationId), ['automation-beta']);
  assert.deepEqual(reader.listAutomations({ workspace_path: 'D:\\missing' }).automations, []);
  assert.equal(reader.listAutomations({ workspace_path: 'D:\\missing' }).total, 0);
  // 空表是空列表而非错误
  const empty = fixture(t);
  assert.deepEqual(createSessionReader(empty).listAutomations({}), { source: 'local_tasks_index', automations: [], total: 0 });
});

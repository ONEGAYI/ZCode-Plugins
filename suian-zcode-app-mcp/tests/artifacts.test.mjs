import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server.mjs';
import { fixture } from './fixtures.mjs';

const references = items => items.map(({ kind, ref, label, purpose }) => ({ kind, ref, label, purpose }));

test('会话工件每次详情查询原 Host，失败保留引用详情并明确返回查询错误；列表不查询 Host', async t => {
  const f = fixture(t), queries = [];
  const call = await connect(t, f, { controller: { getSessionStatus: async args => {
    queries.push(args);
    if (queries.length === 3) throw new Error('gateway_unavailable: 网关未连接');
    return { source: 'original_host', session_id: args.session_id, title: '实时名称', status: queries.length === 1 ? 'running' : 'completed', queried_at: queries.length * 1000 };
  } } });
  const item = { kind: 'session', ref: 'sess_child', label: '关联会话', purpose: '跟进' };
  await call('set_artifacts', { expected_revision: 0, upsert: [item] });
  await call('get_artifacts');
  assert.equal(queries.length, 0);
  const first = (await call('get_artifacts', { ref: item.ref })).structuredContent;
  assert.equal(first.session.status, 'running'); assert.equal(first.hyperlink, null);
  const second = (await call('get_artifacts', { ref: item.ref })).structuredContent;
  assert.equal(second.session.status, 'completed'); assert.equal(queries.length, 2);
  const failed = (await call('get_artifacts', { ref: item.ref })).structuredContent;
  assert.equal(failed.item.ref, item.ref); assert.match(failed.session.error, /gateway_unavailable/);
  assert.equal(failed.session.status, undefined);
  await call('get_artifacts', { ref: 'sess_not_registered' });
  assert.equal(queries.length, 3);
});

test('会话工件读取时按任务索引实时反查列表名称，改名后刷新即得新名且不动存储', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_child', title: '旧列表名' });
  const call = await connect(t, f, { controller: { getSessionStatus: async args => ({ source: 'original_host', session_id: args.session_id, title: '实时名称', status: 'completed', queried_at: 1 }) } });
  const item = { kind: 'session', ref: 'sess_child', label: '旧列表名', purpose: '跟进' };
  await call('set_artifacts', { expected_revision: 0, upsert: [item] });
  assert.equal((await call('get_artifacts')).structuredContent.items[0].session_title, '旧列表名');
  f.index.prepare("UPDATE tasks SET title='新列表名' WHERE task_id='sess_child'").run();
  const after = (await call('get_artifacts')).structuredContent;
  assert.equal(after.items[0].session_title, '新列表名');
  assert.equal(after.items[0].label, '旧列表名');
  assert.equal(after.revision, 1);
  const detail = (await call('get_artifacts', { ref: item.ref })).structuredContent;
  assert.equal(detail.item.session_title, '新列表名');
  const noop = await call('set_artifacts', { expected_revision: 1, upsert: [item] });
  assert.equal(noop.structuredContent.changed, false);
});

test('名称反查边界：未入索引或已删除省略字段，索引不可用降级读取，跨工作区取最新行', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_a', title: '在册会话' });
  f.task({ id: 'sess_del', title: '已删除', deleted: 1 });
  f.task({ id: 'sess_empty', title: '' });
  f.task({ id: 'sess_dup', title: '旧工作区名', workspace: 'D:\\w1', key: 'D:\\w1', updated: 10 });
  f.task({ id: 'sess_dup', title: '新工作区名', workspace: 'D:\\w2', key: 'D:\\w2', updated: 20 });
  const items = ['sess_a', 'sess_del', 'sess_empty', 'sess_dup', 'sess_missing'].map(ref => ({ kind: 'session', ref, label: '标注 ' + ref, purpose: '跟进' }))
    .concat([{ kind: 'file', ref: 'D:/fixture/a.md', label: '文件', purpose: '交付' }]);
  const call = await connect(t, f);
  await call('set_artifacts', { expected_revision: 0, upsert: items });
  const titles = new Map((await call('get_artifacts')).structuredContent.items.map(item => [item.ref, item.session_title]));
  assert.equal(titles.get('sess_a'), '在册会话');
  assert.equal(titles.get('sess_del'), undefined);
  assert.equal(titles.get('sess_empty'), undefined);
  assert.equal(titles.get('sess_dup'), '新工作区名');
  assert.equal(titles.get('sess_missing'), undefined);
  assert.equal(titles.get('D:/fixture/a.md'), undefined);
  const broken = await connect(t, { ...f, indexDbPath: join(dirname(f.indexDbPath), 'missing-index.sqlite') });
  const degraded = (await broken('get_artifacts')).structuredContent;
  assert.equal(degraded.isError, undefined);
  assert.equal(degraded.items.find(item => item.ref === 'sess_a').session_title, undefined);
  assert.equal(degraded.items.find(item => item.ref === 'sess_a').label, '标注 sess_a');
});

test('start_session 在首发前自动登记双方关系；后续人工维护保留方向和创建时间', async t => {
  const f = fixture(t); f.session({ id: 'sess_alpha', title: '父会话' });
  const call = await connect(t, { ...f, now: () => 1000 }, { controller: { startSession: async args => {
    const created = { session_id: 'sess_child', title: '子任务', workspace_path: 'D:/fixture' };
    await args.onCreated(created);
    return { ...created, delivery_status: 'accepted' };
  }, getSessionStatus: async () => ({ status: 'running', source: 'original_host', queried_at: 2000 }) } });
  const response = await call('start_session', { workspace_path: 'D:/fixture', message: '实现任务', title: '子任务' });
  assert.equal(response.isError, undefined);
  const parent = (await call('get_artifacts')).structuredContent;
  const child = (await call('get_artifacts', {}, 'sess_child')).structuredContent;
  assert.equal(parent.items[0].ref, 'sess_child'); assert.equal(parent.items[0].session_direction, 'outgoing');
  assert.equal(child.items[0].ref, 'sess_alpha'); assert.equal(child.items[0].session_direction, 'incoming');
  assert.equal(child.items[0].label, '父会话');
  await call('set_artifacts', { expected_revision: parent.revision, upsert: [{ kind: 'session', ref: 'sess_child', label: '继续任务', purpose: '复核' }] });
  const detail = (await call('get_artifacts', { ref: 'sess_child' })).structuredContent;
  assert.equal(detail.item.session_direction, 'outgoing'); assert.equal(detail.item.created_at, 1000);
});

test('列表可分页读取而没有总条数限制，详情不能混用分页参数；旧条目不编造时间', async t => {
  const f = fixture(t), call = await connect(t, f);
  const items = Array.from({ length: 205 }, (_, i) => ({ kind: 'link', ref: `https://example.com/${i}`, label: `参考 ${i}`, purpose: '跟进' }));
  await call('set_artifacts', { expected_revision: 0, upsert: items });
  const first = (await call('get_artifacts', { offset: 0, limit: 200 })).structuredContent;
  assert.equal(first.items.length, 200); assert.equal(first.stats.total, 205); assert.equal(first.next_offset, 200);
  const last = (await call('get_artifacts', { offset: first.next_offset, limit: 200 })).structuredContent;
  assert.equal(last.items.length, 5); assert.equal(last.next_offset, null);
  assert.equal((await call('get_artifacts', { ref: items[0].ref, limit: 20 })).isError, true);
  const db = new DatabaseSync(f.artifactDbPath);
  db.prepare('INSERT INTO artifact_state VALUES (?,?,?,?)').run('sess_legacy', 1, JSON.stringify([items[0]]), null); db.close();
  const old = (await call('get_artifacts', { ref: items[0].ref }, 'sess_legacy')).structuredContent;
  assert.equal(old.item.created_at, null); assert.equal(old.item.updated_at, null);
  await call('set_artifacts', { expected_revision: 1, upsert: [{ ...items[0], purpose: '继续核对' }] }, 'sess_legacy');
  const changed = (await call('get_artifacts', { ref: items[0].ref }, 'sess_legacy')).structuredContent;
  assert.equal(changed.item.created_at, null); assert.equal(typeof changed.item.updated_at, 'number');
});

test('自动创建关系在同一事务保存，子记录失败不会留下父单边引用', async t => {
  const f = fixture(t);
  const call = await connect(t, f, { controller: { startSession: async args => {
    await args.onCreated({ session_id: 'sess_child', title: '子任务' });
    return { session_id: 'sess_child', delivery_status: 'accepted' };
  } } });
  await call('set_artifacts', { expected_revision: 0, upsert: [{ kind: 'link', ref: 'https://example.com/existing', label: '已有引用', purpose: '保留' }] });
  const before = (await call('get_artifacts')).structuredContent;
  const db = new DatabaseSync(f.artifactDbPath);
  db.exec("CREATE TRIGGER reject_child BEFORE INSERT ON artifact_state WHEN NEW.session_id='sess_child' BEGIN SELECT RAISE(ABORT,'fixture child reject'); END"); db.close();
  const failed = await call('start_session', { workspace_path: 'D:/fixture', message: '测试' });
  assert.equal(failed.isError, true); assert.match(failed.structuredContent.error, /fixture child reject/);
  assert.deepEqual((await call('get_artifacts')).structuredContent, before);
  assert.deepEqual((await call('get_artifacts', {}, 'sess_child')).structuredContent.items, []);
});

async function connect(t, config, options) {
  const server = createMcpServer(config, options);
  const client = new Client({ name: 'artifact-contract', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const call = (name, args = {}, session = 'sess_alpha') => client.callTool({ name, arguments: args, _meta: { session_id: session } });
  call.listTools = () => client.listTools();
  return call;
}

test('工件时间由服务记录，相同 upsert 不更新时间；详情和列表共用同一条目', async t => {
  let clock = 1000;
  const call = await connect(t, { ...fixture(t), now: () => clock });
  const item = { kind: 'link', ref: 'https://example.com/details', label: '文档', purpose: '核对' };
  await call('set_artifacts', { expected_revision: 0, upsert: [item] });
  const detail = (await call('get_artifacts', { ref: item.ref })).structuredContent;
  assert.deepEqual(detail.item, { ...item, created_at: 1000, updated_at: 1000 });
  assert.equal(detail.hyperlink, item.ref);
  assert.equal(detail.items, undefined);
  clock = 2000;
  assert.equal((await call('set_artifacts', { expected_revision: 1, upsert: [item] })).structuredContent.changed, false);
  assert.equal((await call('get_artifacts', { ref: item.ref })).structuredContent.item.updated_at, 1000);
  await call('set_artifacts', { expected_revision: 1, upsert: [{ ...item, purpose: '继续评审' }] });
  const updated = (await call('get_artifacts', { ref: item.ref })).structuredContent;
  assert.equal(updated.item.created_at, 1000); assert.equal(updated.item.updated_at, 2000);
  assert.deepEqual((await call('get_artifacts')).structuredContent.items, [updated.item]);
  assert.equal((await call('get_artifacts', { ref: 'https://example.com/missing' })).structuredContent.code, 'artifact_not_found');
  assert.equal((await call('get_artifacts', { ref: item.ref, offset: 0 })).isError, true);
  assert.equal((await call('set_artifacts', { expected_revision: 2, upsert: [{ ...item, created_at: 1 }] })).isError, true);
});

test('issue 分类按 pr/link 同规则校验 HTTP(S) URL，非 HTTP(S) 整批拒绝且报错文案一致', async t => {
  const f = fixture(t), call = await connect(t, f);
  const issue = { kind: 'issue', ref: 'https://github.com/example/repo/issues/67', label: '面板增强议题', purpose: '跟踪交付' };
  const written = await call('set_artifacts', { expected_revision: 0, upsert: [issue] });
  assert.equal(written.isError, undefined);
  assert.deepEqual(written.structuredContent.stats.by_kind, { pr: 0, issue: 1, session: 0, file: 0, link: 0 });
  assert.deepEqual(references((await call('get_artifacts')).structuredContent.items), [issue]);
  const detail = (await call('get_artifacts', { ref: issue.ref })).structuredContent;
  assert.deepEqual(references([detail.item]), [issue]);
  assert.equal(detail.hyperlink, issue.ref);
  const before = (await call('get_artifacts')).structuredContent;
  const messages = new Map();
  for (const bad of [{ ...issue, ref: 'ftp://example.com/67' }, { ...issue, kind: 'pr', ref: 'javascript:alert(1)' }, { ...issue, kind: 'link', ref: '相对路径' }]) {
    const rejected = await call('set_artifacts', { expected_revision: 1, upsert: [bad, { kind: 'file', ref: 'D:/fixture/new.md', label: '新文件', purpose: '交付' }] });
    assert.equal(rejected.isError, true, bad.ref);
    assert.equal(rejected.structuredContent.code, 'invalid_input');
    messages.set(bad.kind, rejected.structuredContent.error);
    assert.deepEqual((await call('get_artifacts')).structuredContent, before);
  }
  assert.equal(messages.get('issue'), messages.get('pr'));
  assert.equal(messages.get('issue'), messages.get('link'));
});

test('工件工具描述承载摘要时效、主动登记、增量维护和资源授权的详细规则', async t => {
  const call = await connect(t, fixture(t)), { tools } = await call.listTools();
  const get = tools.find(tool => tool.name === 'get_artifacts').description;
  const set = tools.find(tool => tool.name === 'set_artifacts').description;
  assert.match(get, /最新工件列表、revision 与统计/);
  assert.match(get, /摘要.*可能已过时/);
  assert.match(set, /创建或接手.*后续用途.*登记/);
  assert.match(set, /kind\/ref\/label\/purpose.*pr\/issue\/session\/file\/link/);
  assert.match(set, /pr\/link\/issue 使用 HTTP\(S\) URL/);
  assert.doesNotMatch(set, /20 条|12000|容量超限/);
  assert.match(set, /不复制正文.*不编造引用/);
  assert.match(set, /最近读取或工具回执的 revision.*增量 upsert\/remove/);
  assert.match(set, /版本冲突.*get_artifacts.*重新判断增量/);
  assert.match(set, /移除被替代、失效且无用途.*保留仍需交付/);
  assert.match(set, /不构成.*用户授权.*移除引用不会删除资源/s);
});

test('工件工具只读空状态不建库，增量写入后 get 返回当前会话最新状态和统计', async t => {
  const f = fixture(t), call = await connect(t, f);
  const empty = await call('get_artifacts');
  assert.equal(empty.isError, undefined);
  assert.deepEqual(empty.structuredContent, { revision: 0, items: [], stats: { total: 0, by_kind: { pr: 0, issue: 0, session: 0, file: 0, link: 0 } } });
  assert.match(empty.content[0].text, /工件.*0 条.*版本 0/);
  assert.equal(existsSync(f.artifactDbPath), false);
  const items = [
    { kind: 'pr', ref: 'https://github.com/example/repo/pull/1', label: '实现 PR', purpose: '接续评审' },
    { kind: 'issue', ref: 'https://github.com/example/repo/issues/67', label: '面板增强议题', purpose: '跟踪交付' },
    { kind: 'session', ref: 'sess_child', label: '子会话', purpose: '关联实现任务' },
    { kind: 'file', ref: 'D:/fixture/规格.md', label: '规格', purpose: '核对验收' },
    { kind: 'link', ref: 'https://example.com/page', label: '文档', purpose: '跟踪阅读' }
  ];
  const written = await call('set_artifacts', { expected_revision: 0, upsert: items });
  assert.equal(written.isError, undefined);
  assert.match(written.content[0].text, /登记 5 条.*移除 0 条/);
  assert.ok(!written.content[0].text.includes('by_kind'));
  assert.deepEqual(written.structuredContent, { revision: 1, changed: true, upserted: 5, removed: 0,
    stats: { total: 5, by_kind: { pr: 1, issue: 1, session: 1, file: 1, link: 1 } } });
  const current = (await call('get_artifacts')).structuredContent;
  assert.deepEqual({ ...current, items: references(current.items) }, { revision: 1, items, stats: written.structuredContent.stats });
  assert.equal((await call('get_artifacts', {}, 'sess_other')).structuredContent.stats.total, 0);
});

test('新库首次 revision_conflict 后仍可读取空状态并合法重试', async t => {
    const f = fixture(t), call = await connect(t, f);
    const item = { kind: 'file', ref: 'D:/fixture/a.md', label: '结果', purpose: '交付' };
    const rejected = await call('set_artifacts', { expected_revision: 1, upsert: [item] });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.code, 'revision_conflict');
    const empty = await call('get_artifacts');
    assert.equal(empty.isError, undefined);
    assert.deepEqual(empty.structuredContent, { revision: 0, items: [], stats: { total: 0, by_kind: { pr: 0, issue: 0, session: 0, file: 0, link: 0 } } });
    const retried = await call('set_artifacts', { expected_revision: 0, upsert: [item] });
    assert.equal(retried.isError, undefined);
    assert.equal(retried.structuredContent.revision, 1);
    assert.deepEqual(references((await call('get_artifacts')).structuredContent.items), [item]);
});

test('统计摘要模式不限制工件数量和完整表示字符数，增量更新与冲突检查继续有效', async t => {
  const f = fixture(t), call = await connect(t, f);
  const item = { kind: 'file', ref: 'D:/fixture/a.md', label: '文😀', purpose: '交付' };
  const many = Array.from({ length: 100 }, (_, i) => ({ ...item, ref: `D:/fixture/${i}.md` }));
  assert.equal((await call('set_artifacts', { expected_revision: 0, upsert: many })).isError, undefined);
  const over = await call('set_artifacts', { expected_revision: 1, upsert: [{ ...item, ref: 'D:/fixture/100.md' }] });
  assert.equal(over.isError, undefined);
  assert.equal(over.structuredContent.stats.total, 101);
  const exact = { ...item, label: '😀'.repeat(13000) };
  const accepted = await call('set_artifacts', { expected_revision: 0, upsert: [exact] }, 'sess_unicode');
  assert.equal(accepted.isError, undefined);
  const updated = await call('set_artifacts', { expected_revision: 1, upsert: [{ ...exact, label: exact.label + '中' }] }, 'sess_unicode');
  assert.equal(updated.isError, undefined);
  assert.deepEqual(references((await call('get_artifacts', {}, 'sess_unicode')).structuredContent.items), [{ ...exact, label: exact.label + '中' }]);
});

test('工件入口拒绝未知、冲突和歧义身份，不接受目标会话或转换 ref', async t => {
  const f = fixture(t), server = createMcpServer(f);
  f.history.exec(`CREATE TABLE tool_usage (session_id TEXT, trace_id TEXT, tool_name TEXT);
    INSERT INTO tool_usage VALUES ('sess_a','shared','mcp__fixture__get_artifacts');
    INSERT INTO tool_usage VALUES ('sess_b','shared','mcp__fixture__get_artifacts');`);
  const client = new Client({ name: 'artifact-identity', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  for (const [meta, code] of [[{}, 'caller_unknown'], [{ session_id: 'a', 'com.zcode/request-context': { session_id: 'b' } }, 'caller_context_conflict'],
    [{ trace_id: 'shared' }, 'caller_ambiguous']]) {
    const r = await client.callTool({ name: 'get_artifacts', arguments: {}, _meta: meta });
    assert.equal(r.isError, true); assert.equal(r.structuredContent.code, code);
  }
  assert.equal(existsSync(f.artifactDbPath), false);
  for (const name of ['get_artifacts', 'set_artifacts']) {
    const args = name === 'get_artifacts' ? { session_id: 'sess_target' } : { expected_revision: 0, session_id: 'sess_target' };
    assert.equal((await client.callTool({ name, arguments: args, _meta: { session_id: 'sess_alpha' } })).isError, true);
  }
  const call = await connect(t, f), item = { kind: 'link', ref: 'https://example.com/a#x', label: '参考', purpose: '核对' };
  const other = { ...item, ref: 'https://example.com/a' };
  await call('set_artifacts', { expected_revision: 0, upsert: [item, other] });
  assert.deepEqual(references((await call('get_artifacts')).structuredContent.items), [item, other]);
});

test('损坏和不兼容的已有存储报错，不能伪装为空集合', async t => {
  for (const incompatible of [false, true]) {
    const f = fixture(t), call = await connect(t, f);
    if (incompatible) { const db = new DatabaseSync(f.artifactDbPath); db.exec('PRAGMA user_version=9'); db.close(); }
    else writeFileSync(f.artifactDbPath, '不是 SQLite');
    const response = await call('get_artifacts');
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.items, undefined);
    if (incompatible) assert.equal(response.structuredContent.code, 'artifact_storage_incompatible');
  }
});

test('独立 stdio 进程的 CAS 只有一个胜者，冷重启保留结果，宿主数据库字节不变', async t => {
  const f = fixture(t), item = { kind: 'file', ref: 'D:/fixture/a.md', label: '结果', purpose: '交付' };
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const before = [digest(f.indexDbPath), digest(f.sessionDbPath)];
  async function processClient() {
    const client = new Client({ name: 'artifact-process', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, stderr: 'pipe', args: [
      fileURLToPath(new URL('../cli.mjs', import.meta.url)), '--index-db', f.indexDbPath, '--session-db', f.sessionDbPath, '--artifact-db', f.artifactDbPath
    ] });
    t.after(() => client.close());
    await client.connect(transport);
    const call = (name, args = {}) => client.callTool({ name, arguments: args, _meta: { session_id: 'sess_alpha' } });
    call.close = () => client.close();
    return call;
  }
  const [one, two] = await Promise.all([processClient(), processClient()]);
  await one('set_artifacts', { expected_revision: 0, upsert: [item] });
  const attempts = await Promise.all([one, two].map((call, i) => call('set_artifacts', { expected_revision: 1, upsert: [{ ...item, label: `并发 ${i}` }] })));
  assert.equal(attempts.filter(r => !r.isError).length, 1);
  assert.equal(attempts.find(r => r.isError).structuredContent.code, 'revision_conflict');
  await one.close(); await two.close();
  const cold = await processClient(), state = (await cold('get_artifacts')).structuredContent;
  assert.equal(state.revision, 2); assert.equal(state.items[0].label, attempts[0].isError ? '并发 1' : '并发 0');
  assert.deepEqual([digest(f.indexDbPath), digest(f.sessionDbPath)], before);
});

test('冲突和无效批次保持整个旧状态；更新保序，无变化不加版本', async t => {
  const f = fixture(t), call = await connect(t, f);
  const a = { kind: 'file', ref: 'D:/fixture/a.md', label: 'A', purpose: '交付' };
  const b = { ...a, ref: 'D:/fixture/b.md', label: 'B' };
  await call('set_artifacts', { expected_revision: 0, upsert: [a, b] });
  const before = (await call('get_artifacts')).structuredContent;
  for (const [args, code] of [
    [{ expected_revision: 0, remove: [a.ref] }, 'revision_conflict'],
    [{ expected_revision: 1, upsert: [a, { ...a, label: '重复' }] }, 'invalid_input'],
    [{ expected_revision: 1, upsert: [a], remove: [a.ref] }, 'invalid_input'],
    [{ expected_revision: 1, upsert: [{ ...a, ref: 'relative.md' }], remove: [b.ref] }, 'invalid_input'],
    [{ expected_revision: 1, upsert: [{ ...a, kind: 'link', ref: 'javascript:alert(1)' }] }, 'invalid_input']
  ]) {
    const rejected = await call('set_artifacts', args);
    assert.equal(rejected.isError, true, JSON.stringify(args));
    assert.equal(rejected.structuredContent.code, code);
    assert.deepEqual((await call('get_artifacts')).structuredContent, before);
    assert.equal(rejected.structuredContent.items, undefined);
  }
  const noop = (await call('set_artifacts', { expected_revision: 1, upsert: [a], remove: ['D:/fixture/missing.md'] })).structuredContent;
  assert.equal(noop.changed, false); assert.equal(noop.revision, 1);
  const c = { ...a, ref: 'D:/fixture/c.md', label: 'C' }, updated = { ...a, purpose: '接续查看' };
  await call('set_artifacts', { expected_revision: 1, upsert: [c, updated] });
  assert.deepEqual(references((await call('get_artifacts')).structuredContent.items), [updated, b, c]);
});

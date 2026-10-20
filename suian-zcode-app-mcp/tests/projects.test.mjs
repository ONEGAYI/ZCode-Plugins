import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fixture } from './fixtures.mjs';
import { createSessionReader } from '../sessions.mjs';
import { createMcpServer } from '../server.mjs';

function projectFixture(t) {
  const f = fixture(t);
  for (const [id, workspace] of [['parent', 'D:/alpha'], ['sibling', 'D:/beta'], ['other', 'D:/alpha']]) f.task({ id, workspace });
  f.session({ id: 'parent', directory: 'D:/alpha', permission: { mode: 'plan' } });
  f.index.exec([
    'ALTER TABLE tasks ADD COLUMN host_id TEXT DEFAULT "local"',
    'ALTER TABLE tasks ADD COLUMN root_path TEXT',
    'ALTER TABLE tasks ADD COLUMN project_id TEXT',
    'ALTER TABLE tasks ADD COLUMN execution_directories TEXT',
    'CREATE TABLE projects (project_id TEXT PRIMARY KEY,host_id TEXT,name TEXT,deleted INTEGER)',
    'CREATE TABLE project_roots (project_id TEXT,root_path TEXT,position INTEGER)',
    "INSERT INTO projects VALUES ('project-a','local','项目 A',0),('project-b','local','项目 B',0)",
    "INSERT INTO project_roots VALUES ('project-a','D:/alpha',0),('project-a','D:/beta',1),('project-b','D:/alpha',0)",
    "UPDATE tasks SET root_path=workspace_path,project_id=CASE task_id WHEN 'other' THEN 'project-b' ELSE 'project-a' END",
    // 对齐真实宿主索引 schema：主根标记与项目排序键（is_primary/pinned/position）
    'ALTER TABLE project_roots ADD COLUMN is_primary INTEGER DEFAULT 0',
    'ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0',
    'ALTER TABLE projects ADD COLUMN position INTEGER DEFAULT 0',
    "UPDATE project_roots SET is_primary=1 WHERE project_id='project-a' AND root_path='D:/alpha'"
  ].join(';'));
  return f;
}

test('项目筛选以项目 ID 区分同目录的不同项目，当前会话公布冻结目录，查询不写索引', t => {
  const f = projectFixture(t), reader = createSessionReader(f);
  f.index.prepare('UPDATE tasks SET execution_directories=? WHERE task_id=?').run('[]', 'parent');
  const before = readFileSync(f.indexDbPath);
  const list = reader.listSessions({ project_id: 'project-a' });
  assert.deepEqual(list.sessions.map(row => row.session_id), ['parent', 'sibling']);
  assert.ok(list.sessions.every(row => row.project_id === 'project-a'));
  assert.deepEqual(reader.listSessions({ project_id: 'project-b' }).sessions.map(row => row.session_id), ['other']);
  assert.deepEqual(reader.listSessions({ project_id: null }).sessions, []);
  const current = reader.sessionOverview({ session_id: 'parent' });
  assert.equal(current.project_id, 'project-a');
  assert.deepEqual(current.additional_directories, []);
  assert.deepEqual(readFileSync(f.indexDbPath), before);
});

test('列表区分多目录项目与会话附加目录，摘要最多三项并明确截断', t => {
  const f = projectFixture(t), reader = createSessionReader(f);
  f.index.exec("INSERT INTO project_roots (project_id,root_path,position) VALUES ('project-a','D:/gamma',2),('project-a','D:/delta',3),('project-a','D:/epsilon',4)");
  f.index.prepare('UPDATE tasks SET execution_directories=? WHERE task_id=?')
    .run(JSON.stringify(['D:/gamma', 'D:/delta', 'D:/epsilon', 'D:/frozen-only']), 'parent');
  const before = readFileSync(f.indexDbPath);
  const rows = reader.listSessions().sessions;
  const parent = rows.find(row => row.session_id === 'parent');
  assert.equal(parent.is_multi_workspace_project, true);
  assert.equal(parent.additional_directories_count, 4);
  assert.deepEqual(parent.additional_directories_preview, ['D:/gamma', 'D:/delta', 'D:/epsilon']);
  assert.equal(parent.additional_directories_truncated, true);
  const sibling = rows.find(row => row.session_id === 'sibling');
  assert.equal(sibling.additional_directories_count, 4);
  assert.deepEqual(sibling.additional_directories_preview, ['D:/alpha', 'D:/gamma', 'D:/delta']);
  const other = rows.find(row => row.session_id === 'other');
  assert.equal(other.is_multi_workspace_project, false);
  assert.equal(other.additional_directories_count, 0);
  assert.deepEqual(other.additional_directories_preview, []);
  assert.equal(other.additional_directories_truncated, false);
  assert.deepEqual(readFileSync(f.indexDbPath), before);
  f.index.prepare('UPDATE tasks SET execution_directories=? WHERE task_id=?').run('[]', 'parent');
  const frozenEmpty = reader.listSessions({ project_id: 'project-a' }).sessions.find(row => row.session_id === 'parent');
  assert.equal(frozenEmpty.is_multi_workspace_project, true);
  assert.equal(frozenEmpty.additional_directories_count, 0);
  assert.deepEqual(frozenEmpty.additional_directories_preview, []);
  assert.equal(frozenEmpty.additional_directories_truncated, false);
});

test('query 通过附加目录找到所属项目，先筛选再分页并保留项目与归档边界', t => {
  const f = projectFixture(t), reader = createSessionReader(f);
  f.index.exec("UPDATE tasks SET execution_directories='[]' WHERE task_id='parent'");
  f.index.exec("INSERT INTO project_roots (project_id,root_path,position) VALUES ('project-a','D:/third',2),('project-a','D:/fourth',3),('project-a','D:/beyond-preview',4)");
  const before = readFileSync(f.indexDbPath);
  const first = reader.listSessions({ query: 'BETA', limit: 1 });
  assert.equal(first.total, 2);
  assert.deepEqual(first.sessions.map(row => row.session_id), ['parent']);
  assert.equal(first.next_offset, 1);
  const next = reader.listSessions({ query: 'BETA', limit: 1, offset: first.next_offset });
  assert.deepEqual(next.sessions.map(row => row.session_id), ['sibling']);
  assert.equal(next.next_offset, null);
  assert.equal(reader.listSessions({ query: 'beyond-preview' }).total, 2);
  assert.equal(reader.listSessions({ query: 'd:\\BETA\\' }).total, 2);
  assert.deepEqual(reader.listSessions({ query: 'beta', workspace_path: 'D:/alpha' }).sessions.map(row => row.session_id), ['parent']);
  assert.equal(reader.listSessions({ query: 'beta', project_id: 'project-b' }).total, 0);
  assert.deepEqual(readFileSync(f.indexDbPath), before);
  f.index.prepare('UPDATE tasks SET execution_directories=? WHERE task_id=?').run('["D:/frozen-only"]', 'parent');
  assert.equal(reader.listSessions({ query: 'frozen-only' }).total, 2);
  f.index.prepare('UPDATE tasks SET project_id=NULL,execution_directories=? WHERE task_id=?').run('["D:/unclassified-extra"]', 'other');
  assert.deepEqual(reader.listSessions({ query: 'unclassified-extra' }).sessions.map(row => row.session_id), ['other']);
  f.index.exec("UPDATE tasks SET archived=1 WHERE task_id='sibling'");
  assert.equal(reader.listSessions({ query: 'beta' }).total, 1);
  assert.equal(reader.listSessions({ query: 'beta', include_archived: true }).total, 2);
  f.index.exec("UPDATE tasks SET deleted=1 WHERE task_id='parent'");
  assert.deepEqual(reader.listSessions({ query: 'beta', include_archived: true }).sessions.map(row => row.session_id), ['sibling']);
});

test('旧索引继续支持原有列表，显式项目筛选报告宿主索引不支持', t => {
  const f = fixture(t); f.task({ id: 'old' });
  const reader = createSessionReader(f);
  assert.equal(reader.listSessions().total, 1);
  assert.equal(reader.listSessions({ query: 'WORK\\ALPHA' }).total, 1);
  assert.equal(reader.listSessions().sessions[0].is_multi_workspace_project, undefined);
  assert.throws(() => reader.listSessions({ project_id: 'project-a' }), /project_schema_unsupported/);
});

test('远端发起者仍可查询会话元信息，但不把远端项目目录继承为本机权限', t => {
  const f = projectFixture(t), reader = createSessionReader(f);
  f.index.exec("UPDATE tasks SET host_id='remote' WHERE task_id='parent'");
  assert.equal(reader.sessionOverview({ session_id: 'parent' }).session_title, 'parent');
  assert.equal(reader.sessionProject({ session_id: 'parent' }), undefined);
});

test('MCP 创建在会话范围内继承项目和目录，跨项目与显式未归类不误继承', async t => {
  const f = projectFixture(t), calls = [];
  const controller = { startSession: async args => { calls.push(args); return { session_id: 'new', delivery_status: 'accepted' }; } };
  const server = createMcpServer(f, { controller }), client = new Client({ name: 'multi-root-contract', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const start = ({ omit_workspace, ...arguments_ } = {}) => client.callTool({ name: 'start_session',
    arguments: { ...(omit_workspace ? {} : { workspace_path: 'D:/alpha' }), message: 'hello', ...arguments_ }, _meta: { session_id: 'parent' } });
  assert.equal((await start({})).isError, undefined);
  assert.equal(calls.at(-1).project_id, 'project-a');
  assert.deepEqual(calls.at(-1).additional_directories, ['D:/beta']);
  await start({ workspace_path: 'd:/BETA/' });
  assert.equal(calls.at(-1).project_id, 'project-a');
  assert.deepEqual(calls.at(-1).additional_directories, ['D:/alpha']);
  await start({ workspace_path: 'D:/elsewhere' });
  assert.equal(calls.at(-1).project_id, undefined);
  assert.equal(calls.at(-1).additional_directories, undefined);
  assert.equal((await start({ project_id: null })).isError, true, '显式 null 已无语义：与 workspace_path 同传被互斥校验拒绝');
  await start({ omit_workspace: true, project_id: 'project-b' });
  assert.equal(calls.at(-1).project_id, 'project-b');
  assert.equal(calls.at(-1).workspace_path, 'D:/alpha', '项目模式以项目主根为执行目录（fixture 中 project-b 唯一根，无 is_primary 标记取首个）');
  assert.equal(calls.at(-1).additional_directories, undefined, '项目模式不继承项目附加根');
  await start({ additional_directories: [] });
  assert.equal(calls.at(-1).project_id, 'project-a');
  assert.deepEqual(calls.at(-1).additional_directories, []);
  const listed = await client.callTool({ name: 'list_sessions', arguments: { project_id: 'project-b' } });
  assert.deepEqual(listed.structuredContent.sessions.map(row => row.session_id), ['other']);
  assert.equal(listed.structuredContent.sessions[0].is_multi_workspace_project, false);
  const searched = await client.callTool({ name: 'list_sessions', arguments: { query: 'beta' } });
  assert.deepEqual(searched.structuredContent.sessions.map(row => row.session_id), ['parent', 'sibling']);
  assert.deepEqual(searched.structuredContent.sessions[0].additional_directories_preview, ['D:/beta']);
  const current = await client.callTool({ name: 'get_current_session', arguments: {}, _meta: { session_id: 'parent' } });
  assert.equal(current.structuredContent.project_id, 'project-a');
  assert.deepEqual(current.structuredContent.additional_directories, ['D:/beta']);
  const count = calls.length;
  assert.equal((await start({ additional_directories: ['relative/path'] })).isError, true);
  assert.equal(calls.length, count);
  f.index.exec("INSERT INTO tasks (workspace_key,task_id,host_id,workspace_path,root_path,project_id) VALUES ('duplicate','parent','local','D:/beta','D:/beta','project-a')");
  const ambiguous = await start({});
  assert.equal(ambiguous.isError, true, '归属不唯一时跳过目录继承，目录反查命中多个已注册项目，引导显式 project_id');
  assert.match(ambiguous.structuredContent.error, /project_id_required/);
  assert.ok(ambiguous.structuredContent.error.includes('project-a') && ambiguous.structuredContent.error.includes('project-b'), '多命中列出全部候选');
  f.index.exec("UPDATE tasks SET deleted=1 WHERE workspace_key='duplicate'");
  assert.equal((await start({})).isError, undefined, '唯一有效归属不能被另一条已删除记录阻断');
  assert.equal(calls.at(-1).project_id, 'project-a');
  assert.deepEqual(calls.at(-1).additional_directories, ['D:/beta']);
});

test('项目注册表读取：探测支持、列表排序过滤、按 ID 与按根反查、会话归属精确读回', t => {
  const f = projectFixture(t), reader = createSessionReader(f);
  assert.equal(reader.projectsSupported(), true);
  assert.equal(createSessionReader(fixture(t)).projectsSupported(), false, '普通索引无项目表');
  assert.deepEqual(reader.listProjects(), { source: 'local_tasks_index', projects: [
    { project_id: 'project-a', name: '项目 A', pinned: false,
      roots: [{ root_path: 'D:/alpha', is_primary: true }, { root_path: 'D:/beta', is_primary: false }] },
    { project_id: 'project-b', name: '项目 B', pinned: false, roots: [{ root_path: 'D:/alpha', is_primary: false }] }] });
  f.index.exec("UPDATE projects SET pinned=1 WHERE project_id='project-b'");
  assert.deepEqual(reader.listProjects().projects.map(p => p.project_id), ['project-b', 'project-a'], '置顶项目优先');
  f.index.exec("UPDATE projects SET pinned=0 WHERE project_id='project-b';UPDATE projects SET position=5 WHERE project_id='project-a'");
  assert.deepEqual(reader.listProjects().projects.map(p => p.project_id), ['project-b', 'project-a'], '未置顶时按 position、project_id 排序');
  assert.equal(reader.projectById('project-a').name, '项目 A');
  assert.deepEqual(reader.projectById('project-a').roots.map(r => r.root_path), ['D:/alpha', 'D:/beta']);
  assert.equal(reader.projectById('project-z'), null);
  assert.deepEqual(reader.projectsByRoot('D:/beta').map(p => p.project_id), ['project-a'], '唯一命中');
  assert.deepEqual(reader.projectsByRoot('d:/ALPHA\\').map(p => p.project_id), ['project-b', 'project-a'], '路径归一后多命中');
  assert.deepEqual(reader.projectsByRoot('D:/elsewhere'), [], '未命中返回空');
  assert.equal(reader.sessionProjectId({ session_id: 'parent' }), 'project-a');
  f.index.exec("UPDATE tasks SET archived=1 WHERE task_id='parent'");
  assert.equal(reader.sessionProjectId({ session_id: 'parent' }), 'project-a', '读回含归档行');
  f.index.exec("UPDATE tasks SET project_id=NULL WHERE task_id='parent'");
  assert.equal(reader.sessionProjectId({ session_id: 'parent' }), null, 'null 表示已确认未归类');
  assert.equal(reader.sessionProjectId({ session_id: 'ghost' }), undefined, '行缺失返回 undefined');
  f.index.exec("UPDATE projects SET deleted=1 WHERE project_id='project-b'");
  assert.deepEqual(reader.listProjects().projects.map(p => p.project_id), ['project-a'], '已删除项目不列入');
  f.index.exec("UPDATE projects SET deleted=0,host_id='remote' WHERE project_id='project-b'");
  assert.deepEqual(reader.listProjects().projects.map(p => p.project_id), ['project-a'], '非本机项目不列入');
  assert.equal(reader.projectById('project-b'), null, '非本机项目按不存在处理');
  const legacy = fixture(t);
  legacy.task({ id: 'old' });
  const legacyReader = createSessionReader(legacy);
  assert.equal(legacyReader.sessionProjectId({ session_id: 'old' }), undefined, '旧索引无 project_id 列');
  assert.deepEqual(legacyReader.projectsByRoot('D:/alpha'), [], '旧索引按根反查降级为空');
  assert.throws(() => legacyReader.listProjects(), /project_schema_unsupported/, '旧索引显式报告不支持项目列表');
});

test('start_session 项目模式以主根为执行目录并归属项目，互斥校验与跨项目反查引导', async t => {
  const f = projectFixture(t), calls = [];
  const controller = { startSession: async args => { calls.push(args); return { session_id: 'new', delivery_status: 'accepted' }; } };
  const server = createMcpServer(f, { controller }), client = new Client({ name: 'project-mode-contract', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const call = arguments_ => client.callTool({ name: 'start_session', arguments: { message: 'hello', ...arguments_ }, _meta: { session_id: 'parent' } });
  await call({ project_id: 'project-a' });
  assert.equal(calls.at(-1).project_id, 'project-a');
  assert.equal(calls.at(-1).workspace_path, 'D:/alpha', '多根项目取 is_primary 主根');
  f.index.exec("UPDATE project_roots SET is_primary=CASE root_path WHEN 'D:/beta' THEN 1 ELSE 0 END WHERE project_id='project-a'");
  await call({ project_id: 'project-a' });
  assert.equal(calls.at(-1).workspace_path, 'D:/beta', '主根标记变更后取新主根');
  const count = calls.length;
  const missing = await call({ project_id: 'project-z' });
  assert.equal(missing.isError, true);
  assert.match(missing.structuredContent.error, /project_not_found/);
  assert.equal((await call({ project_id: 'project-a', workspace_path: 'D:/alpha' })).isError, true, '两个都传被互斥校验拒绝');
  assert.equal((await call({})).isError, true, '都不传被互斥校验拒绝');
  assert.equal(calls.length, count, '被拒绝的调用不进入控制器');
  f.index.exec("INSERT INTO projects (project_id,host_id,name,deleted,pinned,position) VALUES ('project-c','local','项目 C',0,0,0);"
    + "INSERT INTO project_roots (project_id,root_path,position,is_primary) VALUES ('project-c','D:/gamma',0,1)");
  const unique = await call({ workspace_path: 'D:/gamma' });
  assert.equal(unique.isError, true, '跨项目命中已注册根而未填 project_id 时引导反查');
  assert.match(unique.structuredContent.error, /project_id_required/);
  assert.ok(unique.structuredContent.error.includes('项目 C') && unique.structuredContent.error.includes('project-c'), '唯一命中列出该候选');
  f.index.exec("UPDATE tasks SET deleted=1 WHERE task_id='parent'");
  const multi = await call({ workspace_path: 'D:/alpha' });
  assert.equal(multi.isError, true, '继承未命中时目录反查多命中同样引导');
  assert.match(multi.structuredContent.error, /project_id_required/);
  assert.ok(multi.structuredContent.error.includes('project-a') && multi.structuredContent.error.includes('project-b'), '多命中列出全部候选');
});

test('list_projects 按宿主索引能力差异化公布：新库返回注册表，旧库 schema 不出现 project_id', async t => {
  const f = projectFixture(t);
  const controller = { startSession: async args => args };
  const server = createMcpServer(f, { controller }), client = new Client({ name: 'project-tool-contract', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const listed = await client.listTools();
  const projectTool = listed.tools.find(tool => tool.name === 'list_projects');
  assert.ok(projectTool);
  assert.deepEqual(projectTool.inputSchema.properties, {});
  assert.equal(projectTool.inputSchema.additionalProperties, false);
  assert.equal(projectTool.annotations.readOnlyHint, true);
  const projects = await client.callTool({ name: 'list_projects', arguments: {} });
  assert.equal(projects.isError, undefined);
  assert.equal(projects.structuredContent.source, 'local_tasks_index');
  assert.deepEqual(projects.structuredContent.projects.map(p => p.project_id), ['project-a', 'project-b']);
  assert.deepEqual(projects.structuredContent.projects[0].roots, [{ root_path: 'D:/alpha', is_primary: true }, { root_path: 'D:/beta', is_primary: false }]);
  assert.match(projects.content[0].text, /项目：共 2 个/);
  assert.equal((await client.callTool({ name: 'list_projects', arguments: { limit: 5 } })).isError, true, '无参数工具拒绝未知字段');
  await client.close(); await server.close();
  const legacy = fixture(t);
  const legacyServer = createMcpServer(legacy, { controller }), legacyClient = new Client({ name: 'legacy-tool-contract', version: '1' });
  const [lct, lst] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await legacyClient.close(); await legacyServer.close(); });
  await legacyServer.connect(lst); await legacyClient.connect(lct);
  const legacyTools = await legacyClient.listTools();
  assert.equal(legacyTools.tools.some(tool => tool.name === 'list_projects'), false, '旧宿主索引不公布项目工具');
  const legacyStart = legacyTools.tools.find(tool => tool.name === 'start_session').inputSchema;
  assert.equal(Object.hasOwn(legacyStart.properties, 'project_id'), false, '旧宿主 schema 不出现 project_id 字段');
  assert.equal(legacyStart.required.includes('workspace_path'), true, '旧宿主仍要求 workspace_path');
});

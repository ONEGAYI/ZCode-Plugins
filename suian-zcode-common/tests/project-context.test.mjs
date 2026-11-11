import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectContext } from '../project-context.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'project-context-')), indexDbPath = join(dir, 'tasks.sqlite');
  const db = new DatabaseSync(indexDbPath);
  t.after(() => { db.close(); rmSync(dir, { recursive: true }); });
  db.exec([
    'CREATE TABLE tasks (task_id TEXT,workspace_key TEXT,workspace_path TEXT,workspace_identity TEXT,root_path TEXT,host_id TEXT,project_id TEXT,execution_directories TEXT,deleted INTEGER)',
    'CREATE TABLE projects (project_id TEXT,host_id TEXT,name TEXT,deleted INTEGER)',
    'CREATE TABLE project_roots (project_id TEXT,root_path TEXT,position INTEGER)',
    "INSERT INTO tasks VALUES ('session','key-a','D:/alpha',NULL,'D:/alpha','local','project',NULL,0)",
    "INSERT INTO projects VALUES ('project','local','项目',0)",
    "INSERT INTO project_roots VALUES ('project','D:/alpha',0),('project','D:/beta',1)"
  ].join(';'));
  return { db, indexDbPath, read: () => readProjectContext({ indexDbPath, sessionId: 'session' }) };
}

test('受管工作树保留冻结执行范围，并单独给出原 Host 归属目录', t => {
  const f = fixture(t);
  f.db.exec("ALTER TABLE tasks ADD COLUMN worktree_root TEXT; UPDATE tasks SET worktree_root='D:/worktrees/alpha', root_path='D:/worktrees/alpha/src', execution_directories='[]'");
  const context = f.read();
  assert.equal(context.workspacePath, 'D:/worktrees/alpha/src');
  assert.equal(context.hostWorkspacePath, 'D:/alpha');
  assert.deepEqual(context.additionalDirectories, []);
  f.db.exec('UPDATE tasks SET execution_directories=NULL');
  assert.throws(f.read, { code: 'project_storage_invalid' }, '冻结范围缺失时不能把主目录加入编辑范围');
});

test('按会话冻结目录优先于项目 roots，空数组不扩大权限，读取不写索引', t => {
  const f = fixture(t);
  assert.deepEqual(f.read().additionalDirectories, ['D:/beta']);
  f.db.exec("UPDATE tasks SET execution_directories='[]'");
  const before = readFileSync(f.indexDbPath);
  assert.deepEqual(f.read().additionalDirectories, []);
  assert.deepEqual(readFileSync(f.indexDbPath), before);
  f.db.prepare('UPDATE tasks SET execution_directories=?').run('["D:/frozen"]');
  assert.deepEqual(f.read().additionalDirectories, ['D:/frozen']);
});

test('远端 Host、错项目 Host 与同 ID 多归属明确拒绝', t => {
  const f = fixture(t);
  f.db.exec("UPDATE tasks SET host_id='remote'");
  assert.throws(f.read, { code: 'remote_workspace_unavailable' });
  f.db.exec("UPDATE tasks SET host_id='local'; UPDATE projects SET host_id='remote'");
  assert.throws(f.read, { code: 'project_storage_invalid' });
  f.db.exec("UPDATE projects SET host_id='local'; INSERT INTO tasks SELECT task_id,'key-b',workspace_path,workspace_identity,root_path,host_id,project_id,execution_directories,deleted FROM tasks");
  assert.throws(f.read, { code: 'ambiguous_session' });
  assert.equal(readProjectContext({ indexDbPath: f.indexDbPath, sessionId: 'session', workspaceKey: 'key-a' }).workspacePath, 'D:/alpha');
  f.db.exec("UPDATE tasks SET deleted=1 WHERE workspace_key='key-b'");
  assert.equal(f.read().workspacePath, 'D:/alpha', '已删除归属不使唯一有效会话变成歧义');
});

test('相对目录、删除的会话与损坏目录 JSON 不得获得本机目录权限', t => {
  const f = fixture(t);
  f.db.exec("UPDATE tasks SET execution_directories='[\"relative/path\"]'");
  assert.throws(f.read, { code: 'project_storage_invalid' });
  f.db.exec("UPDATE tasks SET execution_directories=NULL, root_path='relative'");
  assert.throws(f.read, { code: 'project_storage_invalid' });
  f.db.exec("UPDATE tasks SET root_path='D:/alpha', deleted=1");
  assert.throws(f.read, { code: 'session_not_found' });
  f.db.exec("UPDATE tasks SET deleted=0, execution_directories='{'");
  assert.throws(f.read, SyntaxError);
});

test('旧版单目录与未首发会话保留启动绑定，未知数据库格式仍明确失败', t => {
  const f = fixture(t);
  f.db.exec("DROP TABLE tasks; CREATE TABLE tasks (task_id TEXT,workspace_key TEXT,workspace_path TEXT,workspace_identity TEXT); INSERT INTO tasks VALUES ('session','key','D:/old',NULL)");
  assert.equal(f.read().workspacePath, 'D:/old');
  assert.deepEqual(f.read().additionalDirectories, []);
  assert.equal(readProjectContext({ indexDbPath: f.indexDbPath, sessionId: 'deferred', workspacePath: 'D:/bound' }).workspacePath, 'D:/bound');
  f.db.exec('DROP TABLE tasks');
  assert.throws(f.read, /no such table/);
});

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function fixture(t) {
  const root = fileURLToPath(new URL('../.scratch/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'test-'));
  const indexDbPath = join(directory, 'tasks.sqlite');
  const sessionDbPath = join(directory, 'sessions.sqlite');
  const index = new DatabaseSync(indexDbPath);
  const history = new DatabaseSync(sessionDbPath);
  index.exec(`CREATE TABLE tasks (
    workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT,
    task_id TEXT, title TEXT, provider TEXT, task_status TEXT,
    created_at INTEGER, updated_at INTEGER, pinned INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
    PRIMARY KEY (workspace_key, task_id)
  );`);
  history.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, title TEXT, directory TEXT, path TEXT, revert TEXT
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER,
    time_created INTEGER, data TEXT
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER,
    time_created INTEGER, data TEXT
  );`);
  t.after(() => { index.close(); history.close(); rmSync(directory, { recursive: true }); });
  return {
    indexDbPath, sessionDbPath, index, history,
    task({ id, title = id, workspace = 'D:\\work\\alpha', key = workspace,
      identity = null, updated = 10, pinned = 0, archived = 0, deleted = 0 }) {
      index.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(key, workspace, identity, id, title, 'glm', 'completed', 1, updated, pinned, archived, deleted);
    },
    session({ id, title = id, directory = 'D:\\work\\alpha', revert = null }) {
      history.prepare('INSERT INTO session VALUES (?,?,?,?,?)')
        .run(id, title, directory, directory, revert && JSON.stringify(revert));
    },
    message({ id, session = 'sess_alpha', role = 'user', parent, sequence, time = 1,
      info = {}, parts = [{ type: 'text', text: id }] }) {
      history.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, session, sequence, time,
        JSON.stringify({ role, ...(parent && { parentID: parent }), ...info }));
      parts.forEach((part, i) => history.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)')
        .run(`${id}_part_${i}`, id, session, i, time, JSON.stringify(part)));
    }
  };
}

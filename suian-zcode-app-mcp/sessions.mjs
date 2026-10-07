import { DatabaseSync } from 'node:sqlite';
import { win32 } from 'node:path';
import { getConversationMessageProjectionPolicy } from './vendor/projection.js';

function openReadOnly(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 2000 });
  db.exec('PRAGMA query_only=ON; BEGIN;');
  return db;
}

const taskColumns = `task_id AS session_id, title, workspace_path, workspace_key,
  workspace_identity, provider, task_status AS status, created_at, updated_at, pinned, archived`;
const taskItem = row => ({ ...row, pinned: !!row.pinned, archived: !!row.archived });

const normalizeWorkspace = path => win32.normalize(path).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();

export function createSessionReader({ indexDbPath, sessionDbPath }) {
  return {
    listSessions({ limit = 20, offset = 0, workspace_path, query, include_archived = false } = {}) {
      const db = openReadOnly(indexDbPath);
      try {
        const conditions = ['deleted=0'], args = [];
        if (!include_archived) conditions.push('archived=0');
        if (workspace_path !== undefined) {
          db.function('normalize_workspace', normalizeWorkspace);
          conditions.push('normalize_workspace(workspace_path)=?');
          args.push(normalizeWorkspace(workspace_path));
        }
        if (query !== undefined) {
          conditions.push('(instr(lower(title),lower(?))>0 OR instr(lower(task_id),lower(?))>0)');
          args.push(query, query);
        }
        const where = conditions.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...args).n;
        const sessions = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE ${where}
          ORDER BY updated_at DESC, task_id, workspace_key LIMIT ? OFFSET ?`).all(...args, limit, offset).map(taskItem);
        const next = offset + sessions.length;
        return { source: 'local_tasks_index', sessions, total, next_offset: next < total ? next : null };
      } finally { db.close(); }
    },
    readSession({ session_id, limit = 30, before_message_id, workspace_key }) {
      const index = openReadOnly(indexDbPath);
      let task;
      try {
        const keyFilter = workspace_key === undefined ? '' : ' AND workspace_key=?';
        const args = workspace_key === undefined ? [session_id] : [session_id, workspace_key];
        const rows = index.prepare(`SELECT ${taskColumns} FROM tasks WHERE task_id=? AND deleted=0${keyFilter}`).all(...args);
        if (!rows.length) throw new Error('session_not_found: 任务索引中没有该会话，或它已删除');
        if (rows.length > 1) throw new Error('ambiguous_session: 此 ID 属于多个工作区，请使用列表返回的 workspace_key');
        task = taskItem(rows[0]);
        if (task.workspace_identity) throw new Error('remote_history_unavailable: 该工作区历史位于远端，本版只读取本机 CLI 历史');
      } finally { index.close(); }
      const db = openReadOnly(sessionDbPath);
      try {
        const session = db.prepare('SELECT id, title, directory, revert FROM session WHERE id=?').get(session_id);
        if (!session) throw new Error('history_not_found: 指定会话不在本地 CLI 历史库中');
        if (normalizeWorkspace(session.directory) !== normalizeWorkspace(task.workspace_path))
          throw new Error('workspace_mismatch: 任务索引与本地历史库的工作区不一致');
        const parts = new Map();
        for (const row of db.prepare(`SELECT id, message_id, CASE WHEN json_extract(data,'$.type')='text' THEN data
          ELSE json_object('type',json_extract(data,'$.type'),'synthetic',json(data -> '$.synthetic'),
            'metadata',json_extract(data,'$.metadata'),'summaryMessageId',json_extract(data,'$.summaryMessageId'),
            'filename',json_extract(data,'$.filename'),'mime',json_extract(data,'$.mime')) END AS data
          FROM part WHERE session_id=?
          ORDER BY message_id, sequence IS NULL, sequence, time_created, id`).all(session_id)) {
          const part = JSON.parse(row.data);
          if (typeof part?.type !== 'string' || part.type === 'text' && typeof part.text !== 'string')
            throw new Error('history_format_error: 消息片段缺少有效 type 或文本正文');
          const list = parts.get(row.message_id) ?? [];
          list.push(part);
          parts.set(row.message_id, list);
        }
        let active = db.prepare(`SELECT id, time_created, json_remove(data,'$.contextSnapshot') AS data
          FROM message WHERE session_id=? ORDER BY sequence IS NULL, sequence, time_created, rowid`).all(session_id)
          .map(row => {
            const info = JSON.parse(row.data);
            if (info?.role !== 'user' && info?.role !== 'assistant')
              throw new Error('history_format_error: 消息缺少 user/assistant 角色');
            return { info: { ...info, id: row.id }, createdAt: row.time_created, parts: parts.get(row.id) ?? [] };
          });
        const revert = session.revert && JSON.parse(session.revert);
        if (revert?.targetMessageID) {
          const target = active.findIndex(m => m.info.id === revert.targetMessageID);
          if (!revert.keptMessageIDs && target < 0) throw new Error('回退目标不在持久化历史中');
          const byId = new Map(active.map(m => [m.info.id, m]));
          const kept = revert.keptMessageIDs ? revert.keptMessageIDs.map(id => byId.get(id)).filter(Boolean) : active.slice(0, target);
          if (revert.branchCutAfterMessageID) {
            const cut = active.findIndex(m => m.info.id === revert.branchCutAfterMessageID);
            active = cut >= 0 ? [...kept, ...active.slice(cut + 1)] : kept;
          } else {
            const created = active.findIndex(m => m.info.id === revert.createdMessageID);
            active = created >= 0 ? [...kept, ...active.slice(created)] : kept;
          }
        }
        const messages = [];
        for (const message of active) {
          const { info, parts: content } = message;
          const policy = getConversationMessageProjectionPolicy(message);
          if (!(info.role === 'user' && policy === 'realUserInput' || info.role === 'assistant' && policy === 'visibleAssistant')) continue;
          const text = content.filter(p => p.type === 'text' && !p.ignored && !p.synthetic).map(p => p.text).join('');
          if (revert?.targetMessageID && info.role === 'assistant' && info.parentID === revert.createdMessageID &&
            text.endsWith('Rewound conversation to before message ' + revert.targetMessageID + '.')) continue;
          const attachments = content.filter(p => p.type === 'file').map(p => ({ filename: p.filename, mime: p.mime }));
          if (!text && !attachments.length) continue;
          messages.push({ message_id: info.id, role: info.role, parent_message_id: info.parentID ?? null,
            created_at: message.createdAt, text, attachments });
        }
        const end = before_message_id === undefined ? messages.length : messages.findIndex(m => m.message_id === before_message_id);
        if (end < 0) throw new Error('消息游标不在当前会话中');
        const start = Math.max(0, end - limit);
        return { source: 'local_cli_sqlite', branch: revert?.targetMessageID ? 'persisted_revert' : 'persisted',
          session: { ...task, title: session.title, workspace_path: session.directory },
          messages: messages.slice(start, end), total: messages.length,
          next_before_message_id: start > 0 ? messages[start].message_id : null };
      } finally { db.close(); }
    }
  };
}

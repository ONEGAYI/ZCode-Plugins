import { DatabaseSync } from 'node:sqlite';
import { win32 } from 'node:path';
import { readProjectContext } from 'suian-zcode-common/project-context.mjs';
import { getConversationMessageProjectionPolicy } from 'suian-zcode-common/vendor/projection.js';

function openReadOnly(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 2000 });
  db.exec('PRAGMA query_only=ON; BEGIN;');
  return db;
}

const taskColumns = `task_id AS session_id, title, workspace_path, workspace_key,
  workspace_identity, provider, mode AS permission_mode, task_status AS status, created_at, updated_at, pinned, archived`;
const taskColumnsFor = db => taskColumns + (db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'project_id') ? ', project_id, host_id' : '');
const taskItem = row => ({ ...row, pinned: !!row.pinned, archived: !!row.archived });

// automations 行映射对齐官方 rowToAutomation：布尔真实化、可空字段统一 null；
// scheduleRule 为 JSON 列，历史脏数据按未配置处理，不让单行拖垮整个列表
const automationItem = row => ({ automationId: row.automation_id, title: row.title, cronExpr: row.cron_expr,
  enabled: row.enabled === 1, lifecycleStatus: row.lifecycle_status,
  nextRunAt: row.next_run_at ?? null, lastRunAt: row.last_run_at ?? null, runCount: row.run_count,
  recurring: row.recurring === 1, maxRuns: row.max_runs ?? null, scheduleRule: parseScheduleRule(row.schedule_rule),
  workspaceKey: row.workspace_key, workspacePath: row.workspace_path, targetTaskId: row.target_task_id ?? null });

function parseScheduleRule(raw) {
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const normalizeWorkspace = path => win32.normalize(path).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();

// 项目注册表（list_projects 与 start_session 项目模式的数据源）：只读本机未删除项目；
// 左连接展开 roots 后在内存聚合，项目按置顶、位置排序，roots 按位置排序，布尔字段真实化
const projectTablesPresent = db => db.prepare(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('projects','project_roots')").get().n === 2;
const projectRowSql = filter => `SELECT p.project_id,p.name,p.pinned,r.root_path,r.is_primary
  FROM projects p LEFT JOIN project_roots r ON r.project_id=p.project_id
  WHERE p.host_id='local' AND p.deleted=0${filter}
  ORDER BY p.pinned DESC,p.position,p.project_id,r.position,r.root_path`;
const assembleProjects = rows => {
  const projects = [];
  for (const row of rows) {
    let project = projects.at(-1);
    if (!project || project.project_id !== row.project_id) {
      project = { project_id: row.project_id, name: row.name, pinned: !!row.pinned, roots: [] };
      projects.push(project);
    }
    if (row.root_path !== null) project.roots.push({ root_path: row.root_path, is_primary: !!row.is_primary });
  }
  return projects;
};

export function createSessionReader({ indexDbPath, sessionDbPath }) {
  return {
    // 宿主能力探测：仅当索引同时具备 projects 与 project_roots 两表时按项目能力差异化注册工具
    projectsSupported() {
      const db = openReadOnly(indexDbPath);
      try { return projectTablesPresent(db); } finally { db.close(); }
    },
    listProjects() {
      const db = openReadOnly(indexDbPath);
      try {
        if (!projectTablesPresent(db)) throw new Error('project_schema_unsupported: 当前宿主索引不支持项目列表（ZCode Desktop 3.16+）');
        return { source: 'local_tasks_index', projects: assembleProjects(db.prepare(projectRowSql('')).all()) };
      } finally { db.close(); }
    },
    projectById(projectId) {
      const db = openReadOnly(indexDbPath);
      try {
        if (!projectTablesPresent(db)) return null;
        const [project] = assembleProjects(db.prepare(projectRowSql(' AND p.project_id=?')).all(projectId));
        return project ?? null;
      } finally { db.close(); }
    },
    // 按工作区根反查所属项目：路径经 normalize 精确匹配（大小写/斜杠/尾斜杠归一）；
    // 旧宿主索引无项目表时按空结果降级，调用方仅在支持项目时进入
    projectsByRoot(workspacePath) {
      const db = openReadOnly(indexDbPath);
      try {
        if (!projectTablesPresent(db)) return [];
        db.function('normalize_workspace', normalizeWorkspace);
        return db.prepare(`SELECT p.project_id,p.name FROM projects p JOIN project_roots r ON r.project_id=p.project_id
          WHERE p.host_id='local' AND p.deleted=0 AND normalize_workspace(r.root_path)=?
          ORDER BY p.position,p.project_id`).all(normalizeWorkspace(workspacePath));
      } finally { db.close(); }
    },
    // start_session 项目归属的写后读回：按 task_id 精确定位（含归档行、排除删除行，与 listSessionStates 同款精确路径）；
    // 行缺失、跨工作区歧义或索引无 project_id 列返回 undefined 表示无法核实，null 表示已确认未归类
    sessionProjectId({ session_id }) {
      const db = openReadOnly(indexDbPath);
      try {
        if (!taskColumnsFor(db).includes('project_id')) return undefined;
        const rows = db.prepare('SELECT project_id,host_id FROM tasks WHERE task_id=? AND deleted=0').all(session_id);
        if (rows.length !== 1 || rows[0].host_id !== 'local') return undefined;
        return rows[0].project_id;
      } finally { db.close(); }
    },
    sessionProject({ session_id }) {
      const index = openReadOnly(indexDbPath);
      try {
        if (!taskColumnsFor(index).includes('project_id')) return undefined;
        const matches = index.prepare('SELECT host_id,workspace_key FROM tasks WHERE task_id=? AND deleted=0').all(session_id);
        if (matches.length !== 1 || matches[0].host_id !== 'local') return undefined;
        return readProjectContext({ indexDbPath, sessionId: session_id, workspaceKey: matches[0].workspace_key });
      } finally { index.close(); }
    },
    sessionTitle({ session_id }) {
      // 复核用轻量读取：只查两库标题。session_title 为 null 表示 CLI 库尚无该会话行（deferPersistence 未落）。
      // index_title 在跨工作区同 task_id 时取任意行，仅供诊断展示；分叉判定只用 session_title（CLI 库主键无歧义）
      const index = openReadOnly(indexDbPath);
      let index_title = null;
      try {
        const row = index.prepare('SELECT title FROM tasks WHERE task_id=? AND deleted=0').get(session_id);
        if (row) index_title = row.title;
      } finally { index.close(); }
      const db = openReadOnly(sessionDbPath);
      let session_title = null;
      try {
        const row = db.prepare('SELECT title FROM session WHERE id=?').get(session_id);
        if (row) session_title = row.title;
      } finally { db.close(); }
      return { index_title, session_title };
    },
    // 权限继承读取 CLI 会话库；任务索引的 mode 可能滞后，不能用于决定新会话权限。
    sessionMode({ session_id }) {
      const db = openReadOnly(sessionDbPath);
      try {
        const row = db.prepare("SELECT json_extract(permission, '$.mode') AS mode FROM session WHERE id=?").get(session_id);
        return { mode: row?.mode ?? null, observed: row ? [row.mode] : [] };
      } finally { db.close(); }
    },
    // get_current_session 的自省读取：两库都可能没有行（子代理上下文、deferPersistence 未落库），字段可空不报错。
    // 跨工作区同 task_id 的多行按 workspace_key 排序全部返回，交调用方判断；index_title 取首行，与 sessionTitle 的诊断语义一致。
    sessionOverview({ session_id }) {
      const index = openReadOnly(indexDbPath);
      let indexMatches, project;
      try {
        indexMatches = index.prepare(`SELECT ${taskColumnsFor(index)} FROM tasks WHERE task_id=? AND deleted=0
          ORDER BY workspace_key`).all(session_id).map(taskItem);
        if (indexMatches.length === 1 && indexMatches[0].host_id === 'local')
          project = readProjectContext({ indexDbPath, sessionId: session_id, workspaceKey: indexMatches[0].workspace_key });
      } finally { index.close(); }
      const db = openReadOnly(sessionDbPath);
      let sessionTitle = null, workspacePath = null, permissionMode = null;
      try {
        const row = db.prepare("SELECT title, directory, json_extract(permission, '$.mode') AS mode FROM session WHERE id=?").get(session_id);
        if (row) ({ title: sessionTitle, directory: workspacePath, mode: permissionMode } = row);
      } finally { db.close(); }
      return { session_title: sessionTitle, index_title: indexMatches.length ? indexMatches[0].title : null,
        workspace_path: workspacePath, permission_mode: permissionMode, index_matches: indexMatches,
        ...(project ? { project_id: project.projectId, project_name: project.projectName,
          project_deleted: project.projectDeleted, additional_directories: project.additionalDirectories } : {}) };
    },
    listSessions({ limit = 20, offset = 0, workspace_path, project_id, query, include_archived = false } = {}) {
      const db = openReadOnly(indexDbPath);
      try {
        const conditions = ['deleted=0'], args = [];
        const columns = taskColumnsFor(db);
        const projectColumns = columns.includes('project_id') ? `, execution_directories,
          (SELECT COUNT(*) FROM project_roots WHERE project_id=tasks.project_id) AS project_root_count,
          (SELECT json_group_array(root_path) FROM (
            SELECT root_path FROM project_roots WHERE project_id=tasks.project_id AND root_path<>tasks.root_path
            ORDER BY position,root_path)) AS project_additional_directories` : '';
        if (project_id !== undefined) {
          if (!columns.includes('project_id')) throw new Error('project_schema_unsupported: 当前宿主索引不支持项目筛选');
          conditions.push('project_id IS ?'); args.push(project_id);
        }
        if (!include_archived) conditions.push('archived=0');
        if (workspace_path !== undefined || query !== undefined) db.function('normalize_workspace', normalizeWorkspace);
        if (workspace_path !== undefined) {
          conditions.push('normalize_workspace(workspace_path)=?');
          args.push(normalizeWorkspace(workspace_path));
        }
        if (query !== undefined) {
          const pathQuery = normalizeWorkspace(query);
          const projectQuery = projectColumns ? ` OR project_id IN (
              SELECT project_id FROM project_roots WHERE instr(normalize_workspace(root_path),?)>0
              UNION
              SELECT member.project_id FROM tasks member,json_each(member.execution_directories) directory
              WHERE member.deleted=0 AND instr(normalize_workspace(directory.value),?)>0
            ) OR (project_id IS NULL AND EXISTS (
              SELECT 1 FROM json_each(execution_directories) directory WHERE instr(normalize_workspace(directory.value),?)>0
            ))` : '';
          conditions.push(`(instr(lower(title),lower(?))>0 OR instr(lower(task_id),lower(?))>0
            OR instr(normalize_workspace(workspace_path),?)>0${projectQuery})`);
          args.push(query, query, pathQuery);
          if (projectColumns) args.push(pathQuery, pathQuery, pathQuery);
        }
        const where = conditions.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...args).n;
        // 置顶优先展示（对齐 Desktop 端置顶区语义），置顶段内部与非置顶段各自按更新时间倒序
        const sessions = db.prepare(`SELECT ${columns}${projectColumns} FROM tasks WHERE ${where}
          ORDER BY pinned DESC, updated_at DESC, task_id, workspace_key LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row => {
            if (!projectColumns) return taskItem(row);
            const { execution_directories, project_root_count, project_additional_directories, ...task } = row;
            const directories = JSON.parse(execution_directories ?? project_additional_directories);
            return { ...taskItem(task), is_multi_workspace_project: project_root_count > 1,
              additional_directories_count: directories.length, additional_directories_preview: directories.slice(0, 3),
              additional_directories_truncated: directories.length > 3 };
          });
        const next = offset + sessions.length;
        return { source: 'local_tasks_index', sessions, total, next_offset: next < total ? next : null };
      } finally { db.close(); }
    },
    // 置顶列表与 listSessions 同源；排序在置顶行集下等价（listSessions 多出的 pinned DESC 对全置顶行是常数）
    listPinnedSessions({ limit = 20, offset = 0, workspace_path, include_archived = false } = {}) {
      const db = openReadOnly(indexDbPath);
      try {
        const conditions = ['deleted=0', 'pinned=1'], args = [];
        if (!include_archived) conditions.push('archived=0');
        if (workspace_path !== undefined) {
          db.function('normalize_workspace', normalizeWorkspace);
          conditions.push('normalize_workspace(workspace_path)=?');
          args.push(normalizeWorkspace(workspace_path));
        }
        const where = conditions.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...args).n;
        const sessions = db.prepare(`SELECT ${taskColumnsFor(db)} FROM tasks WHERE ${where}
          ORDER BY updated_at DESC, task_id, workspace_key LIMIT ? OFFSET ?`).all(...args, limit, offset).map(taskItem);
        const next = offset + sessions.length;
        return { source: 'local_tasks_index', sessions, total, next_offset: next < total ? next : null };
      } finally { db.close(); }
    },
    // 写后读回的精确定位：按 task_id 精确匹配（子串/分页无关），含归档行、排除删除行；
    // 跨工作区同 ID 多行由调用方判歧义，不在此静默取舍
    listSessionStates({ session_id, workspace_path, workspace_key }) {
      const db = openReadOnly(indexDbPath);
      try {
        const conditions = ['task_id=?', 'deleted=0'], args = [session_id];
        if (workspace_key !== undefined) { conditions.push('workspace_key=?'); args.push(workspace_key); }
        if (workspace_path !== undefined) {
          db.function('normalize_workspace', normalizeWorkspace);
          conditions.push('normalize_workspace(workspace_path)=?');
          args.push(normalizeWorkspace(workspace_path));
        }
        return db.prepare(`SELECT ${taskColumnsFor(db)} FROM tasks WHERE ${conditions.join(' AND ')}`).all(...args).map(taskItem);
      } finally { db.close(); }
    },
    // 定时任务清单：直读 automations 表（官方任务索引同库），只读、离线可用；
    // 缺省全量，与官方 automation list 同按创建时间倒序。产品上限 20 条，不做分页。
    listAutomations({ workspace_path, workspace_key } = {}) {
      const db = openReadOnly(indexDbPath);
      try {
        const conditions = [], args = [];
        if (workspace_key !== undefined) { conditions.push('workspace_key=?'); args.push(workspace_key); }
        if (workspace_path !== undefined) {
          db.function('normalize_workspace', normalizeWorkspace);
          conditions.push('normalize_workspace(workspace_path)=?');
          args.push(normalizeWorkspace(workspace_path));
        }
        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
        const automations = db.prepare(`SELECT automation_id, title, cron_expr, enabled, lifecycle_status,
          next_run_at, last_run_at, run_count, recurring, max_runs, schedule_rule,
          workspace_key, workspace_path, target_task_id FROM automations${where}
          ORDER BY created_at DESC, automation_id`).all(...args).map(automationItem);
        return { source: 'local_tasks_index', automations, total: automations.length };
      } finally { db.close(); }
    },
    readSession({ session_id, limit = 30, before_message_id, workspace_key }) {
      const index = openReadOnly(indexDbPath);
      let task;
      try {
        const keyFilter = workspace_key === undefined ? '' : ' AND workspace_key=?';
        const args = workspace_key === undefined ? [session_id] : [session_id, workspace_key];
        const rows = index.prepare(`SELECT ${taskColumnsFor(index)} FROM tasks WHERE task_id=? AND deleted=0${keyFilter}`).all(...args);
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

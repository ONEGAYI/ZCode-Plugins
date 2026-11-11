import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const fail = (code, message) => Object.assign(new Error(message), { code });

// 只读 Host 任务索引；按上游 resolveSessionDirectories 的顺序读取冻结目录或项目 roots。
export function readProjectContext({ indexDbPath, sessionId, workspacePath, workspaceKey }) {
  const legacy = { projectId: null, workspacePath, additionalDirectories: [] };
  if (!indexDbPath) return legacy;
  try { statSync(indexDbPath); }
  catch (error) { if (error.code === 'ENOENT') return legacy; throw error; }
  const db = new DatabaseSync(indexDbPath, { readOnly: true, timeout: 2000 });
  try {
    db.exec('BEGIN');
    const matches = db.prepare('SELECT * FROM tasks WHERE task_id=?' + (workspaceKey === undefined ? '' : ' AND workspace_key=?'))
      .all(sessionId, ...(workspaceKey === undefined ? [] : [workspaceKey]));
    const rows = matches.filter(row => row.deleted !== 1);
    if (rows.length > 1) throw fail('ambiguous_session', '会话对应多个工作区，请提供 workspace_key');
    const row = rows[0];
    if (!row) {
      if (matches.length) throw fail('session_not_found', '会话已删除，不能取得目录权限');
      return legacy; // 尚未首发落库的会话只有启动绑定。
    }
    if (!Object.hasOwn(row, 'project_id')) {
      if (row.workspace_identity) throw fail('remote_workspace_unavailable', '本机插件不能把远端目录作为本机目录');
      return { ...legacy, workspacePath: row.workspace_path };
    }
    if (row.host_id !== 'local') throw fail('remote_workspace_unavailable', '本机插件不能把远端目录作为本机目录');
    const cwd = row.root_path;
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw fail('project_storage_invalid', '会话执行目录必须是绝对路径');
    const managed = row.worktree_root != null;
    if (managed && (typeof row.workspace_path !== 'string' || !isAbsolute(row.workspace_path) || typeof row.execution_directories !== 'string'))
      throw fail('project_storage_invalid', '受管工作树缺少原 Host 归属或冻结目录');
    let project = null, roots = [];
    if (row.project_id !== null) {
      project = db.prepare('SELECT project_id,host_id,name,deleted FROM projects WHERE project_id=?').get(row.project_id);
      if (!project || project.host_id !== row.host_id) throw fail('project_storage_invalid', '会话项目不存在或 Host 归属不一致');
      roots = db.prepare('SELECT root_path FROM project_roots WHERE project_id=? ORDER BY position,root_path').all(row.project_id).map(root => root.root_path);
    }
    const additionalDirectories = typeof row.execution_directories === 'string' ? JSON.parse(row.execution_directories) : roots.filter(path => path !== cwd);
    if (!Array.isArray(additionalDirectories) || additionalDirectories.some(path => typeof path !== 'string' || !isAbsolute(path))) throw fail('project_storage_invalid', '会话附加目录必须是绝对路径');
    return { projectId: row.project_id, projectName: project?.name ?? null, projectDeleted: project?.deleted === 1,
      workspacePath: cwd, additionalDirectories, ...(managed ? { hostWorkspacePath: row.workspace_path } : {}) };
  } finally { db.close(); }
}

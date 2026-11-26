import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setCommonLocation } from '../common-client.mjs';

// 进程内 MCP 测试的公共层锚点（PKG-03 迁移后 createMcpServer 需要公共定位）：
// 构建一次 common 发布目录并按官方 InstalledPluginRecord 写安装记录；子进程场景导出宿主注入变量。
// node --test 并行进程同时冷启动：各自构建到 PID 专属临时目录再原子 rename，失败方复用已就位结果。
// 缓存存在即复用；common 源变化后删除 tests/.scratch/common-anchor 重建。
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const anchorRoot = join(fileURLToPath(new URL('./', import.meta.url)), '.scratch', 'common-anchor');
const commonReleaseDir = join(anchorRoot, 'common-release');
if (!existsSync(join(commonReleaseDir, 'release.json'))) {
  const stagingDir = `${commonReleaseDir}.tmp-${process.pid}`;
  rmSync(stagingDir, { recursive: true, force: true });
  execFileSync(process.execPath, [join(repoRoot, 'suian-zcode-common', 'build-release.mjs'), '--out', stagingDir], { stdio: 'ignore' });
  try {
    renameSync(stagingDir, commonReleaseDir);
  } catch {
    rmSync(stagingDir, { recursive: true, force: true }); // 他进程已就位，复用其产物
  }
  if (!existsSync(join(commonReleaseDir, 'release.json'))) throw new Error('common 发布目录构建后仍不可用：' + commonReleaseDir);
}
const commonRelease = JSON.parse(readFileSync(join(commonReleaseDir, 'release.json'), 'utf8'));
mkdirSync(join(anchorRoot, 'data', 'suian-zcode-app-mcp'), { recursive: true });
const installedPluginsPath = join(anchorRoot, 'installed_plugins.json');
const registryContent = JSON.stringify({
  version: 1,
  plugins: [{ id: 'suian-zcode-common@suian-zcode-plugins', name: 'suian-zcode-common', marketplace: 'suian-zcode-plugins',
    version: commonRelease.pluginVersion, installPath: commonReleaseDir, installedAt: '2026-10-20T00:00:00.000Z', scope: 'user' }],
}) + '\n';
// 各进程写入内容一致：目标已是期望内容时跳过覆盖；rename 撞上他进程并发覆盖（Windows EPERM）
// 时重读校验，一致即复用。仅在不一致时才失败，避免并行冷启动竞态让整个文件级测试报废。
let registryOk = false;
try { registryOk = readFileSync(installedPluginsPath, 'utf8') === registryContent; } catch {}
if (!registryOk) {
  const registryTemp = `${installedPluginsPath}.tmp-${process.pid}`;
  writeFileSync(registryTemp, registryContent);
  try {
    renameSync(registryTemp, installedPluginsPath);
  } catch (error) {
    rmSync(registryTemp, { force: true });
    try { registryOk = readFileSync(installedPluginsPath, 'utf8') === registryContent; } catch {}
    if (!registryOk) throw error;
  }
}
setCommonLocation({ installedPluginsPath });
export const testZcodePluginData = join(anchorRoot, 'data', 'suian-zcode-app-mcp');
export const testInstalledPluginsPath = installedPluginsPath;
// 旧宿主样本：3.14.3 至 3.18.2 的宿主会在 content 文本后自行追加 structuredContent，工具结果文本因此保持纯摘要
export const LEGACY_ZCODE_APP_VERSION = '3.18.2';

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
    task_id TEXT, title TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build', task_status TEXT,
    created_at INTEGER, updated_at INTEGER, pinned INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
    PRIMARY KEY (workspace_key, task_id)
  );`);
  // automations 与 tasks 同库（官方 tasks-index.sqlite），列集按官方 AUTOMATION_SCHEMA（schema-v1.ts）
  index.exec(`CREATE TABLE automations (
    automation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', cron_expr TEXT NOT NULL, prompt TEXT NOT NULL,
    model TEXT, provider TEXT, mode TEXT, thought_level TEXT, model_selection TEXT,
    workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
    target_task_id TEXT, bot_delivery_target TEXT, location_kind TEXT NOT NULL DEFAULT 'local',
    recurring INTEGER NOT NULL DEFAULT 1, max_runs INTEGER, end_at INTEGER,
    schedule_rule TEXT, schedule_edited_by_user INTEGER NOT NULL DEFAULT 0,
    run_count INTEGER NOT NULL DEFAULT 0, scheduled_run_count INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, lifecycle_status TEXT NOT NULL DEFAULT 'active',
    next_run_at INTEGER, last_run_at INTEGER, running INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER,
    dispatch_status TEXT NOT NULL DEFAULT 'idle', dispatch_attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  history.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, title TEXT, directory TEXT, path TEXT, revert TEXT, permission TEXT, parent_id TEXT, task_type TEXT
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
    indexDbPath, sessionDbPath, artifactDbPath: join(directory, 'artifacts.sqlite'), index, history,
    task({ id, title = id, workspace = 'D:\\work\\alpha', key = workspace,
      identity = null, updated = 10, pinned = 0, archived = 0, deleted = 0, mode = 'build' }) {
      index.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(key, workspace, identity, id, title, 'glm', mode, 'completed', 1, updated, pinned, archived, deleted);
    },
    // 列语义与官方 automationRepo.create 对齐；未列出的列走 DDL 缺省
    automation({ id = 'automation-fixture', title = id, cron = '0 9 * * *',
      workspace = 'D:\\work\\alpha', key = workspace, target = null,
      recurring = 1, maxRuns = null, scheduleRule = null, runCount = 0,
      enabled = 1, lifecycle = 'active', nextRunAt = null, lastRunAt = null, created = 10 }) {
      index.prepare(`INSERT INTO automations (automation_id, title, cron_expr, prompt, workspace_key, workspace_path,
        target_task_id, recurring, max_runs, schedule_rule, run_count, enabled, lifecycle_status,
        next_run_at, last_run_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, title, cron, '', key, workspace, target, recurring, maxRuns, scheduleRule, runCount,
          enabled, lifecycle, nextRunAt, lastRunAt, created, created);
    },
    session({ id, title = id, directory = 'D:\\work\\alpha', revert = null, permission = null, parent = null, taskType = null }) {
      history.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?)')
        .run(id, title, directory, directory, revert && JSON.stringify(revert), permission && JSON.stringify(permission), parent, taskType);
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

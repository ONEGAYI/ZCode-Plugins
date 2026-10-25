#!/usr/bin/env node
// jsonl 事件日志的按天滚动、行内嵌版本与写入点自清理（日志留存窗口，见 docs/keepalive-log-retention-spec.md）。
// 仅用 Node 内置模块、相对导入链外无依赖：depcheck-hook 与 toast-action 的导入链在依赖全丢时仍须可用。
// toast-executor 是自包含单文件部署快照（PKG-06），不 import 本模块，滚动行为在内联实现中保持一致。
import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RETENTION_DAYS = 7;

export function dayStamp(date = new Date()) {
  return date.getFullYear() + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0');
}

export function cutoffStamp(now = new Date(), retentionDays = RETENTION_DAYS) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  return dayStamp(cutoff);
}

// 过期判定只认 `<family>-<yyyyMMdd>.log.jsonl` 严格模式与精确的旧单文件名；
// 命名不符合的文件一律不动，防止误删运行数据。
export function listExpiredLogFiles(names, { family, legacyName, now = new Date(), retentionDays = RETENTION_DAYS }) {
  const dated = new RegExp(`^${family}-(\\d{8})\\.log\\.jsonl$`);
  const cutoff = cutoffStamp(now, retentionDays);
  return names.filter(name => name === legacyName || (() => {
    const match = dated.exec(name);
    return match !== null && match[1] < cutoff;
  })());
}

// 版本来源单一：写日志方相邻的 .zcode-plugin/plugin.json；读不到（如异构部署副本）返回 null。
export async function resolvePluginVersion(moduleUrl = import.meta.url) {
  try {
    const manifest = JSON.parse(await readFile(join(dirname(fileURLToPath(moduleUrl)), '.zcode-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : null;
  } catch {
    return null;
  }
}

export async function appendFamilyLog({ dataDir, family, legacyName, version, entry, now = new Date() }) {
  await mkdir(dataDir, { recursive: true });
  for (const expired of listExpiredLogFiles(await readdir(dataDir), { family, legacyName, now })) {
    await unlink(join(dataDir, expired)).catch(() => {});
  }
  const line = { at: now.toISOString(), ...(version ? { v: version } : {}), ...entry };
  await appendFile(join(dataDir, `${family}-${dayStamp(now)}.log.jsonl`), JSON.stringify(line) + '\n', 'utf8');
}

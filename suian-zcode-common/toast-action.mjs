#!/usr/bin/env node
// Toast 按钮协议入口：suian-zcode-common://fix → 现场重扫依赖 → 复制修复提示词并打开 ZCode。
// 注意相对导入 notification-action.mjs——本入口不得经 node_modules 解析（依赖缺失场景仍需可用）。
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { copyPromptAndOpenWorkspace } from './notification-action.mjs';
import { resolveDataDir } from './depcheck-hook.mjs';
import { scanSuianPlugins } from './depcheck.mjs';
import { buildFixPrompt } from './depcheck-prompt.mjs';
import { appendFamilyLog, resolvePluginVersion } from './log-rotate.mjs';

export function parseActionUri(uri) {
  const match = /^suian-zcode-common:\/\/([a-z-]+)$/i.exec(String(uri ?? ''));
  return match ? { action: match[1].toLowerCase() } : null;
}

export async function runAction({ uri, dataDir, homeDir = homedir(), setClipboard, openWorkspace }) {
  const parsed = parseActionUri(uri);
  if (!parsed) return { ok: false, reason: 'invalid_uri' };
  if (parsed.action !== 'fix') return { ok: false, reason: 'unknown_action' };
  // 按钮点击与 Toast 弹出可能间隔很久，现场重扫保证提示词反映当前实际状态
  const result = await scanSuianPlugins({ homeDir });
  const prompt = buildFixPrompt(result);
  await copyPromptAndOpenWorkspace({ prompt, dataDir, setClipboard, openWorkspace });
  if (result.skipped) return { ok: false, reason: 'registry_unavailable', skipped: result.skipped, action: 'fix', issues: null };
  return { ok: true, action: 'fix', issues: result.issues.length };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dataDir = process.argv[3] ?? resolveDataDir();
  const logAction = async entry => {
    try {
      await appendFamilyLog({ dataDir, family: 'toast-action', legacyName: 'toast-action-log.jsonl', version: await resolvePluginVersion(), entry });
    } catch {}
  };
  runAction({ uri: process.argv[2], dataDir })
    .then(async result => {
      console.log(JSON.stringify(result));
      await logAction({ uri: process.argv[2], ok: result.ok, reason: result.reason ?? null, issues: result.issues ?? null });
      process.exit(result.ok ? 0 : 1);
    })
    .catch(async error => {
      console.log(JSON.stringify({ ok: false, reason: 'error', detail: error.message }));
      await logAction({ uri: process.argv[2], ok: false, reason: 'error', detail: String(error.message).slice(0, 200) });
      process.exit(1);
    });
}

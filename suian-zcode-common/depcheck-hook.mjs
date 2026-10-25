#!/usr/bin/env node
// ZCode Stop Hook：扫描已安装 suian 系列插件的依赖完整性，缺失时经 Toast 提醒并给出复制修复提示词的按钮。
// 约定（源码核实）：hooks.json 以 async:true 注册，宿主 fire-and-forget，stdout 决策被忽略；
// stop_hook_active=true 表示本轮由 Stop 续跑产生，跳过；stdout 不得以 { 开头；恒 exit 0，异常吞掉记日志。
// 本钩子及其导入链（depcheck/notifications/notification-install/cooldown/windows）只用 Node 内置模块，
// 且全部为 common 包内相对导入——不经 node_modules 解析，依赖全丢时仍可运行并报警。
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { scanSuianPlugins } from './depcheck.mjs';
import { buildToastMessage } from './depcheck-prompt.mjs';
import { notifyOnce } from './notifications.mjs';
import { installToastAssets, buildVbsContent, resolveToastPluginsFile } from './notification-install.mjs';
import { toastRootFor } from './toast-runtime.mjs';
import { fileShell } from './windows.mjs';
import { appendFamilyLog, resolvePluginVersion } from './log-rotate.mjs';

export const TOAST_IDENTITY = {
  protocol: 'suian-zcode-common',
  appId: 'SUIAN.SuianZcodeCommon.Toast',
  shortcutName: 'ZCode 公共基础插件.lnk',
  description: 'ZCode 公共基础插件通知',
};
export const TOAST_TITLE = 'suian 插件依赖不完整';
export const TOAST_REASON_CODE = 'dependency-incomplete';

export function resolveDataDir(env = process.env) {
  if (env.ZCODE_PLUGIN_DATA) return join(env.ZCODE_PLUGIN_DATA, 'state');
  return join(homedir(), '.zcode', 'suian-zcode-common');
}

// Toast 身份归调用方：common 首次报警前确保自己的协议/AppID/快捷方式已注册，
// 并保证共享 Toast 运行时（缓存外执行器）已部署。幂等判据是转发 vbs 内容、外置身份描述
// 与注册表协议键三重校验——仅凭 appid 缓存会在 common 升级后指向旧版本缓存路径（按钮运行
// 旧逻辑），或身份被外部清理后静默失声。
export async function ensureToastIdentity({ dataDir, homeDir = process.env.SUIAN_DEPCHECK_HOME || homedir(), pluginsFile = resolveToastPluginsFile(), install = installToastAssets, shell = fileShell }) {
  const toastRoot = toastRootFor(homeDir);
  const desiredVbs = buildVbsContent({ protocol: TOAST_IDENTITY.protocol, launcherPath: join(toastRoot, 'launch.vbs') });
  let vbsMatches = false;
  try { vbsMatches = (await readFile(join(dataDir, 'toast-launch.vbs'), 'utf8')) === desiredVbs; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (vbsMatches) {
    let identityPresent = false;
    try {
      const identity = JSON.parse(await readFile(join(toastRoot, 'identities', `${TOAST_IDENTITY.protocol}.json`), 'utf8'));
      identityPresent = identity?.protocol === TOAST_IDENTITY.protocol && identity.pluginsFile === pluginsFile;
    }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (identityPresent) {
      try {
        await shell.run('reg.exe', ['query', `HKCU\\Software\\Classes\\${TOAST_IDENTITY.protocol}`, '/ve']);
        return { action: 'cached' };
      } catch { /* 协议键缺失（被外部清理），落到重装自愈 */ }
    }
  }
  await install({ dataDir, homeDir, pluginsFile, ...TOAST_IDENTITY });
  return { action: 'installed' };
}

async function persistLastResult(dataDir, result) {
  await mkdir(dataDir, { recursive: true });
  const temporary = join(dataDir, 'depcheck-last.tmp-' + randomUUID());
  await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await rename(temporary, join(dataDir, 'depcheck-last.json'));
}

const defaultNotify = ({ dataDir, message }) => notifyOnce({
  dataDir,
  appId: TOAST_IDENTITY.appId,
  title: TOAST_TITLE,
  message,
  reasonCode: TOAST_REASON_CODE,
  actionLabel: '复制修复提示词并打开 ZCode',
  actionUri: `${TOAST_IDENTITY.protocol}://fix`,
});

// 宿主注入优先定位实际存储根；独立诊断仍允许显式 homeDir 选择默认布局。
const defaultScan = () => scanSuianPlugins({ pluginsFile: resolveToastPluginsFile(), homeDir: process.env.SUIAN_DEPCHECK_HOME || undefined });

export async function runDepcheckHook({ payload, dataDir, scan = defaultScan, ensureIdentity = ({ dataDir: dir }) => ensureToastIdentity({ dataDir: dir }), notify = defaultNotify, persist = persistLastResult }) {
  if (!payload || typeof payload !== 'object') return { action: 'ignored_invalid' };
  if (payload.stop_hook_active === true) return { action: 'skipped_stale' };
  const result = await scan();
  if (result.skipped) return { action: 'skipped', reason: result.skipped };
  await persist(dataDir, result);
  if (result.ok) return { action: 'clean' };
  const identity = await ensureIdentity({ dataDir });
  const toast = await notify({ dataDir, message: buildToastMessage(result) });
  return { action: 'notified', issues: result.issues.length, identity: identity.action, shown: toast.shown === true, toastReason: toast.reason ?? null };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let dataDirArg = null;
  let pluginsFileArg;
  const scanOnly = process.argv.includes('--scan-only');
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--data-dir' && process.argv[i + 1]) dataDirArg = resolve(process.argv[++i]);
    if (process.argv[i] === '--installed-plugins' && process.argv[i + 1]) pluginsFileArg = resolve(process.argv[++i]);
  }
  const dataDir = dataDirArg ?? resolveDataDir();
  const pluginsFile = resolveToastPluginsFile(pluginsFileArg);
  const scan = () => scanSuianPlugins({ pluginsFile, homeDir: process.env.SUIAN_DEPCHECK_HOME || undefined });
  const logHook = async entry => {
    try {
      await appendFamilyLog({ dataDir, family: 'hook', legacyName: 'hook.log.jsonl', version: await resolvePluginVersion(), entry });
    } catch {}
  };
  try {
    if (scanOnly) {
      const result = await scan();
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let payload = null;
    try { payload = JSON.parse(raw); } catch {}
    const result = await runDepcheckHook({ payload, dataDir, scan, ensureIdentity: ({ dataDir: dir }) => ensureToastIdentity({ dataDir: dir, pluginsFile }) });
    console.log('suian-zcode-common:', JSON.stringify(result));
    await logHook({ event: payload?.hook_event_name ?? 'Stop', action: result.action, sessionId: payload?.session_id ?? null, error: null });
  } catch (error) {
    console.log('suian-zcode-common: hook-error', error.message);
    await logHook({ event: 'Stop', action: 'error', error: String(error.message).slice(0, 200) });
  }
  process.exit(0);
}

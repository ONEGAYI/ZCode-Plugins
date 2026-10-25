#!/usr/bin/env node
// suian 共享 Toast 执行器（PKG-06 部署快照）：common 在安装/报警时把本文件原样部署到
// <homeDir>/.zcode/tools/suian-zcode-common/toast/executor.mjs（版本缓存之外）。
// 单文件自包含、只依赖 Node 内置模块：即便 common 与 title 的插件缓存被整体删除，
// 旧通知点击仍能现场诊断并复制修复提示。更新仅经 common 的部署流程（toast-runtime.mjs）。
// common://fix 的扫描与提示词判据同源维护于 depcheck.mjs / depcheck-prompt.mjs（契约测试对齐）；
// title://fix 只读取 title 外置数据目录中的身份描述与模板，不导入 title 缓存代码。
import { appendFile, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOAST_PROTOCOLS = ['suian-zcode-common', 'suian-zcode-title'];
export const COMMON_PACKAGE = 'suian-zcode-common';
export const SUIAN_MARKETPLACE = 'suian-zcode-plugins';
export const TITLE_PLUGIN_ID = 'suian-zcode-title';

const toastRootFor = homeDir => join(homeDir, '.zcode', 'tools', COMMON_PACKAGE, 'toast');
const samePath = (a, b) => toNamespacedPath(resolve(a)) === toNamespacedPath(resolve(b));

// —— URI 契约：只支持 common 依赖修复与 title 网关排障两种身份，动作只接受 fix ——

export function parseActionUri(uri) {
  const match = /^(suian-zcode-common|suian-zcode-title):\/\/([a-z]+)$/i.exec(String(uri ?? ''));
  return match ? { protocol: match[1].toLowerCase(), action: match[2].toLowerCase() } : null;
}

// —— common://fix：现场重扫当前依赖状态（判据与 depcheck.mjs 同步维护：PKG-08 发布契约检查） ——

async function maybeLstat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readJsonAt(path) {
  try { return { status: 'ok', value: JSON.parse(await readFile(path, 'utf8')) }; }
  catch (error) { return { status: error.code === 'ENOENT' ? 'missing' : 'bad' }; }
}

function pickSuianEntries(manifest) {
  const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
  return plugins.filter(entry => {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    const id = typeof entry?.id === 'string' ? entry.id : '';
    return name.startsWith('suian-') || id.endsWith(`@${SUIAN_MARKETPLACE}`);
  });
}

const asArray = value => Array.isArray(value) ? value : [];
const sha256 = data => createHash('sha256').update(data).digest('hex');

const parseVersion = value => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const compareVersion = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};

function readCompatFields(release) {
  const expectedApi = release.expectedCommonApiVersion ?? release.commonApiVersion ?? null;
  return { expectedApi, minimumCommonVersion: typeof release.minimumCommonVersion === 'string' ? release.minimumCommonVersion : null };
}

function releaseShapeOk(release) {
  return release?.formatVersion === 1
    && typeof release?.pluginName === 'string'
    && typeof release?.pluginVersion === 'string' && parseVersion(release.pluginVersion) !== null
    && typeof release?.buildId === 'string' && /^[0-9a-f]{64}$/.test(release.buildId)
    && typeof release?.entries === 'object' && release.entries !== null
    && Array.isArray(release?.files);
}

async function checkReleaseDirectory(installPath, name, issues) {
  const releasePath = join(installPath, 'release.json');
  const releaseRead = await readJsonAt(releasePath);
  if (releaseRead.status === 'missing') {
    issues.push({ plugin: name, code: 'release_missing', detail: `${releasePath} 不存在（非发布包形态；源码开发布局不经原生安装分发）` });
    return null;
  }
  if (releaseRead.status !== 'ok' || !releaseShapeOk(releaseRead.value)) {
    issues.push({ plugin: name, code: 'release_invalid', detail: `release.json 缺失或字段不满足发布契约：${releasePath}` });
    return null;
  }
  const release = releaseRead.value;
  if (release.pluginName !== name) {
    issues.push({ plugin: name, code: 'identity_mismatch', detail: `发布清单身份为 ${release.pluginName}，安装条目是 ${name}` });
    return null;
  }
  for (const entry of release.files) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      issues.push({ plugin: name, code: 'release_invalid', detail: `发布清单文件条目异常：${JSON.stringify(entry)}` });
      continue;
    }
    const filePath = join(installPath, entry.path);
    const present = await maybeLstat(filePath);
    if (!present || !present.isFile()) {
      issues.push({ plugin: name, code: 'file_missing', detail: `发布文件缺失：${entry.path}` });
      continue;
    }
    const content = await readFile(filePath);
    if (sha256(content) !== entry.sha256) {
      issues.push({ plugin: name, code: 'file_digest_mismatch', detail: `发布文件摘要不符：${entry.path}` });
    }
  }
  return release;
}

async function inspectLegacyRuntimeLink(runtimeRoot) {
  const present = await maybeLstat(runtimeRoot);
  if (!present) return 'absent';
  return present.isSymbolicLink() ? 'symlink' : 'directory';
}

export async function scanSuianPlugins({ pluginsFile, homeDir = homedir(), toolsRoot } = {}) {
  const resolvedPluginsFile = pluginsFile ?? join(homeDir, '.zcode', 'cli', 'plugins', 'installed_plugins.json');
  const resolvedToolsRoot = toolsRoot ?? join(homeDir, '.zcode', 'tools');
  const runtimeRoot = join(resolvedToolsRoot, COMMON_PACKAGE, 'runtime');
  const result = { ok: true, skipped: null, checkedAt: new Date().toISOString(), pluginsFile: resolvedPluginsFile, runtimeRoot, legacyRuntimeLink: null, plugins: [], issues: [] };
  const manifestRead = await readJsonAt(resolvedPluginsFile);
  if (manifestRead.status !== 'ok') {
    result.ok = false;
    result.skipped = manifestRead.status === 'missing' ? 'no_manifest' : 'bad_manifest';
    return result;
  }
  const manifest = manifestRead.value;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(manifest.plugins)) {
    result.ok = false;
    result.skipped = 'bad_manifest';
    return result;
  }
  const entries = pickSuianEntries(manifest);
  const commonEntry = entries.find(entry => entry?.name === COMMON_PACKAGE) ?? null;
  // 与 depcheck.mjs 同构：common 基准必须经 checkReleaseDirectory 的身份与逐文件摘要校验后
  // 才参与兼容判定；裸读 release.json 会在 common 损坏/身份不符时给出错误结论。
  const commonReleases = new Map();
  for (const entry of entries) {
    const name = entry.name;
    const installPath = typeof entry.installPath === 'string' ? entry.installPath : null;
    const record = { name, version: entry.version ?? null, installPath, dependsOnCommon: false, buildId: null, releaseVersion: null };
    result.plugins.push(record);
    if (!installPath || !(await maybeLstat(installPath))?.isDirectory()) {
      result.issues.push({ plugin: name, code: 'cache_missing', detail: `缓存目录不存在：${installPath ?? '(清单未提供)'}` });
      record.dependsOnCommon = asArray(entry.dependencies).includes(COMMON_PACKAGE);
      continue;
    }
    const pluginRead = await readJsonAt(join(installPath, '.zcode-plugin', 'plugin.json'));
    if (pluginRead.status !== 'ok') result.issues.push({ plugin: name, code: 'plugin_files_missing', detail: '.zcode-plugin/plugin.json 缺失或不可解析' });
    record.dependsOnCommon = [...asArray(entry.dependencies), ...asArray(pluginRead.value?.dependencies)].includes(COMMON_PACKAGE);
    const release = await checkReleaseDirectory(installPath, name, result.issues);
    if (release) {
      record.buildId = release.buildId;
      record.releaseVersion = release.pluginVersion;
      if (name === COMMON_PACKAGE && typeof release.commonApiVersion === 'number') {
        commonReleases.set(installPath, release);
      }
    }
  }
  const anyConsumer = result.plugins.some(record => record.name !== COMMON_PACKAGE && record.dependsOnCommon);
  if (anyConsumer && !commonEntry) {
    result.issues.push({ plugin: COMMON_PACKAGE, code: 'common_not_installed', detail: '业务插件声明依赖 suian-zcode-common，但清单中没有它的安装条目' });
  } else if (anyConsumer && typeof commonEntry.installPath === 'string') {
    const commonRelease = commonReleases.get(commonEntry.installPath) ?? null;
    if (commonRelease) {
      for (const record of result.plugins) {
        if (record.name === COMMON_PACKAGE || !record.dependsOnCommon || !record.installPath) continue;
        const releaseRead = await readJsonAt(join(record.installPath, 'release.json'));
        if (releaseRead.status !== 'ok') continue;
        const compat = readCompatFields(releaseRead.value);
        if (typeof compat.expectedApi === 'number' && compat.expectedApi !== commonRelease.commonApiVersion) {
          result.issues.push({ plugin: record.name, code: 'api_incompatible', detail: `要求的公共 API 版本为 ${compat.expectedApi}，已安装 common 发布为 ${commonRelease.commonApiVersion}；按市场配套版本更新对应插件或 common` });
        }
        if (compat.minimumCommonVersion) {
          if (!parseVersion(compat.minimumCommonVersion)) {
            result.issues.push({ plugin: record.name, code: 'version_insufficient', detail: `声明的 minimumCommonVersion 无法解析：${compat.minimumCommonVersion}` });
          } else if (compareVersion(commonRelease.pluginVersion, compat.minimumCommonVersion) < 0) {
            result.issues.push({ plugin: record.name, code: 'version_insufficient', detail: `已安装 common ${commonRelease.pluginVersion} 低于要求的 ${compat.minimumCommonVersion}` });
          }
        }
      }
    }
  }
  result.legacyRuntimeLink = await inspectLegacyRuntimeLink(runtimeRoot);
  result.ok = result.issues.length === 0;
  return result;
}

// 提示词文案与 depcheck-prompt.mjs 同步维护（PKG-08：修复路径是原生重装/更新，不是 npm 与链接）
const shortMessages = {
  cache_missing: '缓存目录缺失', plugin_files_missing: '插件文件缺失', release_missing: '非发布包形态',
  release_invalid: '发布清单损坏', identity_mismatch: '发布身份不符', file_missing: '发布文件缺失',
  file_digest_mismatch: '发布文件被改动', common_not_installed: '公共插件未安装',
  api_incompatible: '公共 API 不兼容', version_insufficient: '公共插件版本过低',
};
const fullMessages = {
  ...shortMessages,
  cache_missing: '插件缓存目录缺失', plugin_files_missing: '插件清单 .zcode-plugin/plugin.json 缺失或不可解析',
  release_missing: '插件目录缺 release.json（旧源码缓存形态或安装损坏）', release_invalid: 'release.json 缺失或字段不满足发布契约',
  identity_mismatch: '发布清单身份与安装记录条目不一致', file_missing: '发布清单声明的文件缺失于安装目录',
  file_digest_mismatch: '发布文件内容与发布清单摘要不符（被改动或传输损坏）',
  common_not_installed: '业务插件声明依赖公共插件，但安装清单中没有公共插件条目',
  api_incompatible: '业务要求的公共 API 版本与已安装 common 不一致，需按市场配套版本更新',
  version_insufficient: '已安装 common 版本低于业务声明的最低版本',
};
const versionOf = (result, plugin) => {
  const version = result.plugins.find(entry => entry.name === plugin)?.version;
  return typeof version === 'string' && version ? version : null;
};

const REINSTALL_CODES = new Set(['cache_missing', 'plugin_files_missing', 'release_missing', 'release_invalid', 'identity_mismatch', 'file_missing', 'file_digest_mismatch']);

export function buildFixPrompt(result) {
  if (result.skipped) {
    return `suian 系列插件未完成依赖检查，当前状态未知（${result.skipped}）。安装清单不可用或外置通知身份缺少清单锚点；请按对应插件的 setup 技能确认实际 installed_plugins.json 路径并重新初始化通知身份，再复查。`;
  }
  if (!result.issues.length) {
    return `suian-zcode-common 依赖检查刚刚复查通过，所有已安装 suian 系列插件的发布包完整性与公共 API 兼容性均正常，无需修复。`;
  }
  const lines = result.issues.map(issue => {
    const version = versionOf(result, issue.plugin);
    const label = `${issue.plugin}${version ? ` ${version}` : ''}`;
    return `- ${label}：${fullMessages[issue.code] ?? issue.code}${issue.detail ? `（${issue.detail}）` : ''}`;
  });
  const roots = result.plugins
    .map(entry => `- ${entry.name}${versionOf(result, entry.name) ? ` ${versionOf(result, entry.name)}` : ''}：${entry.installPath ?? '(未知)'}`)
    .join('\n');
  const reinstallTargets = [...new Set(result.issues.filter(issue => REINSTALL_CODES.has(issue.code)).map(issue => issue.plugin))]
    .filter(name => name !== COMMON_PACKAGE || result.issues.some(issue => issue.plugin === COMMON_PACKAGE && REINSTALL_CODES.has(issue.code)));
  const commonUpgradeNeeded = result.issues.some(issue => issue.code === 'api_incompatible' || issue.code === 'version_insufficient' || issue.plugin === COMMON_PACKAGE && issue.code === 'common_not_installed');
  const steps = [];
  if (result.issues.some(issue => issue.code === 'common_not_installed')) {
    steps.push(`1. 安装清单中没有 suian-zcode-common：在 ZCode 插件市场安装（或重新安装任一依赖它的 suian 业务插件，依赖会一并安装）`);
  }
  if (commonUpgradeNeeded && result.issues.some(issue => issue.code !== 'common_not_installed')) {
    steps.push(`${steps.length + 1}. 公共层与业务版本不配套：先更新 suian-zcode-common（zcode plugins update suian-zcode-common@suian-zcode-plugins），仍有 api_incompatible 或 version_insufficient 时一并更新对应业务插件`);
  }
  if (reinstallTargets.length) {
    steps.push(`${steps.length + 1}. 对上表存在发布文件问题的插件，通过 ZCode 插件市场重新安装或更新（zcode plugins update <插件>@suian-zcode-plugins）以恢复发布目录；不要在版本缓存内手工执行 npm、创建目录链接或复制文件`);
  }
  const commonRoot = result.plugins.find(entry => entry.name === COMMON_PACKAGE)?.installPath;
  steps.push(`${steps.length + 1}. 修复后运行 node "${commonRoot ?? '<suian-zcode-common 缓存根>'}/depcheck-hook.mjs" --scan-only${result.pluginsFile ? ` --installed-plugins "${result.pluginsFile}"` : ''} 复查，直到缺失清单为空`);
  return [
    '我的 ZCode suian 系列插件依赖不完整，请帮我修复。以下缺失清单来自 suian-zcode-common 的依赖检查（Stop 钩子 depcheck）：',
    '',
    ...lines,
    '',
    '请按 suian-zcode-common:setup 技能（skills/setup/SKILL.md）处理，修复方式是原生重新安装或更新，不是 npm 安装：',
    ...steps,
    '',
    '各插件本次检查实测的缓存根：',
    roots,
  ].join('\n');
}

// —— 身份与安装记录 ——

// 身份文件读取：区分「描述缺失」（identity_missing）与「描述存在但协议不符」（identity_mismatch）。
async function loadIdentity(toastRoot, protocol) {
  const path = join(toastRoot, 'identities', `${protocol}.json`);
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'absent', identity: null }; throw error; }
  try { return { status: 'present', identity: JSON.parse(raw) }; }
  catch { return { status: 'present', identity: null }; }
}

// 点击时重新读取安装记录，取 title 当前安装条目根；缺失时返回 null，不采用任何旧根。
async function resolveTitleInstallRoot(pluginsFile) {
  if (!pluginsFile) return { installRoot: null, skipped: 'anchor_missing' };
  const read = await readJsonAt(pluginsFile);
  if (read.status !== 'ok') return { installRoot: null, skipped: read.status === 'missing' ? 'no_manifest' : 'bad_manifest' };
  if (!read.value || typeof read.value !== 'object' || Array.isArray(read.value) || !Array.isArray(read.value.plugins)) {
    return { installRoot: null, skipped: 'bad_manifest' };
  }
  const entries = pickSuianEntries(read.value).filter(entry => entry?.name === TITLE_PLUGIN_ID);
  for (const entry of entries) {
    if (typeof entry.installPath === 'string' && (await maybeLstat(entry.installPath))?.isDirectory()) return { installRoot: entry.installPath, skipped: null };
  }
  return { installRoot: null, skipped: null };
}

const MISSING_ROOT_NOTE = '（suian-zcode-title 安装条目缺失：请在 ZCode 插件市场重新安装或更新）';

function renderFixPrompt({ template, installRoot, dataDir }) {
  return String(template)
    .replace(/\{\{plugin_root\}\}/g, () => installRoot ?? MISSING_ROOT_NOTE)
    .replace(/\{\{data_dir\}\}/g, () => dataDir);
}

// —— 剪贴板与打开工作区（实现与 notification-action.mjs 同步维护） ——

export const defaultFixWorkspace = () => join(homedir(), '.zcode', 'workspace', 'default');
export function encodeWorkspaceOpenUri(workspacePath) {
  return 'zcode://workspace/open?path=' + encodeURIComponent(workspacePath);
}

async function runPowerShell(script, { env = {}, timeout } = {}) {
  return promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout, env: { ...process.env, ...env } });
}

async function readClipboardOnce(executePowerShell) {
  const { stdout } = await executePowerShell('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::GetText()');
  return stdout.replace(/\r\n$/, '');
}

async function setClipboardViaTempFile(text, { dataDir, executePowerShell = runPowerShell }) {
  const temporary = join(dataDir ?? '.', 'fix-prompt.tmp-' + process.pid);
  await writeFile(temporary, text, 'utf8');
  try {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 400 * attempt));
      try {
        await executePowerShell('Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::SetText([IO.File]::ReadAllText($env:OIL_CLIP_FILE,[Text.Encoding]::UTF8))', { env: { OIL_CLIP_FILE: temporary } });
        return;
      } catch (error) { lastError = error; }
      try { if (await readClipboardOnce(executePowerShell) === text) return; }
      catch (error) { lastError = error; }
    }
    throw new Error('剪贴板写入未生效：' + String(lastError?.message ?? '').slice(0, 120));
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function openWorkspaceViaShell(uri) {
  await promisify(execFile)('cmd.exe', ['/c', 'start', '', uri], { windowsHide: true });
}

// —— 公开动作入口 ——

export async function runAction({ uri, homeDir, toastRoot, pluginsFile, setClipboard = setClipboardViaTempFile, openWorkspace = openWorkspaceViaShell }) {
  const parsed = parseActionUri(uri);
  if (!parsed) return { ok: false, reason: 'invalid_uri' };
  if (parsed.action !== 'fix') return { ok: false, reason: 'unknown_action' };
  const resolvedHome = homeDir ?? process.env.SUIAN_TOAST_HOME ?? homedir();
  const root = toastRoot ?? toastRootFor(resolvedHome);
  const loaded = await loadIdentity(root, parsed.protocol);
  if (loaded.status === 'absent' || !loaded.identity) return { ok: false, reason: 'identity_missing' };
  const identity = loaded.identity;
  if (identity.protocol !== parsed.protocol) return { ok: false, reason: 'identity_mismatch' };

  let prompt;
  let issues = null;
  let skipped = null;
  const registryPath = pluginsFile ?? identity.pluginsFile;
  if (parsed.protocol === 'suian-zcode-common') {
    // 按钮点击与 Toast 弹出可能间隔很久，现场重扫保证提示词反映当前实际状态
    const result = registryPath
      ? await scanSuianPlugins({ pluginsFile: registryPath, homeDir: resolvedHome })
      : { skipped: 'anchor_missing', issues: [], plugins: [] };
    prompt = buildFixPrompt(result);
    skipped = result.skipped;
    issues = skipped ? null : result.issues.length;
  } else {
    if (!identity.templateFile) return { ok: false, reason: 'template_missing' };
    let template;
    try {
      template = await readFile(join(identity.dataDir, identity.templateFile), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: false, reason: 'template_missing' };
      throw error;
    }
    const resolved = await resolveTitleInstallRoot(registryPath);
    const { installRoot } = resolved;
    skipped = resolved.skipped;
    prompt = renderFixPrompt({ template, installRoot, dataDir: identity.dataDir });
    if (skipped) prompt = buildFixPrompt({ skipped }) + '\n\n' + prompt;
  }
  await setClipboard(prompt, { dataDir: identity.dataDir });
  await openWorkspace(encodeWorkspaceOpenUri(defaultFixWorkspace()));
  if (skipped) return { ok: false, reason: 'registry_unavailable', skipped, action: 'fix', identity: parsed.protocol, issues: null };
  return { ok: true, action: 'fix', identity: parsed.protocol, issues };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const uri = process.argv[2];
  const resolvedHome = process.env.SUIAN_TOAST_HOME || homedir();
  const root = toastRootFor(resolvedHome);
  // 自包含滚动（与 log-rotate.mjs 语义一致；本文件是单文件部署快照，不得相对导入共享模块）。
  // 版本经部署占位符注入（readExecutorText 在部署文本上替换）；源码直跑时回退读相邻插件清单。
  const LOG_VERSION_PLACEHOLDER = '__SUIAN_COMMON_LOG_VERSION__';
  const RETENTION_DAYS = 7;
  const dayStamp = (date = new Date()) => date.getFullYear() + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0');
  const cutoffStamp = (now = new Date()) => { const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - RETENTION_DAYS); return dayStamp(cutoff); };
  const resolveLogVersion = async () => {
    const substituted = !(LOG_VERSION_PLACEHOLDER.startsWith('__') && LOG_VERSION_PLACEHOLDER.endsWith('__'));
    if (substituted) return LOG_VERSION_PLACEHOLDER;
    try {
      const manifest = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '.zcode-plugin', 'plugin.json'), 'utf8'));
      return typeof manifest.version === 'string' && manifest.version ? manifest.version : null;
    } catch { return null; }
  };
  const logAction = async (entry, dataDir) => {
    try {
      await mkdir(dataDir, { recursive: true });
      const dated = /^toast-action-(\d{8})\.log\.jsonl$/;
      const cutoff = cutoffStamp();
      for (const name of await readdir(dataDir)) {
        const match = dated.exec(name);
        if (name === 'toast-action-log.jsonl' || (match !== null && match[1] < cutoff)) await unlink(join(dataDir, name)).catch(() => {});
      }
      const version = await resolveLogVersion();
      const line = { at: new Date().toISOString(), ...(version ? { v: version } : {}), ...entry };
      await appendFile(join(dataDir, `toast-action-${dayStamp()}.log.jsonl`), JSON.stringify(line) + '\n', 'utf8');
    } catch { /* 日志尽力而为 */ }
  };
  runAction({ uri, homeDir: resolvedHome, toastRoot: root })
    .then(async result => {
      console.log(JSON.stringify(result));
      const parsed = parseActionUri(uri);
      const loaded = parsed ? await loadIdentity(root, parsed.protocol) : null;
      await logAction({ uri, ok: result.ok, reason: result.reason ?? null, issues: result.issues ?? null }, loaded?.identity?.dataDir ?? root);
      process.exit(result.ok ? 0 : 1);
    })
    .catch(async error => {
      console.log(JSON.stringify({ ok: false, reason: 'error', detail: String(error.message).slice(0, 200) }));
      const parsed = parseActionUri(uri);
      const loaded = parsed ? await loadIdentity(root, parsed.protocol) : null;
      await logAction({ uri, ok: false, reason: 'error', detail: String(error.message).slice(0, 200) }, loaded?.identity?.dataDir ?? root);
      process.exit(1);
    });
}

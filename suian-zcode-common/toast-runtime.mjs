// 共享 Toast 稳定运行时（PKG-06）：把 Toast 执行器部署到版本缓存之外的固定目录，
// 让旧通知的按钮点击不依赖 common 或 title 的插件缓存仍可诊断并复制修复提示。
// 布局（<homeDir>/.zcode/tools/suian-zcode-common/，与网关部署目录分离，互不重启）：
//   toast/executor.mjs    活动执行器（自包含单文件，本包 toast-executor.mjs 的部署快照）
//   toast/launch.vbs      稳定启动器（URI 精确白名单后以隐藏窗口运行活动执行器）
//   active-toast.json     活动 Toast 记录（共享运行根直下；部署切换的提交点，PKG-05 网关移除探针）
//   toast/identities/     各调用方外置身份描述（卸载时只清理归属匹配的自身文件）
// 本模块只用 Node 内置模块：挂在 depcheck-hook 自举链与 client-install 安装链上。
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fileShell } from './windows.mjs';

export const TOAST_PROTOCOLS = ['suian-zcode-common', 'suian-zcode-title'];

export function toastRootFor(homeDir) {
  return join(homeDir, '.zcode', 'tools', 'suian-zcode-common', 'toast');
}

// 活动 Toast 记录固定在共享运行根（tools/suian-zcode-common）直下、文件名 active-toast.json：
// PKG-05 的网关移除以此文件为探针，Toast 记录存在时保留网关部署目录（gateway-deploy.mjs 同注）。
// Toast 与网关的活动记录是两个独立文件，互不触碰、互不重启。
export function activeToastRecordFor(homeDir) {
  return join(homeDir, '.zcode', 'tools', 'suian-zcode-common', 'active-toast.json');
}

const vbsQuote = value => String(value).replace(/"/g, '""');

// 稳定启动器：URI 与两个已知常量精确比对（动作只有 fix），运行参数不可能成为命令行拼接输入。
export function buildStableLauncherVbs({ nodeExe, executorPath }) {
  return [
    '\' suian 共享 Toast 启动器（common 部署，请勿手改）：URI 白名单校验后运行缓存外活动执行器',
    'If WScript.Arguments.Count = 0 Then WScript.Quit 1',
    'Dim uri',
    'uri = WScript.Arguments(0)',
    'If uri <> "suian-zcode-common://fix" And uri <> "suian-zcode-title://fix" Then WScript.Quit 1',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """" & "${vbsQuote(nodeExe)}" & """ """ & "${vbsQuote(executorPath)}" & """ """ & uri & """", 0, False`,
  ].join('\r\n') + '\r\n';
}

// 调用方数据目录中的转发桥：只放行本协议的 fix，再转发给稳定启动器。
export function buildForwardVbs({ protocol, launcherPath }) {
  return [
    `' ${protocol} 按钮激活桥（安装器生成，请勿手改）：仅接受本协议 fix，转发到缓存外稳定启动器`,
    'If WScript.Arguments.Count = 0 Then WScript.Quit 1',
    'Dim uri',
    'uri = WScript.Arguments(0)',
    `If uri <> "${vbsQuote(protocol)}://fix" Then WScript.Quit 1`,
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """" & "${vbsQuote(launcherPath)}" & """ """ & uri & """", 0, False`,
  ].join('\r\n') + '\r\n';
}

// 执行器源定位：源码模式与本模块同目录；发布模式 bundle 位于 dist/，上级有 release.json。
export function resolveExecutorSource(entryUrl = import.meta.url) {
  const entryDir = dirname(fileURLToPath(entryUrl));
  const parent = join(entryDir, '..');
  let bundled = false;
  try { bundled = statSync(join(parent, 'release.json')).isFile(); } catch { /* 无发布标记按源码布局 */ }
  return bundled ? join(parent, 'toast-executor.mjs') : join(entryDir, 'toast-executor.mjs');
}

async function readOptionalText(shell, path) {
  try { return await shell.readText(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function parseOptionalJson(shell, path) {
  const raw = await readOptionalText(shell, path);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// 部署共享 Toast 运行时：暂存 → node --check 校验 → 切换 executor/launch → 提交活动记录。
// 校验或切换失败时原活动部署保持可用，错误原样上抛（日志不得隐藏原始错误）。
export async function deployToastRuntime({ homeDir, nodeExe = process.execPath, executorText, shell = fileShell, checkNode = process.execPath, now = () => new Date() }) {
  if (!homeDir) throw new Error('deployToastRuntime 需要 homeDir');
  if (typeof executorText !== 'string' || !executorText) throw new Error('deployToastRuntime 需要 executorText');
  const toastRoot = toastRootFor(homeDir);
  const executorPath = join(toastRoot, 'executor.mjs');
  const launcherPath = join(toastRoot, 'launch.vbs');
  const activePath = activeToastRecordFor(homeDir);
  await shell.mkdir(toastRoot);

  const desiredLauncher = buildStableLauncherVbs({ nodeExe, executorPath });
  const currentExecutor = await readOptionalText(shell, executorPath);
  const currentLauncher = await readOptionalText(shell, launcherPath);
  const currentActive = await parseOptionalJson(shell, activePath);
  if (currentExecutor === executorText
    && currentLauncher === desiredLauncher
    && currentActive?.formatVersion === 1
    && currentActive.nodeExe === nodeExe
    && currentActive.executor === 'executor.mjs'
    && currentActive.launcher === 'launch.vbs') {
    return { action: 'unchanged', toastRoot };
  }

  const stagingExecutor = join(toastRoot, `.executor.staging-${randomUUID()}.mjs`);
  await shell.writeText(stagingExecutor, executorText);
  // 暂存校验通过后才允许切换；失败时活动部署与活动记录保持原样
  await shell.run(checkNode, ['--check', stagingExecutor]);

  const backup = join(toastRoot, `.executor.old-${randomUUID()}`);
  const activeTmp = join(toastRoot, `.active-toast.tmp-${randomUUID()}`);
  let backedUp = false;
  let executorInstalled = false, launcherChanged = false;
  if (currentExecutor !== null) {
    await shell.rename(executorPath, backup);
    backedUp = true;
  }
  try {
    await shell.rename(stagingExecutor, executorPath);
    executorInstalled = true;
    if (currentLauncher !== desiredLauncher) {
      launcherChanged = true;
      await shell.writeText(launcherPath, desiredLauncher);
    }
    const active = {
      formatVersion: 1, executor: 'executor.mjs', launcher: 'launch.vbs',
      nodeExe, deployedAt: now().toISOString(),
    };
    await shell.writeText(activeTmp, JSON.stringify(active, null, 2) + '\n');
    await shell.rename(activeTmp, activePath);
  } catch (error) {
    // 活动记录是最后的提交点；此前失败必须恢复实际被 VBS 执行的文件。
    try {
      if (executorInstalled) await shell.remove(executorPath);
      if (backedUp) await shell.rename(backup, executorPath);
      if (launcherChanged) {
        if (currentLauncher === null) await shell.remove(launcherPath);
        else await shell.writeText(launcherPath, currentLauncher);
      }
    } catch (rollbackError) {
      throw new Error(`Toast 执行器切换失败（${error.message}），且回滚失败（${rollbackError.message}）；备份位置 ${backup}`);
    }
    throw error;
  }
  if (backedUp) await shell.remove(backup);
  return { action: 'deployed', toastRoot };
}

// 调用方身份描述外置登记：身份归调用方所有，公共执行器只按协议读取，不反向导入业务代码。
export async function registerToastIdentity({ homeDir, protocol, appId, dataDir, pluginsFile = null, description = '', templateFile = null, shell = fileShell, now = () => new Date() }) {
  if (!protocol || !appId || !dataDir) throw new Error('registerToastIdentity 需要 protocol/appId/dataDir');
  const identitiesDir = join(toastRootFor(homeDir), 'identities');
  await shell.mkdir(identitiesDir);
  const identityPath = join(identitiesDir, `${protocol}.json`);
  const current = await parseOptionalJson(shell, identityPath);
  const desired = { formatVersion: 1, protocol, appId, dataDir, pluginsFile: pluginsFile ? resolve(pluginsFile) : null, description, templateFile };
  if (current && Object.keys(desired).every(key => current[key] === desired[key])) {
    return { action: 'unchanged', identityPath };
  }
  const record = { ...desired, updatedAt: now().toISOString() };
  const tmp = join(identitiesDir, `.${protocol}.tmp-${randomUUID()}`);
  await shell.writeText(tmp, JSON.stringify(record, null, 2) + '\n');
  await shell.rename(tmp, identityPath);
  return { action: 'registered', identityPath };
}

// 只移除归属匹配的自身身份；共享运行目录与另一身份不受影响。
export async function removeToastIdentity({ homeDir, protocol, shell = fileShell }) {
  const identityPath = join(toastRootFor(homeDir), 'identities', `${protocol}.json`);
  await shell.remove(identityPath);
  return { action: 'removed', identityPath };
}

// 安装检查：报告稳定部署、外置身份/模板与实际协议注册目标。
// 不以 AppID 缓存为健康依据——缓存与部署是两回事。
export async function checkToastRuntime({ homeDir, protocols = TOAST_PROTOCOLS, shell = fileShell }) {
  const toastRoot = toastRootFor(homeDir);
  const active = await parseOptionalJson(shell, activeToastRecordFor(homeDir));
  const executorPresent = (await shell.stat(join(toastRoot, 'executor.mjs')))?.isFile === true;
  const launcherPresent = (await shell.stat(join(toastRoot, 'launch.vbs')))?.isFile === true;
  const identities = {};
  const protocolTargets = {};
  for (const protocol of protocols) {
    const identity = await parseOptionalJson(shell, join(toastRoot, 'identities', `${protocol}.json`));
    const registered = identity !== null && identity.protocol === protocol;
    let templatePresent = null;
    if (registered && identity.templateFile) {
      templatePresent = (await shell.stat(join(identity.dataDir, identity.templateFile)))?.isFile === true;
    }
    let command = null;
    try {
      const output = await shell.run('reg.exe', ['query', `HKCU\\Software\\Classes\\${protocol}\\shell\\open\\command`, '/ve']);
      const match = /REG_SZ\s+(.+)$/.exec(String(output).trim());
      command = match ? match[1].trim() : null;
    } catch { /* 协议键缺失：报告 null，不判失败 */ }
    identities[protocol] = {
      registered,
      appId: identity?.appId ?? null,
      dataDir: identity?.dataDir ?? null,
      pluginsFile: identity?.pluginsFile ?? null,
      templateFile: identity?.templateFile ?? null,
      templatePresent,
    };
    protocolTargets[protocol] = { command };
  }
  const healthy = executorPresent && launcherPresent && active !== null
    && protocols.every(protocol => identities[protocol].registered && identities[protocol].pluginsFile && identities[protocol].templatePresent !== false);
  return { toastRoot, deployed: { active, executorPresent, launcherPresent }, identities, protocols: protocolTargets, healthy };
}

// 供 installToastAssets 读取执行器源文本（代码文件读取不是用户系统边界，走真实 fs）。
export async function readExecutorText(entryUrl = import.meta.url) {
  const path = resolveExecutorSource(entryUrl);
  try {
    const text = await readFile(path, 'utf8');
    // 部署前注入日志版本占位符：执行器单文件快照运行时读不到相邻插件清单。
    // 版本读不到时保留占位符原样——执行器按"未替换"分支降级（v 字段省略）。
    let version = null;
    try { version = JSON.parse(await readFile(join(dirname(path), '.zcode-plugin', 'plugin.json'), 'utf8')).version ?? null; } catch { /* 无清单按降级 */ }
    return version ? text.replaceAll('__SUIAN_COMMON_LOG_VERSION__', version) : text;
  } catch (error) {
    throw new Error(`读取 Toast 执行器源失败（${path}）：${error.message}`);
  }
}

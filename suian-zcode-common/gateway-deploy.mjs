// 网关运行文件的缓存外部署（PKG-05）：部署真实文件副本到 deployments/{{buildId}}，
// 写独立活动记录 active-gateway.json，供稳定启动器选择部署版本与实际 Node。
// buildId 只由部署清单内容决定（与路径无关）；gateway 和 Toast 的活动记录彼此独立。
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const defaultRoot = dirname(fileURLToPath(import.meta.url));
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

// 网关运行闭包（源码相对路径 → 部署相对路径）。文档、技能、业务客户端模块不参与；
// from 为 null 表示在源内动态展开（node_modules/ws/lib）。
const RUNTIME_STATIC = [
  { from: 'gateway.mjs', to: 'gateway.mjs' },
  { from: 'gateway-build.mjs', to: 'gateway-build.mjs' },
  { from: 'rpc-broker.mjs', to: 'rpc-broker.mjs' },
  { from: 'rpc-diagnostics.mjs', to: 'rpc-diagnostics.mjs' },
  { from: 'terminal-gateway.mjs', to: 'terminal-gateway.mjs' },
  { from: 'terminal-relay.mjs', to: 'terminal-relay.mjs' },
  { from: 'vendor/remote-shared.js', to: 'vendor/remote-shared.js' },
  { from: 'vendor/serialization.js', to: 'vendor/serialization.js' },
  { from: 'vendor/buffer.js', to: 'vendor/buffer.js' },
  { from: 'vendor/channelClient.js', to: 'vendor/channelClient.js' },
  { from: 'vendor/foundation.js', to: 'vendor/foundation.js' },
  { from: 'vendor/channels.shared.js', to: 'vendor/channels.shared.js' },
  { from: 'node_modules/ws/package.json', to: 'node_modules/ws/package.json' },
  { from: 'node_modules/ws/index.js', to: 'node_modules/ws/index.js' },
  { from: 'node_modules/ws/wrapper.mjs', to: 'node_modules/ws/wrapper.mjs' },
  { from: 'node_modules/ws/LICENSE', to: 'licenses/ws-LICENSE' },
  { from: '.zcode-plugin/plugin.json', to: '.zcode-plugin/plugin.json' },
];
const WS_LIB_FROM = 'node_modules/ws/lib';
const WS_LIB_TO = 'node_modules/ws/lib';

export async function gatewayRuntimeManifest(sourceRoot) {
  const libFiles = (await readdir(join(sourceRoot, WS_LIB_FROM))).filter(file => file.endsWith('.js')).map(file => ({ from: `${WS_LIB_FROM}/${file}`, to: `${WS_LIB_TO}/${file}` }));
  return [...RUNTIME_STATIC, ...libFiles].sort((left, right) => (left.to < right.to ? -1 : 1));
}

// 内容指纹：同清单内容必同 buildId，路径变化不影响。
async function manifestDigest(sourceRoot, manifest) {
  const hash = createHash('sha256');
  for (const item of manifest) hash.update(item.to).update('\0').update(await readFile(join(sourceRoot, item.from))).update('\0');
  return hash.digest('hex');
}

export async function computeGatewayBuildId(sourceRoot) {
  return manifestDigest(sourceRoot, await gatewayRuntimeManifest(sourceRoot));
}

async function pluginVersion(sourceRoot) {
  return JSON.parse(await readFile(join(sourceRoot, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
}

export const deploymentsRoot = toolsRoot => join(toolsRoot, 'deployments');
export const activeGatewayFile = toolsRoot => join(toolsRoot, 'active-gateway.json');

export async function readDeployment(toolsRoot, buildId) {
  const deploymentDir = join(deploymentsRoot(toolsRoot), buildId);
  return { deploymentDir, deployment: JSON.parse(await readFile(join(deploymentDir, 'deployment.json'), 'utf8')) };
}

// 校验部署完整性：清单逐文件比对摘要；被篡改的部署不能作为候选或回退目标。
export async function verifyDeployment({ toolsRoot, buildId }) {
  if (!/^[0-9a-f]{64}$/.test(buildId)) throw new Error(`Invalid buildId: ${buildId}`);
  const { deploymentDir, deployment } = await readDeployment(toolsRoot, buildId);
  if (deployment.formatVersion !== 1 || deployment.kind !== 'gateway-runtime' || !Array.isArray(deployment.runtime) || deployment.buildId !== buildId) {
    throw new Error(`deployment.json is not a valid gateway runtime manifest for ${buildId}`);
  }
  const runtime = [...deployment.runtime].sort((left, right) => (left.path < right.path ? -1 : 1));
  for (const entry of runtime) {
    let content;
    try { content = await readFile(join(deploymentDir, entry.path)); }
    catch { throw new Error(`Deployed runtime file missing: ${entry.path}`); }
    const digest = sha256(content);
    if (digest !== entry.sha256) throw new Error(`Deployed runtime digest mismatch: ${entry.path}`);
  }
  const hash = createHash('sha256');
  for (const entry of runtime) hash.update(entry.path).update('\0').update(await readFile(join(deploymentDir, entry.path))).update('\0');
  if (hash.digest('hex') !== buildId) throw new Error(`Deployed runtime digest mismatch: deployment ${buildId}`);
  return { buildId, deploymentDir };
}

// 暂存并检查运行文件；暂存与部署都不改变活动版本（活动记录由 writeActiveGateway 切换）。
export async function deployGatewayRuntime({ sourceRoot = defaultRoot, toolsRoot }) {
  const manifest = await gatewayRuntimeManifest(sourceRoot);
  const buildId = await manifestDigest(sourceRoot, manifest);
  const deploymentDir = join(deploymentsRoot(toolsRoot), buildId);
  await mkdir(deploymentsRoot(toolsRoot), { recursive: true });
  const deploymentFile = join(deploymentDir, 'deployment.json');
  try {
    await verifyDeployment({ toolsRoot, buildId });
    return { buildId, deploymentDir, alreadyPresent: true };
  } catch (error) {
    // 部署目录已存在但损坏时不静默覆盖，明确报出。
    let existing = false;
    try { await readFile(deploymentFile); existing = true; } catch {}
    if (existing) throw new Error(`Existing deployment ${buildId} is corrupt: ${error.message}`);
  }

  const stagingDir = join(deploymentsRoot(toolsRoot), `.staging-${buildId}-${randomUUID().slice(0, 8)}`);
  try {
    await rm(stagingDir, { recursive: true, force: true });
    const runtime = [];
    for (const item of manifest) {
      const target = join(stagingDir, item.to);
      await mkdir(dirname(target), { recursive: true });
      const content = await readFile(join(sourceRoot, item.from));
      await writeFile(target, content);
      runtime.push({ path: item.to, sha256: sha256(content), bytes: content.length });
    }
    await writeFile(join(stagingDir, 'deployment.json'), `${JSON.stringify({ formatVersion: 1, kind: 'gateway-runtime', buildId, pluginVersion: await pluginVersion(sourceRoot), runtime }, null, 2)}\n`);
    await rename(stagingDir, deploymentDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  await verifyDeployment({ toolsRoot, buildId });
  return { buildId, deploymentDir, alreadyPresent: false };
}

// 缓存外稳定启动器：VBS（内容与源码 run.vbs 相同）与读活动记录的 PowerShell 启动器。
export async function ensureLaunchers({ sourceRoot = defaultRoot, toolsRoot }) {
  const launcherDir = join(toolsRoot, 'launchers');
  await mkdir(launcherDir, { recursive: true });
  const vbs = await readFile(join(sourceRoot, 'run.vbs'));
  const ps = await readFile(join(sourceRoot, 'gateway-launcher.ps1'));
  await writeFile(join(launcherDir, 'gateway-launch.vbs'), vbs);
  await writeFile(join(launcherDir, 'run.ps1'), ps);
  return { launcherDir, vbsFile: join(launcherDir, 'gateway-launch.vbs'), psFile: join(launcherDir, 'run.ps1') };
}

export async function readActiveGateway(toolsRoot) {
  let raw;
  try { raw = await readFile(activeGatewayFile(toolsRoot), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const active = JSON.parse(raw);
  if (active.version !== 1 || typeof active.build_id !== 'string' || typeof active.node_path !== 'string') throw new Error('Invalid active gateway record');
  return active;
}

// 原子切换活动网关记录；不触碰 active-toast.json（Toast 活动记录独立维护）。
export async function writeActiveGateway({ toolsRoot, buildId, nodePath }) {
  const previous = await readActiveGateway(toolsRoot);
  const target = activeGatewayFile(toolsRoot);
  const staging = `${target}.tmp-${randomUUID().slice(0, 8)}`;
  await mkdir(toolsRoot, { recursive: true });
  await writeFile(staging, `${JSON.stringify({ version: 1, build_id: buildId, node_path: nodePath }, null, 2)}\n`);
  try { await rename(staging, target); }
  catch (error) { await rm(staging, { force: true }); throw error; }
  return { previous: previous ? previous.build_id : null };
}

// 撤销指定部署目录（仅用于本次失败暂存与首次失败的显式撤销；不做旧部署垃圾回收）。
export async function removeDeployment({ toolsRoot, buildId }) {
  await rm(join(deploymentsRoot(toolsRoot), buildId), { recursive: true, force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: {
    candidate: { type: 'boolean' }, deploy: { type: 'boolean' }, verify: { type: 'boolean' }, activate: { type: 'boolean' },
    'read-active': { type: 'boolean' }, 'remove-deployment': { type: 'boolean' }, 'ensure-launchers': { type: 'boolean' }, status: { type: 'boolean' },
    'source-root': { type: 'string' }, 'tools-root': { type: 'string' }, 'build-id': { type: 'string' }, 'node-path': { type: 'string' },
  } });
  const sourceRoot = values['source-root'] ?? defaultRoot;
  const toolsRoot = values['tools-root'];
  const buildId = values['build-id'];
  if (values.candidate) {
    console.log(JSON.stringify({ ok: true, buildId: await computeGatewayBuildId(sourceRoot), version: await pluginVersion(sourceRoot) }));
  } else if (values.status) {
    const active = await readActiveGateway(toolsRoot);
    console.log(JSON.stringify({ ok: true, candidateBuildId: await computeGatewayBuildId(sourceRoot), version: await pluginVersion(sourceRoot), active }));
  } else if (values.deploy) {
    const result = await deployGatewayRuntime({ sourceRoot, toolsRoot });
    console.log(JSON.stringify({ ok: true, ...result }));
  } else if (values['ensure-launchers']) {
    const result = await ensureLaunchers({ sourceRoot, toolsRoot });
    console.log(JSON.stringify({ ok: true, ...result }));
  } else if (values.verify) {
    const result = await verifyDeployment({ toolsRoot, buildId });
    console.log(JSON.stringify({ ok: true, ...result }));
  } else if (values.activate) {
    const result = await writeActiveGateway({ toolsRoot, buildId, nodePath: values['node-path'] });
    console.log(JSON.stringify({ ok: true, ...result }));
  } else if (values['read-active']) {
    const active = await readActiveGateway(toolsRoot);
    console.log(JSON.stringify({ ok: true, active }));
  } else if (values['remove-deployment']) {
    await removeDeployment({ toolsRoot, buildId });
    console.log(JSON.stringify({ ok: true }));
  } else {
    console.error('缺少子命令（--candidate/--deploy/--verify/--activate/--read-active/--remove-deployment/--ensure-launchers）');
    process.exit(2);
  }
}

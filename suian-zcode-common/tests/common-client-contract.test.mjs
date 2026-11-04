import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadCommonModule } from '../locate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const commonRoot = resolve(here, '..');
const nodeBin = process.execPath;
const RUNTIME_EXPORTS = [
  'COMMON_API_VERSION', 'connectHost', 'probeHost', 'saveAuthorization', 'clearAuthorization',
  'readTitlePolicy', 'writeTitlePolicy', 'readProjectContext', 'MCP_APP_MIME_TYPE',
  'supportsZcodeMcpApps', 'notifyOnce', 'checkPromptRecoveryToast', 'shouldNotify', 'copyPromptAndOpenWorkspace',
  'getConversationMessageProjectionPolicy', 'TopicWireFrameAssembler', 'conversationTopicFrameSchema',
  'v4ConversationRowsRangeResultSchema', 'PROTOCOL_V4_LIMITS', 'measureTopicNotificationEnvelopeBytes',
  'encodeTopicWireFrames',
];
const INSTALL_EXPORTS = ['checkRuntime', 'fileShell', 'buildVbsContent', 'buildProtocolCommand', 'ensureToastAppId', 'installToastAssets', 'removeToastAssets', 'toastRootFor', 'deployToastRuntime', 'registerToastIdentity', 'removeToastIdentity', 'checkToastRuntime'];

let stagingPromise;
function staging() {
  stagingPromise ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pkg01-staging-'));
    const run = spawnSync(nodeBin, [join(commonRoot, 'build-release.mjs'), '--out', join(dir, 'release')], { encoding: 'utf8', windowsHide: true });
    return { dir, run, releaseDir: join(dir, 'release') };
  })();
  return stagingPromise;
}

const consumerScript = `import { loadCommonModule } from './locate.mjs';
const options = JSON.parse(process.argv[2] ?? '{}');
// 本脚本代表规范消费者：默认声明第 1 代 API；"缺省必须拒绝"由专项用例单独覆盖。
if (options.expectedCommonApiVersion === undefined && !options.omitApiDeclaration) options.expectedCommonApiVersion = 1;
try {
  const loaded = await loadCommonModule(options.entryOverride ?? 'client', options);
  console.log(JSON.stringify({ ok: true, root: loaded.root, buildId: loaded.buildId, pluginVersion: loaded.pluginVersion,
    commonApiVersion: loaded.commonApiVersion,
    api: { connectHost: typeof loaded.module.connectHost, probeHost: typeof loaded.module.probeHost,
      readProjectContext: typeof loaded.module.readProjectContext, TopicWireFrameAssembler: typeof loaded.module.TopicWireFrameAssembler } }));
} catch (error) {
  process.exitCode = 3;
  console.log(JSON.stringify({ ok: false, code: error.code, stage: error.stage }));
}
`;

function consumerEnv(extra = {}) {
  const env = { ...process.env };
  delete env.ZCODE_PLUGIN_DATA;
  return { ...env, ...extra };
}

async function buildWorld(t, { storageName = '宿主 存储根' } = {}) {
  const { run, releaseDir } = await staging();
  assert.equal(run.status, 0, `构建发布目录失败：\n${run.stdout}\n${run.stderr}`);
  const base = await mkdtemp(join(tmpdir(), 'pkg01-world-'));
  const storageRoot = join(base, storageName);
  const installs = {
    'suian-zcode-common': [JSON.parse(await readFile(join(releaseDir, 'release.json'), 'utf8')).pluginVersion, releaseDir],
    'suian-zcode-title': ['0.1.5', null],
    'suian-zcode-app-mcp': ['0.10.0', null],
  };
  const registry = { version: 1, plugins: [] };
  for (const [name, [version, source]] of Object.entries(installs)) {
    const installPath = join(storageRoot, 'cache', 'suian-zcode-plugins', name, version);
    await mkdir(join(installPath, '.zcode-plugin'), { recursive: true });
    if (source) await cp(source, installPath, { recursive: true });
    await writeFile(join(installPath, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name, version }));
    registry.plugins.push({ id: `${name}@suian-zcode-plugins`, name, marketplace: 'suian-zcode-plugins', version, installPath, installedAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', scope: 'user' });
  }
  const registryPath = join(storageRoot, 'installed_plugins.json');
  await writeFile(registryPath, JSON.stringify(registry));
  for (const id of ['suian-zcode-title@suian-zcode-plugins', 'suian-zcode-app-mcp@suian-zcode-plugins']) {
    await mkdir(join(storageRoot, 'data', id), { recursive: true });
  }
  const consumerDir = join(base, '消费者 目录');
  await mkdir(consumerDir, { recursive: true });
  await cp(join(commonRoot, 'locate.mjs'), join(consumerDir, 'locate.mjs'));
  await writeFile(join(consumerDir, 'consumer.mjs'), consumerScript);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, storageRoot, registryPath, commonInstall: registry.plugins[0].installPath, consumerDir, releaseDir };
}

const runConsumer = (world, options, env = {}) => {
  const result = spawnSync(nodeBin, [join(world.consumerDir, 'consumer.mjs'), JSON.stringify(options)], { cwd: world.consumerDir, encoding: 'utf8', windowsHide: true, env: consumerEnv(env) });
  return { status: result.status, payload: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null, stderr: result.stderr };
};

test('旧路径契约：无链接的独立目录裸导入 suian-zcode-common 失败', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pkg01-bare-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = spawnSync(nodeBin, ['--input-type=module', '-e', "await import('suian-zcode-common/client.mjs')"], { cwd: dir, encoding: 'utf8', windowsHide: true, env: consumerEnv() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test('client 入口导出恰好是三消费者运行期契约集合', async () => {
  const module = await import('../client.mjs');
  assert.deepEqual(Object.keys(module).sort(), [...RUNTIME_EXPORTS].sort());
  assert.equal(module.COMMON_API_VERSION, 1);
});

test('client-install 入口导出恰好是安装期契约集合', async () => {
  const module = await import('../client-install.mjs');
  assert.deepEqual(Object.keys(module).sort(), [...INSTALL_EXPORTS].sort());
});

test('导入纯净：隔离 HOME 下导入发布产物不写文件', async t => {
  const { run, releaseDir } = await staging();
  assert.equal(run.status, 0, run.stderr);
  const home = await mkdtemp(join(tmpdir(), 'pkg01-home-'));
  const before = (await readdir(home)).sort();
  t.after(() => rm(home, { recursive: true, force: true }));
  const entryUrl = pathToFileURL(join(releaseDir, 'dist', 'client.mjs')).href;
  const result = spawnSync(nodeBin, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(entryUrl)}); if (typeof m.connectHost !== 'function') throw new Error('connectHost 缺失');`], { cwd: home, encoding: 'utf8', windowsHide: true, env: consumerEnv({ HOME: home, USERPROFILE: home }) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(home)).sort(), before);
});

test('定位器：ZCODE_PLUGIN_DATA 锚点推导存储根，两个独立消费者得到同一 common 根与 buildId', async t => {
  const world = await buildWorld(t);
  const title = runConsumer(world, {}, { ZCODE_PLUGIN_DATA: join(world.storageRoot, 'data', 'suian-zcode-title@suian-zcode-plugins') });
  const mcp = runConsumer(world, {}, { ZCODE_PLUGIN_DATA: join(world.storageRoot, 'data', 'suian-zcode-app-mcp@suian-zcode-plugins') });
  assert.equal(title.status, 0, JSON.stringify(title.payload) + title.stderr);
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(title.payload.root, world.commonInstall);
  assert.equal(mcp.payload.root, world.commonInstall);
  assert.equal(title.payload.buildId, mcp.payload.buildId);
  assert.ok(/^[0-9a-f]{64}$/.test(title.payload.buildId));
  assert.equal(title.payload.commonApiVersion, 1);
  for (const consumer of [title, mcp]) {
    assert.equal(consumer.payload.api.connectHost, 'function');
    assert.equal(consumer.payload.api.probeHost, 'function');
    assert.equal(consumer.payload.api.readProjectContext, 'function');
    assert.equal(consumer.payload.api.TopicWireFrameAssembler, 'function');
  }
});

test('定位器：无环境注入的入口显式传安装记录路径（技能命令/独立 CLI 场景）', async t => {
  const world = await buildWorld(t);
  const result = runConsumer(world, { installedPluginsPath: world.registryPath });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.payload.root, world.commonInstall);
});

test('定位器：无锚点且无显式路径报 anchor_missing，不假定默认用户目录', async t => {
  const world = await buildWorld(t);
  const result = runConsumer(world, {});
  assert.equal(result.status, 3);
  assert.equal(result.payload.code, 'anchor_missing');
});

test('定位器失败分类：注册表缺失/损坏、未安装、歧义、路径缺失、release 缺失或损坏各自独立', async t => {
  const world = await buildWorld(t);
  const world2 = await buildWorld(t, { storageName: '第二 宿主根' });
  const baseRegistry = JSON.parse(await readFile(world.registryPath, 'utf8'));
  const withRegistry = async mutate => {
    await writeFile(world.registryPath, JSON.stringify(mutate(structuredClone(baseRegistry))));
  };
  const check = (expectedCode, options, scope = world) => {
    const result = runConsumer(scope, options);
    assert.equal(result.payload?.code, expectedCode, `期望 ${expectedCode}，实际 ${result.stderr || JSON.stringify(result.payload)}`);
    assert.ok(result.payload.stage, `${expectedCode} 必须携带失败阶段`);
  };

  await rm(world.registryPath);
  check('registry_missing', { installedPluginsPath: world.registryPath });

  await writeFile(world.registryPath, '{ not json');
  check('registry_invalid', { installedPluginsPath: world.registryPath });

  await withRegistry(registry => ({ ...registry, plugins: registry.plugins.filter(plugin => plugin.name !== 'suian-zcode-common') }));
  check('common_not_installed', { installedPluginsPath: world.registryPath });

  await withRegistry(registry => ({ ...registry, plugins: [...registry.plugins, { ...registry.plugins[0], installPath: join(world.base, '另一份安装') }] }));
  check('common_ambiguous', { installedPluginsPath: world.registryPath });

  await withRegistry(registry => { registry.plugins[0].installPath = join(world.base, '不存在的安装'); return registry; });
  check('install_path_missing', { installedPluginsPath: world.registryPath });

  await rm(join(world2.commonInstall, 'release.json'));
  check('release_missing', { installedPluginsPath: world2.registryPath }, world2);

  await writeFile(join(world2.commonInstall, 'release.json'), '{ bad');
  check('release_invalid', { installedPluginsPath: world2.registryPath }, world2);
});

test('定位器失败分类：入口缺失、API 不兼容、版本不足在导入前拦截', async t => {
  const world = await buildWorld(t);
  const missing = runConsumer(world, { installedPluginsPath: world.registryPath, entryOverride: 'gateway' });
  assert.equal(missing.payload.code, 'entry_missing');

  // 消费者未声明 expectedCommonApiVersion 时必须显式拒绝（无默认代际），
  // 防止忘写声明的调用方静默按第 1 代放行未来的不兼容发布。
  const undeclared = runConsumer(world, { installedPluginsPath: world.registryPath, omitApiDeclaration: true });
  assert.equal(undeclared.payload.code, 'api_incompatible', JSON.stringify(undeclared.payload));

  const releasePath = join(world.commonInstall, 'release.json');
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  release.commonApiVersion = 2;
  await writeFile(releasePath, JSON.stringify(release));
  assert.equal(runConsumer(world, { installedPluginsPath: world.registryPath }).payload.code, 'api_incompatible');

  const world2 = await buildWorld(t, { storageName: '版本 不足根' });
  assert.equal(runConsumer(world2, { installedPluginsPath: world2.registryPath, minimumCommonVersion: '999.0.0' }).payload.code, 'version_insufficient');
assert.equal(runConsumer(world2, { installedPluginsPath: world2.registryPath, minimumCommonVersion: 'not-a-version' }).payload.code, 'version_insufficient');  assert.equal(runConsumer(world2, { commonRoot: '相对路径' }).payload.code, 'common_root_invalid');  await rm(join(world2.commonInstall, 'dist', 'client.mjs'));  assert.equal(runConsumer(world2, { installedPluginsPath: world2.registryPath }).payload.code, 'entry_missing');
});

test('进程内首次加载固定 common 根：注册表其后变化不热换，新进程读到新根', async t => {
  const world = await buildWorld(t);
  const declared = { installedPluginsPath: world.registryPath, expectedCommonApiVersion: 1 };
  const first = await loadCommonModule('client', declared);
  const secondInstall = join(world.base, '新版 common');
  await cp(world.commonInstall, secondInstall, { recursive: true });
  const registry = JSON.parse(await readFile(world.registryPath, 'utf8'));
  registry.plugins[0].installPath = secondInstall;
  await writeFile(world.registryPath, JSON.stringify(registry));
  const second = await loadCommonModule('client', declared);
  assert.equal(second.root, first.root, '同进程内不得热换 common 根');
  assert.equal(second.buildId, first.buildId);
  const fresh = runConsumer(world, { installedPluginsPath: world.registryPath });
  assert.equal(fresh.payload.root, secondInstall, '新进程应读取注册表当前指向');
});

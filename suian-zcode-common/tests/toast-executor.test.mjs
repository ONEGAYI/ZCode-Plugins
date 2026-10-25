import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat as fsStat, unlink, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { buildReleaseWorld } from './depcheck-fixture.mjs';
import { deployToastRuntime, readExecutorText, registerToastIdentity, toastRootFor } from '../toast-runtime.mjs';
import { runAction, parseActionUri, TITLE_PLUGIN_ID } from '../toast-executor.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executorSource = join(pluginRoot, 'toast-executor.mjs');

// 本文件禁止真实 PowerShell / cmd / reg 调用；进程内 monkey-patch 拦截并计数。
const originalExecFile = childProcess.execFile;
let nativeCalls = 0;
childProcess.execFile = () => { nativeCalls++; throw new Error('executor test attempted native execution'); };
syncBuiltinESMExports();
after(() => {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  assert.equal(nativeCalls, 0, 'executor tests must use injected system boundaries');
});

const TITLE_TEMPLATE = [
  '请帮我检查并修复 ZCode 自动命名插件的公共网关 RPC。',
  '插件目录：{{plugin_root}}',
  '数据目录：{{data_dir}}',
].join('\n');

// 文件系统真实、系统命令只放行 node --check 的注入 shell：部署真实落盘，又不触达注册表/PowerShell。
const realIoShell = {
  mkdir: path => mkdir(path, { recursive: true }),
  readText: path => readFile(path, 'utf8'),
  writeText: (path, text) => writeFile(path, text, 'utf8'),
  remove: async path => { try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
  rename: (from, to) => rename(from, to),
  stat: async path => {
    try { const info = await fsStat(path); return { isFile: info.isFile(), isDirectory: info.isDirectory() }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  },
  run: (cmd, args) => {
    if (args[0] === '--check') return promisify(originalExecFile)(cmd, args, { windowsHide: true }).then(r => r.stdout);
    throw new Error('unexpected system call in deployment: ' + cmd);
  },
};

// 构造部署好的 Toast 世界：发布形态 fixture 世界 + 稳定运行时 + 两个外置身份 + title 外置模板。
async function buildToastWorld(t, { customRegistry = false } = {}) {
  const world = await buildReleaseWorld(t);
  if (customRegistry) {
    const pluginsFile = join(world.root, '自定义 存储根', 'installed_plugins.json');
    await mkdir(dirname(pluginsFile), { recursive: true });
    await rename(world.pluginsFile, pluginsFile);
    world.pluginsFile = pluginsFile;
  }
  const homeDir = world.homeDir;
  const executorText = await readExecutorText(); // 与真实部署一致：经占位符注入版本
  await deployToastRuntime({ homeDir, nodeExe: process.execPath, executorText, shell: realIoShell });
  const commonDataDir = join(world.root, 'toast-common-data');
  const titleDataDir = join(world.root, 'toast-title-data');
  await mkdir(commonDataDir, { recursive: true });
  await mkdir(titleDataDir, { recursive: true });
  await registerToastIdentity({ homeDir, protocol: 'suian-zcode-common', appId: 'SUIAN.SuianZcodeCommon.Toast', dataDir: commonDataDir, pluginsFile: world.pluginsFile, description: 'ZCode 公共基础插件通知', shell: realIoShell });
  await registerToastIdentity({ homeDir, protocol: 'suian-zcode-title', appId: 'SUIAN.SuianZcodeTitle.Toast', dataDir: titleDataDir, pluginsFile: world.pluginsFile, description: 'ZCode Stop 自动命名', templateFile: 'toast-prompt-template.md', shell: realIoShell });
  await writeFile(join(titleDataDir, 'toast-prompt-template.md'), TITLE_TEMPLATE, 'utf8');
  return { ...world, homeDir, toastRoot: toastRootFor(homeDir), commonDataDir, titleDataDir };
}

const inject = () => {
  const clipboard = [], opened = [];
  return {
    clipboard, opened,
    setClipboard: async text => { clipboard.push(text); },
    openWorkspace: async uri => { opened.push(uri); },
  };
};

test('同时移除 common 与 title 测试缓存后，已部署执行器与外置模板仍可生成并复制修复提示', async t => {
  const world = await buildToastWorld(t);
  // 模拟旧缓存被宿主清理：插件缓存目录整体删除、公共稳定入口链接悬空；已部署执行器与外置身份保留
  await rm(join(world.homeDir, '.zcode', 'cli', 'plugins', 'cache'), { recursive: true, force: true });
  await rm(join(world.homeDir, '.zcode', 'tools', 'suian-zcode-common', 'runtime'), { force: true });
  const common = inject(), title = inject();
  const commonResult = await runAction({ uri: 'suian-zcode-common://fix', homeDir: world.homeDir, ...common });
  assert.equal(commonResult.ok, true);
  assert.ok(commonResult.issues > 0, '缓存删除后现场扫描必须报告缺失');
  assert.match(common.clipboard[0], /缓存目录缺失|插件文件缺失|依赖/);
  assert.equal(common.opened.length, 1, '复制成功后打开固定默认工作区');
  const titleResult = await runAction({ uri: 'suian-zcode-title://fix', homeDir: world.homeDir, ...title });
  assert.equal(titleResult.ok, true);
  assert.match(title.clipboard[0], /修复 ZCode 自动命名插件/);
  assert.match(title.clipboard[0], /安装条目缺失/, 'title 安装条目随缓存删除，必须明确说明缺失');
  assert.ok(!title.clipboard[0].includes(world.installPaths['suian-zcode-title']), '不得把已删除的旧缓存根当作有效入口输出');
  assert.equal(title.opened.length, 1);
});

test('title 点击插入当前安装条目根：重装换根后提示词用新根，不残留旧根', async t => {
  const world = await buildToastWorld(t, { customRegistry: true });
  const first = inject();
  await runAction({ uri: 'suian-zcode-title://fix', homeDir: world.homeDir, ...first });
  const oldRoot = world.installPaths['suian-zcode-title'];
  assert.ok(first.clipboard[0].includes(oldRoot), '安装条目存在时插入当前根');

  // 模拟重装到新版本目录：改写安装记录
  const registryPath = world.pluginsFile;
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const newRoot = join(world.root, 'cache-v2', 'suian-zcode-title', '0.1.6');
  await mkdir(newRoot, { recursive: true });
  const entry = registry.plugins.find(plugin => plugin.name === 'suian-zcode-title');
  entry.installPath = newRoot;
  entry.version = '0.1.6';
  await writeFile(registryPath, JSON.stringify(registry), 'utf8');
  const second = inject();
  await runAction({ uri: 'suian-zcode-title://fix', homeDir: world.homeDir, ...second });
  assert.ok(second.clipboard[0].includes(newRoot), '提示词必须反映当前安装条目根');
  assert.ok(!second.clipboard[0].includes(oldRoot), '旧根不得再作为有效入口出现');
  assert.ok(second.clipboard[0].includes(world.titleDataDir), '{{data_dir}} 使用外置身份数据目录');
});

test('common 点击现场重扫：依赖修复前后提示词反映当前状态', async t => {
  const world = await buildToastWorld(t, { customRegistry: true });
  const broken = inject();
  const victim = join(world.installPaths['suian-zcode-title'], 'dist', 'hook.mjs');
  const original = await readFile(victim, 'utf8');
  await rm(victim);
  const brokenResult = await runAction({ uri: 'suian-zcode-common://fix', homeDir: world.homeDir, ...broken });
  assert.equal(brokenResult.issues, 1);
  assert.match(broken.clipboard[0], /发布文件缺失/, '修复提示词使用完整描述文案');
  assert.ok(broken.clipboard[0].includes(`--installed-plugins "${world.pluginsFile}"`), '外部复查命令必须使用同一自定义清单');
  await writeFile(victim, original, 'utf8');
  const fixed = inject();
  const fixedResult = await runAction({ uri: 'suian-zcode-common://fix', homeDir: world.homeDir, ...fixed });
  assert.equal(fixedResult.issues, 0);
  assert.match(fixed.clipboard[0], /复查通过/);
});

test('安装清单缺失、损坏或旧身份无锚点时，两个协议均明确报告未完成检查', async t => {
  for (const [mode, skipped] of [['missing', 'no_manifest'], ['json', 'bad_manifest'], ['shape', 'bad_manifest'], ['anchor', 'anchor_missing']]) {
    await t.test(mode, async () => {
      const world = await buildToastWorld(t);
      if (mode === 'missing') await rm(world.pluginsFile);
      if (mode === 'json') await writeFile(world.pluginsFile, '{bad');
      if (mode === 'shape') await writeFile(world.pluginsFile, 'null');
      for (const protocol of ['suian-zcode-common', 'suian-zcode-title']) {
        if (mode === 'anchor') {
          const path = join(world.toastRoot, 'identities', protocol + '.json');
          const identity = JSON.parse(await readFile(path, 'utf8'));
          delete identity.pluginsFile;
          await writeFile(path, JSON.stringify(identity));
        }
        const scope = inject();
        const result = await runAction({ uri: protocol + '://fix', homeDir: world.homeDir, ...scope });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'registry_unavailable');
        assert.equal(result.skipped, skipped);
        assert.equal(result.issues, null, '未扫描不能报告零项问题');
        assert.match(scope.clipboard[0], /未完成.*检查/);
        assert.doesNotMatch(scope.clipboard[0], /复查通过|无需修复/);
      }
    });
  }
});

test('身份缺失或协议不匹配时明确失败，不默认采用另一插件的数据', async t => {
  const world = await buildToastWorld(t);
  await rm(join(world.toastRoot, 'identities', 'suian-zcode-title.json'));
  const missing = inject();
  const missingResult = await runAction({ uri: 'suian-zcode-title://fix', homeDir: world.homeDir, ...missing });
  assert.deepEqual(missingResult, { ok: false, reason: 'identity_missing' });
  assert.equal(missing.clipboard.length, 0, '身份缺失不得复制任何提示');
  // common 身份完好，不受影响
  const common = inject();
  assert.equal((await runAction({ uri: 'suian-zcode-common://fix', homeDir: world.homeDir, ...common })).ok, true);

  // 身份文件协议与 URI 协议不符：拒绝
  const identityPath = join(world.toastRoot, 'identities', 'suian-zcode-title.json');
  const forged = { formatVersion: 1, protocol: 'suian-zcode-common', appId: 'x', dataDir: world.commonDataDir, templateFile: null };
  await writeFile(identityPath, JSON.stringify(forged), 'utf8');
  const mismatch = inject();
  const mismatchResult = await runAction({ uri: 'suian-zcode-title://fix', homeDir: world.homeDir, ...mismatch });
  assert.deepEqual(mismatchResult, { ok: false, reason: 'identity_mismatch' });
  assert.equal(mismatch.clipboard.length, 0);
});

test('title 外置模板缺失时明确失败', async t => {
  const world = await buildToastWorld(t);
  await rm(join(world.titleDataDir, 'toast-prompt-template.md'));
  const scope = inject();
  const result = await runAction({ uri: 'suian-zcode-title://fix', homeDir: world.homeDir, ...scope });
  assert.deepEqual(result, { ok: false, reason: 'template_missing' });
  assert.equal(scope.clipboard.length, 0);
});

test('URI 校验：只接受对应协议的 fix，拒绝无效 URI 与未知动作', async () => {
  assert.deepEqual(parseActionUri('suian-zcode-common://fix'), { action: 'fix', protocol: 'suian-zcode-common' });
  assert.deepEqual(parseActionUri('suian-zcode-title://FIX'), { action: 'fix', protocol: 'suian-zcode-title' });
  assert.equal(parseActionUri('suian-zcode-common://fix?x=1'), null, 'URI 不得携带查询参数');
  assert.equal(parseActionUri('suian-zcode-common://fix/../../etc'), null);
  assert.equal(parseActionUri('file:///etc/passwd'), null);
  assert.equal(parseActionUri('suian-zcode-app-mcp://fix'), null, '只支持 common 与 title 两种身份');
  assert.deepEqual(parseActionUri('suian-zcode-title://wipe'), { action: 'wipe', protocol: 'suian-zcode-title' });
  const scope = inject();
  assert.deepEqual(await runAction({ uri: 'suian-zcode-title://wipe', homeDir: 'H:\\x', ...scope }), { ok: false, reason: 'unknown_action' });
  assert.deepEqual(await runAction({ uri: 'not-a-uri', homeDir: 'H:\\x', ...scope }), { ok: false, reason: 'invalid_uri' });
  assert.equal(scope.clipboard.length, 0);
});

test('执行器自包含：不相对导入任何包内模块，不依赖版本缓存代码', async () => {
  const source = await readFile(executorSource, 'utf8');
  const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('node:'), `执行器必须自包含，发现非内置导入：${specifier}`);
  }
});

test('真实部署文件公开入口冒烟：子进程执行 URI 动作，系统边界全部拦截', async t => {
  const world = await buildToastWorld(t, { customRegistry: true });
  await rm(world.installPaths['suian-side-editor'], { recursive: true });
  const registry = JSON.parse(await readFile(world.pluginsFile, 'utf8'));
  const newTitleRoot = join(world.root, '更新后的 title 根');
  await mkdir(newTitleRoot);
  registry.plugins.find(plugin => plugin.name === 'suian-zcode-title').installPath = newTitleRoot;
  await writeFile(world.pluginsFile, JSON.stringify(registry));
  const dir = await mkdtemp(join(tmpdir(), 'zcode-toast-executor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preload = join(dir, 'intercept.mjs');
  const logFile = join(dir, 'intercept.log');
  await writeFile(preload, [
    "import cp from 'node:child_process';",
    "import fs from 'node:fs';",
    "import {syncBuiltinESMExports} from 'node:module';",
    "cp.execFile=(command,args, options, callback)=>{",
    "  fs.appendFileSync(process.env.SUIAN_INTERCEPT_LOG, command+' '+JSON.stringify(args)+'\\n');",
    "  if(options?.env?.OIL_CLIP_FILE) fs.appendFileSync(process.env.SUIAN_INTERCEPT_LOG, fs.readFileSync(options.env.OIL_CLIP_FILE,'utf8')+'\\n');",
    "  if(typeof options==='function'){callback(null,{stdout:'',stderr:''});return {}}",
    "  if(typeof callback==='function'){callback(null,{stdout:'',stderr:''});return {}}",
    "  return {stdout:'',stderr:''};",
    "};",
    'syncBuiltinESMExports();',
  ].join('\n'), 'utf8');
  for (const protocol of ['suian-zcode-common', 'suian-zcode-title']) {
  const stopped = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(world.toastRoot, 'executor.mjs'), protocol + '://fix'], {
    windowsHide: true, encoding: 'utf8',
    env: {
      ...process.env,
      SUIAN_TOAST_HOME: world.homeDir,
      SUIAN_INTERCEPT_LOG: logFile,
      ZCODE_PLUGIN_DATA: undefined,
      OIL_ZCODE_TITLE_DATA: undefined,
    },
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  const payload = JSON.parse(stopped.stdout.trim().split('\n').at(-1));
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'fix');
  if (protocol === 'suian-zcode-common') assert.ok(payload.issues > 0, '自定义清单中的缓存缺失必须检出');
  }
  const intercepted = await readFile(logFile, 'utf8');
  assert.match(intercepted, /powershell\.exe/, '剪贴板写入经 PowerShell 且被拦截');
  assert.match(intercepted, /cmd\.exe.*zcode:\/\/workspace\/open/, '打开工作区经 cmd start 且被拦截');
  assert.ok(intercepted.includes(newTitleRoot), '无宿主环境的部署入口读取自定义清单中的新 title 根');
  const today = new Date();
  const dayStamp = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
  const log = await readFile(join(world.titleDataDir, `toast-action-${dayStamp}.log.jsonl`), 'utf8');
  const entry = JSON.parse(log.trim().split('\n').at(-1));
  assert.equal(entry.uri, 'suian-zcode-title://fix');
  assert.equal(entry.ok, true);
  assert.equal(typeof entry.v, 'string', '执行器内联滚动的行内嵌版本字段（源码直跑回退读相邻清单）');
});

test('title 安装条目身份常量与插件 ID 一致', () => {
  assert.equal(TITLE_PLUGIN_ID, 'suian-zcode-title');
});

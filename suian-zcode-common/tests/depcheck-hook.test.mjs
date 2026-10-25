import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runDepcheckHook, resolveDataDir, ensureToastIdentity } from '../depcheck-hook.mjs';
import { runAction, parseActionUri } from '../toast-action.mjs';
import { scanSuianPlugins } from '../depcheck.mjs';
import { buildFixPrompt, summarizeIssues } from '../depcheck-prompt.mjs';
import { buildVbsContent } from '../notification-install.mjs';
import { buildReleaseWorld } from './depcheck-fixture.mjs';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

test('stop_hook_active 轮直接跳过且不触发扫描', async () => {
  let scanCalled = false;
  const result = await runDepcheckHook({
    payload: { stop_hook_active: true, session_id: 'sess_x' },
    dataDir: '.',
    scan: async () => { scanCalled = true; return { ok: true, issues: [] }; },
  });
  assert.equal(result.action, 'skipped_stale');
  assert.equal(scanCalled, false);
});

test('无效 stdin 载荷被忽略', async () => {
  const result = await runDepcheckHook({ payload: null, dataDir: '.' });
  assert.equal(result.action, 'ignored_invalid');
});

test('清单缺失时静默跳过且不安装身份不发通知', async t => {
  const world = await buildReleaseWorld(t);
  let identityCalled = false;
  let notifyCalled = false;
  const result = await runDepcheckHook({
    payload: { session_id: 'sess_x' },
    dataDir: join(world.root, 'data'),
    scan: () => scanSuianPlugins({ pluginsFile: join(world.root, 'absent.json') }),
    ensureIdentity: async () => { identityCalled = true; return { action: 'cached' }; },
    notify: async () => { notifyCalled = true; return { shown: true }; },
  });
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'no_manifest');
  assert.equal(identityCalled, false);
  assert.equal(notifyCalled, false);
});

test('依赖齐全时只落盘检查结果，不安装身份不发通知', async t => {
  const world = await buildReleaseWorld(t);
  const dataDir = join(world.root, 'data');
  let identityCalled = false;
  let notifyCalled = false;
  const result = await runDepcheckHook({
    payload: { session_id: 'sess_x' },
    dataDir,
    scan: () => scanSuianPlugins({ homeDir: world.homeDir }),
    ensureIdentity: async () => { identityCalled = true; return { action: 'cached' }; },
    notify: async () => { notifyCalled = true; return { shown: true }; },
  });
  assert.equal(result.action, 'clean');
  assert.equal(identityCalled, false);
  assert.equal(notifyCalled, false);
  const persisted = JSON.parse(await readFile(join(dataDir, 'depcheck-last.json'), 'utf8'));
  assert.equal(persisted.ok, true);
});

test('发现缺失时先确保 Toast 身份再以修复引导文案通知', async t => {
  const world = await buildReleaseWorld(t);
  await rm(join(world.installPaths['suian-side-editor'], 'cli.mjs'));
  const dataDir = join(world.root, 'data');
  const calls = { identity: [], notify: [] };
  const result = await runDepcheckHook({
    payload: { session_id: 'sess_x' },
    dataDir,
    scan: () => scanSuianPlugins({ homeDir: world.homeDir }),
    ensureIdentity: async arg => { calls.identity.push(arg); return { action: 'installed' }; },
    notify: async arg => { calls.notify.push(arg); return { shown: true }; },
  });
  assert.equal(result.action, 'notified');
  assert.equal(result.issues, 1);
  assert.equal(result.shown, true);
  assert.deepEqual(calls.identity, [{ dataDir }]);
  assert.equal(calls.notify.length, 1);
  assert.match(calls.notify[0].message, /suian-side-editor 0\.3\.0：发布文件缺失/);
  assert.match(calls.notify[0].message, /点击按钮复制修复提示词/);
  const persisted = JSON.parse(await readFile(join(dataDir, 'depcheck-last.json'), 'utf8'));
  assert.equal(persisted.issues[0].code, 'file_missing');
});

test('通知处于冷却（shown:false）时不视为错误', async t => {
  const world = await buildReleaseWorld(t);
  await rm(join(world.installPaths['suian-zcode-title'], 'dist', 'hook.mjs'));
  const result = await runDepcheckHook({
    payload: { session_id: 'sess_x' },
    dataDir: join(world.root, 'data'),
    scan: () => scanSuianPlugins({ homeDir: world.homeDir }),
    ensureIdentity: async () => ({ action: 'cached' }),
    notify: async () => ({ shown: false, reason: 'cooldown' }),
  });
  assert.equal(result.action, 'notified');
  assert.equal(result.shown, false);
  assert.equal(result.toastReason, 'cooldown');
});

test('Toast 按钮动作对缺失世界复制含修复步骤的提示词并打开工作区', async t => {
  const world = await buildReleaseWorld(t);
  await rm(join(world.installPaths['suian-side-editor'], 'cli.mjs'));
  const clipboard = [];
  const opened = [];
  const result = await runAction({
    uri: 'suian-zcode-common://fix',
    dataDir: join(world.root, 'data'),
    homeDir: world.homeDir,
    setClipboard: async text => { clipboard.push(text); },
    openWorkspace: async uri => { opened.push(uri); },
  });
  assert.deepEqual(result, { ok: true, action: 'fix', issues: 1 });
  assert.equal(clipboard.length, 1);
  const prompt = clipboard[0];
  assert.match(prompt, /suian-side-editor 0\.3\.0：发布清单声明的文件缺失于安装目录/);
  assert.match(prompt, /suian-zcode-common:setup/);
  assert.match(prompt, /zcode plugins update/);
  assert.match(prompt, /depcheck-hook\.mjs" --scan-only/);
  assert.doesNotMatch(prompt, /npm ci/, '修复提示词不得再引导 npm 安装');
  assert.doesNotMatch(prompt, /link\.mjs --plugin-root/, '修复提示词不得再引导修包链接');
  assert.match(prompt, new RegExp(world.installPaths['suian-zcode-common'].replace(/\\/g, '\\\\')));
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^zcode:\/\/workspace\/open\?path=/);
});

test('按钮动作在依赖已修复后复制复查通过说明', async t => {
  const world = await buildReleaseWorld(t);
  const clipboard = [];
  const result = await runAction({
    uri: 'suian-zcode-common://fix',
    dataDir: join(world.root, 'data'),
    homeDir: world.homeDir,
    setClipboard: async text => { clipboard.push(text); },
    openWorkspace: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.issues, 0);
  assert.match(clipboard[0], /复查通过/);
});

test('源码按钮入口在清单不可用时也不能返回零问题与通过状态', async t => {
  const world = await buildReleaseWorld(t);
  await rm(world.pluginsFile);
  const clipboard = [];
  const result = await runAction({ uri: 'suian-zcode-common://fix', homeDir: world.homeDir,
    dataDir: world.root, setClipboard: async text => clipboard.push(text), openWorkspace: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.issues, null);
  assert.equal(result.reason, 'registry_unavailable');
  assert.match(clipboard[0], /未完成.*检查/);
});

test('协议 URI 解析：合法 fix 动作放行，非法与未知动作被拒绝', async () => {
  assert.deepEqual(parseActionUri('suian-zcode-common://fix'), { action: 'fix' });
  assert.equal(parseActionUri('https://example.com'), null);
  assert.deepEqual(parseActionUri('suian-zcode-common://unknown'), { action: 'unknown' });
  const result = await runAction({ uri: 'suian-zcode-common://unknown', dataDir: '.' });
  assert.deepEqual(result, { ok: false, reason: 'unknown_action' });
  const invalid = await runAction({ uri: 'not-a-uri', dataDir: '.' });
  assert.deepEqual(invalid, { ok: false, reason: 'invalid_uri' });
});

test('数据目录解析：宿主注入 ZCODE_PLUGIN_DATA 时挂 state 子目录', () => {
  assert.equal(resolveDataDir({ ZCODE_PLUGIN_DATA: 'C:\\plugin-data' }), join('C:\\plugin-data', 'state'));
  assert.equal(resolveDataDir({}), join(homedir(), '.zcode', 'suian-zcode-common'));
});

test('宿主冒烟：齐全世界 Stop 载荷正常退出且落盘检查结果', async t => {
  const world = await buildReleaseWorld(t);
  const dataDir = join(dirname(world.pluginsFile), 'data', 'suian-zcode-common');
  const hook = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')).hooks.Stop[0].hooks[0];
  assert.equal(hook.async, true, 'Stop 依赖检查必须异步注册以免阻塞对话');
  assert.equal(hook.timeoutMs >= 30000, true);
  const command = hook.command.replaceAll('${ZCODE_PLUGIN_ROOT}', pluginRoot);
  const stopped = spawnSync(command, {
    shell: true, windowsHide: true, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sess_smoke_fixture', cwd: world.root, hook_event_name: 'Stop' }),
    env: { ...process.env, ZCODE_PLUGIN_DATA: dataDir, SUIAN_DEPCHECK_HOME: world.homeDir, OIL_ZCODE_TITLE_DATA: undefined },
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.ok(!stopped.stdout.trimStart().startsWith('{'), 'stdout 不得以 { 开头');
  assert.match(stopped.stdout, /"action":"clean"/);
  const persisted = JSON.parse(await readFile(join(dataDir, 'state', 'depcheck-last.json'), 'utf8'));
  assert.equal(persisted.ok, true);
  const today = new Date();
  const dayStamp = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
  const log = (await readFile(join(dataDir, 'state', `hook-${dayStamp}.log.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.at(-1).action, 'clean');
  assert.equal(typeof log.at(-1).v, 'string', '按天滚动的事件行内嵌版本字段');
});

test('宿主冒烟：非法 stdin 与续跑轮不崩且不扫真实缓存', async t => {
  const world = await buildReleaseWorld(t);
  const dataDir = join(world.root, 'host-data2');
  const command = `node "${join(pluginRoot, 'depcheck-hook.mjs')}"`;
  for (const [input, expected] of [
    ['not-json', /ignored_invalid/],
    [JSON.stringify({ stop_hook_active: true, session_id: 'sess_x' }), /skipped_stale/],
  ]) {
    const stopped = spawnSync(command, {
      shell: true, windowsHide: true, encoding: 'utf8', input,
      env: { ...process.env, ZCODE_PLUGIN_DATA: dataDir, SUIAN_DEPCHECK_HOME: world.homeDir, OIL_ZCODE_TITLE_DATA: undefined },
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, expected);
  }
});

test('修复提示词模板：缺失明细与缓存根一一对应', async t => {
  const world = await buildReleaseWorld(t);
  await rm(join(world.installPaths['suian-zcode-app-mcp'], 'dist', 'cli.mjs'));
  await rm(join(world.installPaths['suian-zcode-common'], 'dist', 'client.mjs'));
  const result = await scanSuianPlugins({ homeDir: world.homeDir });
  const prompt = buildFixPrompt(result);
  assert.match(prompt, /suian-zcode-app-mcp 0\.11\.0：发布清单声明的文件缺失于安装目录（发布文件缺失：dist\/cli\.mjs）/);
  assert.match(prompt, /suian-zcode-common 0\.5\.0：发布清单声明的文件缺失于安装目录（发布文件缺失：dist\/client\.mjs）/);
  for (const spec of world.specs) assert.match(prompt, new RegExp(spec.name));
});

test('摘要与提示词对异常 version 值安全（类型白名单与分隔符）', () => {
  const result = {
    issues: [{ plugin: 'suian-side-editor', code: 'file_missing', detail: '发布文件缺失：dist/cli.mjs' }],
    plugins: [
      { name: 'suian-side-editor', version: { bad: 1 }, installPath: 'C:\\cache\\suian-side-editor' },
      { name: 'suian-zcode-common', version: null, installPath: 'C:\\cache\\suian-zcode-common' },
    ],
  };
  assert.equal(summarizeIssues(result), 'suian-side-editor：发布文件缺失');
  const prompt = buildFixPrompt(result);
  assert.doesNotMatch(prompt, /object Object/);
  assert.match(prompt, /suian-side-editor：发布清单声明的文件缺失于安装目录/);
});

test('Toast 身份：旧版 vbs 嵌入缓存内入口时必须重装为稳定转发桥', async t => {
  const world = await buildReleaseWorld(t);
  const dataDir = join(world.root, 'data');
  await mkdir(dataDir, { recursive: true });
  // 模拟旧版本安装残留：vbs 直接嵌入版本缓存内的 toast-action.mjs
  const staleVbs = `' 旧格式桥\r\nsh.Run """" & "node.exe" & """ """ & "${join(world.root, 'old-cache', 'toast-action.mjs')}" & """ """ & WScript.Arguments(0) & """", 0, False\r\n`;
  await writeFile(join(dataDir, 'toast-launch.vbs'), staleVbs);
  await writeFile(join(dataDir, 'toast-appid.txt'), 'SUIAN.SuianZcodeCommon.Toast');
  const installs = [];
  const shell = { run: async () => '' };
  const result = await ensureToastIdentity({ dataDir, homeDir: world.homeDir, install: async arg => { installs.push(arg); }, shell });
  assert.equal(result.action, 'installed');
  assert.equal(installs.length, 1, '旧格式 vbs 必须重装为稳定入口');
  assert.equal(installs[0].homeDir, world.homeDir, '安装必须携带 homeDir 以定位共享运行目录');
});

test('Toast 身份：vbs、清单锚点与注册表键均正常时走缓存短路，不重装', async t => {
  const world = await buildReleaseWorld(t);
  const dataDir = join(world.root, 'data');
  const toastRoot = join(world.homeDir, '.zcode', 'tools', 'suian-zcode-common', 'toast');
  await mkdir(join(toastRoot, 'identities'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(toastRoot, 'identities', 'suian-zcode-common.json'), JSON.stringify({ formatVersion: 1, protocol: 'suian-zcode-common', appId: 'SUIAN.SuianZcodeCommon.Toast', dataDir, pluginsFile: world.pluginsFile, templateFile: null }));
  await writeFile(join(dataDir, 'toast-launch.vbs'), buildVbsContent({ protocol: 'suian-zcode-common', launcherPath: join(toastRoot, 'launch.vbs') }));
  await writeFile(join(dataDir, 'toast-appid.txt'), 'SUIAN.SuianZcodeCommon.Toast');
  const installs = [];
  let registryQueried = false;
  const shell = { run: async (cmd, args) => { registryQueried = cmd === 'reg.exe' && args[0] === 'query'; return ''; } };
  const result = await ensureToastIdentity({ dataDir, homeDir: world.homeDir, pluginsFile: world.pluginsFile, install: async arg => { installs.push(arg); }, shell });
  assert.equal(result.action, 'cached');
  assert.equal(installs.length, 0);
  assert.equal(registryQueried, true, '缓存命中必须校验注册表协议键存在');
});

test('Toast 身份：旧身份缺少清单锚点时重装，并携带自定义清单路径', async t => {
  const world = await buildReleaseWorld(t);
  const dataDir = join(world.root, 'data');
  const toastRoot = join(world.homeDir, '.zcode', 'tools', 'suian-zcode-common', 'toast');
  await mkdir(join(toastRoot, 'identities'), { recursive: true });
  await mkdir(dataDir);
  await writeFile(join(dataDir, 'toast-launch.vbs'), buildVbsContent({ protocol: 'suian-zcode-common', launcherPath: join(toastRoot, 'launch.vbs') }));
  await writeFile(join(toastRoot, 'identities', 'suian-zcode-common.json'), JSON.stringify({ protocol: 'suian-zcode-common' }));
  const pluginsFile = join(world.root, '自定义 清单', 'installed_plugins.json');
  const installs = [];
  const result = await ensureToastIdentity({ dataDir, homeDir: world.homeDir, pluginsFile, shell: { run: async () => '' }, install: async options => installs.push(options) });
  assert.equal(result.action, 'installed');
  assert.equal(installs[0].pluginsFile, pluginsFile);
});

test('Toast 身份：外置身份描述被外部删除时自愈重装', async t => {
  const world = await buildReleaseWorld(t);
  const dataDir = join(world.root, 'data');
  const toastRoot = join(world.homeDir, '.zcode', 'tools', 'suian-zcode-common', 'toast');
  await mkdir(join(toastRoot, 'identities'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'toast-launch.vbs'), buildVbsContent({ protocol: 'suian-zcode-common', launcherPath: join(toastRoot, 'launch.vbs') }));
  await writeFile(join(dataDir, 'toast-appid.txt'), 'SUIAN.SuianZcodeCommon.Toast');
  const installs = [];
  const shell = { run: async () => '' };
  const result = await ensureToastIdentity({ dataDir, homeDir: world.homeDir, install: async arg => { installs.push(arg); }, shell });
  assert.equal(result.action, 'installed');
  assert.equal(installs.length, 1, '身份描述缺失必须重装，不能仅凭 AppID 缓存判定健康');
});

test('Toast 身份：注册表协议键被外部删除时自愈重装', async t => {
  const world = await buildReleaseWorld(t);
  const dataDir = join(world.root, 'data');
  const toastRoot = join(world.homeDir, '.zcode', 'tools', 'suian-zcode-common', 'toast');
  await mkdir(join(toastRoot, 'identities'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(toastRoot, 'identities', 'suian-zcode-common.json'), JSON.stringify({ formatVersion: 1, protocol: 'suian-zcode-common', appId: 'SUIAN.SuianZcodeCommon.Toast', dataDir, templateFile: null }));
  await writeFile(join(dataDir, 'toast-launch.vbs'), buildVbsContent({ protocol: 'suian-zcode-common', launcherPath: join(toastRoot, 'launch.vbs') }));
  await writeFile(join(dataDir, 'toast-appid.txt'), 'SUIAN.SuianZcodeCommon.Toast');
  const installs = [];
  const shell = { run: async () => { throw new Error('exit 1: 系统找不到指定的注册表项'); } };
  const result = await ensureToastIdentity({ dataDir, homeDir: world.homeDir, install: async arg => { installs.push(arg); }, shell });
  assert.equal(result.action, 'installed');
  assert.equal(installs.length, 1);
});

test('Toast 身份：vbs 尚未安装（首次运行）时直接安装', async t => {
  const world = await buildReleaseWorld(t);
  const dataDir = join(world.root, 'data');
  const installs = [];
  let registryQueried = false;
  const shell = { run: async cmd => { registryQueried = true; return ''; } };
  const result = await ensureToastIdentity({ dataDir, homeDir: world.homeDir, install: async arg => { installs.push(arg); }, shell });
  assert.equal(result.action, 'installed');
  assert.equal(installs.length, 1);
  assert.equal(registryQueried, false, 'vbs 缺失时无需查询注册表');
});

test('不自举静态契约：depcheck 全链路只用 Node 内置模块与包内相对导入', async () => {
  const chain = ['depcheck.mjs', 'depcheck-hook.mjs', 'depcheck-prompt.mjs', 'toast-action.mjs', 'notifications.mjs', 'cooldown.mjs', 'notification-install.mjs', 'notification-action.mjs', 'windows.mjs'];
  for (const file of chain) {
    const source = await readFile(join(pluginRoot, file), 'utf8');
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
    assert.ok(specifiers.length > 0 || file === 'depcheck-prompt.mjs', `${file} 应有可检查的导入`);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${file} 引入了非内置且非相对的依赖：${specifier}`,
      );
    }
  }
});

test('--scan-only 手动复查入口：输出 JSON 结果且不读 stdin、不落盘', async t => {
  const world = await buildReleaseWorld(t);
  await rm(join(world.installPaths['suian-side-editor'], 'cli.mjs'));
  const dataDir = join(world.root, 'scan-data');
  const stopped = spawnSync(`node "${join(pluginRoot, 'depcheck-hook.mjs')}" --scan-only --data-dir "${dataDir}"`, {
    shell: true, windowsHide: true, encoding: 'utf8', input: '',
    env: { ...process.env, ZCODE_PLUGIN_DATA: undefined, SUIAN_DEPCHECK_HOME: world.homeDir, OIL_ZCODE_TITLE_DATA: undefined },
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  const parsed = JSON.parse(stopped.stdout);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.issues.map(i => i.code), ['file_missing']);
  const entries = await readdir(dataDir).catch(() => []);
  assert.deepEqual(entries, [], '--scan-only 不应写任何数据文件');
});

test('--scan-only 采用宿主自定义数据路径或显式清单，不读取默认 HOME 的清单', async t => {
  const world = await buildReleaseWorld(t);
  const pluginsFile = join(world.root, '自定义 存储', 'installed_plugins.json');
  await mkdir(join(world.root, '自定义 存储'));
  await writeFile(pluginsFile, await readFile(world.pluginsFile));
  await rm(world.pluginsFile);
  await rm(world.installPaths['suian-side-editor'], { recursive: true });
  for (const injected of [true, false]) {
    const args = [join(pluginRoot, 'depcheck-hook.mjs'), '--scan-only', ...(!injected ? ['--installed-plugins', pluginsFile] : [])];
    const child = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ZCODE_PLUGIN_DATA: injected ? join(world.root, '自定义 存储', 'data', 'common') : undefined, SUIAN_DEPCHECK_HOME: world.homeDir } });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.skipped, null, child.stdout);
    assert.ok(result.issues.some(issue => issue.code === 'cache_missing'));
  }
});

test('toast-action 环境变量回退与 hook 一致（ZCODE_PLUGIN_DATA 挂 state 子目录）', async t => {
  const world = await buildReleaseWorld(t);
  const pluginData = join(world.root, 'plugin-data');
  const stopped = spawnSync(`node "${join(pluginRoot, 'toast-action.mjs')}" "suian-zcode-common://unknown"`, {
    shell: true, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, ZCODE_PLUGIN_DATA: pluginData },
  });
  assert.equal(stopped.status, 1);
  const today = new Date();
  const dayStamp = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
  const log = await readFile(join(pluginData, 'state', `toast-action-${dayStamp}.log.jsonl`), 'utf8');
  const entry = JSON.parse(log.trim());
  assert.equal(entry.reason, 'unknown_action');
});

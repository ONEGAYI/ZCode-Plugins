// PKG-03 发布包契约测试：解包可运行的 MCP、工件 Hook 与原生面板资源。
// 全部验证发生在隔离 staging（tests/.scratch/）：无业务 node_modules、无 junction、无源码目录可达，
// 公共层仅经 PKG-01 安装记录定位。对应工单 #115 验收条件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildCommonRelease, createHostStorage, pluginRoot } from './release-fixture.mjs';
import { fixture } from './fixtures.mjs';

const run = promisify(execFile);
const scratchRoot = join(fileURLToPath(new URL('./', import.meta.url)), '.scratch');
await mkdir(scratchRoot, { recursive: true });
const staging = await mkdtemp(join(scratchRoot, 'release-pkg-'));

// ---- 模块级一次性准备：构建 common 发布目录、宿主存储根与 app-mcp 发布目录 ----
const commonOut = join(staging, 'common-release');
const commonRelease = await buildCommonRelease(commonOut);
const host = await createHostStorage({
  root: join(staging, 'storage'),
  commonInstallPath: commonOut,
  commonVersion: commonRelease.pluginVersion,
});
const appOut = join(staging, 'app-mcp-release');
const buildResult = JSON.parse((await run(process.execPath, [join(pluginRoot, 'build-release.mjs'), '--out', appOut], { windowsHide: true })).stdout);
const buildInputsPath = buildResult.inputsPath;

const release = JSON.parse(await readFile(join(appOut, 'release.json'), 'utf8'));
const distCli = join(appOut, release.entries['cli'] ?? 'dist/cli.mjs');
const distHook = join(appOut, release.entries['artifact-hook'] ?? 'dist/artifact-hook.mjs');
const distInstall = join(appOut, release.entries.install ?? 'dist/install.mjs');
// 隔离子进程环境：仅保留系统必需变量 + 宿主注入锚点，不含 NODE_PATH 与源码路径
const neutralEnv = extra => ({
  SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive,
  ComSpec: process.env.ComSpec, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
  ZCODE_PLUGIN_DATA: host.dataPath, ZCODE_PLUGIN_ROOT: appOut, ZCODE_PLUGIN_ID: 'suian-zcode-app-mcp@suian-zcode-plugins',
  ...extra,
});
const neutralCwd = join(staging, 'neutral-cwd');
await mkdir(neutralCwd, { recursive: true });

test('发布目录包含三入口 bundle 与完整元信息，业务输入未内联 common 实现', async () => {
  assert.equal(release.formatVersion, 1);
  assert.equal(release.pluginName, 'suian-zcode-app-mcp');
  assert.equal(release.pluginVersion, JSON.parse(await readFile(join(appOut, '.zcode-plugin', 'plugin.json'), 'utf8')).version);
  assert.equal(release.commonApiVersion, 1, '顶层 commonApiVersion（规格 5.3 统一字段名）');
  assert.equal(release.expectedCommonApiVersion, undefined, '不再使用旧字段名 expectedCommonApiVersion');
  assert.match(release.minimumCommonVersion, /^\d+\.\d+\.\d+/);
  for (const [name, path] of Object.entries(release.entries)) {
    assert.match(path, /^dist\//, `入口 ${name} 应位于 dist/`);
    await stat(join(appOut, path));
  }
  const inputs = JSON.parse(await readFile(buildInputsPath, 'utf8')).inputs;
  const commonInputs = Object.keys(inputs).filter(key => key.includes('suian-zcode-common'));
  assert.deepEqual(commonInputs.sort(), ['../suian-zcode-common/locate.mjs'], 'common 侧输入只允许薄定位器');
  for (const bundle of ['dist/cli.mjs', 'dist/artifact-hook.mjs', 'dist/install.mjs']) {
    const text = await readFile(join(appOut, bundle), 'utf8');
    assert.ok(!/from\s+['"]suian-zcode-common\//.test(text), `${bundle} 不应残留公共层裸导入`);
  }
  // SDK 与 zod 的许可必须随包分发（第三方义务）
  const licenses = await readdir(join(appOut, 'licenses'));
  assert.ok(licenses.filter(name => /LICENSE/i.test(name)).length >= 2, `licenses/ 至少包含 SDK 与 zod 许可：${licenses}`);
  await stat(join(appOut, 'vendor', 'NOTICE.md'));
  await stat(join(appOut, 'LICENSE'));
});

test('发布目录纯净：无 node_modules、无 junction、无运行数据与研究快照', async () => {
  const forbidden = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) forbidden.push(`junction:${path}`);
      if (entry.name === 'node_modules' || entry.name === '.scratch' || entry.name === 'experiments' || entry.name === 'tests' || entry.name === 'docs') forbidden.push(`forbidden-dir:${path}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(appOut);
  assert.deepEqual(forbidden, []);
  for (const file of release.files.map(item => item.path)) {
    assert.ok(!/(config\.local|\.sqlite|\.log$|remote\.blob)/.test(file), `包内不应含运行数据：${file}`);
  }
  // 产物不携带本机路径（可移植发布）
  for (const bundle of ['dist/cli.mjs', 'dist/artifact-hook.mjs', 'dist/install.mjs']) {
    const text = await readFile(join(appOut, bundle), 'utf8');
    assert.ok(!text.includes('ZCode-Plugins') && !/[A-Za-z]:\\\\?CODE/.test(text), `${bundle} 不应内嵌本机绝对路径`);
  }
});

test('清单注册指向 dist 入口且模板变量语义保持', async () => {
  const mcp = JSON.parse(await readFile(join(appOut, '.mcp.json'), 'utf8'));
  const spec = mcp.mcpServers['suian-zcode-app'];
  assert.equal(spec.type, 'stdio');
  assert.equal(spec.command, 'node');
  assert.ok(spec.args[0].startsWith('${ZCODE_PLUGIN_ROOT}/dist/cli.mjs'), 'stdio 入口应指向 dist bundle');
  assert.ok(spec.args.includes('${ZCODE_PLUGIN_DATA}/config.json'), '数据目录模板变量语义保持');
  const hooks = JSON.parse(await readFile(join(appOut, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    assert.ok(hooks[event][0].hooks[0].command.includes('${ZCODE_PLUGIN_ROOT}/dist/artifact-hook.mjs'), `${event} Hook 指向 dist 入口`);
    assert.ok(hooks[event][0].hooks[0].command.includes('${ZCODE_PLUGIN_DATA}/config.json'), `${event} Hook 保持数据目录变量`);
  }
});

async function spawnServer(t, { config, capabilities, clientName = 'zcode', clientVersion = '3.16.0' }) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [distCli, '--config', config], stderr: 'pipe', env: neutralEnv({ ZCODE_APP_VERSION: '3.16.0' }),
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: clientName, version: clientVersion }, capabilities ? { capabilities } : undefined);
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

test('隔离环境无业务依赖时 MCP initialize 与工具列表正常，公共加载指向同一 common 安装记录', async t => {
  const dataDir = await mkdtemp(join(staging, 'iso-'));
  const config = join(dataDir, 'config.json');
  const indexDb = join(dataDir, 'tasks.sqlite');
  const sessionDb = join(dataDir, 'sessions.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const index = new DatabaseSync(indexDb);
  index.exec("CREATE TABLE tasks (workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT, task_id TEXT, title TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build', task_status TEXT, created_at INTEGER, updated_at INTEGER, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, PRIMARY KEY (workspace_key, task_id)); INSERT INTO tasks VALUES ('D:\\\\work\\\\alpha','D:\\\\work\\\\alpha',NULL,'sess_release','发布包验证','glm','build','completed',1,10,0,0,0);");
  index.close();
  const session = new DatabaseSync(sessionDb);
  session.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, path TEXT, revert TEXT, permission TEXT, parent_id TEXT, task_type TEXT);');
  session.close();
  await writeFile(config, JSON.stringify({ indexDbPath: indexDb, sessionDbPath: sessionDb, gatewayConfigPath: join(dataDir, 'missing-gateway.json') }));
  const { client, stderr } = await spawnServer(t, { config });
  assert.equal((await client.listTools()).tools.length, 19, '十九个公开工具');
  const sessions = (await client.callTool({ name: 'list_sessions', arguments: {} })).structuredContent;
  assert.equal(sessions.sessions[0].session_id, 'sess_release');
  // 公共层经安装记录加载成功：网关缺失错误来自 common 的 connectHost，而非定位失败
  const sent = await client.callTool({ name: 'send_message', arguments: { session_id: 'sess_release', message: 'hello', workspace_path: 'D:/work/alpha' }, _meta: { session_id: 'sess_release' } });
  assert.equal(sent.isError, true);
  assert.match(sent.structuredContent.error, /公共网关尚未配置/);
  assert.ok(!sent.structuredContent.error.includes('anchor') && !stderr().includes('anchor_missing'), '公共定位不应失败');
  await client.close();
  const [{ at, ...record }] = stderr().trim().split('\n').map(JSON.parse);
  assert.ok(Number.isFinite(Date.parse(at)));
  assert.deepEqual(record, { event: 'tool_error', tool: 'send_message', stage: 'config', reasonCode: 'gateway_not_configured' });
  assert.equal(stderr().trim().split('\n').length, 1);
});

test('工件 Hook 与 stdio 使用同一外置配置：三事件链路后工具可读写同一工件库', async t => {
  const f = fixture(t);
  f.task({ id: 'sess_hook_release', title: 'Hook 会话' });
  f.session({ id: 'sess_hook_release' });
  f.message({ id: 'msg_hook_assistant', session: 'sess_hook_release', role: 'assistant', sequence: 1,
    info: { time: { completed: 123 }, semantics: { kind: 'assistant_response' }, anchor: { turnId: 'turn-1' } } });
  const dataDir = await mkdtemp(join(staging, 'hook-'));
  const config = join(dataDir, 'config.json');
  await writeFile(config, JSON.stringify({
    indexDbPath: f.indexDbPath, sessionDbPath: f.sessionDbPath,
    artifactDbPath: join(dataDir, 'artifacts.sqlite'), gatewayConfigPath: join(dataDir, 'missing-gateway.json'),
  }));
  const runHook = async input => {
    const child = spawn(process.execPath, [distHook, '--config', config], { windowsHide: true, env: neutralEnv(), cwd: neutralCwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', err = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise(resolve => child.on('exit', resolve));
    return { code, stdout, err };
  };
  const started = await runHook({ hookEventName: 'SessionStart', sessionId: 'sess_hook_release' });
  assert.equal(started.code, 0, started.err);
  const submitted = await runHook({ hookEventName: 'UserPromptSubmit', sessionId: 'sess_hook_release' });
  assert.equal(submitted.code, 0, submitted.err);
  assert.ok(JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext, 'UserPromptSubmit 注入工件简表');
  const stopped = await runHook({ hookEventName: 'Stop', sessionId: 'sess_hook_release', turnId: 'turn-1' });
  assert.equal(stopped.code, 0, stopped.err);
  await stat(join(dataDir, 'artifacts.sqlite'));
  // stdio 服务通过同一 config 写入并读回，证明 Hook 与 MCP 共享工件库
  const { client, stderr } = await spawnServer(t, { config });
  const registered = await client.callTool({ name: 'set_artifacts', arguments: { expected_revision: 0, upsert: [{ kind: 'link', ref: 'https://example.com/pkg', label: '发布包工件', purpose: '发布包契约验证' }] }, _meta: { session_id: 'sess_hook_release' } });
  assert.ok(!registered.isError, 'set_artifacts 失败：' + JSON.stringify(registered.structuredContent) + ' stderr=' + stderr());
  const got = await client.callTool({ name: 'get_artifacts', arguments: {}, _meta: { session_id: 'sess_hook_release' } });
  assert.equal(got.structuredContent.items[0].ref, 'https://example.com/pkg');
});

test('面板 HTML 经正式服务资源入口返回且与源文件字节一致', async t => {
  const dataDir = await mkdtemp(join(staging, 'ui-'));
  const config = join(dataDir, 'config.json');
  await writeFile(config, JSON.stringify({ indexDbPath: join(dataDir, 'missing-index.sqlite'), sessionDbPath: join(dataDir, 'missing-session.sqlite'), gatewayConfigPath: join(dataDir, 'missing-gateway.json') }));
  const mime = 'text/html;profile=mcp-app';
  const { client } = await spawnServer(t, {
    config, clientVersion: '3.16.0',
    capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [mime] } } },
  });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 21, 'UI 能力协商成功后公开面板专用工具');
  const html = await client.readResource({ uri: 'ui://suian-zcode-app-mcp/artifacts.html' });
  const expected = await readFile(join(pluginRoot, 'ui', 'artifacts.html'), 'utf8');
  assert.equal(html.contents[0].text, expected, '面板 HTML 字节一致，不回溯源码目录');
  assert.equal(html.contents[0].mimeType, mime);
});

test('安装器 --check-only 不安装 npm、不修链、不注册额外 MCP/Hook，原配置与停用状态保留', async t => {
  const dataDir = await mkdtemp(join(staging, 'check-'));
  const config = join(dataDir, 'config.json');
  await writeFile(config, JSON.stringify({ indexDbPath: 'D:/keep/index.sqlite', authDataDir: join(dataDir, 'auth') }));
  const registryBefore = await readFile(host.registryPath, 'utf8');
  const configBefore = await readFile(config, 'utf8');
  const skill = await readFile(join(appOut, 'skills/setup/SKILL.md'), 'utf8');
  const documentedEntry = skill.match(/node "([^"]+)"/)[1].replaceAll('{{plugin_root}}',appOut).replaceAll('{{command_dir}}',join(appOut,'dist'));
  const { stdout } = await run(process.execPath, [documentedEntry, '--check-only', '--installed-plugins', host.registryPath, '--config', config],
    { windowsHide: true, env: neutralEnv(), cwd: neutralCwd });
  const result = JSON.parse(stdout);
  assert.equal(result.action, 'checked');
  assert.equal(await readFile(host.registryPath, 'utf8'), registryBefore, '安装记录（含停用状态）不变');
  assert.equal(await readFile(config, 'utf8'), configBefore, '外置配置不变');
  // 没有新的 MCP 注册、Hook 或 npm 痕迹：发布目录与数据目录均无新增 node_modules
  await assert.rejects(stat(join(appOut, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(stat(join(dataDir, 'node_modules')), { code: 'ENOENT' });
});

test('--check-only 在无锚点时明确失败且不安装', async () => {
  const dataDir = join(staging, 'check-noanchor');
  await mkdir(dataDir, { recursive: true });
  await assert.rejects(run(process.execPath, [distInstall, '--check-only'], { windowsHide: true, env: neutralEnv({ ZCODE_PLUGIN_DATA: undefined }), cwd: neutralCwd }), error => {
    assert.equal(error.code,1);assert.match(error.stderr,/anchor_missing/);return true;
  });
});

test('发布包 debug 技能的独立握手脚本只需 Node，并显式传安装记录',async t=>{
  const text=await readFile(join(appOut,'skills/debug/verification.md'),'utf8');
  const script=text.match(/@'\r?\n([\s\S]*?)\r?\n'@/)[1];
  const cwd=await mkdtemp(join(tmpdir(),'pkg-debug-isolated-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const config=join(cwd,'config.json');
  await writeFile(config,JSON.stringify({indexDbPath:join(cwd,'index.sqlite'),sessionDbPath:join(cwd,'sessions.sqlite')}));
  const pending=run(process.execPath,['--input-type=module','-',distCli,config,host.registryPath],{windowsHide:true,cwd,env:neutralEnv({ZCODE_PLUGIN_DATA:undefined})});
  pending.child.stdin.end(script);
  const {stdout}=await pending;
  const result=JSON.parse(stdout);
  assert.ok(result.names.includes('list_sessions'));
  assert.ok(result.toolCount>=19);
});

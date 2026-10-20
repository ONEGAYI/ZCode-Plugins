import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { linkCommon } from '../../suian-zcode-common/link.mjs';

test('分别缓存的两个业务插件通过公共包入口启动，MCP 公布基础十九个工具', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-native-cache-'));
  t.after(() => rm(root, { recursive: true }));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const roots = {};
  for (const name of ['suian-zcode-common', 'suian-zcode-title', 'suian-zcode-app-mcp']) {
    const { version } = JSON.parse(await readFile(join(repo, name, '.zcode-plugin', 'plugin.json'), 'utf8'));
    const dest = join(root, '市场 缓存', name, version);
    await cp(join(repo, name), dest, { recursive: true, filter: path => !['node_modules', 'tests', 'docs', 'experiments', '.local', '.scratch', 'config.local.json'].includes(basename(path)) });
    roots[name] = dest;
    const sourceModules = join(repo, name, 'node_modules');
    if (name === 'suian-zcode-title') continue;
    for (const entry of await readdir(sourceModules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'suian-zcode-common') continue;
      await mkdir(join(dest, 'node_modules'), { recursive: true });
      await symlink(join(sourceModules, entry.name), join(dest, 'node_modules', entry.name), process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  await linkCommon({ commonRoot: roots['suian-zcode-common'], runtimeRoot: join(root, '稳定公共入口'), pluginRoots: [roots['suian-zcode-title'], roots['suian-zcode-app-mcp']] });
  const title = await promisify(execFile)(process.execPath, [join(roots['suian-zcode-title'], 'cli.mjs'), '--help'], { windowsHide: true });
  assert.match(title.stdout, /用法/);
  const mcpData = join(root, '数据', 'mcp');
  const spec = JSON.parse(await readFile(join(roots['suian-zcode-app-mcp'], '.mcp.json'), 'utf8')).mcpServers['suian-zcode-app'];
  const args = spec.args.map(value => value.replaceAll('${ZCODE_PLUGIN_ROOT}', roots['suian-zcode-app-mcp']).replaceAll('${ZCODE_PLUGIN_DATA}', mcpData));
  await promisify(execFile)(process.execPath, [join(roots['suian-zcode-app-mcp'], 'install.mjs'), '--native-plugin', '--config', join(mcpData, 'config.json')], { windowsHide: true });
  const transport = new StdioClientTransport({ command: spec.command, args, stderr: 'pipe' });
  const client = new Client({ name: 'native-cache-contract', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, JSON.parse(await readFile(join(roots['suian-zcode-app-mcp'], '.zcode-plugin', 'plugin.json'), 'utf8')).version);
  // server 按本机真实宿主索引差异化注册：含 projects 表（Desktop 3.16+）时加公布 list_projects
  const listed = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(listed.length, listed.includes('list_projects') ? 20 : 19);
  assert.ok(listed.includes('start_session') && listed.includes('list_sessions'));
  await client.close();
  const hook = JSON.parse(await readFile(join(roots['suian-zcode-title'], 'hooks', 'hooks.json'), 'utf8')).hooks.Stop[0].hooks[0];
  assert.equal(hook.async, true);
  const titleData = join(root, '数据', 'title');
  const command = hook.command.replaceAll('${ZCODE_PLUGIN_ROOT}', roots['suian-zcode-title']).replaceAll('${ZCODE_PLUGIN_DATA}', titleData);
  const stopped = spawnSync(command, { shell: true, windowsHide: true, encoding: 'utf8', input: JSON.stringify({ session_id: 'sess_native_cache_fixture', cwd: root }), env: { ...process.env, OIL_ZCODE_TITLE_DATA: undefined, ZCODE_PLUGIN_DATA: titleData } });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /not_configured/);
  assert.equal(JSON.parse((await readFile(join(titleData, 'state', 'hook.log.jsonl'), 'utf8')).trim()).action, 'not_configured');
});

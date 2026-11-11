import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { validateMarketplaceEntry } from '../../release-marketplace.mjs';
import { connect } from './fixtures.mjs';

test('独立原生入口绑定宿主工作区，元信息使用 session 侧栏和 common 依赖', () => {
  const root = new URL('../', import.meta.url);
  assert.ok(existsSync(new URL('.zcode-plugin/plugin.json', root)), 'SE-01 原生插件元信息尚未提供');
  const plugin = JSON.parse(readFileSync(new URL('.zcode-plugin/plugin.json', root)));
  assert.equal(plugin.name, 'suian-side-editor');
  assert.deepEqual(plugin.dependencies, ['suian-zcode-common']);
  assert.deepEqual(plugin.ui.surfaces, [{ id: 'editor', title: { 'zh-CN': '文本编辑器', en: 'Text editor' }, server: 'suian-side-editor', resourceUri: 'ui://suian-side-editor/editor.html', availability: 'session' }]);
  const mcp = JSON.parse(readFileSync(new URL('.mcp.json', root))).mcpServers['suian-side-editor'];
  assert.equal(mcp.type, 'stdio');
  assert.equal(mcp.cwd, '${ZCODE_PROJECT_DIR}');
  assert.deepEqual(mcp.env, { SUIAN_SIDE_EDITOR_WORKSPACE: '${ZCODE_PROJECT_DIR}' });
  assert.deepEqual(mcp.args, ['${ZCODE_PLUGIN_ROOT}/cli.mjs']);
});

test('原生市场登记唯一编辑器条目，并保持固定 ZIP、公共依赖和版本一致', () => {
  const root = new URL('../', import.meta.url);
  const marketplace = JSON.parse(readFileSync(new URL('../marketplace.json', root)));
  const entries = marketplace.plugins.filter(item => item.name === 'suian-side-editor');
  assert.equal(entries.length, 1, '市场必须登记唯一的 suian-side-editor 条目');
  const plugin = JSON.parse(readFileSync(new URL('.zcode-plugin/plugin.json', root)));
  const pkg = JSON.parse(readFileSync(new URL('package.json', root)));
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root)));
  assert.deepEqual(validateMarketplaceEntry(entries[0]).problems, []);
  assert.equal(new URL(entries[0].source.url).pathname.split('/').at(-1), `${plugin.name}-${plugin.version}.zip`);
  assert.deepEqual(entries[0].dependencies, plugin.dependencies);
  assert.ok(marketplace.plugins.some(item => item.name === 'suian-zcode-common'));
  assert.equal(entries[0].version, plugin.version);
  assert.equal(pkg.version, plugin.version);
  assert.equal(lock.version, plugin.version);
  assert.equal(lock.packages[''].version, plugin.version);
  assert.ok(existsSync(new URL('skills/setup/SKILL.md', root)), '独立缓存需要原生 setup 技能入口');
  assert.ok(existsSync(new URL('ui/dist/editor.html', root)), '市场包必须自带构建的 UI');
  assert.ok(existsSync(new URL('ui/dist/THIRD-PARTY-LICENSES.txt', root)), '市场包必须自带第三方许可');
});

test('MCP 握手自报版本与插件包版本一致', async t => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const client = await connect(t);
  assert.deepEqual(client.getServerVersion(), { name: pkg.name, version: pkg.version });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installSkill } from '../install.mjs';

async function skillFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-mcp-skill-'));
  t.after(() => rm(root, { recursive: true }));
  const pluginRoot = join(root, '中文 plugin');
  const skillFile = join(root, 'skills', 'suian-zcode-app-mcp', 'SKILL.md');
  await mkdir(pluginRoot);
  const template = '---\nname: suian-zcode-app-mcp\ndescription: 初始化会话 MCP\n---\n\n<!-- suian-zcode-app-mcp:plugin-root -->\n其他操作指引。\n';
  await writeFile(join(pluginRoot, 'SKILL.md'), template);
  return { root, pluginRoot, skillFile, template };
}

test('部署技能到指定目录，注入插件绝对路径，保留模板和原文', async (t) => {
  const f = await skillFixture(t);
  const result = await installSkill({ pluginRoot: f.pluginRoot, skillFile: f.skillFile });
  assert.equal(result.action, 'written');
  const installed = await readFile(f.skillFile, 'utf8');
  assert.match(installed, /^---\nname: suian-zcode-app-mcp\n/);
  assert.ok(installed.includes(`**本机插件根**：\`${f.pluginRoot}\``));
  assert.ok(installed.includes('其他操作指引。'));
  assert.ok(!installed.includes('<!-- suian-zcode-app-mcp:plugin-root -->'));
  assert.equal(await readFile(join(f.pluginRoot, 'SKILL.md'), 'utf8'), f.template);
});

test('重复部署相同内容不改写，模板更新后同步技能副本', async (t) => {
  const f = await skillFixture(t);
  await installSkill({ pluginRoot: f.pluginRoot, skillFile: f.skillFile });
  const oldTime = new Date('2020-01-01T00:00:00Z');
  await utimes(f.skillFile, oldTime, oldTime);
  const before = (await stat(f.skillFile)).mtimeMs;
  assert.equal((await installSkill({ pluginRoot: f.pluginRoot, skillFile: f.skillFile })).action, 'unchanged');
  assert.equal((await stat(f.skillFile)).mtimeMs, before);
  await writeFile(join(f.pluginRoot, 'SKILL.md'), f.template + '新增初始化指引。\n');
  assert.equal((await installSkill({ pluginRoot: f.pluginRoot, skillFile: f.skillFile })).action, 'written');
  assert.ok((await readFile(f.skillFile, 'utf8')).includes('新增初始化指引。'));
});

test('模板缺少定位锚点时明确失败，保留已安装副本', async (t) => {
  const f = await skillFixture(t);
  await mkdir(dirname(f.skillFile), { recursive: true });
  await writeFile(f.skillFile, '原技能副本');
  await writeFile(join(f.pluginRoot, 'SKILL.md'), '没有插件定位信息的模板');
  await assert.rejects(installSkill({ pluginRoot: f.pluginRoot, skillFile: f.skillFile }), /缺少插件根锚点/);
  assert.equal(await readFile(f.skillFile, 'utf8'), '原技能副本');
});

test('CLI 自行定位仓库根，允许在隔离技能目录安装', async (t) => {
  const f = await skillFixture(t);
  const cli = fileURLToPath(new URL('../install.mjs', import.meta.url));
  const skillsDir = join(f.root, 'CLI skills');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, '--skills-dir', skillsDir], { windowsHide: true });
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).ok, true);
  const installed = await readFile(join(skillsDir, 'suian-zcode-app-mcp', 'SKILL.md'), 'utf8');
  assert.ok(installed.includes(`**本机插件根**：\`${dirname(cli)}\``));
});

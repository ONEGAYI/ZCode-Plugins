import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));

export async function installSkill({ pluginRoot = root, skillFile = join(homedir(), '.zcode', 'skills', 'suian-zcode-app-mcp', 'SKILL.md') } = {}) {
  pluginRoot = resolve(pluginRoot);
  const template = await readFile(join(pluginRoot, 'SKILL.md'), 'utf8');
  const marker = '<!-- suian-zcode-app-mcp:plugin-root -->';
  if (!template.includes(marker)) throw new Error('技能模板缺少插件根锚点');
  const deployed = template.replace(marker, `**本机插件根**：\`${pluginRoot}\``);
  let existing;
  try { existing = await readFile(skillFile, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing === deployed) return { ok: true, action: 'unchanged', skill_file: skillFile };
  await mkdir(dirname(skillFile), { recursive: true });
  await writeFile(skillFile, deployed);
  return { ok: true, action: 'written', skill_file: skillFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { 'skills-dir': { type: 'string', default: join(homedir(), '.zcode', 'skills') } } });
  console.log(JSON.stringify(await installSkill({ skillFile: join(resolve(values['skills-dir']), 'suian-zcode-app-mcp', 'SKILL.md') })));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, appendFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('健康接口固定启动时的代码指纹，磁盘代码变化可识别，文档变化不影响指纹', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-build-'));
  t.after(() => rm(root, { recursive: true }));
  const source = fileURLToPath(new URL('..', import.meta.url));
  await cp(source, root, { recursive: true, filter: path => !['tests', 'docs', '.scratch'].includes(path.slice(source.length + 1).split(/[\\/]/)[0]) });
  const { startGateway } = await import(pathToFileURL(join(root, 'gateway.mjs')));
  const gateway = await startGateway({ mode: 'local-only' });
  t.after(() => gateway.close());
  const healthUrl = gateway.url.replace('ws:', 'http:').replace('/ws', '/health');
  const initial = await (await fetch(healthUrl)).json();
  assert.match(initial.build?.id ?? '', /^[a-f0-9]{64}$/, '健康接口应提供实际加载代码的指纹');
  assert.equal(initial.build.root, root);
  assert.equal(initial.build.version, JSON.parse(await readFile(join(root, '.zcode-plugin/plugin.json'), 'utf8')).version);
  const diskBuild = async () => JSON.parse((await exec(process.execPath, [join(root, 'gateway-build.mjs')])).stdout);
  assert.deepEqual(await diskBuild(), initial.build);
  await appendFile(join(root, 'README.md'), '\n文档修改\n');
  assert.deepEqual(await diskBuild(), initial.build);
  for (const file of ['rpc-broker.mjs', 'rpc-diagnostics.mjs', 'vendor/channels.shared.js', 'node_modules/ws/lib/receiver.js']) {
    const previous = await diskBuild();
    await appendFile(join(root, file), '\n// fixture runtime change\n');
    assert.notEqual((await diskBuild()).id, previous.id, file + ' 应纳入指纹');
    assert.deepEqual((await (await fetch(healthUrl)).json()).build, initial.build, '运行中健康状态不能冒报磁盘上的新代码');
  }
  const alias = join(root, '公共入口');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedBuild = await exec(process.execPath, [join(alias, 'gateway-build.mjs')]);
  assert.ok(linkedBuild.stdout.trim(), '经公共 junction 执行也必须输出指纹');
  assert.deepEqual(JSON.parse(linkedBuild.stdout), await diskBuild());
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../doctor.mjs';
import { buildHookCommand } from '../install.mjs';

test('doctor 读取已安装 Stop Hook，配置就绪不表示已经真实触发', async t => {
  const root = await mkdtemp(join(tmpdir(), 'z-title-doctor-'));
  t.after(() => rm(root, { recursive: true }));
  const configFile = join(root, 'user-config.json'), pluginRoot = 'D:\\plugin';
  const command = buildHookCommand({ pluginRoot });
  const backend = {
    read: async () => ({ title: '测试标题', turnCount: 5, context: { recent_turns: [1, 2, 3] } }),
    models: async () => ({ providers: [{ providerId: 'fixture' }] })
  };
  const options = { backend, event: { session_id: 'sess_fixture' }, config: {}, pluginRoot, configFile };
  const write = value => writeFile(configFile, JSON.stringify(value));
  await write({ hooks: { enabled: true, events: { Stop: [{ hooks: [{ type: 'command', command, async: true }] }] } } });
  const before = await readFile(configFile, 'utf8');
  const ready = await runDoctor(options);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.hook, 'configured');
  assert.equal(ready.hookDetails.enabled, true);
  assert.equal(ready.hookDetails.async, true);
  assert.equal(ready.hookDetails.execution, 'not_verified');
  assert.equal(ready.hookDetails.configFile, configFile);
  assert.equal(ready.selectedTurns, 3);
  assert.equal(await readFile(configFile, 'utf8'), before);

  for (const globalDisabled of [true, false]) {
    await write({ hooks: { enabled: !globalDisabled, events: { Stop: [{ hooks: [{ type: 'command', command, async: true, enabled: globalDisabled }] }] } } });
    const disabled = await runDoctor(options);
    assert.equal(disabled.status, 'not_ready');
    assert.equal(disabled.hook, 'disabled');
  }
  await write({ hooks: { events: { Stop: [{ hooks: [{ type: 'command', command, async: true }] }] } } });
  assert.equal((await runDoctor(options)).status, 'ready', 'enabled 省略时遵循官方默认启用');
  assert.equal((await runDoctor({ ...options, config: { enabled: false } })).status, 'not_ready');

  await write({ hooks: { events: { Stop: [{ hooks: [{ type: 'command', command, async: false }] }] } } });
  const foreground = await runDoctor(options);
  assert.equal(foreground.hook, 'configured');
  assert.equal(foreground.hookDetails.async, false);
  assert.equal(foreground.status, 'not_ready');

  await write({ hooks: { events: { Stop: [{ hooks: [{ type: 'command', command: 'node other-plugin/hook.mjs', async: true }] }] } } });
  assert.equal((await runDoctor(options)).hook, 'not_configured');
  await rm(configFile);
  const missing = await runDoctor(options);
  assert.equal(missing.hook, 'not_configured');
  assert.equal(missing.status, 'not_ready');
  await writeFile(configFile, '{invalid');
  await assert.rejects(runDoctor(options), SyntaxError);
});

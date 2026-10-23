import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PATCH_PROFILES, selectProfile } from '../local-only/profiles.mjs';

test('3.16.3 正式包独立路由且保留旧包', async () => {
  const actual = { exeFileVersion: '3.16.3.8992', appAsarSha256: '21183dbf3bee0a786d6cc3b648dda96f7d443c9674092538b2a6ffb72002822e' };
  const route = selectProfile({ actual, platform: 'win32' });
  assert.equal(route.ok, true, route.reason);
  assert.equal(route.profile.patchVersion, 1);
  assert.ok(PATCH_PROFILES.some(p => p.packageIdentity.exeFileVersion === '3.16.2.8769'));
  const profile = await import('../local-only/profiles/windows-3.16.3.8992.mjs');
  const gate = { process: { env: { ZCODE_LOCAL_ONLY: '1', ZCODE_LOCAL_ONLY_WORKSPACE: 'D:/fixture' } }, URL, cA: 'wss://example.com/ws' };
  vm.runInNewContext(profile.renderP1GateCode(), gate);
  assert.equal(gate.cA, 'ws://127.0.0.1:17331/ws');
  let started = 0;
  const context = { __LO_MODE: true, __LO_WS: 'D:/fixture', __loApp: { isReady: () => true }, Oe: () => [{ id: 7 }], pi: { getStatus: () => ({ status: 'idle' }), start: (id, args) => { assert.equal(id, 7); assert.equal(args.workspacePath, 'D:/fixture'); started++; } }, setTimeout: fn => fn() };
  vm.runInNewContext(profile.renderP6AutoStartCode().body, context);
  assert.equal(started, 1);
  context.__LO_MODE = false;
  vm.runInNewContext(profile.renderP6AutoStartCode().body, context);
  assert.equal(started, 1);
});

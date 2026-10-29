import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATCH_PROFILES, selectProfile } from '../local-only/profiles.mjs';

// 3.17.1.9553 原版产物真实锚点切片（2026-10-29 本机安装提取，脱敏：仅编译产物代码）。
// 每条与档案 INJECTIONS.find 精确一致；合成后用于 applyInjections 全链断言与 node --check。
const ANCHOR_P1 = 'Sx=process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim(),Cx=process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim();';
const ANCHOR_P2 = 'getLogin:s(async()=>{let e=await e3(),t=await t3(e);return t?{userId:e,jwt:t.slice(7)}:void 0},"getLogin")';
const ANCHOR_P3 = 'resolveDeviceSid:s(async(he,Rt)=>(He=await Fl(Rt,he),t.get(h)===me&&(me.deviceSid=He,me.qrUrl=me.connectUrl=""),He),"resolveDeviceSid")';
const ANCHOR_P4 = 'getToken:s(async he=>{let Rt=await Gn(),Xo=await m(Gn,Rt,()=>Ul.token(Rt.jwt,AbortSignal.any([Q,he])));return await Gn(),e.logger.info("[web-remote-control] V2 device token acquired"),Xo},"getToken")';
const ANCHOR_P5 = 'async notifyAuthStateChanged(h,b){let x=++D;if(b.state==="signed-in"){';
const ANCHOR_P6 = 'disposeWorkspaceHostAttachmentsForRemoteSession:s(e=>Ci.disposeRemoteSession(e),"disposeWorkspaceHostAttachmentsForRemoteSession")});rg.current=Bt;';

function buildSyntheticIndex() {
  return [
    'import{b as Tw}from"./chunk-FIXTURE.js";',
    'var s=(f)=>f;',
    'let Cx0=0;',
    ANCHOR_P1,
    'var wrap={' + ANCHOR_P4 + ',' + ANCHOR_P3 + ',' + ANCHOR_P2 + '};',
    'class Mgr{' + ANCHOR_P5 + '0;return}}}',
    'var Bt=mk({foo:1,' + ANCHOR_P6,
    'Bt.startNotifications();',
  ].join('\n') + '\n';
}

test('3.17.1 正式包独立路由且保留旧包', async () => {
  const actual = { exeFileVersion: '3.17.1.9553', appAsarSha256: '9a09f6ef7a938072c57f56d3dbf4b5677eaceb1c5b00ae555fb7e2bfdea88255' };
  const route = selectProfile({ actual, platform: 'win32' });
  assert.equal(route.ok, true, route.reason);
  assert.equal(route.profile.id, 'windows-3.17.1.9553-9a09f6ef');
  assert.equal(route.profile.patchVersion, 1);
  assert.equal(route.profile.mainEntry, 'out/main/index.js');
  assert.ok(PATCH_PROFILES.some(p => p.packageIdentity.exeFileVersion === '3.16.2.8769'));
  assert.ok(PATCH_PROFILES.some(p => p.packageIdentity.exeFileVersion === '3.16.3.8992'));
  // 摘要不符的同版本包必须拒绝（digest_mismatch），不落到其他档案
  const wrong = selectProfile({ actual: { ...actual, appAsarSha256: '0'.repeat(64) }, platform: 'win32' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'digest_mismatch');

  const profile = await import('../local-only/profiles/windows-3.17.1.9553.mjs');
  assert.equal(profile.SUPPORTED_PACKAGE.exeFileVersion, '3.17.1.9553');
  assert.equal(profile.SUPPORTED_PACKAGE.appAsarSha256.toLowerCase(), actual.appAsarSha256);
  assert.equal(profile.SUPPORTED_PACKAGE.appAsarBytes, 374627566);
  assert.equal(profile.PATCH_VERSION, 1);

  // P1：开关开启时 Sx（relay WS 覆盖变量）被改写为回环网关 WS
  const gate = { process: { env: { ZCODE_LOCAL_ONLY: '1', ZCODE_LOCAL_ONLY_WORKSPACE: 'D:/fixture' } }, URL, Sx: 'wss://example.com/ws' };
  vm.runInNewContext(profile.renderP1GateCode(), gate);
  assert.equal(gate.Sx, 'ws://127.0.0.1:17331/ws');
  // 开关关闭：保留原覆盖值
  const gateOff = { process: { env: { ZCODE_LOCAL_ONLY: '0' } }, URL, Sx: 'wss://example.com/ws' };
  vm.runInNewContext(profile.renderP1GateCode(), gateOff);
  assert.equal(gateOff.Sx, 'wss://example.com/ws');

  // P6：开关开启且解析到工作区时经 Ne()（排除 CUA 指示窗）取窗口并 Bt.start；关闭不启动
  let started = 0;
  const context = { __LO_MODE: true, __LO_WS: 'D:/fixture', __loApp: { isReady: () => true }, Ne: () => [{ id: 7 }], Bt: { getStatus: () => ({ status: 'idle' }), start: (id, args) => { assert.equal(id, 7); assert.equal(args.workspacePath, 'D:/fixture'); started++; } }, setTimeout: fn => fn() };
  vm.runInNewContext(profile.renderP6AutoStartCode().body, context);
  assert.equal(started, 1);
  // getStatus 非 idle 时幂等不叠加
  const busy = { __LO_MODE: true, __LO_WS: 'D:/fixture', __loApp: { isReady: () => true }, Ne: () => [{ id: 7 }], Bt: { getStatus: () => ({ status: 'running' }), start: () => { started++; } }, setTimeout: fn => fn() };
  vm.runInNewContext(profile.renderP6AutoStartCode().body, busy);
  assert.equal(started, 1);
  context.__LO_MODE = false;
  vm.runInNewContext(profile.renderP6AutoStartCode().body, context);
  assert.equal(started, 1);
});

test('3.17.1 档案对真实锚点切片全链注入且产物语法合法', async () => {
  const profile = await import('../local-only/profiles/windows-3.17.1.9553.mjs');
  const source = buildSyntheticIndex();
  const { content, applied } = profile.applyInjections(source);
  assert.equal(applied.length, 7);
  assert.deepEqual(applied.map(a => a.id), [
    'P0-fs-import', 'P1-mode-gate', 'P2-login-short-circuit', 'P3-device-sid-short-circuit',
    'P4-token-short-circuit', 'P5-signed-out-isolation', 'P6-auto-start',
  ]);
  // 短路语义落位：P2/P3/P4 守卫在回调体首、P5 守卫在方法体首、P6 引用 Bt/Ne
  assert.ok(content.includes('getLogin:s(async()=>{if(__LO_MODE)return{userId:"local-only-device",jwt:"local-only"};'));
  assert.ok(content.includes('resolveDeviceSid:s(async(he,Rt)=>__LO_MODE?"local-only-device":'));
  assert.ok(content.includes('getToken:s(async he=>{if(__LO_MODE)return __LO_TOKEN();'));
  assert.ok(content.includes('async notifyAuthStateChanged(h,b){if(__LO_MODE&&b&&b.state!=="signed-in")return;'));
  assert.ok(content.includes('typeof Ne==="function"?Ne():'));
  assert.ok(content.includes('Bt.getStatus('));
  // 重复注入必须拒绝
  assert.throws(() => profile.applyInjections(content), /__LO_MODE/);
  // node --check 语法验证（真实 prepare 同款检查）
  const dir = mkdtempSync(join(tmpdir(), 'lo-3171-'));
  try {
    const f = join(dir, 'index.check.mjs');
    writeFileSync(f, content);
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

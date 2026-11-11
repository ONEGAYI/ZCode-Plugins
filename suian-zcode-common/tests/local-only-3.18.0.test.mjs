import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATCH_PROFILES, selectProfile } from '../local-only/profiles.mjs';

// 3.18.0.10300 原版产物真实锚点切片（2026-11-11 本机安装提取，脱敏：仅编译产物代码）。
// 每条与档案 INJECTIONS.find 精确一致；合成后用于 applyInjections 全链断言与 node --check。
const ANCHOR_P1 = 'I_=process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim(),E_=process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim();';
const ANCHOR_P2 = 'getLogin:s(async()=>{let e=await i4(),t=await a4(e);return t?{userId:e,jwt:t.slice(7)}:void 0},"getLogin")';
const ANCHOR_P3 = 'resolveDeviceSid:s(async(ve,At)=>(je=await id(At,ve),t.get(h)===ye&&(ye.deviceSid=je,ye.qrUrl=ye.connectUrl=""),je),"resolveDeviceSid")';
const ANCHOR_P4 = 'getToken:s(async ve=>{let At=await Kn(),Qo=await m(Kn,At,()=>sd.token(At.jwt,AbortSignal.any([de,ve])));return await Kn(),e.logger.info("[web-remote-control] V2 device token acquired"),Qo},"getToken")';
const ANCHOR_P5 = 'async notifyAuthStateChanged(h,y){let D=++_;if(y.state==="signed-in"){';
const ANCHOR_P6 = 'disposeWorkspaceHostAttachmentsForRemoteSession:s(e=>Ti.disposeRemoteSession(e),"disposeWorkspaceHostAttachmentsForRemoteSession")});xg.current=Gt;';

function buildSyntheticIndex() {
  return [
    'import{b as Tw}from"./chunk-FIXTURE.js";',
    'var s=(f)=>f;',
    'let E_0=0;',
    ANCHOR_P1,
    'var wrap={' + ANCHOR_P4 + ',' + ANCHOR_P3 + ',' + ANCHOR_P2 + '};',
    'class Mgr{' + ANCHOR_P5 + '0;return}}}',
    'var Gt=mk({foo:1,' + ANCHOR_P6,
    'Gt.startNotifications();',
  ].join('\n') + '\n';
}

test('3.18.0 正式包独立路由且保留旧包', async () => {
  const actual = { exeFileVersion: '3.18.0.10300', appAsarSha256: 'dea4826e24415540f196a5f89c5d5a9a12754604b07601d3a9bd377203bd3f72' };
  const route = selectProfile({ actual, platform: 'win32' });
  assert.equal(route.ok, true, route.reason);
  assert.equal(route.profile.id, 'windows-3.18.0.10300-dea4826e');
  assert.equal(route.profile.patchVersion, 1);
  assert.equal(route.profile.mainEntry, 'out/main/index.js');
  for (const version of ['3.16.2.8769', '3.16.3.8992', '3.17.1.9553', '3.17.2.9661']) {
    assert.ok(PATCH_PROFILES.some(p => p.packageIdentity.exeFileVersion === version), version);
  }
  // 摘要不符的同版本包必须拒绝（digest_mismatch），不落到其他档案
  const wrong = selectProfile({ actual: { ...actual, appAsarSha256: '0'.repeat(64) }, platform: 'win32' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'digest_mismatch');

  const profile = await import('../local-only/profiles/windows-3.18.0.10300.mjs');
  assert.equal(profile.SUPPORTED_PACKAGE.exeFileVersion, '3.18.0.10300');
  assert.equal(profile.SUPPORTED_PACKAGE.appAsarSha256.toLowerCase(), actual.appAsarSha256);
  assert.equal(profile.SUPPORTED_PACKAGE.appAsarBytes, 384813639);
  assert.equal(profile.PATCH_VERSION, 1);

  // 旧包档案字节保持不变：3.17.2 档案仍按其身份独立命中，且 P1 改写变量仍为 kx
  const old = await import('../local-only/profiles/windows-3.17.2.9661.mjs');
  assert.equal(old.PATCH_VERSION, 1);
  assert.ok(old.renderP1GateCode().includes('kx='));

  // P1：开关开启时 I_（relay WS 覆盖变量）被改写为回环网关 WS
  const gate = { process: { env: { ZCODE_LOCAL_ONLY: '1', ZCODE_LOCAL_ONLY_WORKSPACE: 'D:/fixture' } }, URL, I_: 'wss://example.com/ws' };
  vm.runInNewContext(profile.renderP1GateCode(), gate);
  assert.equal(gate.I_, 'ws://127.0.0.1:17331/ws');
  // 开关关闭：保留原覆盖值
  const gateOff = { process: { env: { ZCODE_LOCAL_ONLY: '0' } }, URL, I_: 'wss://example.com/ws' };
  vm.runInNewContext(profile.renderP1GateCode(), gateOff);
  assert.equal(gateOff.I_, 'wss://example.com/ws');
  // 已存在回环覆盖时优先沿用
  const gateLoopback = { process: { env: { ZCODE_LOCAL_ONLY: '1' } }, URL, I_: 'wss://127.0.0.1:19000/custom' };
  vm.runInNewContext(profile.renderP1GateCode(), gateLoopback);
  assert.equal(gateLoopback.I_, 'wss://127.0.0.1:19000/custom');

  // P6：开关开启且解析到工作区时经 Ge()（排除 CUA 指示窗）取窗口并 Gt.start；关闭不启动
  let started = 0;
  const context = { __LO_MODE: true, __LO_WS: 'D:/fixture', __loApp: { isReady: () => true }, Ge: () => [{ id: 7 }], Gt: { getStatus: () => ({ status: 'idle' }), start: (id, args) => { assert.equal(id, 7); assert.equal(args.workspacePath, 'D:/fixture'); started++; } }, setTimeout: fn => fn() };
  vm.runInNewContext(profile.renderP6AutoStartCode().body, context);
  assert.equal(started, 1);
  // getStatus 非 idle 时幂等不叠加
  const busy = { __LO_MODE: true, __LO_WS: 'D:/fixture', __loApp: { isReady: () => true }, Ge: () => [{ id: 7 }], Gt: { getStatus: () => ({ status: 'running' }), start: () => { started++; } }, setTimeout: fn => fn() };
  vm.runInNewContext(profile.renderP6AutoStartCode().body, busy);
  assert.equal(started, 1);
  context.__LO_MODE = false;
  vm.runInNewContext(profile.renderP6AutoStartCode().body, context);
  assert.equal(started, 1);
});

test('3.18.0 档案对真实锚点切片全链注入且产物语法合法', async () => {
  const profile = await import('../local-only/profiles/windows-3.18.0.10300.mjs');
  const source = buildSyntheticIndex();
  const { content, applied } = profile.applyInjections(source);
  assert.equal(applied.length, 7);
  assert.deepEqual(applied.map(a => a.id), [
    'P0-fs-import', 'P1-mode-gate', 'P2-login-short-circuit', 'P3-device-sid-short-circuit',
    'P4-token-short-circuit', 'P5-signed-out-isolation', 'P6-auto-start',
  ]);
  // 短路语义落位：P2/P3/P4 守卫在回调体首、P5 守卫在方法体首、P6 引用 Gt/Ge
  assert.ok(content.includes('getLogin:s(async()=>{if(__LO_MODE)return{userId:"local-only-device",jwt:"local-only"};'));
  assert.ok(content.includes('resolveDeviceSid:s(async(ve,At)=>__LO_MODE?"local-only-device":'));
  assert.ok(content.includes('getToken:s(async ve=>{if(__LO_MODE)return __LO_TOKEN();'));
  assert.ok(content.includes('async notifyAuthStateChanged(h,y){if(__LO_MODE&&y&&y.state!=="signed-in")return;'));
  assert.ok(content.includes('typeof Ge==="function"?Ge():'));
  assert.ok(content.includes('Gt.getStatus('));
  assert.ok(content.includes('xg.current=Gt;'));
  // 注入不得改写原包其他标识符：P3/P4 会话映射与注册函数名原样保留
  assert.ok(content.includes('ye.deviceSid=je'));
  assert.ok(content.includes('await id(At,ve)'));
  assert.ok(content.includes('m(Kn,At,()=>sd.token('));
  // 重复注入必须拒绝
  assert.throws(() => profile.applyInjections(content), /__LO_MODE/);
  // node --check 语法验证（真实 prepare 同款检查）
  const dir = mkdtempSync(join(tmpdir(), 'lo-3180-'));
  try {
    const f = join(dir, 'index.check.mjs');
    writeFileSync(f, content);
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { PATCH_PROFILES, selectProfile } from '../local-only/profiles.mjs';

const identity = { exeFileVersion: '3.18.1.10376', appAsarSha256: '1af9cdd891f6ba3436bf289b387314819cefdf09aa49ec736694c24e8000eae4' };
const select = (actual = identity) => selectProfile({ actual, platform: 'win32' });

// 3.18.1.10376 原版编译产物切片；不包含运行数据。
const env = 'M_=process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim(),O_=process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim();';
const login = 'getLogin:s(async()=>{let e=await w4(),t=await y4(e);return t?{userId:e,jwt:t.slice(7)}:void 0},"getLogin")';
const sid = 'resolveDeviceSid:s(async(ve,At)=>(je=await cd(At,ve),t.get(h)===ye&&(ye.deviceSid=je,ye.qrUrl=ye.connectUrl=""),je),"resolveDeviceSid")';
const token = 'getToken:s(async ve=>{let At=await jn(),Qo=await m(jn,At,()=>ad.token(At.jwt,AbortSignal.any([de,ve])));return await jn(),e.logger.info("[web-remote-control] V2 device token acquired"),Qo},"getToken")';
const auth = 'async notifyAuthStateChanged(h,y){let D=++_;if(y.state==="signed-in"){';
const manager = 'disposeWorkspaceHostAttachmentsForRemoteSession:s(e=>xi.disposeRemoteSession(e),"disposeWorkspaceHostAttachmentsForRemoteSession")});Mg.current=Gt;';
const source = [
  'var vg=getVersion(),' + env + 'function oD(){}',
  'var options={' + login + ',' + sid + ',' + token + '};',
  'class Mgr{' + auth + 'return}}}',
  'var Gt=mk({' + manager + 'Gt.startNotifications();',
].join('\n');

test('3.18.1 按完整原包身份独立路由，保留五份旧档案', () => {
  const route = select();
  assert.equal(route.ok, true, route.reason);
  assert.equal(route.profile.id, 'windows-3.18.1.10376-1af9cdd8');
  assert.equal(route.profile.mainEntry, 'out/main/index.js');
  assert.equal(route.profile.patchVersion, 1);
  assert.equal(route.profile.packageIdentity.appAsarBytes, 384827497);
  assert.equal(select({ ...identity, appAsarSha256: '0'.repeat(64) }).code, 'digest_mismatch');
  assert.deepEqual(PATCH_PROFILES.slice(0, 5).map(p => p.id), [
    'windows-3.16.2.8769-1f960ba2', 'windows-3.16.3.8992-21183dbf', 'windows-3.17.1.9553-9a09f6ef',
    'windows-3.17.2.9661-b11a6bc5', 'windows-3.18.0.10300-dea4826e',
  ]);
  assert.equal(select({ exeFileVersion: '3.18.0.10300',
    appAsarSha256: 'dea4826e24415540f196a5f89c5d5a9a12754604b07601d3a9bd377203bd3f72' }).profile.id, 'windows-3.18.0.10300-dea4826e');
});

test('3.18.1 真实锚点切片可唯一注入，短路位置与主入口语法正确', () => {
  const { applyInjections } = select().profile;
  const { content, applied } = applyInjections(source);
  assert.deepEqual(applied.map(item => item.id), ['P0-fs-import', 'P1-mode-gate', 'P2-login-short-circuit',
    'P3-device-sid-short-circuit', 'P4-token-short-circuit', 'P5-signed-out-isolation', 'P6-auto-start']);
  assert.match(content, /getLogin:s\(async\(\)=>\{if\(__LO_MODE\)return\{userId:"local-only-device",jwt:"local-only"\};let e=await w4\(\)/);
  assert.ok(content.includes('resolveDeviceSid:s(async(ve,At)=>__LO_MODE?"local-only-device":(je=await cd(At,ve)'));
  assert.ok(content.includes('getToken:s(async ve=>{if(__LO_MODE)return __LO_TOKEN();let At=await jn()'));
  assert.ok(content.includes('async notifyAuthStateChanged(h,y){if(__LO_MODE&&y&&y.state!=="signed-in")return;let D=++_'));
  assert.ok(content.includes('Mg.current=Gt;import'));
  assert.throws(() => applyInjections(content), /__LO_MODE/);
  assert.throws(() => applyInjections(source.replace(env, '')), /P1-mode-gate 未命中/);
  assert.throws(() => applyInjections(source + env), /P1-mode-gate 命中多次/);
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: content, stdio: ['pipe', 'pipe', 'pipe'] });
});

test('3.18.1 P1 保留关模式与回环门禁，P6 只为闲置应用窗口启动', async () => {
  const { renderP1GateCode, renderP6AutoStartCode } = await import('../local-only/profiles/windows-3.18.1.10376.mjs');
  const gate = (mode, current, gateway) => {
    const context = { process: { env: { ZCODE_LOCAL_ONLY: mode, ZCODE_LOCAL_ONLY_GATEWAY: gateway } }, URL, M_: current };
    vm.runInNewContext(renderP1GateCode(), context);
    return context.M_;
  };
  assert.equal(gate('0', 'wss://example.com/official'), 'wss://example.com/official');
  assert.equal(gate('1', 'wss://127.0.0.1@outside.example/ws', 'https://outside.example'), 'ws://127.0.0.1:17331/ws');
  assert.equal(gate('1', 'wss://example.com/official', 'http://127.0.0.1:19000/path'), 'ws://127.0.0.1:19000/ws');
  assert.equal(gate('1', 'wss://[::1]:19000/custom'), 'wss://[::1]:19000/custom');
  const starts = [];
  let status = 'idle';
  const context = { __LO_MODE: true, __LO_WS: 'D:/fixture', __loApp: { isReady: () => true }, Ge: () => [{ id: 7 }],
    Gt: { getStatus: () => ({ status }), start: (id, { workspacePath }) => starts.push([id, workspacePath]) }, setTimeout: fn => fn() };
  vm.runInNewContext(renderP6AutoStartCode().body, context);
  status = 'running';
  vm.runInNewContext(renderP6AutoStartCode().body, context);
  context.__LO_MODE = false;
  status = 'idle';
  vm.runInNewContext(renderP6AutoStartCode().body, context);
  assert.deepEqual(starts, [[7, 'D:/fixture']]);
});

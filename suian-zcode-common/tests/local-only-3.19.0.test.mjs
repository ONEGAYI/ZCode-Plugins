import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { PATCH_PROFILES, selectProfile } from '../local-only/profiles.mjs';

const identity = { exeFileVersion: '3.19.0.10774', appAsarSha256: '2421850970f361aaa1b3f1d6c960b101a5d476ad95631359d0413a19de1197cb' };
const select = (actual = identity) => selectProfile({ actual, platform: 'win32' });

// 3.19.0.10774 原版编译产物切片；不包含运行数据。
const env = 'pM=process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim(),mM=process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim();';
const login = 'getLogin:i(async()=>{let e=await x5(),t=await _5(e);return t?{userId:e,jwt:t.slice(7)}:void 0},"getLogin")';
const sid = 'resolveDeviceSid:i(async(Se,xt)=>(Ze=await wd(xt,Se),t.get(h)===be&&(be.deviceSid=Ze,be.qrUrl=be.connectUrl=""),Ze),"resolveDeviceSid")';
const token = 'getToken:i(async Se=>{let xt=await Zo(),ni=await m(Zo,xt,()=>hd.token(xt.jwt,AbortSignal.any([de,Se])));return await Zo(),e.logger.info("[web-remote-control] V2 device token acquired"),ni},"getToken")';
const auth = 'async notifyAuthStateChanged(h,b){let M=++T;if(b.state==="signed-in"){';
const manager = 'disposeWorkspaceHostAttachmentsForRemoteSession:i(e=>Ns.disposeRemoteSession(e),"disposeWorkspaceHostAttachmentsForRemoteSession")});zg.current=zt;';
const source = [
  'var vg=getVersion(),' + env + 'function cD(){}',
  'var options={' + login + ',' + sid + ',' + token + '};',
  'class Mgr{' + auth + 'return}}}',
  'var zt=mk({' + manager + 'zt.startNotifications();',
].join('\n');

test('3.19.0 按完整原包身份独立路由，保留七份旧档案', () => {
  const route = select();
  assert.equal(route.ok, true, route.reason);
  assert.equal(route.profile.id, 'windows-3.19.0.10774-24218509');
  assert.equal(route.profile.mainEntry, 'out/main/index.js');
  assert.equal(route.profile.patchVersion, 1);
  assert.equal(route.profile.packageIdentity.appAsarBytes, 385171742);
  assert.equal(select({ ...identity, appAsarSha256: '0'.repeat(64) }).code, 'digest_mismatch');
  assert.deepEqual(PATCH_PROFILES.slice(0, 7).map(p => p.id), [
    'windows-3.16.2.8769-1f960ba2', 'windows-3.16.3.8992-21183dbf', 'windows-3.17.1.9553-9a09f6ef',
    'windows-3.17.2.9661-b11a6bc5', 'windows-3.18.0.10300-dea4826e', 'windows-3.18.1.10376-1af9cdd8',
    'windows-3.18.2.10443-4c0b8510',
  ]);
  assert.equal(select({ exeFileVersion: '3.18.2.10443',
    appAsarSha256: '4c0b8510a1ff7f1142714a1dc37139058254b784ad72b70ba781f09334b0c131' }).profile.id, 'windows-3.18.2.10443-4c0b8510');
});

test('3.19.0 真实锚点切片可唯一注入，短路位置与主入口语法正确', () => {
  const { applyInjections } = select().profile;
  const { content, applied } = applyInjections(source);
  assert.deepEqual(applied.map(item => item.id), ['P0-fs-import', 'P1-mode-gate', 'P2-login-short-circuit',
    'P3-device-sid-short-circuit', 'P4-token-short-circuit', 'P5-signed-out-isolation', 'P6-auto-start']);
  assert.match(content, /getLogin:i\(async\(\)=>\{if\(__LO_MODE\)return\{userId:"local-only-device",jwt:"local-only"\};let e=await x5\(\)/);
  assert.ok(content.includes('resolveDeviceSid:i(async(Se,xt)=>__LO_MODE?"local-only-device":(Ze=await wd(xt,Se)'));
  assert.ok(content.includes('getToken:i(async Se=>{if(__LO_MODE)return __LO_TOKEN();let xt=await Zo()'));
  assert.ok(content.includes('async notifyAuthStateChanged(h,b){if(__LO_MODE&&b&&b.state!=="signed-in")return;let M=++T'));
  assert.ok(content.includes('zg.current=zt;import'));
  assert.throws(() => applyInjections(content), /__LO_MODE/);
  assert.throws(() => applyInjections(source.replace(env, '')), /P1-mode-gate 未命中/);
  assert.throws(() => applyInjections(source + env), /P1-mode-gate 命中多次/);
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: content, stdio: ['pipe', 'pipe', 'pipe'] });
});

test('3.19.0 P1 保留关模式与回环门禁，P6 只为闲置应用窗口启动', async () => {
  const { renderP1GateCode, renderP6AutoStartCode } = await import('../local-only/profiles/windows-3.19.0.10774.mjs');
  const gate = (mode, current, gateway) => {
    const context = { process: { env: { ZCODE_LOCAL_ONLY: mode, ZCODE_LOCAL_ONLY_GATEWAY: gateway } }, URL, pM: current };
    vm.runInNewContext(renderP1GateCode(), context);
    return context.pM;
  };
  assert.equal(gate('0', 'wss://example.com/official'), 'wss://example.com/official');
  assert.equal(gate('1', 'wss://127.0.0.1@outside.example/ws', 'https://outside.example'), 'ws://127.0.0.1:17331/ws');
  assert.equal(gate('1', 'wss://example.com/official', 'http://127.0.0.1:19000/path'), 'ws://127.0.0.1:19000/ws');
  assert.equal(gate('1', 'wss://[::1]:19000/custom'), 'wss://[::1]:19000/custom');
  const starts = [];
  let status = 'idle';
  const context = { __LO_MODE: true, __LO_WS: 'D:/fixture', __loApp: { isReady: () => true }, Ke: () => [{ id: 7 }],
    zt: { getStatus: () => ({ status }), start: (id, { workspacePath }) => starts.push([id, workspacePath]) }, setTimeout: fn => fn() };
  vm.runInNewContext(renderP6AutoStartCode().body, context);
  status = 'running';
  vm.runInNewContext(renderP6AutoStartCode().body, context);
  context.__LO_MODE = false;
  status = 'idle';
  vm.runInNewContext(renderP6AutoStartCode().body, context);
  assert.deepEqual(starts, [[7, 'D:/fixture']]);
});

test('3.19.0 本地占位 token 保留 Base64URL 字符表和 22 字符形状', async () => {
  const { renderP1GateCode } = await import('../local-only/profiles/windows-3.19.0.10774.mjs');
  const context = { process: { env: { ZCODE_LOCAL_ONLY: '1' } }, URL, pM: '',
    Math: { floor: Math.floor, random: () => 0.99999 } };
  vm.runInNewContext(renderP1GateCode(), context);
  assert.equal(context.__LO_TOKEN(), '_'.repeat(21) + 'A');
});

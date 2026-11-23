import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { PATCH_PROFILES, selectProfile } from '../local-only/profiles.mjs';

const identity = { exeFileVersion: '4.0.0.10870', appAsarSha256: '99f33f89fa570458d39bd56bd6f0fb84b9822d321f43a2c65ba5b1241f4253a6' };
const select = (actual = identity) => selectProfile({ actual, platform: 'win32' });

// 原版 Windows x64 编译产物的锚点切片；不包含运行数据。
const env = 'mM=process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim(),fM=process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim();';
const login = 'getLogin:i(async()=>{let e=await _5(),t=await M5(e);return t?{userId:e,jwt:t.slice(7)}:void 0},"getLogin")';
const sid = 'resolveDeviceSid:i(async(Se,xt)=>(Ze=await yd(xt,Se),t.get(h)===be&&(be.deviceSid=Ze,be.qrUrl=be.connectUrl=""),Ze),"resolveDeviceSid")';
const token = 'getToken:i(async Se=>{let xt=await Zo(),ni=await m(Zo,xt,()=>bd.token(xt.jwt,AbortSignal.any([de,Se])));return await Zo(),e.logger.info("[web-remote-control] V2 device token acquired"),ni},"getToken")';
const auth = 'async notifyAuthStateChanged(h,b){let M=++T;if(b.state==="signed-in"){';
const manager = 'disposeWorkspaceHostAttachmentsForRemoteSession:i(e=>Ns.disposeRemoteSession(e),"disposeWorkspaceHostAttachmentsForRemoteSession")});jg.current=zt;';
const source = [
  'var version=getVersion(),' + env,
  'var options={' + login + ',' + sid + ',' + token + '};',
  'class Mgr{' + auth + 'return}}}',
  'var zt=mk({' + manager + 'zt.startNotifications();',
].join('\n');

test('4.0.0 按完整包身份选档，保留九份旧档案', () => {
  const route = select();
  assert.equal(route.ok, true, route.reason);
  assert.equal(route.profile.id, 'windows-4.0.0.10870-99f33f89');
  assert.equal(route.profile.mainEntry, 'out/main/index.js');
  assert.equal(route.profile.patchVersion, 1);
  assert.equal(route.profile.packageIdentity.appAsarBytes, 385203576);
  assert.equal(select({ ...identity, appAsarSha256: '0'.repeat(64) }).code, 'digest_mismatch');
  assert.deepEqual(PATCH_PROFILES.slice(0, 9).map(p => p.id), [
    'windows-3.16.2.8769-1f960ba2', 'windows-3.16.3.8992-21183dbf',
    'windows-3.17.1.9553-9a09f6ef', 'windows-3.17.2.9661-b11a6bc5',
    'windows-3.18.0.10300-dea4826e', 'windows-3.18.1.10376-1af9cdd8',
    'windows-3.18.2.10443-4c0b8510', 'windows-3.19.0.10774-24218509',
    'windows-3.19.1.10833-f9186044',
  ]);
  assert.equal(select({ exeFileVersion: '3.19.1.10833',
    appAsarSha256: 'f9186044ab9220a2a50376e067eade1e4fef18e6d5c07b1483d1f6ca894ce41a' }).profile.id,
  'windows-3.19.1.10833-f9186044');
});

test('4.0.0 原版锚点唯一命中并保持 ESM 语法', () => {
  const { applyInjections } = select().profile;
  const { content, applied } = applyInjections(source);
  assert.deepEqual(applied.map(item => item.id), ['P0-fs-import', 'P1-mode-gate', 'P2-login-short-circuit',
    'P3-device-sid-short-circuit', 'P4-token-short-circuit', 'P5-signed-out-isolation', 'P6-auto-start']);
  assert.ok(content.includes('getLogin:i(async()=>{if(__LO_MODE)return{userId:"local-only-device",jwt:"local-only"};let e=await _5(),t=await M5(e)'));
  assert.ok(content.includes('resolveDeviceSid:i(async(Se,xt)=>__LO_MODE?"local-only-device":(Ze=await yd(xt,Se)'));
  assert.ok(content.includes('getToken:i(async Se=>{if(__LO_MODE)return __LO_TOKEN();let xt=await Zo()'));
  assert.ok(content.includes('()=>bd.token(xt.jwt,AbortSignal.any([de,Se]))'));
  assert.ok(content.includes('jg.current=zt;import'));
  assert.throws(() => applyInjections(content), /__LO_MODE/);
  assert.throws(() => applyInjections(source.replace(sid, '')), /P3-device-sid-short-circuit 未命中/);
  assert.throws(() => applyInjections(source + manager), /P6-auto-start 命中多次/);
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: content, stdio: ['pipe', 'pipe', 'pipe'] });
});

test('4.0.0 注入体绑定本包的压缩名，不沿用上一包的变量名', async () => {
  const { renderP1GateCode, renderP6AutoStartCode } = await import('../local-only/profiles/windows-4.0.0.10870.mjs');
  // 上一包 3.19.1 的 relay 覆盖值与挂接容器名；本包入口中它们分别是 URL 覆盖值与无关标识。
  const stale = /(?<![\w$])(pM|Vg)(?![\w$])/;
  const gate = renderP1GateCode();
  assert.match(gate, /if\(__LO_MODE\)mM=\(function\(\)\{/);
  assert.doesNotMatch(gate, stale);
  const autoStart = renderP6AutoStartCode();
  assert.match(autoStart.body, /var w=Ke\(\);/);
  assert.match(autoStart.body, /zt\.getStatus\(w\[0\]\.id\)/);
  assert.match(autoStart.body, /zt\.start\(w\[0\]\.id,\{workspacePath:__LO_WS\}\)/);
  assert.doesNotMatch(autoStart.body, stale);
});

test('4.0.0 关闭时保留官方地址，开启时只连回环并为闲置窗口启动', async () => {
  const { renderP1GateCode, renderP6AutoStartCode } = await import('../local-only/profiles/windows-4.0.0.10870.mjs');
  const gate = (mode, current, gateway) => {
    const context = { process: { env: { ZCODE_LOCAL_ONLY: mode, ZCODE_LOCAL_ONLY_GATEWAY: gateway } }, URL, mM: current };
    vm.runInNewContext(renderP1GateCode(), context);
    return context;
  };
  assert.equal(gate('0', 'wss://example.com/official').mM, 'wss://example.com/official');
  assert.equal(gate('1', 'wss://127.0.0.1@outside.example/ws', 'https://outside.example').mM, 'ws://127.0.0.1:17331/ws');
  const local = gate('1', 'wss://example.com/official', 'http://127.0.0.1:19000/path');
  assert.equal(local.mM, 'ws://127.0.0.1:19000/ws');
  assert.match(local.__LO_TOKEN(), /^[A-Za-z0-9_-]{21}A$/);

  const starts = [];
  let status = 'running';
  const context = { __LO_MODE: true, __LO_WS: 'D:/fixture', __loApp: { isReady: () => true }, Ke: () => [{ id: 7 }],
    zt: { getStatus: () => ({ status }), start: (id, { workspacePath }) => starts.push([id, workspacePath]) }, setTimeout: fn => fn() };
  vm.runInNewContext(renderP6AutoStartCode().body, context);
  status = 'idle';
  vm.runInNewContext(renderP6AutoStartCode().body, context);
  context.__LO_MODE = false;
  vm.runInNewContext(renderP6AutoStartCode().body, context);
  assert.deepEqual(starts, [[7, 'D:/fixture']]);
});

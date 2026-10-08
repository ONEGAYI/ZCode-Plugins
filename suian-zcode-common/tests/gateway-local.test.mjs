import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { startGateway } from '../gateway.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('本地模式处理注册、启动与心跳，不连接官方上游且客户端离开后保持配对', { timeout: 3000 }, async t => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  let connections = 0;
  upstream.on('connection', () => connections++);
  t.after(() => { for (const socket of upstream.clients) socket.terminate(); upstream.close(); });
  const gateway = await startGateway({ mode: 'local-only', upstreamUrl: `ws://127.0.0.1:${upstream.address().port}/ws`, controlToken: 'fixture-only-token' });
  t.after(() => gateway.close());
  const healthUrl = gateway.url.replace('ws:', 'http:').replace('/ws', '/health');
  assert.equal((await (await fetch(healthUrl)).json()).mode, 'local-only');
  const desktop = new WebSocket(gateway.url);
  t.after(() => desktop.terminate());
  await once(desktop, 'open');
  const registered = once(desktop, 'message');
  desktop.send(JSON.stringify({ type: 'device_register_init', device_mid: 'fixture-device', pass_hash: 'fixture-private-hash' }));
  const registration = JSON.parse((await registered)[0]);
  assert.equal(registration.type, 'device_register_ack');
  assert.match(registration.device_sid, /^d_local_/);
  const acknowledged = once(desktop, 'message');
  desktop.send(JSON.stringify({ type: 'auth_init', role: 'device', device_sid: registration.device_sid }));
  assert.equal(JSON.parse((await acknowledged)[0]).pair_status, 'matched');
  for (let i = 0; i < 3; i++) {
    const heartbeat = once(desktop, 'message');
    desktop.send(JSON.stringify({ type: 'pair_status_query', device_sid: registration.device_sid }));
    const reply = JSON.parse((await heartbeat)[0]);
    assert.equal(reply.type, 'pair_status_ack');
    assert.equal(reply.pair_status, 'matched');
  }
  const peer = new WebSocket(gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-only-token' } });
  t.after(() => peer.terminate());
  await once(peer, 'open');
  const closed = once(peer, 'close'); peer.close(); await closed;
  const health = await (await fetch(healthUrl)).json();
  assert.equal(health.desktop_ready, true);
  assert.equal(health.desktop_connected, true);
  assert.equal(health.upstream_connected, false);
  assert.equal(health.upstream_paired, false);
  assert.equal(health.paired, true);
  assert.equal(connections, 0);
  assert.ok(!JSON.stringify(health).includes('fixture-private-hash'));
});

test('本地模式在设备就绪前拒绝 RPC，不接受 terminal 角色或不匹配的注册标识', { timeout: 3000 }, async t => {
  for (const invalid of ['terminal', 'wrong-registration']) {
    const gateway = await startGateway({ mode: 'local-only', upstreamUrl: 'ws://127.0.0.1:1/ws', controlToken: 'fixture-boundary-token' });
    t.after(() => gateway.close());
    const desktop = new WebSocket(gateway.url);
    t.after(() => desktop.terminate());
    await once(desktop, 'open');
    const peer = new WebSocket(gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-boundary-token' } });
    t.after(() => peer.terminate());
    assert.equal((await once(peer, 'close'))[0], 1013);
    if (invalid === 'wrong-registration') {
      const registered = once(desktop, 'message');
      desktop.send(JSON.stringify({ type: 'device_register_init', device_mid: 'fixture-boundary' }));
      await registered;
    }
    const closed = once(desktop, 'close');
    desktop.send(JSON.stringify({ type: 'auth_init', role: invalid === 'terminal' ? 'terminal' : 'device', device_sid: 'd_other' }));
    assert.equal((await closed)[0], 1008);
    const health = await (await fetch(gateway.url.replace('ws:', 'http:').replace('/ws', '/health'))).json();
    assert.equal(health.desktop_ready, false);
  }
});

test('实际网关 CLI 从配置加载本地模式，关闭的上游不影响设备就绪', { timeout: 3000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-local-cli-'));
  t.after(() => rm(dir, { recursive: true }));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, mode: 'local-only', port: 0, upstream_url: 'ws://127.0.0.1:1/ws', instance_id: 'fixture-local-cli', control_token: 'fixture-cli-token' }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../gateway.mjs', import.meta.url)), '--config', config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, 'line'); lines.close();
  const { relay_url, health_url } = JSON.parse(line);
  const desktop = new WebSocket(relay_url);
  t.after(() => desktop.terminate());
  await once(desktop, 'open');
  const ack = once(desktop, 'message');
  desktop.send(JSON.stringify({ type: 'auth_init', role: 'device', device_sid: 'd_fixture-cli' }));
  assert.equal(JSON.parse((await ack)[0]).pair_status, 'matched');
  const health = await (await fetch(health_url)).json();
  assert.equal(health.mode, 'local-only');
  assert.equal(health.desktop_ready, true);
  assert.equal(health.upstream_connected, false);
  assert.equal(stderr, '');
});

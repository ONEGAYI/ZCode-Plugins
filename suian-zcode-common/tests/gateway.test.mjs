import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { startGateway } from '../gateway.mjs';

test('健康入口区分网关、设备连接和配对，拒绝浏览器连接且不返回认证材料', { timeout: 3000 }, async (t) => {
  const { gateway, desktop, upstream, relay } = await connectedFixture(t, 'matched', { instanceId: 'fixture-installation', controlToken: 'fixture-health-token' });
  const healthUrl = gateway.url.replace('ws:', 'http:').replace('/ws', '/health');
  const response = await fetch(healthUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    service: 'suian-zcode-gateway', version: 1, instance_id: 'fixture-installation',
    upstream_url: `ws://127.0.0.1:${relay.address().port}/ws`,
    desktop_connected: true, upstream_connected: true, paired: true,
    upstream_paired: true, local_clients: 0, rpc_protocol_version: 1,
  });
  const changed = once(desktop, 'message');
  upstream.send('{"type":"pair_status_ack","pair_status":"waiting"}');
  await changed;
  assert.equal((await (await fetch(healthUrl)).json()).paired, false);
  assert.equal((await fetch(healthUrl, { headers: { Origin: 'https://example.test' } })).status, 403);
  const browser = new WebSocket(gateway.url, { origin: 'https://example.test' });
  browser.on('error', () => {});
  const browserRejected = new Promise((resolve) => browser.once('unexpected-response', (_request, rejected) => { rejected.resume(); browser.terminate(); resolve(rejected.statusCode); }));
  assert.equal(await browserRejected, 403);
  assert.equal(relay.clients.size, 1);
  const shutdown = await fetch(healthUrl.replace('/health', '/shutdown'), { method: 'POST', headers: { Authorization: 'Bearer fixture-health-token' } });
  assert.equal(shutdown.status, 409);
  assert.match(await shutdown.text(), /Stop mobile remote control in ZCode/);
  const disconnected = once(desktop, 'close');
  desktop.terminate();
  await disconnected;
  await new Promise((resolve) => upstream.once('close', resolve));
  const offline = await (await fetch(healthUrl)).json();
  assert.equal(offline.desktop_connected, false);
  assert.equal(offline.upstream_connected, false);
  assert.equal(offline.paired, false);
});

test('唯一设备连接原样转发认证及文本/二进制消息，并保留 mid 和握手头', { timeout: 3000 }, async (t) => {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(relay, 'listening');
  t.after(() => { for (const socket of relay.clients) socket.terminate(); relay.close(); });
  const faults = [];
  const gateway = await startGateway({ upstreamUrl: `ws://127.0.0.1:${relay.address().port}/ws`, onError: (error) => faults.push(error) });
  t.after(() => gateway.close());
  let connections = 0;
  relay.on('connection', () => connections++);
  const accepted = once(relay, 'connection');
  const authInit = '{ "type":"auth_init", "role":"device", "device_sid":"d_fixture", "meta":{"platform":"win32","version":"3.14.4","name":"fixture"}, "client_ts":1 }';
  const firstMessage = new Promise((resolve) => relay.once('connection', (socket) => socket.once('message', (...args) => resolve(args))));
  const desktop = new WebSocket(`${gateway.url}?mid=fixture-mid`, { headers: { 'X-Device-ID': 'fixture-mid' } });
  t.after(() => desktop.terminate());
  desktop.once('open', () => desktop.send(authInit));
  const [upstream, request] = await accepted;
  assert.equal(request.url, '/ws?mid=fixture-mid');
  assert.equal(request.headers['x-device-id'], 'fixture-mid');
  const [initBytes, initBinary] = await firstMessage;
  assert.equal(initBytes.toString(), authInit);
  assert.equal(initBinary, false);

  const challenge = '{"type":"auth_challenge","nonce":"fixture-nonce","server_ts":2}';
  const challenged = once(desktop, 'message');
  upstream.send(challenge);
  assert.equal((await challenged)[0].toString(), challenge);
  const proof = createHmac('sha256', 'fixture-pass-hash').update('fixture-nonce|device|d_fixture').digest('base64url');
  const authResponse = JSON.stringify({ type: 'auth_response', device_sid: 'd_fixture', proof, client_ts: 3 });
  const responded = once(upstream, 'message');
  desktop.send(authResponse);
  assert.equal((await responded)[0].toString(), authResponse);

  const ack = '{"type":"auth_ack","pair_status":"matched","server_ts":4}';
  const acknowledged = once(desktop, 'message');
  upstream.send(ack);
  assert.equal((await acknowledged)[0].toString(), ack);
  const binary = Buffer.from([0, 255, 17, 128]);
  const binaryUp = once(upstream, 'message');
  desktop.send(binary);
  assert.deepEqual(await binaryUp, [binary, true]);
  const binaryDown = once(desktop, 'message');
  upstream.send(binary);
  assert.deepEqual(await binaryDown, [binary, true]);

  const duplicate = new WebSocket(gateway.url);
  t.after(() => duplicate.terminate());
  const [code] = await once(duplicate, 'close');
  assert.equal(code, 1008);
  assert.equal(connections, 1);
  assert.deepEqual(faults, []);
});

async function connectedFixture(t, pairStatus, options = {}) {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(relay, 'listening');
  t.after(() => { for (const socket of relay.clients) socket.terminate(); relay.close(); });
  const gateway = await startGateway({ upstreamUrl: `ws://127.0.0.1:${relay.address().port}/ws`, ...options });
  t.after(() => gateway.close());
  const accepted = once(relay, 'connection');
  const desktop = new WebSocket(gateway.url);
  t.after(() => desktop.terminate());
  const opened = once(desktop, 'open');
  const [upstream] = await accepted;
  await opened;
  const ack = once(desktop, 'message');
  upstream.send(JSON.stringify({ type: 'auth_ack', pair_status: pairStatus }));
  await ack;
  return { gateway, desktop, upstream, relay };
}

test('手机与两个本地 bootstrap 并行，回复各归调用方，且不新增上游连接', { timeout: 3000 }, async (t) => {
  const { gateway, desktop, upstream, relay } = await connectedFixture(t, 'matched');
  const requests = [];
  desktop.on('message', (data) => requests.push(JSON.parse(data.toString())));
  const receivedTwo = new Promise((resolve) => desktop.on('message', () => { if (requests.length === 2) resolve(); }));
  const first = gateway.bootstrap();
  const second = gateway.bootstrap();
  await receivedTwo;
  for (const request of requests) {
    assert.equal(request.type, 'data');
    assert.equal(request.payload.zcode_type, 'bootstrap-request');
    assert.match(request.payload.requestId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  }
  assert.notEqual(requests[0].payload.requestId, requests[1].payload.requestId);
  const phoneRequest = '{"type":"data","payload":{"zcode_type":"bootstrap-request","requestId":"phone-request"},"client_ts":10}';
  const phoneReceived = once(desktop, 'message');
  upstream.send(phoneRequest);
  assert.equal((await phoneReceived)[0].toString(), phoneRequest);

  // 先返回第二个本地请求，确认按 requestId 分流，而非先入先出。
  const secondReply = { zcode_type: 'bootstrap-response', requestId: requests[1].payload.requestId, success: true, result: { tasks: [], workspaces: [{ key: 'fixture-second' }] } };
  const nextOfficialMessage = once(upstream, 'message');
  desktop.send(JSON.stringify({ type: 'data', payload: secondReply, client_ts: 11 }));
  assert.deepEqual(await second, secondReply);
  const phoneReply = '{ "type":"data", "payload":{"zcode_type":"bootstrap-response","requestId":"phone-request","success":true,"result":{"tasks":[],"workspaces":[]}}, "client_ts":12 }';
  desktop.send(phoneReply);
  assert.equal((await nextOfficialMessage)[0].toString(), phoneReply);
  const firstReply = { zcode_type: 'bootstrap-response', requestId: requests[0].payload.requestId, success: false, error: 'fixture failure' };
  const nextMarker = once(upstream, 'message');
  desktop.send(JSON.stringify({ type: 'data', payload: firstReply, client_ts: 13 }));
  assert.deepEqual(await first, firstReply);
  const marker = '{"type":"pair_status_query","client_ts":14}';
  desktop.send(marker);
  assert.equal((await nextMarker)[0].toString(), marker);
  assert.equal(relay.clients.size, 1);
});

test('真实 waiting 状态禁止本地注入，并拒绝尚未完成的请求', { timeout: 3000 }, async (t) => {
  const { gateway, desktop, upstream } = await connectedFixture(t, 'waiting');
  await assert.rejects(gateway.bootstrap(), /尚未配对/);
  const matched = once(desktop, 'message');
  upstream.send('{"type":"pair_status_ack","pair_status":"matched"}');
  await matched;
  const requested = once(desktop, 'message');
  const pending = gateway.bootstrap();
  const rejection = assert.rejects(pending, /配对结束/);
  await requested;
  const waiting = once(desktop, 'message');
  upstream.send('{"type":"pair_status_ack","pair_status":"waiting"}');
  assert.equal((await waiting)[0].toString(), '{"type":"pair_status_ack","pair_status":"waiting"}');
  await rejection;
  await assert.rejects(gateway.bootstrap(), /尚未配对/);
});

test('本地请求超时或设备断开时明确失败', { timeout: 3000 }, async (t) => {
  const { gateway, desktop, upstream } = await connectedFixture(t, 'matched');
  const timedRequest = once(desktop, 'message');
  const timeout = assert.rejects(gateway.bootstrap({ timeoutMs: 30 }), /bootstrap 超时/);
  const requestId = JSON.parse((await timedRequest)[0].toString()).payload.requestId;
  await timeout;
  const nextOfficialMessage = once(upstream, 'message');
  desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-response', requestId, success: true, result: {} } }));
  const marker = '{"type":"pair_status_query","client_ts":15}';
  desktop.send(marker);
  assert.equal((await nextOfficialMessage)[0].toString(), marker);
  const requested = once(desktop, 'message');
  const pending = gateway.bootstrap();
  const rejection = assert.rejects(pending, /连接断开/);
  await requested;
  desktop.close();
  await rejection;
});

test('实测观察只暴露方向、消息类型、配对状态和本地归属，不暴露凭据或消息正文', { timeout: 3000 }, async (t) => {
  const events = [];
  const { gateway, desktop, upstream } = await connectedFixture(t, 'matched', { onTraffic: (event) => events.push(event) });
  const phoneReceived = once(desktop, 'message');
  upstream.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-request', requestId: 'phone-id', privateText: 'fixture-secret' } }));
  await phoneReceived;
  const authReceived = once(upstream, 'message');
  desktop.send(JSON.stringify({ type: 'auth_response', device_sid: 'fixture-private-sid', proof: 'fixture-proof' }));
  await authReceived;
  const localReceived = once(desktop, 'message');
  const local = gateway.bootstrap();
  const requestId = JSON.parse((await localReceived)[0].toString()).payload.requestId;
  desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-response', requestId, success: true, result: { tasks: ['fixture-private-task'] } } }));
  await local;
  assert.deepEqual(events, [
    { from: 'upstream', type: 'auth_ack', zcodeType: null, pairStatus: 'matched', local: false },
    { from: 'upstream', type: 'data', zcodeType: 'bootstrap-request', pairStatus: null, local: false },
    { from: 'desktop', type: 'auth_response', zcodeType: null, pairStatus: null, local: false },
    { from: 'desktop', type: 'data', zcodeType: 'bootstrap-response', pairStatus: null, local: true },
  ]);
});

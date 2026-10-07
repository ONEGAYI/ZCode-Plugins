import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { startGateway } from '../gateway.mjs';
import { Hs as encode, Bs as Assembler, Ws as parse } from '../vendor/remote-shared.js';
import { BufferReader, BufferWriter, deserialize, serialize } from '../vendor/serialization.js';
import { VSBuffer } from '../vendor/buffer.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRpcBroker } from '../rpc-broker.mjs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const workspace = 'D:\\fixture';
const pack = (header, body) => { const w = new BufferWriter(); serialize(w, header); serialize(w, body); return w.buffer.buffer; };
const unpack = bytes => { const r = new BufferReader(VSBuffer.wrap(bytes)); return [deserialize(r), deserialize(r)]; };
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('未在隔离测试窗口内收到预期协议消息');
}

async function fixture(t, pairStatus = 'matched', options = {}) {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(relay, 'listening');
  t.after(() => { for (const s of relay.clients) s.terminate(); relay.close(); });
  const faults = [];
  const gateway = await startGateway({ upstreamUrl: `ws://127.0.0.1:${relay.address().port}/ws`, controlToken: 'fixture-rpc-token', onError: error => faults.push(error.code ?? error.name), ...options.gateway });
  t.after(() => gateway.close());
  const accepted = once(relay, 'connection');
  const desktop = new WebSocket(gateway.url);
  t.after(() => desktop.terminate());
  await once(desktop, 'open');
  const [phone] = await accepted;
  const ack = once(desktop, 'message'); phone.send(JSON.stringify({ type: 'auth_ack', pair_status: pairStatus })); await ack;
  const requests = [], bridgeOpens = [];
  let identity, assembler, physical = 1, message = 1;
  const respond = (header, body) => {
    for (const f of encode(pack(header, body), { ...identity, firstPhysicalSeq: physical, messageSeq: message++ })) {
      physical++; desktop.send(JSON.stringify({ type: 'data', payload: f }));
    }
  };
  desktop.on('message', data => {
    const p = JSON.parse(data).payload;
    if (p?.zcode_type === 'bootstrap-request') {
      desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-response', requestId: p.requestId, success: true,
        result: { workspaces: [{ kind: 'local', workspacePath: workspace }, { kind: 'local', workspacePath: 'D:\\other' },
          { kind: 'remote', workspacePath: '/remote', workspaceIdentity: 'remote:fixture', remoteSessionId: 'remote-session-fixture' }], tasks: [] } } }));
    } else if (p?.zcode_type === 'workspace-bridge-open') {
      bridgeOpens.push(p);
      if (options.ignoreBridge) return;
      identity = { bridgeSessionId: p.bridgeSessionId, bridgeGeneration: p.bridgeGeneration };
      assembler = new Assembler({ identity }); physical = 1; message = 1;
      desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-ready', requestId: p.requestId,
        bridge: { ...identity, kind: p.workspaceKey === 'remote:fixture' ? 'remote' : 'local', workspaceKey: p.workspaceKey,
          workspacePath: p.workspaceKey === 'remote:fixture' ? '/remote' : workspace } } }));
      respond([200], undefined);
    } else if (p?.zcode_type === 'rpc-frame') {
      const result = assembler.accept(parse(p));
      if (result.kind === 'complete') {
        desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'rpc-frame-ack', ...identity, ackMessageSeq: result.messageSeq } }));
        requests.push(unpack(result.bytes));
      }
    }
  });
  return { gateway, desktop, phone, relay, requests, bridgeOpens, respond, faults };
}

test('手机和两个本地客户端的相同 RPC 编号被隔离，复用一个本地 Host 桥且不新增上游 terminal', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const phoneReplies = [], phoneReady = Promise.withResolvers();
  let phoneAssembler;
  const phoneIdentity = { bridgeSessionId: 'phone-virtual-bridge', bridgeGeneration: 1 };
  f.phone.on('message', data => {
    const p = JSON.parse(data).payload;
    if (p?.zcode_type === 'workspace-bridge-ready') { phoneAssembler = new Assembler({ identity: phoneIdentity }); phoneReady.resolve(); }
    else if (p?.zcode_type === 'rpc-frame') {
      const r = phoneAssembler.accept(parse(p));
      if (r.kind === 'complete') phoneReplies.push(unpack(r.bytes));
    }
  });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-open', ...phoneIdentity, workspaceKey: workspace } }));
  await phoneReady.promise;
  const peers = [], replies = [];
  for (let i = 0; i < 2; i++) {
    const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
    t.after(() => peer.terminate());
    peer.on('error', () => {});
    const opened = new Promise(resolve => { peer.once('open', () => resolve(101)); peer.once('unexpected-response', (_r, response) => { response.resume(); peer.terminate(); resolve(response.statusCode); }); });
    assert.equal(await opened, 101, '公共网关应暴露经认证的本地 RPC 入口');
    peers.push(peer); replies.push([]);
    const attached = Promise.withResolvers();
    peer.on('message', (data, binary) => { if (binary) replies[i].push(unpack(data)); else if (JSON.parse(data).type === 'attached') attached.resolve(); });
    peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
    await attached.promise;
  }
  peers[0].send(pack([100, 0, 'fixture', 'left'], ['left']));
  peers[1].send(pack([100, 0, 'fixture', 'right'], ['right']));
  for (const frame of encode(pack([100, 0, 'fixture', 'phone'], ['phone']), { ...phoneIdentity, firstPhysicalSeq: 1, messageSeq: 1 })) f.phone.send(JSON.stringify({ type: 'data', payload: frame }));
  await until(() => f.requests.length === 3);
  assert.equal(new Set(f.requests.map(([h]) => h[1])).size, 3);
  for (const [header, body] of [...f.requests].reverse()) f.respond([201, header[1]], { recipient: body[0] });
  await until(() => replies.every(r => r.some(([h]) => h[0] === 201)) && phoneReplies.some(([h]) => h[0] === 201));
  assert.deepEqual(replies[0].find(([h]) => h[0] === 201), [[201, 0], { recipient: 'left' }]);
  assert.deepEqual(replies[1].find(([h]) => h[0] === 201), [[201, 0], { recipient: 'right' }]);
  assert.deepEqual(phoneReplies.find(([h]) => h[0] === 201), [[201, 0], { recipient: 'phone' }]);
  assert.equal(f.bridgeOpens.length, 1);
  assert.equal(f.relay.clients.size, 1);
});

test('官方鉴权失败后关闭本地客户端，不用缓存的 matched 恢复配对', { timeout: 3000 }, async t => {
  const f = await fixture(t), messages = [];
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  peer.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data)); });
  await once(peer, 'open'); peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
  await until(() => messages.some(m => m.type === 'attached'));
  const closed = once(peer, 'close'); f.phone.send('{"type":"error","code":"AUTH_FAILED"}'); await closed;
  const health = await (await fetch(f.gateway.url.replace('ws:', 'http:').replace('/ws', '/health'))).json();
  assert.equal(health.paired, false);
  assert.equal(health.upstream_paired, false);
  assert.equal(health.local_clients, 0);
});

test('Host 畸形 RPC 回复只中断待处理调用，网关保持运行并明确报告协议错误', { timeout: 3000 }, async t => {
  const f = await fixture(t), messages = [];
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  peer.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data)); });
  await once(peer, 'open'); peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
  await until(() => messages.some(m => m.type === 'attached'));
  peer.send(pack([100, 0, 'fixture', 'pending'], []));
  await until(() => f.requests.length === 1);
  f.respond(undefined, {});
  await until(() => messages.some(m => m.type === 'error'));
  assert.equal(messages.find(m => m.type === 'error').code, 'gateway_rpc_protocol_error');
  const health = await (await fetch(f.gateway.url.replace('ws:', 'http:').replace('/ws', '/health'))).json();
  assert.equal(health.desktop_connected, true);
  assert.deepEqual(f.faults, ['gateway_rpc_protocol_error']);
});

test('Host 不返回桥初始化时明确超时，迟到回复不泄露到手机', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'matched', { ignoreBridge: true, gateway: { bridgeTimeoutMs: 30 } });
  const phoneMessages = [];
  f.phone.on('message', data => phoneMessages.push(JSON.parse(data)));
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  const messages = [];
  peer.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data)); });
  await once(peer, 'open'); peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
  await until(() => messages.length > 0);
  assert.equal(messages[0].code, 'gateway_bridge_timeout');
  const opening = f.bridgeOpens[0];
  f.desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-ready', requestId: opening.requestId,
    bridge: { bridgeSessionId: opening.bridgeSessionId, bridgeGeneration: 1, kind: 'local', workspacePath: workspace } } }));
  const marker = once(f.phone, 'message'); f.desktop.send('{"type":"fixture-marker"}'); await marker;
  assert.equal(phoneMessages.some(m => m.payload?.requestId === opening.requestId), false);
});

test('手机畸形 RPC 帧降级该桥，网关继续服务本地调用', { timeout: 3000 }, async t => {
  const f = await fixture(t), messages = [];
  f.phone.on('message', data => messages.push(JSON.parse(data).payload));
  const identity = { bridgeSessionId: 'phone-invalid-frame', bridgeGeneration: 1 };
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-open', ...identity, workspaceKey: workspace } }));
  await until(() => messages.some(p => p?.zcode_type === 'workspace-bridge-ready'));
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'rpc-frame', ...identity, invalid: true } }));
  await until(() => messages.some(p => p?.zcode_type === 'bridge-degraded'));
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  const attached = Promise.withResolvers();
  peer.on('message', (data, binary) => { if (!binary && JSON.parse(data).type === 'attached') attached.resolve(); });
  await once(peer, 'open'); peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace })); await attached.promise;
  assert.equal(f.bridgeOpens.length, 1);
});

test('手机独用远端工作区时原样转发桥，MCP 本地请求明确让位而不切走手机', { timeout: 3000 }, async t => {
  const f = await fixture(t), messages = [];
  f.phone.on('message', data => messages.push(JSON.parse(data).payload));
  const identity = { bridgeSessionId: 'phone-remote-bridge', bridgeGeneration: 1 };
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-remote-open', ...identity, workspaceKey: 'remote:fixture' } }));
  await until(() => messages.some(p => ['workspace-bridge-ready', 'workspace-bridge-error'].includes(p?.zcode_type)));
  const ready = messages.find(p => p?.zcode_type === 'workspace-bridge-ready');
  assert.equal(ready?.bridge.kind, 'remote', '不能破坏手机既有远端工作区支持');
  assert.equal(ready.bridge.bridgeSessionId, 'phone-remote-bridge');
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  await once(peer, 'open');
  const rejected = new Promise(resolve => peer.on('message', (data, binary) => { if (!binary) resolve(JSON.parse(data)); }));
  peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
  assert.equal((await rejected).code, 'remote_workspace_busy');
  assert.equal(f.bridgeOpens.length, 1);
});

test('手机快速切换远端工作区时丢弃过期 bootstrap，不用旧请求切走当前桥', async () => {
  const pending = [], sent = [];
  const broker = createRpcBroker({ bootstrap: () => { const request = Promise.withResolvers(); pending.push(request); return request.promise; },
    sendDesktop: payload => sent.push(payload), sendPhone: () => {} });
  const workspaces = ['remote:first', 'remote:second'].map(workspaceIdentity => ({ kind: 'remote', workspaceIdentity, workspacePath: '/remote', remoteSessionId: 'fixture' }));
  const first = broker.phoneOpen({ bridgeSessionId: 'first', bridgeGeneration: 1, workspaceKey: 'remote:first' });
  const second = broker.phoneOpen({ bridgeSessionId: 'second', bridgeGeneration: 1, workspaceKey: 'remote:second' });
  pending[1].resolve({ success: true, result: { workspaces } }); await second;
  pending[0].resolve({ success: true, result: { workspaces } }); await first;
  assert.deepEqual(sent.map(p => p.bridgeSessionId), ['second']);
  broker.close(new Error('fixture closed'));
});

test('公共 connectHost 从网关配置附着并调用原 Host，无需远控链接', { timeout: 3000 }, async t => {
  const api = await import('../remote.mjs');
  assert.equal(typeof api.connectHost, 'function', '插件默认入口必须能连接公共网关');
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-client-'));
  t.after(() => rm(dir, { recursive: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const remote = await api.connectHost({ workspacePath: workspace, gatewayConfigPath: configPath, timeoutMs: 1000 });
  t.after(() => remote.close());
  const call = remote.call('zcode-task', 'getTaskMeta', [{ taskId: 'sess_example', workspacePath: workspace }]);
  await until(() => f.requests.length === 1);
  f.respond([201, f.requests[0][0][1]], { title: '网关测试' });
  assert.equal((await call).title, '网关测试');
  assert.equal(remote.workspacePath, workspace);
  assert.equal((await remote.probe()).ok, true);
  assert.equal(f.relay.clients.size, 1);
});

test('本地客户端使用不同本地工作区，订阅事件与关闭取消各归原客户端，长消息分片保持正文', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const peers = [], received = [[], []];
  for (const [index, path] of [workspace, 'D:\\other'].entries()) {
    const socket = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
    peers.push(socket); t.after(() => socket.terminate());
    await once(socket, 'open');
    const attached = Promise.withResolvers();
    socket.on('message', (data, binary) => {
      if (binary) received[index].push(unpack(data));
      else { const message = JSON.parse(data); if (message.type === 'attached') attached.resolve(message); }
    });
    socket.send(JSON.stringify({ type: 'attach', workspace_path: path }));
    assert.equal((await attached.promise).workspace_path, path);
    socket.send(pack([102, 0, 'fixture', 'events'], { workspacePath: path }));
  }
  await until(() => f.requests.length === 2);
  const [leftId, rightId] = f.requests.map(([h]) => h[1]);
  f.respond([204, leftId], { owner: 'left' }); f.respond([204, rightId], { owner: 'right' });
  await until(() => received.every(r => r.some(([h]) => h[0] === 204)));
  assert.deepEqual(received[0].find(([h]) => h[0] === 204), [[204, 0], { owner: 'left' }]);
  assert.deepEqual(received[1].find(([h]) => h[0] === 204), [[204, 0], { owner: 'right' }]);
  const text = '中文正文'.repeat(30000);
  peers[0].send(pack([100, 1, 'fixture', 'long-message'], { text }));
  await until(() => f.requests.length === 3);
  assert.equal(f.requests[2][1].text, text);
  const pendingId = f.requests[2][0][1];
  const closed = once(peers[0], 'close'); peers[0].close(); await closed;
  await until(() => f.requests.length === 5);
  assert.ok(f.requests.some(([h]) => h[0] === 103 && h[1] === leftId));
  assert.ok(f.requests.some(([h]) => h[0] === 101 && h[1] === pendingId));
  f.respond([204, rightId], { owner: 'right-again' });
  await until(() => received[1].filter(([h]) => h[0] === 204).length === 2);
  assert.equal(f.bridgeOpens.length, 1);
});

test('原 Host 报桥降级时本地调用立即失败，物理桥标识不泄露给手机', { timeout: 3000 }, async t => {
  const f = await fixture(t), replies = [], phoneMessages = [];
  f.phone.on('message', data => phoneMessages.push(JSON.parse(data).payload));
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  peer.on('message', (data, binary) => { if (!binary) replies.push(JSON.parse(data)); });
  await once(peer, 'open'); peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
  await until(() => replies.some(r => r.type === 'attached'));
  const { bridgeSessionId, bridgeGeneration } = f.bridgeOpens[0];
  f.desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bridge-degraded', bridgeSessionId, bridgeGeneration, reason: 'rpc-transport-fault' } }));
  await until(() => replies.some(r => r.type === 'error'));
  assert.equal(replies.find(r => r.type === 'error').code, 'gateway_rpc_protocol_error');
  assert.equal(phoneMessages.some(p => p?.bridgeSessionId === bridgeSessionId), false);
});

for (const code of ['WRONG_PARAM', 'INTERNAL']) {
  test(`relay ${code} 后恢复 matched，无需重新鉴权即可附着本地 RPC`, { timeout: 3000 }, async t => {
    const f = await fixture(t);
    const gotError = once(f.desktop, 'message');
    f.phone.send(JSON.stringify({ type: 'error', code, message: 'fixture recoverable error' }));
    assert.equal(JSON.parse((await gotError)[0]).code, code);
    const gotAck = once(f.desktop, 'message');
    f.phone.send(JSON.stringify({ type: 'pair_status_ack', pair_status: 'matched' })); await gotAck;
    const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
    t.after(() => peer.terminate());
    const result = new Promise(resolve => {
      peer.on('message', (data, binary) => { if (!binary) resolve(JSON.parse(data)); });
      peer.once('close', (_code, reason) => resolve({ type: 'closed', reason: reason.toString() }));
    });
    await once(peer, 'open'); peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
    assert.equal((await result).type, 'attached');
  });
}

test('畸形 HTTP upgrade 请求被拒绝，独立网关进程继续服务健康接口', { timeout: 5000 }, async t => {
  const moduleUrl = new URL('../gateway.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `import {startGateway} from ${JSON.stringify(moduleUrl)}; const gateway=await startGateway({upstreamUrl:'ws://127.0.0.1:1/ws'}); console.log(gateway.url);`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const lines = createInterface({ input: child.stdout });
  const [url] = await once(lines, 'line'); lines.close();
  const socket = connect(Number(new URL(url).port), '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const response = Promise.race([once(socket, 'data').then(([data]) => data.toString()), exited.then(([code]) => `gateway exited ${code}: ${stderr}`)]);
  socket.write('GET //[/rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZmFrZS1maXh0dXJlLWtleQ==\r\n\r\n');
  assert.match(await response, /^HTTP\/1\.1 404 /);
  assert.equal((await (await fetch(url.replace('ws:', 'http:').replace('/ws', '/health'))).json()).service, 'suian-zcode-gateway');
});

test('本地 RPC 拒绝缺失或错误令牌以及浏览器 Origin', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Bearer fixture-rpc-token', Origin: 'http://localhost' }]) {
    const socket = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers });
    const denied = new Promise(resolve => socket.once('unexpected-response', (_request, response) => {
      response.resume(); socket.terminate(); resolve(response.statusCode);
    }));
    socket.on('error', error => assert.equal(error.message, 'WebSocket was closed before the connection was established'));
    assert.equal(await denied, 403);
  }
  assert.equal(f.bridgeOpens.length, 0);
});

test('原 Host 回复头合法但正文损坏时客户端返回协议错误，独立进程不崩溃', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-invalid-body-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const moduleUrl = new URL('../gateway-client.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `import {connectHost} from ${JSON.stringify(moduleUrl)}; let host; try {host=await connectHost(${JSON.stringify({workspacePath:workspace,gatewayConfigPath})}); await host.call('fixture','invalid-body');} catch(error){console.log(JSON.stringify({reasonCode:error.reasonCode,message:error.message}));} finally {host?.close();}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const lines = createInterface({ input: child.stdout });
  const result = Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line)), exited.then(([code]) => ({ exitCode: code, stderr }))]);
  await until(() => f.requests.length === 1);
  const writer = new BufferWriter(); serialize(writer, [201, f.requests[0][0][1]]); writer.write(VSBuffer.wrap(Buffer.from([5, 1, 123])));
  const { bridgeSessionId, bridgeGeneration } = f.bridgeOpens[0];
  for (const frame of encode(writer.buffer.buffer, { bridgeSessionId, bridgeGeneration, firstPhysicalSeq: 2, messageSeq: 2 })) f.desktop.send(JSON.stringify({ type: 'data', payload: frame }));
  const reply = await result; lines.close();
  assert.equal(reply.reasonCode, 'gateway_rpc_protocol_error', JSON.stringify(reply));
  assert.equal(reply.message.includes('{'), false, '不回显损坏的正文');
  assert.equal((await exited)[0], 0);
});

test('connectHost 遇到旧网关明确要求升级，不建立远控连接', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../remote.mjs');
  const legacy = createServer((_request, response) => response.end(JSON.stringify({ service: 'suian-zcode-gateway', version: 1, desktop_connected: true, upstream_connected: true })));
  legacy.listen(0, '127.0.0.1'); await once(legacy, 'listening');
  t.after(() => new Promise(resolve => legacy.close(resolve)));
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-upgrade-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: legacy.address().port, control_token: 'fixture-only' }));
  await assert.rejects(connectHost({ workspacePath: workspace, gatewayConfigPath }), error => error.reasonCode === 'gateway_upgrade_required');
});

test('connectHost 配置格式错误不回显令牌或原 JSON', async t => {
  const { connectHost } = await import('../remote.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-config-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, '{"control_token":"secret-fixture-marker"');
  await assert.rejects(connectHost({ workspacePath: workspace, gatewayConfigPath }), error => {
    assert.equal(error.reasonCode, 'gateway_invalid_config');
    assert.equal(error.message.includes('secret-fixture-marker'), false);
    return true;
  });
});

test('手机离线时本地鉴权客户端可调用，虚拟配对不新增官方 terminal，客户端退出后恢复真实 waiting', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'waiting');
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  await once(peer, 'open');
  const attached = new Promise((resolve, reject) => {
    peer.on('message', (data, binary) => { if (!binary && JSON.parse(data).type === 'attached') resolve(); });
    peer.once('close', (_code, reason) => reject(new Error('本地附着被拒绝：' + reason.toString())));
  });
  peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
  await attached;
  const healthUrl = f.gateway.url.replace('ws:', 'http:').replace('/ws', '/health');
  const health = await (await fetch(healthUrl)).json();
  assert.equal(health.upstream_paired, false);
  assert.equal(health.paired, true);
  assert.equal(health.local_clients, 1);
  assert.equal(health.rpc_protocol_version, 1);
  assert.equal(f.relay.clients.size, 1);
  const closed = once(peer, 'close'); peer.close(); await closed;
  await new Promise(resolve => setImmediate(resolve));
  const after = await (await fetch(healthUrl)).json();
  assert.equal(after.upstream_paired, false);
  assert.equal(after.paired, false);
  assert.equal(after.local_clients, 0);
});

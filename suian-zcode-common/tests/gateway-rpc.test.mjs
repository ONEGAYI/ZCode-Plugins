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
import { ChannelClient } from '../vendor/channelClient.js';
import { Emitter } from '../vendor/foundation.js';

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
  const faults = [], diagnostics = [];
  const gateway = await startGateway({ upstreamUrl: `ws://127.0.0.1:${relay.address().port}/ws`, controlToken: 'fixture-rpc-token', onError: error => {
    faults.push(error.code ?? error.name); diagnostics.push(error.diagnostic);
  }, ...options.gateway });
  t.after(() => gateway.close());
  const accepted = options.gateway?.mode === 'local-only' ? undefined : once(relay, 'connection');
  const desktop = new WebSocket(gateway.url);
  t.after(() => desktop.terminate());
  await once(desktop, 'open');
  let phone;
  const ack = once(desktop, 'message');
  if (accepted) { [phone] = await accepted; phone.send(JSON.stringify({ type: 'auth_ack', pair_status: pairStatus,
    ...(options.gateway?.relayProtocolVersion === 2 ? { device_sid: 'd_fixture-v2', server_ts: Math.floor(Date.now() / 1000) } : {}) })); }
  else desktop.send(JSON.stringify({ type: 'auth_init', role: 'device', device_sid: 'd_fixture-existing' }));
  await ack;
  const requests = [], bridgeOpens = [], desktopMessages = [], phoneMessages = [];
  phone?.on('message', data => phoneMessages.push(JSON.parse(data)));
  let identity, assembler, physical = 1, message = 1, helloIssued = false, boundClientId;
  let desktopPaired = pairStatus === 'matched', retiredBridge, terminalClientSessionId;
  const respond = (header, body) => {
    for (const f of encode(pack(header, body), { ...identity, firstPhysicalSeq: physical, messageSeq: message++ })) {
      physical++; desktop.send(JSON.stringify({ type: 'data', payload: f }));
    }
  };
  desktop.on('message', data => {
    const incoming = JSON.parse(data);
    desktopMessages.push(incoming);
    if (incoming.type === 'pair_status_ack') {
      if (options.gateway?.relayProtocolVersion === 2 && Object.keys(incoming).some(key => !['type', 'terminal_sid', 'pair_status', 'server_ts'].includes(key))) return;
      desktopPaired = incoming.pair_status === 'matched';
      if (options.retireBridgeOnUnpaired && !desktopPaired && identity) {
        retiredBridge = identity;
      } else if (desktopPaired && retiredBridge) {
        desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bridge-degraded', ...retiredBridge, reason: 'terminal-owner-ended' } }));
        retiredBridge = undefined;
      }
    }
    // V2 auth_ack 只在首次鉴权时生效；后续配对变化由 pair_status_ack 驱动。
    if (options.gateway?.relayProtocolVersion === 2 && incoming.type === 'data' && !desktopPaired) return;
    const p = incoming.payload;
    if (p?.zcode_type === 'bootstrap-request') {
      // 3.17.1 的 bootstrap 会更新终端归属；缺失或更换身份时销毁当前桥。
      if (options.terminalOwnerHost && terminalClientSessionId !== p.terminalClientSessionId) {
        terminalClientSessionId = p.terminalClientSessionId;
        if (identity) {
          desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bridge-degraded', ...identity, reason: 'terminal-owner-ended' } }));
          identity = undefined; assembler = undefined;
        }
      }
      desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-response', requestId: p.requestId, success: true,
        result: { workspaces: [{ kind: 'local', workspacePath: workspace }, { kind: 'local', workspacePath: 'D:\\other' },
          { kind: 'remote', workspacePath: '/remote', workspaceIdentity: 'remote:fixture', remoteSessionId: 'remote-session-fixture' }],
          ...(options.gateway?.relayProtocolVersion === 2 ? { desktopAppVersion: '3.16.1', windowControlSessionId: 'fixture-window', mobileTaskViewEpoch: 1 } : { tasks: [] }) } } }));
    } else if (p?.zcode_type === 'workspace-bridge-open') {
      bridgeOpens.push(p);
      const navError = p.taskId != null ? options.taskNavigationErrors?.[p.taskId] : undefined;
      if (navError) { desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-error', requestId: p.requestId, reason: 'task_not_found', error: navError } })); return; }
      if (options.ignoreBridge) return;
      identity = { bridgeSessionId: p.bridgeSessionId, bridgeGeneration: p.bridgeGeneration };
      assembler = new Assembler({ identity }); physical = 1; message = 1;
      helloIssued = false; boundClientId = undefined;
      const prepared = options.projectDirectories?.[p.project?.projectId];
      // 任务导航：宿主按 taskId 解析归属目录并以解析结果作为桥目标（模拟 buildWorkspaceBridge 的 task intent）
      const navigated = p.taskId != null ? options.taskDirectories?.[p.taskId] : undefined;
      desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-ready', requestId: p.requestId,
        bridge: { ...identity, kind: p.workspaceKey === 'remote:fixture' ? 'remote' : 'local', workspaceKey: p.workspaceKey,
          workspacePath: prepared?.workspacePath ?? navigated ?? (p.workspaceKey === 'remote:fixture' ? '/remote' : workspace) } } }));
      respond([200], undefined);
    } else if (p?.zcode_type === 'rpc-frame') {
      const result = assembler.accept(parse(p));
      if (result.kind === 'complete') {
        desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'rpc-frame-ack', ...identity, ackMessageSeq: result.messageSeq } }));
        const [header, body] = unpack(result.bytes);
        requests.push([header, body]);
        if (header[0] === 100 && header[2] === 'project' && header[3] === 'prepareSession' && options.projectDirectories) {
          const directories = options.projectDirectories[body[0].projectId];
          if (directories) respond([201, header[1]], directories);
          else respond([202, header[1]], { name: 'Error', message: 'project.not-found' });
        }
        if (options.v4Host && header[0] === 100 && header[2] === 'zcode-agent') {
          try {
            let reply;
            if (header[3] === 'helloConversationV4') {
              helloIssued = true;
              reply = { kind: 'hello', protocolVersion: 3, clientMode: 'web-remote-replayable' };
            } else if (header[3] === 'initializeConversationV4') {
              if (!helloIssued) throw new Error('fault.connection.helloRequired');
              if (boundClientId !== undefined && boundClientId !== body[0].clientId) throw new Error('fault.connection.clientChanged');
              boundClientId = body[0].clientId;
            } else if (header[3] === 'sendConversationCommandV4') {
              if (boundClientId === undefined) throw new Error('fault.connection.handshakeRequired');
              const { envelope } = body[0];
              if (envelope.clientId !== boundClientId) throw new Error('fault.command.clientMismatch');
              reply = { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 1,
                result: { type: 'inputAccepted', inputId: envelope.commandId, delivery: 'queue' } };
            }
            if (header[3] === 'initializeConversationV4' && options.beforeInitializeAck) {
              options.beforeInitializeAck(body[0]).then(() => respond([201, header[1]], reply));
            } else respond([201, header[1]], reply);
          } catch (error) { respond([202, header[1]], { name: error.name, message: error.message }); }
        }
      }
    }
  });
  return { gateway, desktop, phone, relay, requests, bridgeOpens, respond, faults, diagnostics, desktopMessages, phoneMessages };
}

test('V2 自动继承手机终端身份，本地命名调用与手机刷新不结束共享桥', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { terminalOwnerHost: true, gateway: { relayProtocolVersion: 2 } });
  const terminalClientSessionId = 'phone-owner-fixture';
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-request', requestId: 'phone-bootstrap', terminalClientSessionId } }));
  await until(() => f.phoneMessages.some(m => m.payload?.requestId === 'phone-bootstrap'));
  const phoneIdentity = { bridgeSessionId: 'phone-owner-bridge', bridgeGeneration: 1 };
  const phoneAssembler = new Assembler({ identity: phoneIdentity });
  let phoneReply;
  f.phone.on('message', data => {
    const p = JSON.parse(data).payload;
    if (p?.zcode_type !== 'rpc-frame') return;
    const result = phoneAssembler.accept(parse(p));
    if (result.kind === 'complete') {
      const reply = unpack(result.bytes);
      if (reply[0][0] === 201) phoneReply = reply;
    }
  });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-open',
    ...phoneIdentity, workspaceKey: workspace, terminalClientSessionId } }));
  await until(() => f.phoneMessages.some(m => m.payload?.requestId === 'phone-open'));
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-request', requestId: 'phone-refresh', terminalClientSessionId } }));
  await until(() => f.phoneMessages.some(m => m.payload?.requestId === 'phone-refresh'));
  assert.deepEqual(f.faults, [], '手机刷新相同身份时，共享桥不能因内部 bootstrap 丢失归属');

  const dir = await mkdtemp(join(tmpdir(), 'zcode-terminal-owner-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => host.close());
  for (const [channel, method, reply] of [['zcode-agent', 'generateWorkspaceText', { text: 'fixture title' }], ['zcode-task', 'renameTask', { title: 'fixture title' }]]) {
    const pending = host.call(channel, method, []);
    await until(() => f.requests.some(([header]) => header[3] === method));
    f.respond([201, f.requests.find(([header]) => header[3] === method)[0][1]], reply);
    assert.deepEqual(await pending, reply);
  }
  for (const frame of encode(pack([100, 0, 'fixture', 'phone-after-naming'], []), { ...phoneIdentity, firstPhysicalSeq: 1, messageSeq: 1 })) {
    f.phone.send(JSON.stringify({ type: 'data', payload: frame }));
  }
  await until(() => f.requests.some(([header]) => header[3] === 'phone-after-naming'));
  f.respond([201, f.requests.find(([header]) => header[3] === 'phone-after-naming')[0][1]], 'phone-ok');
  await until(() => phoneReply !== undefined);
  assert.deepEqual(phoneReply, [[201, 0], 'phone-ok']);
  assert.equal(f.bridgeOpens.length, 1);
  assert.equal(f.bridgeOpens[0].terminalClientSessionId, terminalClientSessionId);
  assert.deepEqual(f.faults, []);
});

test('V2 手机直接建桥时也能识别并继承终端身份', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'matched', { terminalOwnerHost: true, gateway: { relayProtocolVersion: 2 } });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-direct-open',
    bridgeSessionId: 'phone-direct-bridge', bridgeGeneration: 1, workspaceKey: workspace, terminalClientSessionId: 'phone-direct-owner' } }));
  await until(() => f.phoneMessages.some(m => m.payload?.requestId === 'phone-direct-open'));
  assert.equal(f.desktopMessages.find(m => m.payload?.zcode_type === 'bootstrap-request').payload.terminalClientSessionId, 'phone-direct-owner');
  assert.equal(f.bridgeOpens[0].terminalClientSessionId, 'phone-direct-owner');
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-request', requestId: 'phone-direct-refresh', terminalClientSessionId: 'phone-direct-owner' } }));
  await until(() => f.phoneMessages.some(m => m.payload?.requestId === 'phone-direct-refresh'));
  assert.deepEqual(f.faults, []);
});

test('V2 终端身份随真实配对更新，虚拟配对不能复活旧手机身份', async t => {
  for (const event of ['waiting', 'waiting-stale-bootstrap', 'replacement', 'relay-error', 'anonymous-bootstrap', 'same-terminal-heartbeat', 'nonfatal-error']) {
    await t.test(event, { timeout: 3000 }, async t => {
      const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 } });
      const local = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
      t.after(() => local.terminate());
      await once(local, 'open');
      f.phone.send(JSON.stringify({ type: 'pair_status_ack', pair_status: 'matched', terminal_sid: 'relay-phone-a', server_ts: Math.floor(Date.now() / 1000) }));
      f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-request', requestId: 'owner-before-event', terminalClientSessionId: 'phone-owner-a' } }));
      await until(() => f.phoneMessages.some(m => m.payload?.requestId === 'owner-before-event'));
      const count = f.desktopMessages.length;
      if (event.startsWith('waiting') || event === 'replacement' || event === 'same-terminal-heartbeat') {
        f.phone.send(JSON.stringify({ type: 'pair_status_ack', pair_status: event.startsWith('waiting') ? 'waiting' : 'matched',
          ...(event === 'same-terminal-heartbeat' ? {} : { terminal_sid: event === 'replacement' ? 'relay-phone-b' : '' }), server_ts: Math.floor(Date.now() / 1000) }));
      } else if (event === 'anonymous-bootstrap') {
        f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-request', requestId: 'anonymous-event' } }));
      } else {
        f.phone.send(JSON.stringify({ type: 'error', code: event === 'relay-error' ? 'INTERNAL' : 'WRONG_PARAM' }));
      }
      await until(() => f.desktopMessages.length > count);
      if (event === 'waiting-stale-bootstrap') {
        f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-request', requestId: 'stale-owner-event', terminalClientSessionId: 'phone-owner-a' } }));
        await until(() => f.phoneMessages.some(m => m.payload?.requestId === 'stale-owner-event'));
      }
      await f.gateway.bootstrap();
      const payload = f.desktopMessages.filter(m => m.payload?.zcode_type === 'bootstrap-request').at(-1).payload;
      const retained = event === 'same-terminal-heartbeat' || event === 'nonfatal-error';
      assert.equal(payload.terminalClientSessionId, retained ? 'phone-owner-a' : undefined);
      assert.deepEqual(f.faults, []);
    });
  }
});

test('V2 首次心跳前本地插件即可附着，配对通知不能重复使用 auth_ack', { timeout: 2500 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'waiting', { gateway: { relayProtocolVersion: 2 } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-v2-before-heartbeat-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const client = await connectHost({ workspacePath: workspace, gatewayConfigPath, handshakeTimeoutMs: 1000 });
  t.after(() => client.close());
  assert.equal(client.bootstrap.desktopAppVersion, '3.16.1');
  assert.ok(f.desktopMessages.some(message => message.type === 'pair_status_ack' && message.pair_status === 'matched'));
});

test('V2 空闲失配后的迟到桥失效通知不能破坏下一次本地附着', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'waiting', { retireBridgeOnUnpaired: true, gateway: { relayProtocolVersion: 2 } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-v2-retired-bridge-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  for (let round = 0; round < 4; round++) {
    const count = f.desktopMessages.filter(message => message.type === 'pair_status_ack' && message.pair_status === 'waiting').length;
    const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
    host.close();
    await until(() => f.desktopMessages.filter(message => message.type === 'pair_status_ack' && message.pair_status === 'waiting').length > count);
  }
  assert.equal(f.bridgeOpens.length, 4, '无使用者后释放旧桥，下次附着使用新身份');
  assert.deepEqual(f.faults, []);
  assert.equal(f.phoneMessages.some(message => message.payload?.zcode_type === 'bridge-degraded'), false,
    '旧物理桥的失效通知由网关消费，不泄露给手机');
});

test('V2 手机作为最后使用者断开后，本地附着不复用旧物理桥', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { retireBridgeOnUnpaired: true, gateway: { relayProtocolVersion: 2 } });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'retired-phone',
    bridgeSessionId: 'retired-phone-bridge', bridgeGeneration: 1, workspaceKey: workspace } }));
  await until(() => f.phoneMessages.some(message => message.payload?.zcode_type === 'workspace-bridge-ready'));
  f.phone.send(JSON.stringify({ type: 'pair_status_ack', terminal_sid: '', pair_status: 'waiting', server_ts: Math.floor(Date.now() / 1000) }));
  await until(() => f.desktopMessages.some(message => message.type === 'pair_status_ack' && message.pair_status === 'waiting'));
  const dir = await mkdtemp(join(tmpdir(), 'zcode-v2-retired-phone-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => host.close());
  assert.equal(f.bridgeOpens.length, 2);
  assert.deepEqual(f.faults, []);
});

test('V2 手机导航失败再失配后，本地附着不复用无人使用的旧桥', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { retireBridgeOnUnpaired: true, projectDirectories: {}, gateway: { relayProtocolVersion: 2 } });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-before-failed-navigation',
    bridgeSessionId: 'phone-initial-bridge', bridgeGeneration: 1, workspaceKey: workspace } }));
  await until(() => f.phoneMessages.some(message => message.payload?.requestId === 'phone-before-failed-navigation'));
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'failed-phone-navigation',
    bridgeSessionId: 'phone-missing-project', bridgeGeneration: 2, workspaceKey: workspace, project: { projectId: 'missing', hostId: 'local' } } }));
  await until(() => f.phoneMessages.some(message => message.payload?.requestId === 'failed-phone-navigation'));
  const failure = f.phoneMessages.find(message => message.payload?.requestId === 'failed-phone-navigation').payload;
  assert.equal(failure.zcode_type, 'workspace-bridge-error');
  assert.equal(failure.error, 'project.not-found');
  f.phone.send(JSON.stringify({ type: 'pair_status_ack', terminal_sid: '', pair_status: 'waiting', server_ts: Math.floor(Date.now() / 1000) }));
  await until(() => f.desktopMessages.some(message => message.type === 'pair_status_ack' && message.pair_status === 'waiting'));
  const dir = await mkdtemp(join(tmpdir(), 'zcode-failed-phone-navigation-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => host.close());
  assert.equal(f.bridgeOpens.length, 2);
  assert.deepEqual(f.faults, []);
});

test('本地附着中途退出时，未结束的内部会话查询仍保留 Host 桥', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 } });
  const socket = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'attach', workspace_path: workspace, session_id: 'pending-task' }));
  await until(() => f.requests.some(([header]) => header[3] === 'getTaskMeta'));
  const lookupId = f.requests[0][0][1];
  socket.close(); await once(socket, 'close');
  let health;
  for (let i = 0; i < 100; i++) {
    health = await (await fetch(f.gateway.url.replace('ws:', 'http:').replace('/ws', '/health'))).json();
    if (health.local_clients === 0) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(health.local_clients, 0);
  const dir = await mkdtemp(join(tmpdir(), 'zcode-pending-lookup-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => host.close());
  assert.equal(f.bridgeOpens.length, 1, '仍有内部请求时不能提前释放共享桥');
  f.respond([201, lookupId], { taskId: 'pending-task', workspacePath: workspace });
});

test('RPC 帧故障保留底层序号与运行身份，网关和调用方用诊断 ID 关联且不记录正文', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const errors = [];
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2, onError: error => errors.push(error) } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-diagnostic-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => host.close());
  const pending = host.call('fixture', 'noAck', ['private-message-sentinel']);
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.reasonCode, 'gateway_rpc_protocol_error');
    assert.equal(error.stage, 'gateway');
    assert.equal(error.diagnostic.phase, 'desktop_payload');
    assert.equal(error.diagnostic.reasonCode, 'gateway_rpc_protocol_error');
    assert.equal(error.diagnostic.clientPhase, 'rpc');
    assert.equal(error.diagnostic.causeCode, 'remote.rpcFrame.physicalGap');
    assert.equal(error.diagnostic.seq, 99);
    assert.equal(error.diagnostic.expectedSeq, 2);
    assert.equal(error.diagnostic.expectedMessageSeq, 2);
    assert.equal(error.diagnostic.relayProtocolVersion, 2);
    assert.equal(error.diagnostic.desktopVersion, '3.16.1');
    assert.match(error.diagnostic.gatewayBuildId, /^[a-f0-9]{64}$/);
    assert.match(error.diagnostic.id, /^[a-f0-9-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(error.diagnostic.at)));
    assert.equal(error.diagnostic.id, errors[0].diagnostic.id);
    const serialized = JSON.stringify(error.diagnostic);
    for (const privateValue of ['private-message-sentinel', 'fixture-rpc-token', workspace, f.bridgeOpens[0].bridgeSessionId]) assert.equal(serialized.includes(privateValue), false);
    return true;
  });
  await until(() => f.requests.length === 1);
  const { bridgeSessionId, bridgeGeneration } = f.bridgeOpens[0];
  for (const frame of encode(pack([201, f.requests[0][0][1]], 'private-message-sentinel'), { bridgeSessionId, bridgeGeneration, firstPhysicalSeq: 99, messageSeq: 2 })) {
    f.desktop.send(JSON.stringify({ type: 'data', payload: frame }));
  }
  await rejected;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].diagnostic.reasonCode, 'gateway_rpc_protocol_error');
});

test('默认网关日志为带时间戳的 JSON，合法桥失效保留原因且不误称字节损坏', { timeout: 3000 }, async t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { gateway: { onError: undefined } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-log-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => host.close());
  const pending = assert.rejects(host.call('fixture', 'noAck'), error => {
    assert.equal(error.diagnostic.causeCode, 'bridge_degraded');
    assert.equal(error.diagnostic.bridgeReason, 'terminal-owner-ended');
    return true;
  });
  const { bridgeSessionId, bridgeGeneration } = f.bridgeOpens[0];
  f.desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bridge-degraded', bridgeSessionId, bridgeGeneration, reason: 'terminal-owner-ended', secret: 'private-log-sentinel' } }));
  await pending;
  assert.equal(logged.length, 1);
  assert.equal(logged[0].length, 1);
  const record = JSON.parse(logged[0][0]);
  assert.equal(record.event, 'gateway_error');
  assert.equal(record.reasonCode, 'gateway_rpc_protocol_error');
  assert.equal(record.causeCode, 'bridge_degraded');
  assert.match(record.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(JSON.stringify(record).includes('private-log-sentinel'), false);
});

test('桥初始化超时在网关与客户端保留附着阶段', { timeout: 3000 }, async t => {
  const errors = [];
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { ignoreBridge: true, gateway: { bridgeTimeoutMs: 50, onError: error => errors.push(error) } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-timeout-diagnostic-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  await assert.rejects(connectHost({ workspacePath: workspace, gatewayConfigPath, handshakeTimeoutMs: 1000 }), error => {
    assert.equal(error.reasonCode, 'gateway_bridge_timeout');
    assert.equal(error.diagnostic.phase, 'bridge_initialize');
    assert.equal(error.diagnostic.clientPhase, 'attach');
    assert.equal(error.diagnostic.id, errors[0].diagnostic.id);
    return true;
  });
});

test('无效本地帧和异常关闭保留客户端阶段，拒收对端诊断中的正文与任意文本', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  let scenario = 'json';
  const http = createServer((_req, res) => res.end(JSON.stringify({ service: 'suian-zcode-gateway', rpc_protocol_version: 1, desktop_connected: true, upstream_connected: true })));
  const ws = new WebSocketServer({ server: http });
  ws.on('connection', socket => socket.once('message', () => {
    if (scenario === 'json') socket.send('{private-frame-sentinel');
    else if (scenario === 'close') socket.terminate();
    else socket.send(JSON.stringify({ type: 'error', code: 'gateway_rpc_failed', message: 'fixture', diagnostic: {
      phase: 'bootstrap', causeCode: 'private-token-sentinel', causeName: 'private-name-sentinel', payload: 'private-body-sentinel', seq: -5, expectedSeq: 2
    } }));
  }));
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => { for (const socket of ws.clients) socket.terminate(); ws.close(); http.close(); });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-client-diagnostic-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: http.address().port, control_token: 'fixture-token' }));
  for (scenario of ['json', 'close', 'untrusted']) {
    await assert.rejects(connectHost({ workspacePath: workspace, gatewayConfigPath }), error => {
      assert.equal(error.diagnostic.clientPhase, 'attach');
      if (scenario === 'json') {
        assert.equal(error.diagnostic.phase, 'rpc_message');
        assert.equal(error.diagnostic.causeName, 'SyntaxError');
        assert.equal(error.diagnostic.frameBinary, false);
        assert.equal(error.diagnostic.frameBytes, 23);
      } else if (scenario === 'close') assert.equal(error.diagnostic.closeCode, 1006);
      else {
        assert.equal(error.diagnostic.phase, 'bootstrap');
        assert.equal(error.diagnostic.expectedSeq, 2);
        assert.equal(error.diagnostic.seq, undefined);
      }
      assert.equal(JSON.stringify(error.diagnostic).includes('private-'), false);
      return true;
    });
  }
});

test('Desktop 无 error 事件的异常关闭也有日志，并将诊断关联到在飞 RPC', { timeout: 3000 }, async t => {
  const errors = [];
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { gateway: { onError: error => errors.push(error) } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-close-diagnostic-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => host.close());
  const pending = assert.rejects(host.call('fixture', 'noAck'), error => {
    assert.equal(error.diagnostic.closeCode, 1006);
    assert.equal(error.diagnostic.source, 'desktop');
    assert.equal(error.diagnostic.id, errors[0].diagnostic.id);
    return true;
  });
  await until(() => f.requests.length === 1);
  f.desktop.terminate();
  await pending;
  assert.equal(errors.length, 1, '同一次关闭不重复记录两条错误');
});

test('健康检查报告未就绪时仍保留健康阶段和实际网关身份', async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const http = createServer((_req, res) => res.end(JSON.stringify({ service: 'suian-zcode-gateway', rpc_protocol_version: 1,
    desktop_connected: false, upstream_connected: true, relay_protocol_version: 2, build: { version: '0.7.2', id: 'a'.repeat(64) } })));
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => http.close());
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-health-diagnostic-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: http.address().port, control_token: 'fixture-token' }));
  await assert.rejects(connectHost({ workspacePath: workspace, gatewayConfigPath }), error => {
    assert.equal(error.reasonCode, 'gateway_desktop_offline');
    assert.equal(error.diagnostic.phase, 'health');
    assert.equal(error.diagnostic.gatewayBuildId, 'a'.repeat(64));
    assert.equal(error.diagnostic.gatewayVersion, '0.7.2');
    return true;
  });
});

test('诊断附加不把 Host 允许的非 Error 拒绝值改写为 TypeError', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-rejection-diagnostic-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => host.close());
  for (const value of ['remote rejection', null]) {
    const count = f.requests.length;
    const pending = host.call('fixture', 'noAck').then(() => assert.fail('应保留 Host 拒绝值'), error => assert.equal(error, value));
    await until(() => f.requests.length > count);
    f.respond([203, f.requests.at(-1)[0][1]], value);
    await pending;
  }
});

test('附着后的健康复查失败仍返回健康阶段及诊断信息', async t => {
  const { probeHost } = await import('../gateway-client.mjs');
  let checks = 0;
  const http = createServer((req, res) => {
    if (++checks > 1) { req.socket.destroy(); return; }
    res.end(JSON.stringify({ service: 'suian-zcode-gateway', rpc_protocol_version: 1, desktop_connected: true, upstream_connected: true,
      build: { version: '0.7.2', id: 'b'.repeat(64) } }));
  });
  const ws = new WebSocketServer({ server: http });
  ws.on('connection', socket => socket.once('message', () => {
    socket.send(JSON.stringify({ type: 'attached', bootstrap: {}, workspace_path: workspace }));
    socket.send(pack([200]));
  }));
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => { for (const socket of ws.clients) socket.terminate(); ws.close(); http.close(); });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-reprobe-diagnostic-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: http.address().port, control_token: 'fixture-token' }));
  const result = await probeHost({ workspacePath: workspace, gatewayConfigPath, timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'gateway_unreachable');
  assert.equal(result.diagnostic.phase, 'health');
  assert.equal(result.diagnostic.clientPhase, 'health');
  assert.equal(result.diagnostic.gatewayBuildId, 'b'.repeat(64));
});

test('V2 多执行目录按各自会话归属附着，手机与插件仍共用一个 Host 桥', { timeout: 4000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-project-rpc-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const attach = async (workspacePath, sessionId, actualPath = workspacePath) => {
    const count = f.requests.length;
    const pending = connectHost({ workspacePath, sessionId, gatewayConfigPath });
    const observed = pending.then(value => ({ value }), error => ({ error }));
    await until(() => f.requests.length > count);
    const [header, body] = f.requests.at(-1);
    assert.equal(header[3], 'getTaskMeta');
    assert.equal(body[0].workspacePath, workspacePath);
    f.respond([201, header[1]], { taskId: sessionId, workspacePath: actualPath });
    return observed;
  };
  const a = (await attach(workspace, 'session_a')).value;
  const b = (await attach('D:\\other', 'session_b')).value;
  t.after(() => { a?.close(); b?.close(); });
  assert.ok(a); assert.ok(b);
  const wrong = await attach('D:\\other', 'session_a', workspace);
  assert.match(wrong.error.message, /Session is not present/);
  const ready = Promise.withResolvers();
  f.phone.on('message', data => { const payload = JSON.parse(data).payload; if (payload?.zcode_type === 'workspace-bridge-ready') ready.resolve(payload); });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-project-open',
    bridgeSessionId: 'phone-project-bridge', bridgeGeneration: 1, workspaceKey: 'D:\\other', taskId: 'session_b' } }));
  assert.equal((await ready.promise).bridge.workspacePath, 'D:\\other');
  assert.equal(f.bridgeOpens.length, 1);
  assert.equal(f.relay.clients.size, 1);
  assert.deepEqual(f.faults, ['Error'], '会话归属不符也应留失败诊断');
  assert.equal(f.diagnostics[0].phase, 'session_lookup');
  assert.equal(f.diagnostics[0].reasonCode, 'gateway_error');
});

for (const rootCount of [1, 3]) test(`V2 ${rootCount} 个根目录项目导航采用 Host 主目录且不打断插件`, { timeout: 4000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const directories = { projectId: 'multi-project', workspacePath: 'D:\\project-primary',
    additionalDirectories: rootCount === 1 ? [] : ['D:\\project-extra-a', 'D:\\project-extra-b'] };
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 }, v4Host: true,
    projectDirectories: { 'multi-project': directories } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-project-navigation-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const plugin = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => plugin.close());
  await plugin.call('zcode-agent', 'helloConversationV4');
  await plugin.call('zcode-agent', 'initializeConversationV4', [{ clientId: 'plugin-before-project' }]);

  const phoneIdentity = { bridgeSessionId: 'phone-multi-project', bridgeGeneration: 1 };
  const emitter = new Emitter(), phoneReady = Promise.withResolvers();
  let phoneAssembler, seq = 1, messageSeq = 1;
  const phone = new ChannelClient({ onMessage: emitter.event, send: bytes => {
    const frames = encode(bytes.buffer, { ...phoneIdentity, firstPhysicalSeq: seq, messageSeq: messageSeq++ });
    seq += frames.length;
    for (const frame of frames) f.phone.send(JSON.stringify({ type: 'data', payload: frame }));
  } });
  t.after(() => { phone.dispose(); emitter.dispose(); });
  f.phone.on('message', data => {
    const payload = JSON.parse(data).payload;
    if (payload?.zcode_type === 'workspace-bridge-ready') {
      phoneAssembler = new Assembler({ identity: phoneIdentity }); phoneReady.resolve(payload.bridge);
    } else if (payload?.zcode_type === 'workspace-bridge-error') phoneReady.reject(new Error(payload.error));
    else if (payload?.zcode_type === 'rpc-frame') {
      const result = phoneAssembler.accept(parse(payload));
      if (result.kind === 'complete') emitter.fire(VSBuffer.wrap(result.bytes));
    }
  });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'open-multi-project',
    ...phoneIdentity, workspaceKey: workspace, project: { projectId: 'multi-project', hostId: 'local' } } }));
  const bridge = await phoneReady.promise;
  assert.equal(bridge.workspacePath, 'D:\\project-primary');
  assert.equal(bridge.workspaceKey, 'D:\\project-primary');
  assert.deepEqual(f.requests.find(([header]) => header[2] === 'project' && header[3] === 'prepareSession')[1],
    [{ projectId: 'multi-project', hostId: 'local' }]);
  assert.deepEqual(await phone.getChannel('project').call('prepareSession', [{ projectId: 'multi-project' }]), directories,
    '主目录和附加目录保持 Host 的原始解析结果');
  await phone.getChannel('zcode-agent').call('helloConversationV4', []);
  await phone.getChannel('zcode-agent').call('initializeConversationV4', [{ clientId: 'phone-project-client' }]);
  const replies = await Promise.all([
    phone.getChannel('zcode-agent').call('sendConversationCommandV4', [{ workspacePath: bridge.workspacePath,
      envelope: { clientId: 'phone-project-client', commandId: 'phone-project-send', sessionId: 'project-session' } }]),
    plugin.call('zcode-agent', 'sendConversationCommandV4', [{ workspacePath: workspace,
      envelope: { clientId: 'plugin-before-project', commandId: 'plugin-after-project', sessionId: 'plugin-session' } }]),
  ]);
  assert.deepEqual(replies.map(reply => reply.status), ['accepted', 'accepted']);
  assert.equal(f.bridgeOpens.length, 1, '本地项目导航仍复用同一窗口 Host 桥');
  assert.equal(f.relay.clients.size, 1);
  assert.deepEqual(f.faults, []);
});

for (const pluginFirst of [false, true]) test(`V2 手机项目首页导航不依赖旧 workspaceKey，插件先接入=${pluginFirst}`, { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 },
    projectDirectories: { 'cold-project': { projectId: 'cold-project', workspacePath: 'D:\\cold-primary', additionalDirectories: ['D:\\cold-extra'] } } });
  if (pluginFirst) {
    const dir = await mkdtemp(join(tmpdir(), 'zcode-project-home-'));
    t.after(() => rm(dir, { recursive: true }));
    const gatewayConfigPath = join(dir, 'config.json');
    await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
    const plugin = await connectHost({ workspacePath: workspace, gatewayConfigPath });
    t.after(() => plugin.close());
  }
  const response = new Promise(resolve => f.phone.on('message', data => {
    const payload = JSON.parse(data).payload;
    if (['workspace-bridge-ready', 'workspace-bridge-error'].includes(payload?.zcode_type)) resolve(payload);
  }));
  const project = { projectId: 'cold-project', hostId: 'local' };
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'project-home-open',
    bridgeSessionId: 'project-home-bridge', bridgeGeneration: 1, workspaceKey: 'project-navigation', project } }));
  const reply = await response;
  assert.equal(reply.zcode_type, 'workspace-bridge-ready', reply.error);
  assert.equal(reply.bridge.workspacePath, 'D:\\cold-primary');
  assert.equal(reply.bridge.workspaceKey, 'D:\\cold-primary');
  assert.equal(f.bridgeOpens.length, 1);
  if (!pluginFirst) assert.deepEqual(f.bridgeOpens[0].project, project);
  assert.deepEqual(f.faults, []);
});

test('V2 目标项目不存在时返回 Host 错误，不以旧目录冒充成功且插件继续可用', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 }, v4Host: true, projectDirectories: {} });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-project-error-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const plugin = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => plugin.close());
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'missing-project',
    bridgeSessionId: 'missing-project-bridge', bridgeGeneration: 1, workspaceKey: workspace,
    project: { projectId: 'missing', hostId: 'local' } } }));
  await until(() => f.phoneMessages.some(message => message.payload?.requestId === 'missing-project'));
  const reply = f.phoneMessages.find(message => message.payload?.requestId === 'missing-project').payload;
  assert.equal(reply.zcode_type, 'workspace-bridge-error');
  assert.equal(reply.error, 'project.not-found');
  assert.equal((await plugin.call('zcode-agent', 'helloConversationV4')).protocolVersion, 3);
  assert.equal(f.bridgeOpens.length, 1);
  assert.deepEqual(f.faults, []);
});

test('V2 快速切换项目时迟到的解析结果不能覆盖当前手机目录', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 }, v4Host: true });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-project-race-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const plugin = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => plugin.close());
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'slow-project',
    bridgeSessionId: 'slow-bridge', bridgeGeneration: 1, workspaceKey: workspace,
    project: { projectId: 'slow', hostId: 'local' } } }));
  await until(() => f.requests.length === 1);
  const first = f.requests[0][0][1];
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'current-project',
    bridgeSessionId: 'current-bridge', bridgeGeneration: 2, workspaceKey: workspace,
    project: { projectId: 'current', hostId: 'local' } } }));
  await until(() => f.requests.length === 2);
  f.respond([201, f.requests[1][0][1]], { projectId: 'current', workspacePath: 'D:\\current-primary', additionalDirectories: ['D:\\current-extra'] });
  await until(() => f.phoneMessages.some(message => message.payload?.requestId === 'current-project'));
  f.respond([201, first], { projectId: 'slow', workspacePath: 'D:\\slow-primary', additionalDirectories: [] });
  // 同一 Host 上的后续 RPC 回包证明旧解析回复已先被消费。
  assert.equal((await plugin.call('zcode-agent', 'helloConversationV4')).protocolVersion, 3);
  const replies = f.phoneMessages.map(message => message.payload).filter(payload => payload?.zcode_type === 'workspace-bridge-ready');
  assert.deepEqual(replies.map(reply => [reply.requestId, reply.bridge.workspacePath]), [['current-project', 'D:\\current-primary']]);
  assert.equal(f.bridgeOpens.length, 1);
});

for (const relayProtocolVersion of [1, 2]) test(`relay V${relayProtocolVersion} 旧工作区请求无需 project 服务，手机与插件仍共用桥`, { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion } });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'legacy-phone-open',
    bridgeSessionId: 'legacy-phone-bridge', bridgeGeneration: 1, workspaceKey: workspace } }));
  await until(() => f.phoneMessages.some(message => message.payload?.zcode_type === 'workspace-bridge-ready'));
  const ready = f.phoneMessages.find(message => message.payload?.zcode_type === 'workspace-bridge-ready').payload;
  assert.equal(ready.bridge.workspacePath, workspace);
  const dir = await mkdtemp(join(tmpdir(), 'zcode-legacy-project-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const plugin = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => plugin.close());
  assert.equal(f.requests.length, 0, '旧 Desktop 不需要新增 project RPC 服务');
  assert.equal(f.bridgeOpens.length, 1);
  assert.equal(f.bridgeOpens[0].project, undefined);
  assert.deepEqual(f.faults, []);
});

for (const relayProtocolVersion of [1, 2]) test(`relay V${relayProtocolVersion}：v4 手机与多个本地客户端分别握手后共用 Host 桥，后加入者及重连者仍可发信`, { timeout: 5000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  for (const phoneFirst of [true, false, 'parallel']) {
    const gate = Promise.withResolvers(), phoneInitializing = Promise.withResolvers();
    t.after(() => gate.resolve());
    const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion }, v4Host: true, beforeInitializeAck: async params => {
      if (phoneFirst === 'parallel' && params.capabilities?.workflowRunDeltas === true) {
        phoneInitializing.resolve(); await gate.promise;
      }
    } });
    const dir = await mkdtemp(join(tmpdir(), 'zcode-v4-rpc-'));
    t.after(() => rm(dir, { recursive: true }));
    const gatewayConfigPath = join(dir, 'config.json');
    await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
    const emitter = new Emitter(), phoneReady = Promise.withResolvers();
    const phoneIdentity = { bridgeSessionId: 'phone-v4', bridgeGeneration: 1 };
    let phoneAssembler, seq = 1, messageSeq = 1;
    const phone = new ChannelClient({ onMessage: emitter.event, send: bytes => {
      const frames = encode(bytes.buffer, { ...phoneIdentity, firstPhysicalSeq: seq, messageSeq: messageSeq++ });
      seq += frames.length;
      for (const frame of frames) f.phone.send(JSON.stringify({ type: 'data', payload: frame }));
    } });
    t.after(() => { phone.dispose(); emitter.dispose(); });
    f.phone.on('message', data => {
      const payload = JSON.parse(data).payload;
      if (payload?.zcode_type === 'workspace-bridge-ready') { phoneAssembler = new Assembler({ identity: phoneIdentity }); phoneReady.resolve(); }
      else if (payload?.zcode_type === 'rpc-frame') {
        const result = phoneAssembler.accept(parse(payload));
        if (result.kind === 'complete') emitter.fire(VSBuffer.wrap(result.bytes));
      }
    });
    const phoneApi = { call: (channel, method, args = []) => phone.getChannel(channel).call(method, args) };
    const handshake = async (api, clientId, capabilities) => {
      const hello = await api.call('zcode-agent', 'helloConversationV4');
      assert.equal(hello.protocolVersion, 3);
      await api.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: 3, clientId,
        clientKind: 'web', appVersion: 'fixture', ...(capabilities ? { capabilities } : {}) }]);
    };
    const send = (api, clientId, commandId) => api.call('zcode-agent', 'sendConversationCommandV4', [{ workspacePath: workspace,
      envelope: { clientId, commandId, sessionId: 'sess_fixture', type: 'sendText', issuedAt: 1, payload: { text: '原样正文', requestedDelivery: 'queue' } } }]);
    const startPhone = async () => {
      f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-open', ...phoneIdentity, workspaceKey: workspace } }));
      await phoneReady.promise;
      await handshake(phoneApi, 'phone-client', { workflowRunDeltas: true });
    };
    if (phoneFirst === true) await startPhone();
    const first = await connectHost({ workspacePath: workspace, gatewayConfigPath });
    t.after(() => first.close());
    if (phoneFirst === 'parallel') {
      const phoneHandshake = startPhone();
      await phoneInitializing.promise;
      await first.call('zcode-agent', 'helloConversationV4');
      const localHandshake = first.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: 3,
        clientId: 'local-first', clientKind: 'web', appVersion: 'fixture' }]);
      await first.call('zcode-agent', 'helloConversationV4');
      const invalid = await connectHost({ workspacePath: workspace, gatewayConfigPath });
      t.after(() => invalid.close());
      await invalid.call('zcode-agent', 'helloConversationV4');
      const invalidResult = invalid.call('zcode-agent', 'initializeConversationV4', [{ clientId: 42 }])
        .then(() => 'unexpected success', error => error.message);
      const barrier = await invalid.call('zcode-agent', 'helloConversationV4').then(() => 'ok', error => error.message);
      assert.ok(barrier === 'ok' || /Invalid v4 clientId/.test(barrier));
      gate.resolve();
      await Promise.all([phoneHandshake, localHandshake]);
      assert.match(await invalidResult, /Invalid v4 clientId/);
      assert.deepEqual(f.faults, ['Error']);
      assert.equal(f.diagnostics[0].phase, 'rpc_request', '非法输入记录为本地请求失败，不能冒充 Desktop 协议故障');
      assert.equal(f.diagnostics[0].reasonCode, 'gateway_error');
      assert.equal(f.requests.filter(([header]) => header[3] === 'initializeConversationV4').at(-1)[1][0].capabilities?.workflowRunDeltas, true);
    } else {
      await handshake(first, 'local-first');
      if (!phoneFirst) await startPhone();
    }
    const second = await connectHost({ workspacePath: workspace, gatewayConfigPath });
    t.after(() => second.close());
    await assert.rejects(send(second, 'local-second', 'cmd-uninitialized'), /fault.connection.handshakeRequired/);
    await assert.rejects(second.call('zcode-agent', 'initializeConversationV4', [{ clientId: 'local-second' }]), /fault.connection.helloRequired/);
    await handshake(second, 'local-second');
    await assert.rejects(second.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: 3,
      clientId: 'local-changed', appVersion: 'fixture' }]), /fault.connection.clientChanged/);
    await assert.rejects(send(second, 'phone-client', 'cmd-forged'), /fault.command.clientMismatch/);
    const acks = await Promise.all([send(first, 'local-first', 'cmd-first'), send(second, 'local-second', 'cmd-second'), send(phoneApi, 'phone-client', 'cmd-phone')]);
    assert.deepEqual(acks.map(ack => [ack.status, ack.result.inputId]), [['accepted', 'cmd-first'], ['accepted', 'cmd-second'], ['accepted', 'cmd-phone']]);
    first.close();
    const reconnected = await connectHost({ workspacePath: workspace, gatewayConfigPath });
    t.after(() => reconnected.close());
    await handshake(reconnected, 'local-reconnected');
    assert.equal((await send(reconnected, 'local-reconnected', 'cmd-reconnected')).status, 'accepted');
    assert.equal((await send(phoneApi, 'phone-client', 'cmd-phone-again')).status, 'accepted');
    assert.equal(f.bridgeOpens.length, 1);
    const commands = f.requests.filter(([header]) => header[3] === 'sendConversationCommandV4');
    assert.ok(commands.every(([, body]) => body[0].envelope.payload.text === '原样正文'));
    assert.equal(f.requests.filter(([header]) => header[3] === 'initializeConversationV4').at(-1)[1][0].capabilities.workflowRunDeltas, true);
    if (relayProtocolVersion === 2) {
      for (const message of f.desktopMessages.filter(m => m.type === 'data')) {
        assert.equal(message.client_ts, undefined);
        assert.ok(Math.abs(message.server_ts - Math.floor(Date.now() / 1000)) <= 5);
      }
      assert.ok(f.phoneMessages.some(m => m.type === 'data'));
      for (const message of f.phoneMessages.filter(m => m.type === 'data')) {
        assert.equal(message.server_ts, undefined);
        assert.ok(Math.abs(message.client_ts - Math.floor(Date.now() / 1000)) <= 5);
      }
    }
  }
});

test('被本地校验拒绝的 v4 握手不阻塞排队中其他客户端的 initialize', { timeout: 5000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const gate = Promise.withResolvers(), holding = Promise.withResolvers();
  t.after(() => gate.resolve());
  let forwarded = 0;
  const f = await fixture(t, 'matched', { v4Host: true, beforeInitializeAck: async () => {
    if (++forwarded === 1) { holding.resolve(); await gate.promise; }
  } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-v4-queue-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const holder = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => holder.close());
  await holder.call('zcode-agent', 'helloConversationV4');
  const holderInit = holder.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: 3, clientId: 'holder', clientKind: 'web', appVersion: 'fixture' }]);
  await holding.promise;
  const bad = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => bad.close());
  const badInit = bad.call('zcode-agent', 'initializeConversationV4', [{ clientId: 'bad' }]);
  const good = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => good.close());
  await good.call('zcode-agent', 'helloConversationV4');
  const goodInit = good.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: 3, clientId: 'good', clientKind: 'web', appVersion: 'fixture' }]);
  await new Promise(resolve => setTimeout(resolve, 30));
  gate.resolve();
  await holderInit;
  await assert.rejects(badInit, /fault.connection.helloRequired/);
  await Promise.race([goodInit, new Promise((_, reject) => setTimeout(() => reject(new Error('被拒握手后的排队 initialize 未被转发')), 1500))]);
  const ack = await good.call('zcode-agent', 'sendConversationCommandV4', [{ workspacePath: workspace,
    envelope: { clientId: 'good', commandId: 'cmd-after-rejected', sessionId: 'sess_fixture', type: 'sendText', issuedAt: 1, payload: { text: '原样正文' } } }]);
  assert.equal(ack.status, 'accepted');
});

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

test('本地模式以原有设备会话启动，客户端无官方上游仍可附着、调用与探活', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../remote.mjs');
  const f = await fixture(t, 'matched', { gateway: { mode: 'local-only' } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-local-rpc-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath });
  t.after(() => host.close());
  const pending = host.call('fixture', 'echo', ['local-only']);
  await until(() => f.requests.length === 1);
  f.respond([201, f.requests[0][0][1]], { echoed: 'local-only' });
  assert.deepEqual(await pending, { echoed: 'local-only' });
  const status = await host.probe();
  assert.equal(status.ok, true);
  assert.equal(status.mode, 'local-only');
  assert.equal(status.upstreamPaired, false);
  assert.equal(f.relay.clients.size, 0);
  assert.equal(f.bridgeOpens.length, 1);
  assert.deepEqual(f.faults, []);
});

test('已鉴权 relay 的 INTERNAL 不截断正在执行的本地 RPC，手机仍可重新配对', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../remote.mjs');
  const f = await fixture(t, 'waiting');
  const dir = await mkdtemp(join(tmpdir(), 'zcode-relay-rpc-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const host = await connectHost({ workspacePath: workspace, gatewayConfigPath, timeoutMs: 1000 });
  t.after(() => host.close());
  const pending = host.call('fixture', 'sendPrompt', ['opening']).then(value => ({ value }), error => ({ error: error.message }));
  await until(() => f.requests.length === 1);
  const relayHandled = once(f.desktop, 'message');
  f.phone.send('{"type":"error","code":"INTERNAL"}');
  await relayHandled;
  f.respond([201, f.requests[0][0][1]], { accepted: true });
  assert.deepEqual(await pending, { value: { accepted: true } });
  const healthUrl = f.gateway.url.replace('ws:', 'http:').replace('/ws', '/health');
  const health = await (await fetch(healthUrl)).json();
  assert.equal(health.paired, true);
  assert.equal(health.upstream_paired, false);
  assert.equal(health.local_clients, 1);
  assert.equal(f.bridgeOpens.length, 1);
  const paired = once(f.desktop, 'message');
  f.phone.send('{"type":"pair_status_ack","pair_status":"matched"}');
  await paired;
  assert.equal((await (await fetch(healthUrl)).json()).upstream_paired, true);
  await assert.rejects(host.call('fixture', 'noAck'), error => error.reasonCode === 'gateway_timeout');
  assert.deepEqual(f.faults, []);
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
  assert.equal(f.bridgeOpens.length, 2, '失效手机是最后使用者，后续本地客户端建立新桥');
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

test('公共连接监听保留直接对象参数，独立投递事件并在dispose或close取消原监听', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t), dir = await mkdtemp(join(tmpdir(), 'zcode-rpc-listen-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const hosts = [], listeners = [], values = [[], []];
  for (const [index, owner] of ['left', 'right'].entries()) {
    const host = await connectHost({ workspacePath: workspace, gatewayConfigPath, timeoutMs: 2000 }); hosts.push(host); t.after(() => host.close());
    assert.equal(typeof host.listen, 'function', '公共连接尚未提供已核实的Channel事件监听入口');
    listeners.push(host.listen('fixture', 'onFrames', { workspacePath: workspace, owner })(frame => values[index].push(frame)));
  }
  await until(() => f.requests.filter(([header]) => header[0] === 102).length === 2);
  const subscriptions = f.requests.filter(([header]) => header[0] === 102);
  assert.deepEqual(subscriptions.map(([header, args]) => [header.slice(2), args]), [
    [['fixture', 'onFrames'], { workspacePath: workspace, owner: 'left' }],
    [['fixture', 'onFrames'], { workspacePath: workspace, owner: 'right' }]
  ], 'listen参数必须直接为对象，不能套用call的参数数组');
  const leftId = subscriptions[0][0][1], rightId = subscriptions[1][0][1];
  f.respond([204, leftId], { owner: 'left', value: 1 }); f.respond([204, rightId], { owner: 'right', value: 1 });
  await until(() => values.every(frames => frames.length === 1));
  assert.deepEqual(values, [[{ owner: 'left', value: 1 }], [{ owner: 'right', value: 1 }]]);
  listeners[0].dispose(); await until(() => f.requests.some(([header]) => header[0] === 103 && header[1] === leftId));
  f.respond([204, leftId], { owner: 'left', value: 2 }); f.respond([204, rightId], { owner: 'right', value: 2 });
  await until(() => values[1].length === 2); assert.equal(values[0].length, 1, '取消后的迟到事件不投递');
  hosts[1].close(); await until(() => f.requests.some(([header]) => header[0] === 103 && header[1] === rightId));
  assert.equal(f.bridgeOpens.length, 1, '共用原物理桥，监听仍各归原客户端');
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
  await assert.rejects(connectHost({ workspacePath: workspace, gatewayConfigPath }), error => {
    assert.equal(error.reasonCode, 'gateway_upgrade_required');
    assert.match(error.message, /暂停移动端远控/);
    assert.ok(!error.message.includes('完整退出'));
    return true;
  });
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

test('V2 未登记工作区携带会话身份时经任务导航附着，宿主解析目录后完成归属校验', { timeout: 4000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const draft = 'C:\\Users\\fixture\\workspace\\draft-unregistered';
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 }, taskDirectories: { session_draft1: draft } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-task-nav-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const observed = connectHost({ workspacePath: draft, sessionId: 'session_draft1', gatewayConfigPath, handshakeTimeoutMs: 2000 })
    .then(value => ({ value }), error => ({ error }));
  await until(() => f.bridgeOpens.some(p => p.taskId === 'session_draft1'));
  const open = f.bridgeOpens.find(p => p.taskId === 'session_draft1');
  assert.equal(open.workspaceKey, draft);
  assert.equal(open.taskHostId, 'local');
  await until(() => f.requests.some(([header]) => header[3] === 'getTaskMeta'));
  const [header, body] = f.requests.find(([header]) => header[3] === 'getTaskMeta');
  assert.equal(body[0].taskId, 'session_draft1');
  assert.equal(body[0].workspacePath, draft);
  f.respond([201, header[1]], { taskId: 'session_draft1', workspacePath: draft });
  const { value: client, error } = await observed;
  assert.ok(client, '未登记工作区应经任务导航完成附着，实际错误：' + (error?.message ?? '无'));
  t.after(() => client?.close());
});

test('V2 手机打开未登记工作区的会话：任务身份透传宿主导航，ready 返回归属目录', { timeout: 3000 }, async t => {
  const draft = 'C:\\Users\\fixture\\workspace\\draft-phone';
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 }, taskDirectories: { session_draft2: draft } });
  const outcome = Promise.withResolvers();
  f.phone.on('message', data => {
    const payload = JSON.parse(data).payload;
    if (payload?.zcode_type === 'workspace-bridge-ready') outcome.resolve(payload);
    else if (payload?.zcode_type === 'workspace-bridge-error') outcome.reject(new Error(payload.error));
  });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-task-open',
    bridgeSessionId: 'phone-task-bridge', bridgeGeneration: 1, workspaceKey: draft, taskId: 'session_draft2', taskHostId: 'local' } }));
  const ready = await outcome.promise;
  assert.equal(ready.bridge.workspacePath, draft);
  assert.equal(ready.bridge.initialTaskId, 'session_draft2');
  const open = f.bridgeOpens.find(p => p.taskId === 'session_draft2');
  assert.equal(open?.taskHostId, 'local');
  assert.equal(open?.workspaceKey, draft);
});

test('V2 桥已被插件占用时手机打开未登记会话：复用桥并经 Host 复核任务归属', { timeout: 4000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const draft = 'C:\\Users\\fixture\\workspace\\draft-reused';
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 }, taskDirectories: { session_draft3: draft } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-task-reused-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const plugin = await connectHost({ workspacePath: workspace, gatewayConfigPath, handshakeTimeoutMs: 2000 });
  t.after(() => plugin.close());
  const outcome = Promise.withResolvers();
  f.phone.on('message', data => {
    const payload = JSON.parse(data).payload;
    if (payload?.zcode_type === 'workspace-bridge-ready') outcome.resolve(payload);
    else if (payload?.zcode_type === 'workspace-bridge-error') outcome.reject(new Error(payload.error));
  });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-task-reused',
    bridgeSessionId: 'phone-reused-bridge', bridgeGeneration: 1, workspaceKey: draft, taskId: 'session_draft3', taskHostId: 'local' } }));
  await until(() => f.requests.some(([header]) => header[3] === 'getTaskMeta'));
  const [header, body] = f.requests.find(([header]) => header[3] === 'getTaskMeta');
  assert.equal(body[0].taskId, 'session_draft3');
  assert.equal(body[0].workspacePath, draft);
  f.respond([201, header[1]], { taskId: 'session_draft3', workspacePath: draft });
  const ready = await outcome.promise;
  assert.equal(ready.bridge.workspacePath, draft);
  assert.equal(ready.bridge.initialTaskId, 'session_draft3');
});

test('V2 未登记工作区且无任务身份仍拒绝：手机与本地插件两条路径', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 } });
  const phoneError = Promise.withResolvers();
  f.phone.on('message', data => { const p = JSON.parse(data).payload; if (p?.zcode_type === 'workspace-bridge-error') phoneError.resolve(p); });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-no-task',
    bridgeSessionId: 'phone-no-task-b', bridgeGeneration: 1, workspaceKey: 'D:\\never-registered' } }));
  assert.match((await phoneError.promise).error, /not open in the Desktop window/);
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  await once(peer, 'open');
  const localError = new Promise(resolve => peer.on('message', (d, binary) => { if (!binary) { const m = JSON.parse(d); if (m.type === 'error') resolve(m); } }));
  peer.send(JSON.stringify({ type: 'attach', workspace_path: 'D:\\never-registered' }));
  const local = await localError;
  assert.equal(local.code, 'gateway_rpc_failed');
  assert.match(local.message, /not open in the Desktop window/);
});

test('V2 非 local 任务主机的未登记请求维持拒绝，不进入任务导航', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 } });
  const phoneError = Promise.withResolvers();
  f.phone.on('message', data => { const p = JSON.parse(data).payload; if (p?.zcode_type === 'workspace-bridge-error') phoneError.resolve(p); });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-remote-host',
    bridgeSessionId: 'phone-remote-b', bridgeGeneration: 1, workspaceKey: 'D:\\remote-host-task', taskId: 'session_remote', taskHostId: 'ssh-1' } }));
  assert.match((await phoneError.promise).error, /not open in the Desktop window/);
  assert.ok(!f.bridgeOpens.some(p => p.taskId === 'session_remote'), '不应向宿主转发远端任务导航帧');
});

test('V2 桥复用下任务归属复核不符时拒绝打开并回错误', { timeout: 4000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const draft = 'C:\\Users\\fixture\\workspace\\draft-forged';
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 } });
  const dir = await mkdtemp(join(tmpdir(), 'zcode-task-forged-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const plugin = await connectHost({ workspacePath: workspace, gatewayConfigPath, handshakeTimeoutMs: 2000 });
  t.after(() => plugin.close());
  const phoneError = Promise.withResolvers();
  f.phone.on('message', data => { const p = JSON.parse(data).payload; if (p?.zcode_type === 'workspace-bridge-error') phoneError.resolve(p); });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-task-forged',
    bridgeSessionId: 'phone-forged-b', bridgeGeneration: 1, workspaceKey: draft, taskId: 'session_forged', taskHostId: 'local' } }));
  await until(() => f.requests.some(([header]) => header[3] === 'getTaskMeta'));
  const [header] = f.requests.find(([header]) => header[3] === 'getTaskMeta');
  f.respond([201, header[1]], { taskId: 'session_forged', workspacePath: workspace });
  assert.match((await phoneError.promise).error, /Session is not present/);
});

test('V2 宿主任务导航失败时错误回传手机，本地附着同因失败', { timeout: 3000 }, async t => {
  const { connectHost } = await import('../gateway-client.mjs');
  const f = await fixture(t, 'matched', { gateway: { relayProtocolVersion: 2 },
    taskNavigationErrors: { session_missing: 'project.task-not-found' } });
  const phoneError = Promise.withResolvers();
  f.phone.on('message', data => { const p = JSON.parse(data).payload; if (p?.zcode_type === 'workspace-bridge-error') phoneError.resolve(p); });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-task-missing',
    bridgeSessionId: 'phone-missing-b', bridgeGeneration: 1, workspaceKey: 'D:\\ghost-draft', taskId: 'session_missing', taskHostId: 'local' } }));
  assert.match((await phoneError.promise).error, /project.task-not-found/);
  const dir = await mkdtemp(join(tmpdir(), 'zcode-task-missing-'));
  t.after(() => rm(dir, { recursive: true }));
  const gatewayConfigPath = join(dir, 'config.json');
  await writeFile(gatewayConfigPath, JSON.stringify({ version: 1, port: Number(new URL(f.gateway.url).port), control_token: 'fixture-rpc-token' }));
  const observed = connectHost({ workspacePath: 'D:\\ghost-draft', sessionId: 'session_missing', gatewayConfigPath, handshakeTimeoutMs: 1500 })
    .then(value => ({ value }), error => ({ error }));
  const { error } = await observed;
  assert.match(error?.message, /原 Host 桥初始化超时|project.task-not-found|workspace-bridge/);
});

test('本地与手机的飞行中请求计入 rpc_in_flight，应答后归零且订阅不误计', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const health = async () => (await fetch(f.gateway.url.replace('ws:', 'http:').replace('/ws', '/health'))).json();
  const settle = async (expected, message) => {
    for (let i = 0; i < 150; i++) { if ((await health()).rpc_in_flight === expected) return; await new Promise(resolve => setTimeout(resolve, 2)); }
    assert.fail(message + '；当前 rpc_in_flight=' + (await health()).rpc_in_flight);
  };
  const phoneIdentity = { bridgeSessionId: 'phone-idle-bridge', bridgeGeneration: 1 };
  const phoneReady = Promise.withResolvers();
  f.phone.on('message', data => { if (JSON.parse(data).payload?.zcode_type === 'workspace-bridge-ready') phoneReady.resolve(); });
  f.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-idle-open', ...phoneIdentity, workspaceKey: workspace } }));
  await phoneReady.promise;
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  peer.on('error', () => {});
  await once(peer, 'open');
  const localReplies = [];
  const attached = Promise.withResolvers();
  peer.on('message', (data, binary) => { if (binary) localReplies.push(unpack(data)); else if (JSON.parse(data).type === 'attached') attached.resolve(); });
  peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
  await attached.promise;
  await settle(0, '附着完成后无飞行中请求');
  peer.send(pack([100, 0, 'fixture', 'local-busy'], ['local']));
  for (const frame of encode(pack([100, 0, 'fixture', 'phone-busy'], ['phone']), { ...phoneIdentity, firstPhysicalSeq: 1, messageSeq: 1 })) f.phone.send(JSON.stringify({ type: 'data', payload: frame }));
  await until(() => f.requests.length === 2);
  await settle(2, '本地与手机的飞行中调用同时计入');
  for (const [header] of f.requests) f.respond([201, header[1]], { done: true });
  await until(() => localReplies.some(([h]) => h[0] === 201));
  await settle(0, '应答完成即归零');
  peer.send(pack([102, 1, 'fixture', 'subscribe'], []));
  await until(() => f.requests.some(([h]) => h[0] === 102));
  await settle(0, '长生命周期订阅路由不占用忙判定');
});

test('升级关闭按空闲放行：忙时 409 busy 不退出，空闲或无连接时接受并退出，旧关闭语义不变', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const base = f.gateway.url.replace('ws:', 'http:').replace('/ws', '');
  const healthUrl = base + '/health';
  const shutdown = query => fetch(base + '/shutdown' + query, { method: 'POST', headers: { Authorization: 'Bearer fixture-rpc-token' } });
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  peer.on('error', () => {});
  await once(peer, 'open');
  const attached = Promise.withResolvers();
  peer.on('message', (data, binary) => { if (!binary && JSON.parse(data).type === 'attached') attached.resolve(); });
  peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
  await attached.promise;
  peer.send(pack([100, 0, 'fixture', 'busy'], ['busy']));
  await until(() => f.requests.length === 1);
  const busy = await shutdown('?idle=1');
  assert.equal(busy.status, 409);
  const busyBody = await busy.json();
  assert.equal(busyBody.reason, 'busy');
  assert.equal(busyBody.rpc_in_flight, 1);
  assert.equal((await (await fetch(healthUrl)).json()).rpc_in_flight, 1, '忙时升级关闭不得退出网关');
  const legacy = await shutdown('');
  assert.equal(legacy.status, 409);
  assert.match(await legacy.text(), /Stop mobile remote control in ZCode/);
  f.respond([201, f.requests[0][0][1]], { done: true });
  for (let i = 0; i < 150; i++) { if ((await (await fetch(healthUrl)).json()).rpc_in_flight === 0) break; await new Promise(resolve => setTimeout(resolve, 2)); }
  const desktopClosed = once(f.desktop, 'close');
  const accepted = await shutdown('?idle=1');
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).ok, true);
  await desktopClosed;
  await assert.rejects(fetch(healthUrl), '网关接受升级关闭后应实际退出');
});

test('建桥未完成与远端透传期间 rpc_in_flight 不为零，升级关闭保持 409 且不退出', { timeout: 4000 }, async t => {
  // 场景一：本地 attach 的 bootstrap 已应答、共享桥初始化挂起（bridge-open 无响应）。
  const f = await fixture(t, 'matched', { ignoreBridge: true, gateway: { bridgeTimeoutMs: 3600 } });
  const healthOf = async ff => (await fetch(ff.gateway.url.replace('ws:', 'http:').replace('/ws', '/health'))).json();
  const shutdownIdle = async ff => fetch(ff.gateway.url.replace('ws:', 'http:').replace('/ws', '/shutdown?idle=1'), { method: 'POST', headers: { Authorization: 'Bearer fixture-rpc-token' } });
  const peer = new WebSocket(f.gateway.url.replace('/ws', '/rpc'), { headers: { Authorization: 'Bearer fixture-rpc-token' } });
  t.after(() => peer.terminate());
  peer.on('error', () => {});
  await once(peer, 'open');
  const attached = Promise.withResolvers();
  peer.on('message', (data, binary) => { if (!binary && JSON.parse(data).type === 'attached') attached.resolve(); });
  peer.send(JSON.stringify({ type: 'attach', workspace_path: workspace }));
  await until(() => f.bridgeOpens.length === 1);
  assert.equal((await healthOf(f)).rpc_in_flight, 1, '建桥等待期间必须计入忙判定');
  let busy = await shutdownIdle(f);
  assert.equal(busy.status, 409, '建桥在途时升级关闭不得放行');
  // 桥就绪并完成初始化后释放（ignoreBridge 下 fixture 未建立 identity，手工按桥身份编码初始化帧）。
  const open = f.bridgeOpens[0];
  f.desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-ready', requestId: open.requestId, bridge: { bridgeSessionId: open.bridgeSessionId, bridgeGeneration: 1, kind: 'local', workspacePath: workspace } } }));
  const bridgeIdentity = { bridgeSessionId: open.bridgeSessionId, bridgeGeneration: 1 };
  for (const frame of encode(pack([200], undefined), { ...bridgeIdentity, firstPhysicalSeq: 1, messageSeq: 1 })) f.desktop.send(JSON.stringify({ type: 'data', payload: frame }));
  await attached.promise;
  assert.equal((await healthOf(f)).rpc_in_flight, 0, '桥初始化完成后释放忙判定');

  // 场景二：手机打开远端工作区进入透传，网关看不到请求边界，保守按忙。
  const f2 = await fixture(t, 'matched');
  f2.phone.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-open', requestId: 'phone-remote-open', bridgeSessionId: 'phone-remote-bridge', bridgeGeneration: 1, workspaceKey: 'remote:fixture' } }));
  await until(() => f2.desktopMessages.some(m => m.payload?.zcode_type === 'workspace-bridge-open'));
  assert.ok((await healthOf(f2)).rpc_in_flight >= 1, '远端透传会话期间保守计入忙判定');
  busy = await shutdownIdle(f2);
  assert.equal(busy.status, 409, '透传期间升级关闭不得放行');
  // relay 报 INTERNAL 使手机配对断开（phoneDisconnected 清透传 peer），盲区解除。
  f2.phone.send(JSON.stringify({ type: 'error', code: 'INTERNAL' }));
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 150; i++) { if ((await healthOf(f2)).rpc_in_flight === 0) break; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.equal((await healthOf(f2)).rpc_in_flight, 0, '手机断开后透传盲区解除');
  const accepted = await shutdownIdle(f2);
  assert.equal(accepted.status, 200, '盲区解除且无飞行操作时升级关闭放行');
});

import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createRpcBroker } from './rpc-broker.mjs';

export const OFFICIAL_RELAY = 'wss://zcode.z.ai/ws';

// JSON 只用于观察路由字段；其他文本和二进制消息仍作为不透明数据转发。
function envelope(data, isBinary) {
  if (isBinary) return;
  try { return JSON.parse(data.toString()); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
}

// 只接受一个 Desktop，消息体及文本/二进制类型原样转发。
export async function startGateway({ mode = 'relay', upstreamUrl = OFFICIAL_RELAY, port = 0, instanceId = 'standalone', controlToken, bridgeTimeoutMs = 5000, onError = (error) => console.error('gateway socket error:', error.code ?? error.name), onTraffic = () => {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid gateway port');
  if (!['relay', 'local-only'].includes(mode)) throw new Error('Invalid gateway mode');
  let active;
  const http = createServer(async (request, response) => {
    if (request.headers.origin !== undefined) { response.writeHead(403).end(); return; }
    if (request.method === 'POST' && request.url === '/shutdown' && controlToken) {
      if (request.headers.authorization !== `Bearer ${controlToken}`) { response.writeHead(401).end(); return; }
      if (active) { response.writeHead(409).end('Stop mobile remote control in ZCode first'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"ok":true}');
      await closeGateway();
      return;
    }
    if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({
      service: 'suian-zcode-gateway', version: 1, instance_id: instanceId, upstream_url: upstreamUrl, mode,
      desktop_connected: active?.desktop.readyState === WebSocket.OPEN,
      desktop_ready: active?.authenticated ?? false,
      upstream_connected: active?.upstream?.readyState === WebSocket.OPEN,
      paired: active?.paired ?? false,
      upstream_paired: active?.phonePaired ?? false,
      local_clients: active?.localClients.size ?? 0,
      rpc_protocol_version: 1,
    }));
  });
  const server = new WebSocketServer({ noServer: true });
  const rpcServer = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    const path = request.url.split('?')[0];
    const rpc = path === '/rpc';
    if (request.headers.origin !== undefined || (rpc && (!controlToken || request.headers.authorization !== `Bearer ${controlToken}`))) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (path !== '/ws' && !rpc) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const target = rpc ? rpcServer : server;
    target.handleUpgrade(request, socket, head, ws => target.emit('connection', ws, request));
  });
  rpcServer.on('connection', socket => {
    if (!active?.authenticated) { socket.close(1013, 'Desktop is not authenticated'); return; }
    const connection = active;
    connection.localClients.add(socket);
    connection.paired = true;
    if (mode === 'relay' && !connection.phonePaired) connection.desktop.send(JSON.stringify({ ...connection.lastPairAck, pair_status: 'matched' }));
    socket.on('error', onError);
    connection.broker.acceptLocal(socket);
    socket.on('close', () => {
      connection.localClients.delete(socket);
      if (active !== connection) return;
      connection.paired = connection.authenticated && (mode === 'local-only' || connection.phonePaired || connection.localClients.size > 0);
      if (!connection.paired && connection.authenticated) connection.desktop.send(JSON.stringify(connection.lastPairAck));
    });
  });
  const closeGateway = async () => {
    active?.desktop.terminate();
    active?.upstream?.terminate();
    for (const socket of rpcServer.clients) socket.terminate();
    await Promise.all([
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => rpcServer.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())),
    ]);
  };
  server.on('connection', (desktop, request) => {
    if (active) {
      desktop.close(1008, 'Only one Desktop is allowed');
      return;
    }
    let upstream;
    if (mode === 'relay') {
      const address = new URL(upstreamUrl);
      const mid = new URL(request.url, 'http://127.0.0.1').searchParams.get('mid');
      if (mid !== null) address.searchParams.set('mid', mid);
      const deviceId = request.headers['x-device-id'];
      upstream = new WebSocket(address, { headers: deviceId ? { 'X-Device-ID': deviceId } : {} });
    }
    const connection = { desktop, upstream, paired: false, phonePaired: false, authenticated: false, localClients: new Set(), pending: new Map(), localIds: new Set() };
    const sendData = (socket, payload) => socket.send(JSON.stringify({ type: 'data', payload, client_ts: Date.now() }));
    connection.broker = createRpcBroker({ bootstrap: () => requestBootstrap(connection), bridgeTimeoutMs,
      sendDesktop: payload => sendData(desktop, payload), sendPhone: payload => { if (upstream?.readyState === WebSocket.OPEN) sendData(upstream, payload); } });
    active = connection;
    const queued = [];
    const rejectPending = (error) => {
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      connection.pending.clear();
    };
    const disconnect = () => {
      connection.paired = false;
      rejectPending(new Error('连接断开'));
      connection.broker.close(new Error('Desktop disconnected'));
      for (const socket of rpcServer.clients) socket.close(1011, 'Desktop disconnected');
      desktop.terminate();
      upstream?.terminate();
      if (active === connection) active = undefined;
    };
    desktop.on('message', (data, isBinary) => {
      const message = envelope(data, isBinary);
      const payload = message?.payload;
      const local = message?.type === 'data' && payload?.zcode_type === 'bootstrap-response' && connection.localIds.has(payload.requestId);
      onTraffic({ from: 'desktop', type: message?.type ?? null, zcodeType: payload?.zcode_type ?? null, pairStatus: message?.pair_status ?? null, local });
      if (mode === 'local-only') {
        // 本地模式只处理回环设备的协议就绪，不验证或使用官方凭据。
        if (!connection.authenticated) {
          if (message?.type === 'device_register_init' && typeof message.device_mid === 'string' && message.device_mid) {
            connection.deviceSid = 'd_local_' + randomUUID();
            desktop.send(JSON.stringify({ type: 'device_register_ack', device_sid: connection.deviceSid, server_ts: Date.now() }));
            return;
          }
          if (message?.type !== 'auth_init' || message.role !== 'device' || typeof message.device_sid !== 'string' || !message.device_sid || (connection.deviceSid && message.device_sid !== connection.deviceSid)) {
            desktop.close(1008, 'Expected local Desktop handshake'); return;
          }
          connection.deviceSid = message.device_sid;
          connection.authenticated = true;
          connection.paired = true;
          connection.lastPairAck = { type: 'auth_ack', pair_status: 'matched', server_ts: Date.now() };
          desktop.send(JSON.stringify(connection.lastPairAck));
          return;
        }
        if (message?.type === 'pair_status_query') {
          if (message.device_sid !== connection.deviceSid) { desktop.close(1008, 'Local Desktop session mismatch'); return; }
          desktop.send(JSON.stringify({ type: 'pair_status_ack', pair_status: 'matched', server_ts: Date.now() }));
          return;
        }
      }
      if (local) {
        const pending = connection.pending.get(payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          connection.pending.delete(payload.requestId);
          pending.resolve(payload);
        }
        // 超时、配对结束后的迟到回复也属于本地请求，不发往手机。
        return;
      }
      if (message?.type === 'data' && payload) {
        try { if (connection.broker.desktopPayload(payload)) return; }
        catch (error) {
          const failed = Object.assign(new Error('原 Host RPC 协议错误，已提交操作结果可能未知', { cause: error }), { code: 'gateway_rpc_protocol_error' });
          connection.broker.close(failed); onError(failed); return;
        }
      }
      if (mode === 'local-only') return;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else queued.push([data, isBinary]);
    });
    desktop.on('error', (error) => { onError(error); disconnect(); });
    desktop.on('close', disconnect);
    if (!upstream) return;
    upstream.on('open', () => {
      for (const [data, isBinary] of queued) upstream.send(data, { binary: isBinary });
      queued.length = 0;
    });
    upstream.on('message', (data, isBinary) => {
      const message = envelope(data, isBinary);
      onTraffic({ from: 'upstream', type: message?.type ?? null, zcodeType: message?.payload?.zcode_type ?? null, pairStatus: message?.pair_status ?? null, local: false });
      if (message?.type === 'auth_ack' || message?.type === 'pair_status_ack') {
        if (message.type === 'auth_ack') connection.authenticated = true;
        connection.lastPairAck = message;
        connection.phonePaired = message.pair_status === 'matched';
        if (!connection.phonePaired) connection.broker.phoneDisconnected();
        connection.paired = connection.authenticated && (connection.phonePaired || connection.localClients.size > 0);
        if (!connection.paired) rejectPending(new Error('配对结束'));
        if (connection.authenticated && !connection.phonePaired && connection.localClients.size > 0) { desktop.send(JSON.stringify({ ...message, pair_status: 'matched' })); return; }
      }
      // 3.14.4 已鉴权状态下 WRONG_PARAM 非致命，INTERNAL 等待重新配对但不重做鉴权。
      if (message?.type === 'error' && !(connection.authenticated && message.code === 'WRONG_PARAM')) {
        connection.authenticated = connection.authenticated && message.code === 'INTERNAL';
        connection.phonePaired = false;
        connection.paired = false;
        if (connection.authenticated) connection.lastPairAck = { ...connection.lastPairAck, pair_status: 'waiting' };
        rejectPending(new Error(`relay error: ${message.code}`));
        connection.broker.close(new Error(`relay error: ${message.code}`));
      }
      if (message?.type === 'data' && message.payload?.zcode_type === 'workspace-bridge-open') { void connection.broker.phoneOpen(message.payload); return; }
      if (message?.type === 'data' && ['rpc-frame', 'rpc-frame-ack'].includes(message.payload?.zcode_type)) { connection.broker.phoneFrame(message.payload); return; }
      desktop.send(data, { binary: isBinary });
    });
    upstream.on('error', (error) => { onError(error); disconnect(); });
    upstream.on('close', disconnect);
  });
  http.listen(port, '127.0.0.1');
  await once(http, 'listening');
  function requestBootstrap(connection, timeoutMs = 5000) {
    if (!connection.paired) throw new Error('Desktop 尚未配对');
    const requestId = randomUUID();
    connection.localIds.add(requestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.pending.delete(requestId); reject(new Error('bootstrap 超时')); }, timeoutMs);
      connection.pending.set(requestId, { resolve, reject, timer });
      connection.desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-request', requestId }, client_ts: Date.now() }));
    });
  }
  return {
    url: `ws://127.0.0.1:${http.address().port}/ws`,
    async bootstrap({ timeoutMs = 5000 } = {}) {
      if (!active?.paired) throw new Error('Desktop 尚未配对');
      return requestBootstrap(active, timeoutMs);
    },
    close: closeGateway,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, mode: { type: 'string', default: 'relay' }, port: { type: 'string', default: '17329' }, upstream: { type: 'string', default: OFFICIAL_RELAY }, 'instance-id': { type: 'string', default: 'standalone' } } });
  let options = { mode: values.mode, port: Number(values.port), upstreamUrl: values.upstream, instanceId: values['instance-id'] };
  if (values.config) {
    const config = JSON.parse(await readFile(values.config, 'utf8'));
    if (config.version !== 1 || typeof config.control_token !== 'string' || !config.control_token) throw new Error('Invalid gateway config');
    options = { mode: config.mode === undefined ? 'relay' : config.mode, port: config.port, upstreamUrl: config.upstream_url, instanceId: config.instance_id, controlToken: config.control_token };
  }
  const upstream = new URL(options.upstreamUrl);
  if ((upstream.protocol !== 'wss:' && !(upstream.protocol === 'ws:' && upstream.hostname === '127.0.0.1')) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Upstream must be a credential-free wss URL (or loopback ws for testing)');
  const gateway = await startGateway(options);
  console.log(JSON.stringify({ ok: true, relay_url: gateway.url, health_url: gateway.url.replace('ws:', 'http:').replace('/ws', '/health') }));
  process.once('SIGINT', () => gateway.close());
  process.once('SIGTERM', () => gateway.close());
}

import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';

export const OFFICIAL_RELAY = 'wss://zcode.z.ai/ws';

// JSON 只用于观察路由字段；其他文本和二进制消息仍作为不透明数据转发。
function envelope(data, isBinary) {
  if (isBinary) return;
  try { return JSON.parse(data.toString()); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
}

// 只接受一个 Desktop，消息体及文本/二进制类型原样转发。
export async function startGateway({ upstreamUrl = OFFICIAL_RELAY, port = 0, instanceId = 'standalone', controlToken, onError = (error) => console.error('gateway socket error:', error.code ?? error.name), onTraffic = () => {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid gateway port');
  let active;
  const http = createServer(async (request, response) => {
    if (request.headers.origin !== undefined) { response.writeHead(403).end(); return; }
    if (request.method === 'POST' && request.url === '/shutdown' && controlToken) {
      if (request.headers.authorization !== `Bearer ${controlToken}`) { response.writeHead(401).end(); return; }
      if (active) { response.writeHead(409).end('Fully quit ZCode first'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"ok":true}');
      await closeGateway();
      return;
    }
    if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({
      service: 'suian-zcode-gateway', version: 1, instance_id: instanceId, upstream_url: upstreamUrl,
      desktop_connected: active?.desktop.readyState === WebSocket.OPEN,
      upstream_connected: active?.upstream.readyState === WebSocket.OPEN,
      paired: active?.paired ?? false,
    }));
  });
  const server = new WebSocketServer({ server: http, path: '/ws', verifyClient: (info, done) => done(info.req.headers.origin === undefined, 403) });
  const closeGateway = async () => {
    active?.desktop.terminate();
    active?.upstream.terminate();
    await Promise.all([
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())),
    ]);
  };
  server.on('connection', (desktop, request) => {
    if (active) {
      desktop.close(1008, 'Only one Desktop is allowed');
      return;
    }
    const address = new URL(upstreamUrl);
    const mid = new URL(request.url, 'http://127.0.0.1').searchParams.get('mid');
    if (mid !== null) address.searchParams.set('mid', mid);
    const deviceId = request.headers['x-device-id'];
    const upstream = new WebSocket(address, { headers: deviceId ? { 'X-Device-ID': deviceId } : {} });
    const connection = { desktop, upstream, paired: false, pending: new Map(), localIds: new Set() };
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
      desktop.terminate();
      upstream.terminate();
      if (active === connection) active = undefined;
    };
    desktop.on('message', (data, isBinary) => {
      const message = envelope(data, isBinary);
      const payload = message?.payload;
      const local = message?.type === 'data' && payload?.zcode_type === 'bootstrap-response' && connection.localIds.has(payload.requestId);
      onTraffic({ from: 'desktop', type: message?.type ?? null, zcodeType: payload?.zcode_type ?? null, pairStatus: message?.pair_status ?? null, local });
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
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else queued.push([data, isBinary]);
    });
    upstream.on('open', () => {
      for (const [data, isBinary] of queued) upstream.send(data, { binary: isBinary });
      queued.length = 0;
    });
    upstream.on('message', (data, isBinary) => {
      const message = envelope(data, isBinary);
      onTraffic({ from: 'upstream', type: message?.type ?? null, zcodeType: message?.payload?.zcode_type ?? null, pairStatus: message?.pair_status ?? null, local: false });
      if (message?.type === 'auth_ack' || message?.type === 'pair_status_ack') {
        connection.paired = message.pair_status === 'matched';
        if (!connection.paired) rejectPending(new Error('配对结束'));
      }
      if (message?.type === 'error') {
        connection.paired = false;
        rejectPending(new Error(`relay error: ${message.code}`));
      }
      desktop.send(data, { binary: isBinary });
    });
    for (const socket of [desktop, upstream]) {
      socket.on('error', (error) => { onError(error); disconnect(); });
      socket.on('close', disconnect);
    }
  });
  http.listen(port, '127.0.0.1');
  await once(http, 'listening');
  return {
    url: `ws://127.0.0.1:${http.address().port}/ws`,
    async bootstrap({ timeoutMs = 5000 } = {}) {
      if (!active?.paired) throw new Error('Desktop 尚未配对');
      const connection = active;
      const requestId = randomUUID();
      connection.localIds.add(requestId);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          connection.pending.delete(requestId);
          reject(new Error('bootstrap 超时'));
        }, timeoutMs);
        connection.pending.set(requestId, { resolve, reject, timer });
        connection.desktop.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'bootstrap-request', requestId }, client_ts: Date.now() }));
      });
    },
    close: closeGateway,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, port: { type: 'string', default: '17329' }, upstream: { type: 'string', default: OFFICIAL_RELAY }, 'instance-id': { type: 'string', default: 'standalone' } } });
  let options = { port: Number(values.port), upstreamUrl: values.upstream, instanceId: values['instance-id'] };
  if (values.config) {
    const config = JSON.parse(await readFile(values.config, 'utf8'));
    if (config.version !== 1 || typeof config.control_token !== 'string' || !config.control_token) throw new Error('Invalid gateway config');
    options = { port: config.port, upstreamUrl: config.upstream_url, instanceId: config.instance_id, controlToken: config.control_token };
  }
  const upstream = new URL(options.upstreamUrl);
  if ((upstream.protocol !== 'wss:' && !(upstream.protocol === 'ws:' && upstream.hostname === '127.0.0.1')) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Upstream must be a credential-free wss URL (or loopback ws for testing)');
  const gateway = await startGateway(options);
  console.log(JSON.stringify({ ok: true, relay_url: gateway.url, health_url: gateway.url.replace('ws:', 'http:').replace('/ws', '/health') }));
  process.once('SIGINT', () => gateway.close());
  process.once('SIGTERM', () => gateway.close());
}

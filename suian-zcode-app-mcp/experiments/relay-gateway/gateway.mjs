import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

export const OFFICIAL_RELAY = 'wss://zcode.z.ai/ws';

// JSON 只用于观察路由字段；其他文本和二进制消息仍作为不透明数据转发。
function envelope(data, isBinary) {
  if (isBinary) return;
  try { return JSON.parse(data.toString()); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
}

// 实验原型：只接受一个 Desktop，消息体及文本/二进制类型原样转发。
export async function startGateway({ upstreamUrl = OFFICIAL_RELAY, port = 0, onError = (error) => console.error('gateway socket error:', error.code ?? error.name) } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port, path: '/ws' });
  await once(server, 'listening');
  let active;
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
      if (message?.type === 'data' && payload?.zcode_type === 'bootstrap-response' && connection.localIds.has(payload.requestId)) {
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
  return {
    url: `ws://127.0.0.1:${server.address().port}/ws`,
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
    close: () => new Promise((resolve, reject) => {
      active?.desktop.terminate();
      active?.upstream.terminate();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = await startGateway({ port: Number(process.argv[2] ?? 17329) });
  console.log(`ZCode relay gateway prototype: ${gateway.url}`);
  process.once('SIGINT', () => gateway.close());
}

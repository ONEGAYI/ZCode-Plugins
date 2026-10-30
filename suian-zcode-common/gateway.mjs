import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createRpcBroker } from './rpc-broker.mjs';
import { startTerminalGateway } from './terminal-gateway.mjs';
import { gatewayBuild } from './gateway-build.mjs';
import { rpcDiagnostic, rpcPayloadDiagnostic } from './rpc-diagnostics.mjs';

export const OFFICIAL_RELAY = 'wss://zcode.z.ai/ws';
export const OFFICIAL_RELAY_V2 = 'wss://zcode.z.ai/api/v1/remote/ws2';

// V2 wire 时间戳一律为 Unix 秒；毫秒会被客户端 schema 拒绝并静默丢帧。
const unixNow = () => Math.floor(Date.now() / 1000);

// JSON 只用于观察路由字段；其他文本和二进制消息仍作为不透明数据转发。
function envelope(data, isBinary) {
  if (isBinary) return;
  try { return JSON.parse(data.toString()); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
}

// 只接受一个 Desktop，消息体及文本/二进制类型原样转发。
export async function startGateway({ mode = 'relay', relayProtocolVersion = 1, upstreamUrl = mode === 'terminal' || relayProtocolVersion === 2 ? OFFICIAL_RELAY_V2 : OFFICIAL_RELAY, port = 0, instanceId = 'standalone', controlToken, bridgeTimeoutMs = 5000, onError = error => console.error(JSON.stringify({ event: 'gateway_error', ...error.diagnostic })), onTraffic = () => {}, deviceSid, deviceMid, getToken, WebSocketImpl } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid gateway port');
  if (![1, 2].includes(relayProtocolVersion)) throw new Error('Invalid relay protocol version');
  if (mode === 'terminal') return startTerminalGateway({port,instanceId,controlToken,upstreamUrl,deviceSid,deviceMid,getToken,bridgeTimeoutMs,WebSocketImpl,onError: error => {
    error.diagnostic = rpcDiagnostic(error, { mode, relayProtocolVersion: 2, gatewayVersion: gatewayBuild.version, gatewayBuildId: gatewayBuild.id });
    onError(error);
  }});
  if (!['relay', 'local-only'].includes(mode)) throw new Error('Invalid gateway mode');
  let active;
  const reportError = (error, context = {}) => {
    error.diagnostic = rpcDiagnostic(error, { mode, relayProtocolVersion, gatewayVersion: gatewayBuild.version, gatewayBuildId: gatewayBuild.id,
      desktopVersion: active?.desktopVersion, localClients: active?.localClients.size ?? 0, rpcInFlight: rpcInFlight(), ...context });
    onError(error);
  };
  // 忙判定聚合：RPC 路由在飞数 + 发往 Desktop 尚未应答的 bootstrap 请求；无活动连接时为 0。
  const rpcInFlight = () => (active?.broker.inFlight?.() ?? 0) + (active?.pending.size ?? 0);
  const http = createServer(async (request, response) => {
    if (request.headers.origin !== undefined) { response.writeHead(403).end(); return; }
    if (request.method === 'POST' && request.url.split('?')[0] === '/shutdown' && controlToken) {
      if (request.headers.authorization !== `Bearer ${controlToken}`) { response.writeHead(401).end(); return; }
      const idleOnly = new URL(request.url, 'http://127.0.0.1').searchParams.has('idle');
      if (active && !idleOnly) { response.writeHead(409).end('Stop mobile remote control in ZCode first'); return; }
      if (active && idleOnly && rpcInFlight() > 0) {
        response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, reason: 'busy', rpc_in_flight: rpcInFlight() }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"ok":true}');
      await closeGateway();
      return;
    }
    if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404).end(); return; }
    // charset=utf-8 让 Windows PowerShell 5.1 的 Invoke-RestMethod 正确解码中文部署路径。
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({
      service: 'suian-zcode-gateway', version: 1, build: gatewayBuild, instance_id: instanceId, upstream_url: upstreamUrl, mode, relay_protocol_version: relayProtocolVersion,
      desktop_connected: active?.desktop.readyState === WebSocket.OPEN,
      desktop_ready: active?.authenticated ?? false,
      upstream_connected: active?.upstream?.readyState === WebSocket.OPEN,
      paired: active?.paired ?? false,
      upstream_paired: active?.phonePaired ?? false,
      local_clients: active?.localClients.size ?? 0,
      rpc_in_flight: rpcInFlight(),
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
    if (mode === 'relay' && !connection.phonePaired) connection.sendPairStatus('matched');
    socket.on('error', error => reportError(error, { phase: 'socket', source: 'local_rpc' }));
    connection.broker.acceptLocal(socket);
    socket.on('close', () => {
      connection.localClients.delete(socket);
      if (active !== connection) return;
      connection.paired = connection.authenticated && (mode === 'local-only' || connection.phonePaired || connection.localClients.size > 0);
      if (!connection.paired && connection.authenticated) connection.sendPairStatus(connection.lastPairAck.pair_status);
    });
  });
  let closing = null;
  // 升级关闭成功后调用方仍可能再次 close（fixture/测试清理）；重复关闭无操作而非报错。
  const closeGateway = () => closing ??= (async () => {
    active?.desktop.terminate();
    active?.upstream?.terminate();
    for (const socket of rpcServer.clients) socket.terminate();
    await Promise.all([
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => rpcServer.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())),
    ]);
  })();
  server.on('connection', (desktop, request) => {
    if (active) {
      desktop.close(1008, 'Only one Desktop is allowed');
      return;
    }
    let upstream;
    if (mode === 'relay') {
      const address = new URL(upstreamUrl);
      const query = new URL(request.url, 'http://127.0.0.1').searchParams;
      const mid = query.get('mid');
      if (mid !== null) address.searchParams.set('mid', mid);
      if (relayProtocolVersion === 2 && query.has('token')) address.searchParams.set('token', query.get('token'));
      const deviceId = request.headers['x-device-id'];
      upstream = new WebSocket(address, { headers: deviceId ? { 'X-Device-ID': deviceId } : {} });
    }
    const connection = { desktop, upstream, paired: false, phonePaired: false, authenticated: false, localClients: new Set(), pending: new Map(), localIds: new Set() };
    connection.sendPairStatus = pair_status => desktop.send(JSON.stringify(relayProtocolVersion === 2
      ? { type: 'pair_status_ack', pair_status, server_ts: Math.floor(Date.now() / 1000),
        ...(connection.lastPairAck.terminal_sid === undefined ? {} : { terminal_sid: connection.lastPairAck.terminal_sid }) }
      : { ...connection.lastPairAck, pair_status }));
    const sendData = (socket, payload) => socket.send(JSON.stringify({ type: 'data', payload,
      ...(mode === 'local-only'
        ? { server_ts: unixNow() }
        : relayProtocolVersion === 2 ? { [socket === desktop ? 'server_ts' : 'client_ts']: Math.floor(Date.now() / 1000) } : { client_ts: Date.now() }) }));
    // 3.17.1 把缺少终端身份的 bootstrap 视为结束手机归属；内部握手/建桥继承手机原身份。
    connection.sendDesktop = payload => sendData(desktop,
      connection.terminalClientSessionId && ['bootstrap-request', 'workspace-bridge-open'].includes(payload.zcode_type)
        ? { ...payload, terminalClientSessionId: connection.terminalClientSessionId } : payload);
    connection.broker = createRpcBroker({ bootstrap: () => requestBootstrap(connection), bridgeTimeoutMs, onError: reportError,
      sendDesktop: connection.sendDesktop, sendPhone: payload => { if (upstream?.readyState === WebSocket.OPEN) sendData(upstream, payload); } });
    active = connection;
    const queued = [];
    const rejectPending = (error) => {
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      connection.pending.clear();
    };
    let disconnected = false;
    const disconnect = diagnostic => {
      if (disconnected) return;
      disconnected = true;
      connection.paired = false;
      rejectPending(Object.assign(new Error('连接断开'), { diagnostic }));
      connection.broker.close(Object.assign(new Error('Desktop disconnected'), { diagnostic }));
      for (const socket of rpcServer.clients) socket.close(1011, 'Desktop disconnected');
      desktop.terminate();
      upstream?.terminate();
      if (active === connection) active = undefined;
    };
    const connectionClosed = (source, code) => {
      let diagnostic;
      if (!disconnected && !closing && (code !== 1000 || rpcInFlight() > 0)) {
        const error = new Error('Gateway connection closed');
        reportError(error, { phase: 'socket', source, closeCode: code, reasonCode: 'gateway_connection_closed' });
        diagnostic = error.diagnostic;
      }
      disconnect(diagnostic);
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
            desktop.send(JSON.stringify({ type: 'device_register_ack', device_sid: connection.deviceSid, server_ts: unixNow() }));
            return;
          }
          // 3.16 起 V2 把角色绑定在 token 上，auth_init 不再携带 role；旧客户端的 role 仅作兼容。
          if (message?.type !== 'auth_init' || (message.role !== undefined && message.role !== 'device') || typeof message.device_sid !== 'string' || !message.device_sid || (connection.deviceSid && message.device_sid !== connection.deviceSid)) {
            desktop.close(1008, 'Expected local Desktop handshake'); return;
          }
          connection.deviceSid = message.device_sid;
          connection.authenticated = true;
          connection.paired = true;
          // 客户端以 auth_ack.device_sid 校验握手归属，缺失会一直停在 authenticating。
          connection.lastPairAck = { type: 'auth_ack', device_sid: connection.deviceSid, terminal_sid: '', pair_status: 'matched', server_ts: unixNow() };
          desktop.send(JSON.stringify(connection.lastPairAck));
          return;
        }
        if (message?.type === 'pair_status_query') {
          // 心跳查询不携带 device_sid；旧客户端若带了仍校验。
          if (message.device_sid !== undefined && message.device_sid !== connection.deviceSid) { desktop.close(1008, 'Local Desktop session mismatch'); return; }
          desktop.send(JSON.stringify({ type: 'pair_status_ack', terminal_sid: '', pair_status: 'matched', server_ts: unixNow() }));
          return;
        }
      }
      if (local) {
        const pending = connection.pending.get(payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          connection.pending.delete(payload.requestId);
          connection.desktopVersion = payload.result?.desktopAppVersion;
          pending.resolve(payload);
        }
        // 超时、配对结束后的迟到回复也属于本地请求，不发往手机。
        return;
      }
      if (message?.type === 'data' && payload) {
        try { if (connection.broker.desktopPayload(payload)) return; }
        catch (error) {
          const failed = Object.assign(new Error('原 Host RPC 协议错误，已提交操作结果可能未知', { cause: error }), { code: 'gateway_rpc_protocol_error' });
          reportError(failed, { phase: 'desktop_payload', source: 'desktop', ...rpcPayloadDiagnostic(payload) });
          connection.broker.close(failed); return;
        }
      }
      if (mode === 'local-only') return;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else queued.push([data, isBinary]);
    });
    desktop.on('error', (error) => { reportError(error, { phase: 'socket', source: 'desktop' }); disconnect(error.diagnostic); });
    desktop.on('close', code => connectionClosed('desktop', code));
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
        // relay 的 terminal_sid 只用于识别终端更换，不是 bootstrap 的 terminalClientSessionId。
        if (message.pair_status !== 'matched' || (message.terminal_sid !== undefined && connection.phoneTerminalSid !== undefined && message.terminal_sid !== connection.phoneTerminalSid)) {
          connection.terminalClientSessionId = undefined;
        }
        connection.phoneTerminalSid = message.pair_status === 'matched' ? message.terminal_sid ?? connection.phoneTerminalSid : undefined;
        connection.lastPairAck = message;
        connection.phonePaired = message.pair_status === 'matched';
        if (!connection.phonePaired) connection.broker.phoneDisconnected();
        connection.paired = connection.authenticated && (connection.phonePaired || connection.localClients.size > 0);
        if (!connection.paired) rejectPending(new Error('配对结束'));
        if (connection.authenticated && !connection.phonePaired && connection.localClients.size > 0) { connection.sendPairStatus('matched'); return; }
      }
      // 3.14.4 已鉴权状态下 WRONG_PARAM 非致命，INTERNAL 等待重新配对但不重做鉴权。
      if (message?.type === 'error' && !(connection.authenticated && message.code === 'WRONG_PARAM')) {
        connection.authenticated = connection.authenticated && message.code === 'INTERNAL';
        connection.phonePaired = false;
        connection.terminalClientSessionId = undefined;
        connection.phoneTerminalSid = undefined;
        connection.broker.phoneDisconnected();
        connection.paired = connection.authenticated && connection.localClients.size > 0;
        if (connection.authenticated) connection.lastPairAck = { ...connection.lastPairAck, pair_status: 'waiting' };
        // 已鉴权的 INTERNAL 仅影响手机配对；本地 Host 调用可能仍在执行，不截断其 ACK。
        if (connection.paired) { connection.sendPairStatus('matched'); return; }
        rejectPending(new Error(`relay error: ${message.code}`));
        const failed = new Error(`relay error: ${message.code}`);
        reportError(failed, { phase: 'socket', source: 'upstream' });
        connection.broker.close(failed);
      }
      if (relayProtocolVersion === 2 && connection.phonePaired && message?.type === 'data' && ['bootstrap-request', 'workspace-bridge-open'].includes(message.payload?.zcode_type)) {
        const id = message.payload.terminalClientSessionId;
        if (typeof id === 'string' && id) connection.terminalClientSessionId = id;
        else if (message.payload.zcode_type === 'bootstrap-request') connection.terminalClientSessionId = undefined;
      }
      if (message?.type === 'data' && message.payload?.zcode_type === 'workspace-bridge-open') { void connection.broker.phoneOpen(message.payload); return; }
      if (message?.type === 'data' && ['rpc-frame', 'rpc-frame-ack'].includes(message.payload?.zcode_type)) { connection.broker.phoneFrame(message.payload); return; }
      desktop.send(data, { binary: isBinary });
    });
    upstream.on('error', (error) => { reportError(error, { phase: 'socket', source: 'upstream' }); disconnect(error.diagnostic); });
    upstream.on('close', code => connectionClosed('upstream', code));
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
      connection.sendDesktop({ zcode_type: 'bootstrap-request', requestId });
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
  const { values } = parseArgs({ options: { config: { type: 'string' }, mode: { type: 'string', default: 'relay' }, 'relay-protocol-version': { type: 'string', default: '1' }, port: { type: 'string', default: '17329' }, upstream: { type: 'string' }, 'instance-id': { type: 'string', default: 'standalone' } } });
  let options = { mode: values.mode, relayProtocolVersion: Number(values['relay-protocol-version']), port: Number(values.port), upstreamUrl: values.upstream, instanceId: values['instance-id'] };
  if (values.config) {
    const config = JSON.parse(await readFile(values.config, 'utf8'));
    if (config.version !== 1 || typeof config.control_token !== 'string' || !config.control_token) throw new Error('Invalid gateway config');
    options = { mode: config.mode === undefined ? 'relay' : config.mode, relayProtocolVersion: config.relay_protocol_version ?? 1, port: config.port, upstreamUrl: config.upstream_url, instanceId: config.instance_id, controlToken: config.control_token };
  }
  options.upstreamUrl ??= options.relayProtocolVersion === 2 ? OFFICIAL_RELAY_V2 : OFFICIAL_RELAY;
  const upstream = new URL(options.upstreamUrl);
  if ((upstream.protocol !== 'wss:' && !(upstream.protocol === 'ws:' && upstream.hostname === '127.0.0.1')) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Upstream must be a credential-free wss URL (or loopback ws for testing)');
  const gateway = await startGateway(options);
  // 自包含横幅：stdout 首行进入每次启动的 gateway-<时间戳>.out.log，脱离其他文件仍可溯源
  // 启动时刻、模式、端口、协议版本与构建；error.log 是 stderr 直通，上下文在配对 out.log。
  console.log(JSON.stringify({
    ok: true,
    started_at: new Date().toISOString(),
    mode: options.mode ?? 'relay',
    port: Number(new URL(gateway.url).port),
    relay_protocol_version: options.relayProtocolVersion,
    build: { id: gatewayBuild.id, version: gatewayBuild.version, root: gatewayBuild.root },
    node: process.version,
    pid: process.pid,
    config: values.config ?? null,
    relay_url: gateway.url,
    health_url: gateway.url.replace('ws:', 'http:').replace('/ws', '/health'),
  }));
  process.once('SIGINT', () => gateway.close());
  process.once('SIGTERM', () => gateway.close());
}

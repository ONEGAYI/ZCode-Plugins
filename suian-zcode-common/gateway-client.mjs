import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ChannelClient } from './vendor/channelClient.js';
import { Emitter } from './vendor/foundation.js';
import { VSBuffer } from './vendor/buffer.js';
import { rpcDiagnostic, sanitizeRpcDiagnostic } from './rpc-diagnostics.mjs';

const failure = (reasonCode, message, stage = 'gateway') => Object.assign(new Error(message), { stage, reasonCode });
const defaultConfig = join(homedir(), '.zcode', 'tools', 'suian-zcode-gateway', 'config.json');

export async function connectHost({ workspacePath, sessionId, gatewayConfigPath = defaultConfig, timeoutMs = 120000, handshakeTimeoutMs = 8000 }) {
  const started = Date.now();
  let clientPhase = 'health';
  let config;
  try { config = JSON.parse(await readFile(gatewayConfigPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw failure('gateway_not_configured', '公共网关尚未配置，请按公共 skill 安装', 'config');
    if (error instanceof SyntaxError) throw failure('gateway_invalid_config', '公共网关配置 JSON 无效', 'config');
    throw error;
  }
  if (config.version !== 1 || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.control_token !== 'string' || !config.control_token) throw failure('gateway_invalid_config', '公共网关配置无效', 'config');
  const healthUrl = `http://127.0.0.1:${config.port}/health`;
  let health;
  try { health = await (await fetch(healthUrl, { signal: AbortSignal.timeout(handshakeTimeoutMs) })).json(); }
  catch (error) { throw Object.assign(failure('gateway_unreachable', '公共网关健康检查失败：' + error.name), {
    cause: error, diagnostic: rpcDiagnostic(error, { phase: 'health', clientPhase, elapsedMs: Date.now() - started })
  }); }
  if (health.service !== 'suian-zcode-gateway' || health.rpc_protocol_version !== 1) throw failure('gateway_upgrade_required', '运行中的网关未提供 RPC，请按公共 skill 暂停移动端远控并重载网关，保留 ZCode 完成升级');
  const mode = health.mode === undefined ? 'relay' : health.mode;
  if (!['relay', 'local-only', 'terminal'].includes(mode)) throw failure('gateway_rpc_protocol_error', '公共网关返回未知运行模式');
  if (!health.desktop_connected || (mode === 'local-only' ? !health.desktop_ready : !health.upstream_connected)) throw failure('gateway_desktop_offline', 'Desktop 尚未就绪，或 relay 模式的官方上游尚未连接');
  const diagnose = error => {
    error.diagnostic = rpcDiagnostic(error, { clientPhase, elapsedMs: Date.now() - started,
      gatewayVersion: health.build?.version, gatewayBuildId: health.build?.id, mode, relayProtocolVersion: health.relay_protocol_version });
    return error;
  };
  const ready = Promise.withResolvers(), fault = Promise.withResolvers(), emitter = new Emitter();
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/rpc`, { headers: { Authorization: `Bearer ${config.control_token}` }, handshakeTimeout: handshakeTimeoutMs });
  const client = new ChannelClient({ onMessage: emitter.event, send: bytes => socket.send(bytes.buffer), drain: () => Promise.resolve() });
  let attached, closing = false;
  let timer = setTimeout(() => fault.reject(Object.assign(failure('gateway_timeout', '公共网关附着超时'), {
    diagnostic: { phase: 'attach_timeout' }
  })), handshakeTimeoutMs);
  clientPhase = 'connect';
  socket.on('open', () => { clientPhase = 'attach'; socket.send(JSON.stringify({ type: 'attach', workspace_path: workspacePath, ...(sessionId === undefined ? {} : { session_id: sessionId }) })); });
  socket.on('message', (data, binary) => {
    try {
      if (binary) { emitter.fire(VSBuffer.wrap(data)); return; }
      const message = JSON.parse(data.toString());
      if (message.type === 'attached') { attached = message; clientPhase = 'channel_initialize'; ready.resolve(); }
      else if (message.type === 'error') fault.reject(Object.assign(failure(message.code, message.message), { diagnostic: sanitizeRpcDiagnostic(message.diagnostic) }));
    } catch (error) {
      fault.reject(Object.assign(failure('gateway_rpc_protocol_error', '公共网关 RPC 消息无效，已提交操作结果可能未知'), {
        cause: error, diagnostic: { phase: 'rpc_message', frameBinary: binary, frameBytes: data.length }
      }));
      close();
    }
  });
  socket.on('error', error => fault.reject(Object.assign(failure('gateway_connection_failed', '公共网关 RPC 连接失败'), { cause: error, diagnostic: { phase: 'socket' } })));
  socket.on('close', code => { if (!closing) fault.reject(Object.assign(failure('gateway_connection_closed', '公共网关 RPC 连接已断开，已提交的操作结果可能未知'), { diagnostic: { phase: 'socket', closeCode: code } })); });
  const close = () => { closing = true; clearTimeout(timer); socket.close(); client.dispose(); emitter.dispose(); };
  try {
    await Promise.race([Promise.all([ready.promise, client.whenInitialized()]), fault.promise]);
    clearTimeout(timer); timer = setTimeout(() => fault.reject(Object.assign(failure('gateway_timeout', '原 Host RPC 执行超时，结果可能未知'), {
      diagnostic: { phase: 'rpc_timeout' }
    })), timeoutMs);
    clientPhase = 'rpc';
    return {
      bootstrap: attached.bootstrap, workspacePath: attached.workspace_path,
      call: (channel, method, args = []) => Promise.race([client.getChannel(channel).call(method, args), fault.promise]).catch(error => { throw diagnose(error); }),
      listen: (channel, event, args) => client.getChannel(channel).listen(event, args),
      probe: async () => {
        const current = await (await fetch(healthUrl, { signal: AbortSignal.timeout(handshakeTimeoutMs) })).json();
        return { ok: current.desktop_connected && (mode === 'local-only' ? current.desktop_ready : current.upstream_connected), stage: 'gateway', mode, paired: current.paired, upstreamPaired: current.upstream_paired, localClients: current.local_clients };
      },
      close
    };
  } catch (error) { close(); throw diagnose(error); }
}

export async function probeHost(options) {
  let connection;
  try {
    connection = await connectHost({ ...options, handshakeTimeoutMs: options.timeoutMs ?? 8000 });
    return { ...await connection.probe(), hostReachable: true, workspaceFound: true, sessionFound: true };
  } catch (error) {
    return { ok: false, stage: error.stage ?? 'gateway', reasonCode: error.reasonCode ?? 'gateway_error', paired: false, message: error.message, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
  } finally { connection?.close(); }
}

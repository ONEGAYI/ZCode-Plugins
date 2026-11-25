import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ChannelClient } from './vendor/channelClient.js';
import { Emitter } from './vendor/foundation.js';
import { VSBuffer } from './vendor/buffer.js';

const HEADER_SIZE = 13;
const REGULAR = 1;
const failure = (reasonCode, message) => Object.assign(new Error(message), { stage: 'source_server', reasonCode });

// Source Server 自己提供鉴权和 SocketProtocol，不经过桌面网关的 /rpc 与 attach。
export async function connectSourceServer({
  dataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir(),
  timeoutMs = 120000, handshakeTimeoutMs = 8000,
} = {}) {
  const runDir = join(dataBaseDir, '.zcode', 'server', 'run');
  let status;
  try { status = JSON.parse(await readFile(join(runDir, 'status.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw failure('source_server_not_ready', '未找到本机 Source Server 运行状态');
    if (error instanceof SyntaxError) throw failure('source_server_invalid_status', 'Source Server 运行状态不是有效的 JSON');
    throw error;
  }
  if (status?.state !== 'ready') throw failure('source_server_not_ready', '本机 Source Server 尚未就绪');
  if (status.host !== '127.0.0.1' || !Number.isInteger(status.port) || status.port < 1 || status.port > 65535)
    throw failure('source_server_invalid_status', 'Source Server 未提供有效的 IPv4 回环端点');
  let token;
  try { token = (await readFile(join(runDir, 'ingress-token'), 'utf8')).trim(); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES')
      throw failure('source_server_auth_unavailable', '当前用户无法读取 Source Server 的本机鉴权凭据');
    throw error;
  }
  if (!token) throw failure('source_server_auth_unavailable', 'Source Server 的本机鉴权凭据为空');

  const fault = Promise.withResolvers(), emitter = new Emitter();
  const socket = new WebSocket(`ws://127.0.0.1:${status.port}/ws`, {
    headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: handshakeTimeoutMs,
  });
  const client = new ChannelClient({
    onMessage: emitter.event,
    send: bytes => {
      const header = Buffer.alloc(HEADER_SIZE);
      header[0] = REGULAR;
      header.writeUInt32BE(bytes.byteLength, 9);
      socket.send(Buffer.concat([header, bytes.buffer]));
    },
    drain: () => Promise.resolve(),
  });
  let incoming = Buffer.alloc(0);
  let timer = setTimeout(() => fault.reject(failure('source_server_timeout', 'Source Server RPC 初始化超时')), handshakeTimeoutMs);
  const close = () => {
    clearTimeout(timer);
    socket.close();
    client.dispose();
    emitter.dispose();
  };
  socket.on('message', (chunk, binary) => {
    try {
      if (!binary) throw new Error('Expected a binary RPC message');
      incoming = Buffer.concat([incoming, chunk]);
      while (incoming.length >= HEADER_SIZE) {
        const end = HEADER_SIZE + incoming.readUInt32BE(9);
        if (incoming.length < end) return;
        if (incoming[0] === REGULAR) emitter.fire(VSBuffer.wrap(incoming.subarray(HEADER_SIZE, end)));
        incoming = incoming.subarray(end);
      }
    } catch {
      fault.reject(failure('source_server_protocol_error', 'Source Server 返回无效 RPC 数据，已提交的操作结果可能未知'));
      close();
    }
  });
  socket.on('error', () => fault.reject(failure('source_server_connection_failed', 'Source Server RPC 握手或连接失败')));
  socket.on('close', () => fault.reject(failure('source_server_connection_closed', 'Source Server RPC 已断开，已提交的操作结果可能未知')));
  try {
    await Promise.race([client.whenInitialized(), fault.promise]);
    clearTimeout(timer);
    timer = setTimeout(() => fault.reject(failure('source_server_timeout', 'Source Server RPC 超时，已提交的操作结果可能未知')), timeoutMs);
    return {
      call: (channel, method, args = []) => Promise.race([client.getChannel(channel).call(method, args), fault.promise]),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

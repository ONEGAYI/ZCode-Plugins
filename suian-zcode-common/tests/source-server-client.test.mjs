import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import * as client from '../client.mjs';
import { VSBuffer } from '../vendor/buffer.js';
import { BufferReader, BufferWriter, deserialize, serialize } from '../vendor/serialization.js';

test('Source Server 经带鉴权的 /ws 收发现有 Channel RPC，无需网关附着', async t => {
  const dataBaseDir = await mkdtemp(join(tmpdir(), 'source-server-rpc-'));
  t.after(() => rm(dataBaseDir, { recursive: true }));
  const runDir = join(dataBaseDir, '.zcode', 'server', 'run');
  await mkdir(runDir, { recursive: true });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  await once(server, 'listening');
  const port = server.address().port, token = randomUUID();
  await writeFile(join(runDir, 'status.json'), JSON.stringify({ state: 'ready', host: '127.0.0.1', port }));
  await writeFile(join(runDir, 'ingress-token'), token + '\n', { mode: 0o600 });
  const send = (socket, header, value) => {
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, value);
    const body = writer.buffer.buffer;
    const frame = Buffer.alloc(13);
    frame[0] = 1;
    frame.writeUInt32BE(body.length, 9);
    socket.send(frame);
    socket.send(body);
  };
  let malformed = false, holdReply = false, calls = 0, peer;
  server.on('connection', (socket, request) => {
    peer = socket;
    assert.equal(request.url, '/ws');
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    if (malformed) {
      const frame = Buffer.alloc(14);
      frame[0] = 1;
      frame.writeUInt32BE(1, 9);
      frame[13] = 255;
      socket.send(frame);
      return;
    }
    send(socket, [200]);
    socket.on('message', (frame, binary) => {
      assert.equal(binary, true);
      assert.equal(frame[0], 1);
      assert.equal(frame.readUInt32BE(9), frame.length - 13);
      const reader = new BufferReader(VSBuffer.wrap(frame.subarray(13)));
      const [kind, id, channel, method] = deserialize(reader);
      assert.deepEqual([kind, channel, method, deserialize(reader)], [100, 'model-selection', 'getView', []]);
      calls++;
      if (!holdReply) send(socket, [201, id], { providers: [] });
    });
  });
  assert.equal(typeof client.connectSourceServer, 'function');
  const connection = await client.connectSourceServer({ dataBaseDir, handshakeTimeoutMs: 1000 });
  try {
    assert.deepEqual(await connection.call('model-selection', 'getView'), { providers: [] });
  } finally {
    connection.close();
  }
  await t.test('超时终止连接，后续调用不会送至宿主', async () => {
    holdReply = true;
    const expired = await client.connectSourceServer({ dataBaseDir, handshakeTimeoutMs: 1000, timeoutMs: 60 });
    const ended = once(peer, 'close', { signal: AbortSignal.timeout(1000) });
    try {
      const timeout = { stage: 'source_server', reasonCode: 'source_server_timeout' };
      await assert.rejects(expired.call('model-selection', 'getView'), timeout);
      await assert.rejects(expired.call('model-selection', 'getView'), timeout);
      await ended;
      assert.equal(calls, 2, '只有正常调用和截止前的在途调用应到达宿主');
    } finally {
      expired.close();
    }
  });
  malformed = true;
  await assert.rejects(client.connectSourceServer({ dataBaseDir, handshakeTimeoutMs: 1000 }),
    { stage: 'source_server', reasonCode: 'source_server_protocol_error' });

  await writeFile(join(runDir, 'status.json'), JSON.stringify({ state: 'ready', host: '192.0.2.123', port }));
  await assert.rejects(client.connectSourceServer({ dataBaseDir }), { stage: 'source_server', reasonCode: 'source_server_invalid_status' });
});

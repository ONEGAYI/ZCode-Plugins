import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import { Hs as encode, Bs as Assembler, Ws as parse, S as workspaceKey } from './vendor/remote-shared.js';
import { BufferReader, BufferWriter, deserialize, serialize } from './vendor/serialization.js';
import { VSBuffer } from './vendor/buffer.js';

const samePath = (a, b) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
const packet = (header, tail = Buffer.from([0])) => {
  const writer = new BufferWriter(); serialize(writer, header); writer.write(VSBuffer.wrap(tail)); return writer.buffer.buffer;
};
const headerOf = bytes => { const reader = new BufferReader(VSBuffer.wrap(bytes)); const header = deserialize(reader); return { header, tail: bytes.subarray(reader.pos) }; };

// Local workspace attachments all enter the same window Host in ZCode 3.14.4.
// The broker owns its one physical bridge; peers retain separate RPC ID spaces.
export function createRpcBroker({ bootstrap, sendDesktop, sendPhone, bridgeTimeoutMs = 5000 }) {
  let physical, phone, nextId = 1;
  const peers = new Set(), localPeers = new Set(), routes = new Map(), bridgeRequests = new Set();
  const resetPhysical = error => {
    if (physical) { clearTimeout(physical.timer); physical.ready.reject(error); physical.initialize.reject(error); physical = undefined; }
  };
  const hostSend = bytes => {
    const frames = encode(bytes, { ...physical.identity, firstPhysicalSeq: physical.seq, messageSeq: physical.message++ });
    physical.seq += frames.length;
    for (const frame of frames) sendDesktop(frame);
  };
  const cancelPeer = peer => {
    for (const [localId, id] of peer.ids) {
      const route = routes.get(id);
      if (physical?.initialized) hostSend(packet([route.event ? 103 : 101, id]));
      routes.delete(id);
      peer.ids.delete(localId);
    }
    peers.delete(peer);
  };
  const request = (peer, bytes) => {
    const { header, tail } = headerOf(bytes);
    if (!Array.isArray(header) || ![100, 101, 102, 103].includes(header[0]) || !Number.isInteger(header[1]) || header[1] < 0) throw new Error('Invalid RPC request header');
    const [type, localId] = header;
    if (type === 100 || type === 102) {
      if (peer.ids.has(localId)) throw new Error('Duplicate RPC request ID');
      const id = nextId++;
      routes.set(id, { peer, localId, event: type === 102 }); peer.ids.set(localId, id);
      hostSend(packet([type, id, ...header.slice(2)], tail));
    } else {
      const id = peer.ids.get(localId);
      if (id === undefined) return;
      hostSend(packet([type, id], tail));
      routes.delete(id); peer.ids.delete(localId);
    }
  };
  const ensureHost = async workspacePath => {
    if (!physical) {
      const identity = { bridgeSessionId: randomUUID(), bridgeGeneration: 1 };
      const ready = Promise.withResolvers(), initialize = Promise.withResolvers();
      physical = { identity, requestId: randomUUID(), assembler: new Assembler({ identity }), seq: 1, message: 1, ready, initialize, initialized: false };
      physical.timer = setTimeout(() => resetPhysical(Object.assign(new Error('原 Host 桥初始化超时'), { code: 'gateway_bridge_timeout' })), bridgeTimeoutMs);
      bridgeRequests.add(physical.requestId);
      sendDesktop({ zcode_type: 'workspace-bridge-open', requestId: physical.requestId, ...identity, workspaceKey: workspacePath });
    }
    const [meta] = await Promise.all([physical.ready.promise, physical.initialize.promise]);
    return meta;
  };
  const attach = async (peer, workspacePath, sessionId, suppliedBootstrap) => {
    if (phone?.passthrough) throw Object.assign(new Error('手机当前使用远端工作区，本地 RPC 暂时让位'), { code: 'remote_workspace_busy' });
    const result = suppliedBootstrap ?? await bootstrap();
    if (!result.success) throw new Error('Desktop bootstrap failed');
    const workspace = result.result.workspaces.find(w => w.kind === 'local' && samePath(w.workspacePath, workspacePath));
    if (!workspace) throw new Error('Requested local workspace is not open in the Desktop window');
    if (sessionId !== undefined && !result.result.tasks.some(t => t.taskId === sessionId && samePath(t.workspacePath, workspace.workspacePath))) throw new Error('Session is not present in the requested workspace');
    const meta = await ensureHost(workspace.workspacePath);
    peers.add(peer);
    return { bootstrap: result.result, workspace_path: workspace.workspacePath, meta };
  };
  return {
    async phoneOpen(payload) {
      if (phone) cancelPeer(phone);
      const identity = { bridgeSessionId: payload.bridgeSessionId, bridgeGeneration: payload.bridgeGeneration, ...(payload.recoveryId ? { recoveryId: payload.recoveryId } : {}) };
      const peer = { ids: new Map(), identity, assembler: new Assembler({ identity }), seq: 1, message: 1,
        fail: error => sendPhone({ zcode_type: 'bridge-degraded', ...identity, reason: error.code ?? 'gateway_rpc_failed', error: error.message }),
        send: bytes => {
          const frames = encode(bytes, { ...identity, firstPhysicalSeq: peer.seq, messageSeq: peer.message++ });
          peer.seq += frames.length;
          for (const frame of frames) sendPhone(frame);
        }
      };
      phone = peer;
      try {
        const result = await bootstrap();
        if (phone !== peer) return;
        if (!result.success) throw new Error('Desktop bootstrap failed');
        const workspace = result.result.workspaces.find(w => workspaceKey(w) === payload.workspaceKey);
        if (!workspace) throw new Error('Requested workspace is not open in the Desktop window');
        if (workspace.kind !== 'local') {
          if (localPeers.size) throw Object.assign(new Error('本地 RPC 正在使用窗口 Host，暂不能切换远端工作区'), { code: 'remote_workspace_busy' });
          resetPhysical(new Error('Phone switched to a remote workspace'));
          peer.passthrough = true;
          sendDesktop(payload);
          return;
        }
        const attached = await attach(peer, workspace.workspacePath, undefined, result);
        if (phone !== peer) { cancelPeer(peer); return; }
        sendPhone({ zcode_type: 'workspace-bridge-ready', requestId: payload.requestId, ...identity,
          bridge: { ...attached.meta, ...identity, workspaceKey: attached.workspace_path, workspacePath: attached.workspace_path, initialTaskId: payload.taskId } });
        peer.send(packet([200]));
      } catch (error) {
        cancelPeer(peer);
        if (phone === peer) { phone = undefined; sendPhone({ zcode_type: 'workspace-bridge-error', requestId: payload.requestId, ...identity, reason: 'gateway_attach_failed', error: error.message }); }
      }
    },
    phoneFrame(payload) {
      if (!phone) return;
      if (phone.passthrough) { sendDesktop(payload); return; }
      if (payload.bridgeSessionId !== phone.identity.bridgeSessionId || payload.bridgeGeneration !== phone.identity.bridgeGeneration || payload.recoveryId !== phone.identity.recoveryId) return;
      try {
        const frame = parse(payload);
        if (frame?.zcode_type === 'rpc-frame-ack') return;
        if (!frame) throw new Error('Invalid phone RPC frame');
        const result = phone.assembler.accept(frame);
        if (result.kind === 'fault') throw new Error(result.fault.reasonCode);
        if (result.kind === 'complete') request(phone, Buffer.from(result.bytes));
        const ack = result.kind === 'complete' ? result.messageSeq : result.kind === 'duplicate' ? result.ackMessageSeq : null;
        if (ack) sendPhone({ zcode_type: 'rpc-frame-ack', ...phone.identity, ackMessageSeq: ack });
      } catch (error) { const failed = phone; phone = undefined; cancelPeer(failed); failed.fail(error); }
    },
    desktopPayload(payload) {
      if (payload.zcode_type === 'workspace-bridge-ready' && physical?.requestId === payload.requestId) { physical.ready.resolve(payload.bridge); return true; }
      if (payload.zcode_type === 'workspace-bridge-error' && physical?.requestId === payload.requestId) {
        resetPhysical(new Error(payload.error ?? payload.reason)); return true;
      }
      if (['workspace-bridge-ready', 'workspace-bridge-error'].includes(payload.zcode_type) && bridgeRequests.has(payload.requestId)) return true;
      if (!physical || payload.bridgeSessionId !== physical.identity.bridgeSessionId) {
        if (['rpc-frame', 'rpc-frame-ack'].includes(payload.zcode_type)) return !(phone?.passthrough && payload.bridgeSessionId === phone.identity.bridgeSessionId);
        return false;
      }
      if (payload.zcode_type === 'rpc-frame-ack') return true;
      if (payload.zcode_type === 'bridge-degraded') throw new Error('原 Host RPC 桥已降级');
      if (payload.zcode_type !== 'rpc-frame') return false;
      const result = physical.assembler.accept(parse(payload));
      if (result.kind === 'fault') throw new Error(result.fault.reasonCode);
      if (result.kind === 'complete') {
        const bytes = Buffer.from(result.bytes), { header, tail } = headerOf(bytes);
        if (header[0] === 200) { physical.initialized = true; clearTimeout(physical.timer); physical.initialize.resolve(); }
        else {
          const route = routes.get(header[1]);
          if (route) {
            route.peer.send(packet([header[0], route.localId, ...header.slice(2)], tail));
            if (!route.event) { routes.delete(header[1]); route.peer.ids.delete(route.localId); }
          }
        }
      }
      const ack = result.kind === 'complete' ? result.messageSeq : result.kind === 'duplicate' ? result.ackMessageSeq : null;
      if (ack) sendDesktop({ zcode_type: 'rpc-frame-ack', ...physical.identity, ackMessageSeq: ack });
      return true;
    },
    acceptLocal(socket) {
      const peer = { ids: new Map(), send: bytes => socket.send(bytes), fail: error => {
        if (socket.readyState === 1) { socket.send(JSON.stringify({ type: 'error', code: error.code ?? 'gateway_rpc_failed', message: error.message })); socket.close(1011, 'RPC attachment failed'); }
      } };
      localPeers.add(peer);
      let stage = 'new';
      socket.on('message', async (data, binary) => {
        try {
          if (binary) { if (stage !== 'attached') throw new Error('Attach a workspace before RPC'); request(peer, data); }
          else {
            if (stage !== 'new') throw new Error('Workspace already attached');
            const message = JSON.parse(data.toString());
            if (message.type !== 'attach' || typeof message.workspace_path !== 'string') throw new Error('Invalid workspace attachment');
            stage = 'attaching';
            const result = await attach(peer, message.workspace_path, message.session_id);
            if (socket.readyState !== 1) { cancelPeer(peer); return; }
            stage = 'attached';
            socket.send(JSON.stringify({ type: 'attached', bootstrap: result.bootstrap, workspace_path: result.workspace_path }));
            peer.send(packet([200]));
          }
        } catch (error) {
          peer.fail(error);
        }
      });
      socket.on('close', () => { localPeers.delete(peer); cancelPeer(peer); });
    },
    phoneDisconnected() { if (phone) { cancelPeer(phone); phone = undefined; } },
    close(error) {
      resetPhysical(error);
      const affected = new Set([...peers, ...localPeers, ...(phone ? [phone] : [])]);
      for (const peer of affected) peer.ids.clear();
      peers.clear(); localPeers.clear(); routes.clear(); phone = undefined;
      for (const peer of affected) peer.fail(error);
    }
  };
}

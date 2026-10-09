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
  const forwardRequest = id => {
    const route = routes.get(id), { peer, localId, header } = route;
    let tail = route.tail;
    if (header[0] === 100 && header[2] === 'zcode-agent') {
        const method = header[3];
        if (method === 'helloConversationV4') route.onSuccess = () => { peer.helloIssued = true; };
        if (method === 'initializeConversationV4' || method === 'sendConversationCommandV4') {
          const args = route.initializeArgs ?? deserialize(new BufferReader(VSBuffer.wrap(tail))), params = args[0];
          let reason;
          if (method === 'initializeConversationV4') {
            if (!peer.helloIssued) reason = 'fault.connection.helloRequired';
            else if (peer.clientHello && peer.clientHello.clientId !== params.clientId) reason = 'fault.connection.clientChanged';
            // Host 只绑定一个身份；手机是 v4 增量订阅的消费者，本地写调用不能覆盖其能力声明。
            args[0] = { ...params, clientId: physical.clientId,
              capabilities: peer !== phone && phone?.clientHello ? { ...params.capabilities, ...phone.clientHello.capabilities } : params.capabilities };
            route.onSuccess = () => { peer.clientHello = params; };
          } else {
            if (!peer.clientHello) reason = 'fault.connection.handshakeRequired';
            else if (params.envelope.clientId !== peer.clientHello.clientId) reason = 'fault.command.clientMismatch';
            args[0] = { ...params, envelope: { ...params.envelope, clientId: physical.clientId } };
          }
          const writer = new BufferWriter();
          if (reason) {
            serialize(writer, [202, localId]); serialize(writer, { name: 'Error', message: reason });
            peer.send(writer.buffer.buffer);
            routes.delete(id); peer.ids.delete(localId);
            if (physical.initializing === id) physical.initializing = undefined;
            return;
          }
          serialize(writer, args); tail = writer.buffer.buffer;
        }
    }
    route.sent = true;
    hostSend(packet([header[0], id, ...header.slice(2)], tail));
  };
  // 逐个等待初始化 ACK，之后才读取各端已绑定身份和手机能力，避免并发换绑或覆盖声明。
  const drainInitializations = () => {
    while (physical && !physical.initializing && physical.initializations.length) {
      const id = physical.initializations.shift();
      if (!routes.has(id)) continue; // 排队期间断开或取消的调用已经移除。
      physical.initializing = id;
      forwardRequest(id);
    }
  };
  const cancelPeer = peer => {
    for (const [localId, id] of peer.ids) {
      const route = routes.get(id);
      if (physical?.initialized && route.sent) hostSend(packet([route.event ? 103 : 101, id]));
      routes.delete(id);
      peer.ids.delete(localId);
      if (physical?.initializing === id) physical.initializing = undefined;
    }
    peers.delete(peer);
    drainInitializations();
  };
  const request = (peer, bytes) => {
    const { header, tail } = headerOf(bytes);
    if (!Array.isArray(header) || ![100, 101, 102, 103].includes(header[0]) || !Number.isInteger(header[1]) || header[1] < 0) throw new Error('Invalid RPC request header');
    const [type, localId] = header;
    if (type === 100 || type === 102) {
      if (peer.ids.has(localId)) throw new Error('Duplicate RPC request ID');
      const initialize = type === 100 && header[2] === 'zcode-agent' && header[3] === 'initializeConversationV4';
      let initializeArgs;
      if (initialize) {
        initializeArgs = deserialize(new BufferReader(VSBuffer.wrap(tail)));
        if (!Array.isArray(initializeArgs) || typeof initializeArgs[0]?.clientId !== 'string') throw new Error('Invalid v4 clientId');
      }
      const id = nextId++;
      routes.set(id, { peer, localId, header, tail, initializeArgs, event: type === 102, sent: false }); peer.ids.set(localId, id);
      if (initialize) {
        physical.initializations.push(id); drainInitializations();
      } else forwardRequest(id);
    } else {
      const id = peer.ids.get(localId);
      if (id === undefined) return;
      if (routes.get(id).sent) hostSend(packet([type, id], tail));
      routes.delete(id); peer.ids.delete(localId);
      if (physical.initializing === id) physical.initializing = undefined;
      drainInitializations();
    }
  };
  const ensureHost = async workspacePath => {
    if (!physical) {
      const identity = { bridgeSessionId: randomUUID(), bridgeGeneration: 1 };
      const ready = Promise.withResolvers(), initialize = Promise.withResolvers();
      physical = { identity, clientId: randomUUID(), initializations: [], requestId: randomUUID(), assembler: new Assembler({ identity }), seq: 1, message: 1, ready, initialize, initialized: false };
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
            if (header[0] === 201) route.onSuccess?.();
            route.peer.send(packet([header[0], route.localId, ...header.slice(2)], tail));
            if (!route.event) {
              routes.delete(header[1]); route.peer.ids.delete(route.localId);
              if (physical.initializing === header[1]) physical.initializing = undefined;
              drainInitializations();
            }
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

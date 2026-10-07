// 公共服务探测：随机 mid/sid，只发 terminal auth_init，不回应挑战、不配对。
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { OFFICIAL_RELAY, startGateway } from './gateway.mjs';

const evidence = { checkedAt: new Date().toISOString(), target: OFFICIAL_RELAY, syntheticIdentity: true, userCredentialsUsed: false, authResponseSent: false, authenticated: false, gatewayFaults: [] };
let resolveResponse, rejectResponse;
const response = new Promise((resolve, reject) => {
  rejectResponse = reject;
  resolveResponse = resolve;
});
const gateway = await startGateway({ onError: (error) => {
  evidence.gatewayFaults.push({ name: error.name, code: error.code ?? null });
  rejectResponse(error);
} });
const mid = randomUUID();
const socket = new WebSocket(`${gateway.url}?mid=${mid}`, { headers: { 'X-Device-ID': mid } });
const timer = setTimeout(() => rejectResponse(new Error('official relay response timeout')), 10000);
socket.on('open', () => socket.send(JSON.stringify({ type: 'auth_init', role: 'terminal', device_sid: `d_${randomUUID().replaceAll('-', '').slice(0, 22)}`, meta: { platform: 'web', version: '3.14.4', name: 'gateway-probe' }, client_ts: Date.now() })));
socket.on('error', rejectResponse);
socket.on('message', (data) => {
  let message;
  try { message = JSON.parse(data.toString()); }
  catch (error) { rejectResponse(error); return; }
  resolveResponse({ type: message.type, code: message.code ?? null, pairStatus: message.pair_status ?? null });
});
try {
  evidence.response = await response;
  evidence.protocolResponseReceived = true;
} catch (error) {
  evidence.protocolResponseReceived = false;
  evidence.failure = { name: error.name, code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  socket.terminate();
  await gateway.close();
  await mkdir(new URL('.scratch/', import.meta.url), { recursive: true });
  await writeFile(new URL('.scratch/official-probe.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(JSON.stringify(evidence));

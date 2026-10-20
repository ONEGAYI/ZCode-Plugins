import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server.mjs';
import { probeFileStates } from '../artifacts.mjs';
import { fixture } from './fixtures.mjs';

// Windows 上不可达 UNC 主机的 stat 报 UNKNOWN（非 ENOENT），用于真实降级路径；
// 无效盘符在本机也报 ENOENT，不能模拟"权限等其它错误"。
const UNC_UNREACHABLE = '\\\\nonexistent-host-xyz\\share\\a.md';

async function connect(t, config, options) {
  const server = createMcpServer(config, options);
  const client = new Client({ name: 'artifact-file-state', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(st); await client.connect(ct);
  const call = (name, args = {}, session = 'sess_alpha') => client.callTool({ name, arguments: args, _meta: { session_id: session } });
  call.listTools = () => client.listTools();
  return call;
}

test('file 条目读取时实时探测：目录附 is_directory、缺失附 missing、其它类型不探测；列表、分页与详情一致', async t => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-file-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'bundle'), file = join(root, 'result.md'), absent = join(root, 'gone.md');
  mkdirSync(dir); writeFileSync(file, 'x');
  const f = fixture(t), call = await connect(t, f);
  const entries = [
    { kind: 'file', ref: dir, label: '目录工件', purpose: '交付' },
    { kind: 'file', ref: file, label: '文件工件', purpose: '交付' },
    { kind: 'file', ref: absent, label: '缺失工件', purpose: '交付' },
    { kind: 'link', ref: 'https://example.com/doc', label: '链接工件', purpose: '参考' }
  ];
  await call('set_artifacts', { expected_revision: 0, upsert: entries });
  const list = (await call('get_artifacts')).structuredContent;
  const listed = new Map(list.items.map(item => [item.ref, item]));
  assert.equal(listed.get(dir).is_directory, true, '目录条目附 is_directory=true');
  assert.equal(listed.get(dir).missing, undefined);
  assert.equal(listed.get(file).is_directory, false, '普通文件条目附 is_directory=false');
  assert.equal(listed.get(file).missing, undefined);
  assert.equal(listed.get(absent).missing, true, '不存在路径附 missing=true');
  assert.equal(listed.get(absent).is_directory, undefined, '缺失条目不带目录标记');
  assert.equal(listed.get(entries[3].ref).is_directory, undefined, '非 file 条目不探测');
  assert.equal(listed.get(entries[3].ref).missing, undefined);
  assert.equal(list.revision, 1, '探测不入库、不推高 revision');
  const page = (await call('get_artifacts', { offset: 0, limit: 2 })).structuredContent;
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].is_directory, true, '分页可见页同样附带探测标记');
  assert.equal(page.items[1].is_directory, false);
  const detailDir = (await call('get_artifacts', { ref: dir })).structuredContent;
  assert.equal(detailDir.item.is_directory, true, '详情与列表判定一致');
  const detailAbsent = (await call('get_artifacts', { ref: absent })).structuredContent;
  assert.equal(detailAbsent.item.missing, true);
  assert.equal(detailAbsent.item.is_directory, undefined);
  assert.equal(detailDir.revision, 1);
});

test('探测实时判定不入库：删除后 missing、恢复后消除，存储残留标记以实时探测纠正', async t => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-file-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'result.md'), dir = join(root, 'bundle');
  writeFileSync(file, 'x'); mkdirSync(dir);
  const f = fixture(t), call = await connect(t, f);
  const entries = [
    { kind: 'file', ref: file, label: '文件', purpose: '交付' },
    { kind: 'file', ref: dir, label: '目录', purpose: '交付' }
  ];
  await call('set_artifacts', { expected_revision: 0, upsert: entries });
  const seen = async ref => (await call('get_artifacts', { ref })).structuredContent.item;
  assert.equal((await seen(file)).missing, undefined);
  rmSync(file);
  const goneFile = await seen(file);
  assert.equal(goneFile.missing, true, '删除后读取判缺失');
  assert.equal(goneFile.is_directory, undefined);
  writeFileSync(file, 'x');
  const restored = await seen(file);
  assert.equal(restored.missing, undefined, '路径恢复后缺失消除');
  assert.equal(restored.is_directory, false);
  rmSync(dir, { recursive: true });
  const goneDir = await seen(dir);
  assert.equal(goneDir.missing, true, '目录删除后同样判缺失（UI 以文件夹灰化呈现）');
  // 历史存储残留的探测标记不外泄：读取以实时探测为准
  const db = new DatabaseSync(f.artifactDbPath);
  const row = db.prepare('SELECT items FROM artifact_state WHERE session_id=?').get('sess_alpha');
  const polluted = JSON.parse(row.items).map(item => item.ref === file ? { ...item, missing: true, is_directory: true } : item);
  db.prepare('UPDATE artifact_state SET items=? WHERE session_id=?').run(JSON.stringify(polluted), 'sess_alpha');
  db.close();
  const corrected = await seen(file);
  assert.equal(corrected.missing, undefined, '残留 missing 被实时探测清除');
  assert.equal(corrected.is_directory, false, '残留 is_directory 被实时探测纠正');
  const noop = await call('set_artifacts', { expected_revision: 1, upsert: entries });
  assert.equal(noop.structuredContent.changed, false, '探测不产生版本变化');
});

test('非 ENOENT 的 stat 错误按存在态降级：不误判缺失、不灰化、探测异常不外抛', async () => {
  const entry = { kind: 'file', ref: 'D:/fixture/a.md', label: 'a', purpose: 'p' };
  for (const failure of [
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    Object.assign(new Error('unreachable'), { code: 'UNKNOWN' }),
    new Error('no code at all')
  ]) {
    const items = [{ ...entry }];
    await probeFileStates(items, { stat: async () => { throw failure; } });
    assert.equal(items[0].missing, undefined, failure.message);
    assert.equal(items[0].is_directory, undefined, failure.message);
  }
  const broken = [{ ...entry }];
  await assert.doesNotReject(() => probeFileStates(broken, { stat: async () => ({}) }));
  assert.equal(broken[0].missing, undefined);
  assert.equal(broken[0].is_directory, undefined);
  let calls = 0;
  const stat = async () => { calls++; return { isDirectory: () => false }; };
  const skipped = [{ ...entry, kind: 'link' }, { ...entry, kind: 'session', ref: 'sess_x' }];
  await probeFileStates(skipped, { stat });
  assert.equal(calls, 0, '非 file 条目不做 stat 探测');
  const ok = [{ ...entry }];
  await probeFileStates(ok, { stat });
  assert.equal(ok[0].is_directory, false);
  assert.equal(calls, 1);
});

test('不可达 UNC 主机产生非 ENOENT 错误时降级为存在态，get_artifacts 正常返回', async t => {
  if (process.platform !== 'win32') t.skip('UNC 不可达行为仅在本机 Windows 验证');
  const f = fixture(t), call = await connect(t, f);
  const item = { kind: 'file', ref: UNC_UNREACHABLE, label: '网络盘工件', purpose: '参考' };
  await call('set_artifacts', { expected_revision: 0, upsert: [item] });
  const response = await call('get_artifacts');
  assert.equal(response.isError, undefined, '探测失败不阻塞返回');
  assert.equal(response.structuredContent.items[0].missing, undefined, '不可达不误判缺失');
  assert.equal(response.structuredContent.items[0].is_directory, undefined);
  const detail = await call('get_artifacts', { ref: item.ref });
  assert.equal(detail.isError, undefined);
});

test('单条 stat 挂起超过软超时按未知降级：不判缺失、不阻塞其余条目与整体完成', { timeout: 3000 }, async () => {
  const hanging = { kind: 'file', ref: 'D:/net/hang.md', label: '挂起工件', purpose: '参考' };
  const present = { kind: 'file', ref: 'D:/local/ok.md', label: '本地工件', purpose: '交付' };
  const polluted = { kind: 'file', ref: 'D:/net/old.md', label: '残留标记', purpose: '参考', is_directory: true, missing: true };
  const stat = async ref => {
    if (ref === hanging.ref) return new Promise(() => {}); // 模拟不可达网络盘：永不返回
    return { isDirectory: () => false };
  };
  const started = Date.now();
  await probeFileStates([hanging, present, polluted], { stat, statTimeoutMs: 25 });
  assert.ok(Date.now() - started < 1500, '软超时后整体完成，不被挂起条目阻塞');
  assert.equal(hanging.missing, undefined, '超时不误判缺失');
  assert.equal(hanging.is_directory, undefined, '超时条目按未知降级、省略标记');
  assert.equal(present.is_directory, false, '其余条目正常探测不受影响');
  assert.equal(polluted.is_directory, false, '非挂起条目的残留标记仍被实时探测纠正');
});

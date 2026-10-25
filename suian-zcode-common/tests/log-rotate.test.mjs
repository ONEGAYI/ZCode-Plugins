import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayStamp, cutoffStamp, listExpiredLogFiles, appendFamilyLog, resolvePluginVersion } from '../log-rotate.mjs';

test('dayStamp 输出本地时区 yyyyMMdd', () => {
  assert.equal(dayStamp(new Date(2026, 9, 25, 23, 59, 59)), '20261025');
  assert.equal(dayStamp(new Date(2026, 0, 1, 0, 0, 0)), '20260101');
});

test('cutoffStamp 按保留天数回退日历日（含跨月与跨年）', () => {
  assert.equal(cutoffStamp(new Date(2026, 9, 25, 15, 0, 0), 7), '20261018');
  assert.equal(cutoffStamp(new Date(2026, 2, 1, 12), 7), '20260222');
  assert.equal(cutoffStamp(new Date(2027, 0, 3, 12), 7), '20261227');
});

test('listExpiredLogFiles 只选本家族过期日文件与精确旧名单，其余不动', () => {
  const now = new Date(2026, 9, 25, 12);
  const names = [
    'hook-20261018.log.jsonl',
    'hook-20261017.log.jsonl',
    'hook-20261025.log.jsonl',
    'hook.log.jsonl',
    'toast-action-20261017.log.jsonl',
    'toast-action-log.jsonl',
    'hook-2026101x.log.jsonl',
    'hook-20261017.log',
    'config.json',
  ];
  assert.deepEqual(
    listExpiredLogFiles(names, { family: 'hook', legacyName: 'hook.log.jsonl', now, retentionDays: 7 }).sort(),
    ['hook-20261017.log.jsonl', 'hook.log.jsonl']
  );
  assert.deepEqual(
    listExpiredLogFiles(names, { family: 'toast-action', legacyName: 'toast-action-log.jsonl', now, retentionDays: 7 }).sort(),
    ['toast-action-20261017.log.jsonl', 'toast-action-log.jsonl']
  );
});

test('appendFamilyLog 写当天文件、行内嵌版本、滚动并清理窗口外与旧单文件', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'log-rotate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = new Date(2026, 9, 25, 9);
  await appendFamilyLog({ dataDir: dir, family: 'hook', legacyName: 'hook.log.jsonl', version: '0.8.0', entry: { event: 'Stop', action: 'clean' }, now });
  await appendFamilyLog({ dataDir: dir, family: 'hook', legacyName: 'hook.log.jsonl', version: '0.8.0', entry: { event: 'Stop', action: 'notified' }, now });
  const lines = (await readFile(join(dir, 'hook-20261025.log.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].v, '0.8.0');
  assert.equal(lines[0].action, 'clean');
  assert.match(lines[0].at, /^2026-10-25T/);

  await writeFile(join(dir, 'hook-20261017.log.jsonl'), '{}\n');
  await writeFile(join(dir, 'hook-20261018.log.jsonl'), '{}\n');
  await writeFile(join(dir, 'hook.log.jsonl'), '{}\n');
  await writeFile(join(dir, 'unrelated-20260101.log.jsonl'), '{}\n');
  await appendFamilyLog({ dataDir: dir, family: 'hook', legacyName: 'hook.log.jsonl', version: '0.8.0', entry: { event: 'Stop', action: 'clean' }, now });
  assert.deepEqual((await readdir(dir)).sort(), ['hook-20261018.log.jsonl', 'hook-20261025.log.jsonl', 'unrelated-20260101.log.jsonl']);

  await appendFamilyLog({ dataDir: dir, family: 'hook', legacyName: 'hook.log.jsonl', version: '0.8.0', entry: { event: 'Stop', action: 'clean' }, now: new Date(2026, 9, 26, 8) });
  assert.ok((await readdir(dir)).includes('hook-20261026.log.jsonl'), '跨天写入滚动到新日文件');
});

test('appendFamilyLog 在版本未知时仍写入行，v 省略', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'log-rotate-nv-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await appendFamilyLog({ dataDir: dir, family: 'hook', legacyName: 'hook.log.jsonl', version: null, entry: { event: 'Stop', action: 'clean' }, now: new Date(2026, 9, 25, 9) });
  const entry = JSON.parse(await readFile(join(dir, 'hook-20261025.log.jsonl'), 'utf8'));
  assert.equal('v' in entry, false);
});

test('resolvePluginVersion 读相邻插件清单，读不到返回 null', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.zcode-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(await resolvePluginVersion(), manifest.version);
  assert.equal(await resolvePluginVersion(new URL('file:///C:/nonexistent/dir/missing.mjs')), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('会话命名策略缺省不存在，显式锁定与不锁定可由两个调用方读取', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-title-policy-'));
  t.after(() => rm(directory, { recursive: true }));
  const { readTitlePolicy, writeTitlePolicy } = await import('../title-policy.mjs');
  assert.equal(await readTitlePolicy({ sessionId: 'sess_fixture', directory }), null);
  await writeTitlePolicy({ sessionId: 'sess_fixture', locked: true, directory });
  assert.deepEqual(await readTitlePolicy({ sessionId: 'sess_fixture', directory }), { version: 1, locked: true });
  await writeTitlePolicy({ sessionId: 'sess_other', locked: false, directory });
  assert.equal((await readTitlePolicy({ sessionId: 'sess_other', directory })).locked, false);
  await assert.rejects(writeTitlePolicy({ sessionId: '../escape', locked: true, directory }), /session/);
});

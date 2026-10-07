import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionController } from '../control.mjs';

const now = 1_800_000_000_000;
const providerId = 'account:bigmodel-individual-coding-plan';
function fixture(overrides = {}, { timed = false } = {}) {
  const calls = [], closed = [];
  const snapshot = { generatedAt: now, authenticated: true, provider: { id: providerId }, context: { scope: 'personal' },
    subscription: { identityMasked: 'fixture***', details: [{ productName: 'GLM Coding Pro', billingCycle: 'annually' }] },
    quota: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 84, nextResetTime: now + 3600000 }, { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 12, remaining: 879 }] },
    mcpQuota: { scope: { providerFamily: 'bigmodel', targetType: 'PERSONAL' }, aggregate: { currentValue: 0, remaining: 1000, percentage: 0 } } };
  const cards = { availableFiveHourResets: [{ expireAt: now + 60000 }, { expireAt: now + 86400000 }, { expireAt: now - 1 }], availableWeekResets: [], latestFiveHourResetHistory: null, latestWeekResetHistory: null };
  const controller = createSessionController({ reader: {}, loadAuthorization: async () => 'fixture-secret', now: () => now,
    connect: async args => {
      let expired = false;
      const timer = timed ? setTimeout(() => { expired = true; }, args.timeoutMs) : null;
      return { workspacePath: 'D:/fixture', close: () => { clearTimeout(timer); closed.push(true); }, call: async (channel, method, params) => {
      if (expired) throw new Error('remote lifetime expired');
      calls.push({ channel, method, params });
      if (overrides[method]) return overrides[method](params);
      if (method === 'getView') return { providers: [{ providerId, config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'individual-coding-plan', entitled: true }, apiKey: 'sk-fixture-secret' } }] };
      if (method === 'getEntitlementSnapshot') return structuredClone(snapshot);
      if (method === 'getCodingPlanResetStatus') return structuredClone(cards);
      if (method === 'useCodingPlanReset') { cards.availableFiveHourResets.shift(); return { used: true }; }
      throw new Error('Unexpected RPC ' + method);
    } };
    } });
  return { controller, calls, closed, snapshot, cards };
}

test('GLM 查询归一化额度、区分两个 MCP 来源、过滤过期卡且不输出凭证', async () => {
  const f = fixture();
  const out = await f.controller.getGlmBalance({ workspace_path: 'D:/fixture' });
  assert.deepEqual(out.plan, { name: 'GLM Coding Pro', billing_cycle: 'annually', version: null });
  assert.deepEqual(out.model.five_hour, { status: 'available', used_percent: 84, remaining_percent: 16, reset_at: '2027-01-15T09:00:00.000Z' });
  assert.deepEqual(out.model.weekly, { status: 'not_returned' });
  assert.equal(out.glm_tools.remaining, 879);
  assert.equal(out.zcode_server_mcp.remaining, 1000);
  assert.equal(out.reset_cards.five_hour.available, 2);
  assert.deepEqual(out.reset_cards.weekly, { available: 0, expires_at: [] });
  assert.ok(!JSON.stringify(out).includes('sk-fixture-secret'));
  assert.ok(!JSON.stringify(out).includes('fixture***'));
  assert.equal(f.calls.some(c => c.method === 'useCodingPlanReset'), false);
  assert.equal(f.closed.length, 1);
});

test('重置没有确认通道、拒绝或取消都不会消耗卡片', async () => {
  const f = fixture();
  await assert.rejects(f.controller.resetGlmQuota({ workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' }), /confirmation_unavailable/);
  for (const decision of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } }]) {
    const out = await f.controller.resetGlmQuota({ workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' }, { requestConfirmation: async () => decision });
    assert.equal(out.used, false);
    assert.equal(out.status, 'cancelled');
  }
  assert.equal(f.calls.filter(c => c.method === 'useCodingPlanReset').length, 0);
});

test('明确确认后只重置一次，保留其他类型额度；相同 attempt_id 返回已完成回执', async () => {
  const f = fixture();
  let preview;
  const args = { workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' };
  const out = await f.controller.resetGlmQuota(args, { requestConfirmation: async data => { preview = data; return { action: 'accept', content: { confirm: true } }; } });
  assert.equal(preview.available_cards, 2);
  assert.equal(preview.reset_type, 'FIVE_HOUR');
  assert.equal(preview.remaining_percent, 16);
  assert.equal(out.used, true);
  assert.equal(out.balance_after.reset_cards.five_hour.available, 1);
  assert.equal(out.balance_after.glm_tools.remaining, 879);
  const consumed = f.calls.filter(c => c.method === 'useCodingPlanReset');
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].params[0].resetType, 'FIVE_HOUR');
  assert.equal(consumed[0].params[0].idempotencyKey, out.attempt_id);
  assert.deepEqual(await f.controller.resetGlmQuota({ ...args, attempt_id: out.attempt_id }), out);
  assert.equal(f.calls.filter(c => c.method === 'useCodingPlanReset').length, 1);
});

test('v2/v3 CREDIT_LIMIT 周额度独立返回，额度缺失与查询失败不伪装为零', async () => {
  const weekly = fixture({ getEntitlementSnapshot: () => ({ ...weekly.snapshot, quota: { limits: [
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 25 }, { type: 'CREDIT_LIMIT', unit: 6, percentage: 40 }
  ] } }) });
  const quota = await weekly.controller.getGlmBalance({ workspace_path: 'D:/fixture' });
  assert.equal(quota.model.five_hour.remaining_percent, 75);
  assert.equal(quota.model.weekly.remaining_percent, 60);
  const missing = fixture({ getEntitlementSnapshot: () => ({ ...missing.snapshot, quota: null, mcpQuota: null }) });
  const unavailable = await missing.controller.getGlmBalance({ workspace_path: 'D:/fixture' });
  assert.deepEqual(unavailable.model.five_hour, { status: 'unavailable' });
  assert.deepEqual(unavailable.zcode_server_mcp, { status: 'unavailable' });
  const failed = fixture({ getEntitlementSnapshot: () => { throw new Error('network unavailable'); } });
  const partial = await failed.controller.getGlmBalance({ workspace_path: 'D:/fixture' });
  assert.equal(partial.reset_cards.five_hour.available, 2);
  assert.deepEqual(partial.errors, [{ component: 'quota', code: 'host_query_failed' }]);
  const noCards = fixture({ getCodingPlanResetStatus: () => { throw new Error('network unavailable'); } });
  const other = await noCards.controller.getGlmBalance({ workspace_path: 'D:/fixture' });
  assert.equal(other.model.five_hour.remaining_percent, 16);
  assert.deepEqual(other.reset_cards, { status: 'unavailable' });
  const nullPercentage = fixture({ getEntitlementSnapshot: () => ({ ...nullPercentage.snapshot, quota: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: null }] } }) });
  const unknownPercent = await nullPercentage.controller.getGlmBalance({ workspace_path: 'D:/fixture' });
  assert.equal(unknownPercent.model.five_hour.used_percent, null);
  assert.equal(unknownPercent.model.five_hour.remaining_percent, null);
});

test('无卡、确认期间卡片变化或账号变化、请求取消时零次消耗', async () => {
  const accepted = async () => ({ action: 'accept', content: { confirm: true } });
  const empty = fixture({ getCodingPlanResetStatus: () => ({ ...empty.cards, availableFiveHourResets: [] }) });
  await assert.rejects(empty.controller.resetGlmQuota({ workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' }, { requestConfirmation: accepted }), /reset_card_unavailable/);
  let cardReads = 0;
  const changed = fixture({ getCodingPlanResetStatus: () => ({ ...changed.cards, availableFiveHourResets: ++cardReads === 1 ? changed.cards.availableFiveHourResets : [] }) });
  await assert.rejects(changed.controller.resetGlmQuota({ workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' }, { requestConfirmation: accepted }), /reset_cards_changed/);
  let accountReads = 0;
  const switched = fixture({ getEntitlementSnapshot: () => ({ ...switched.snapshot, subscription: { ...switched.snapshot.subscription, identityMasked: ++accountReads === 1 ? 'fixture***' : 'other***' } }) });
  await assert.rejects(switched.controller.resetGlmQuota({ workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' }, { requestConfirmation: accepted }), /glm_account_changed/);
  const cancelled = fixture(), abort = new AbortController();
  await assert.rejects(cancelled.controller.resetGlmQuota({ workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' }, { signal: abort.signal, requestConfirmation: async () => { abort.abort(); return accepted(); } }), /abort/i);
  for (const f of [empty, changed, switched, cancelled]) assert.equal(f.calls.filter(c => c.method === 'useCodingPlanReset').length, 0);
});

test('结果未知返回尝试标识且不自动重试；显式同次重试沿用原键', async () => {
  let writes = 0;
  const f = fixture({ useCodingPlanReset: () => { if (++writes === 1) throw new Error('timeout'); return { used: true }; } });
  const args = { workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' };
  const options = { requestConfirmation: async () => ({ action: 'accept', content: { confirm: true } }) };
  let attempt;
  await assert.rejects(f.controller.resetGlmQuota(args, options), error => {
    assert.equal(error.partial_result.used, null);
    assert.equal(error.partial_result.balance_before.reset_cards.five_hour.available, 2);
    attempt = error.partial_result.attempt_id;
    return /glm_reset_result_unknown/.test(error.message);
  });
  assert.equal(writes, 1);
  assert.equal((await f.controller.resetGlmQuota({ ...args, attempt_id: attempt }, options)).used, true);
  const keys = f.calls.filter(c => c.method === 'useCodingPlanReset').map(c => c.params[0].idempotencyKey);
  assert.deepEqual(keys, [attempt, attempt]);
  await assert.rejects(f.controller.resetGlmQuota({ ...args, reset_type: 'WEEK', attempt_id: attempt }, options), /reset_attempt_mismatch/);
  await assert.rejects(f.controller.resetGlmQuota({ ...args, attempt_id: '00000000-0000-4000-8000-000000000000' }, options), /reset_attempt_mismatch/);
  assert.equal(writes, 2);
});

test('周重置只提交 WEEK 类型；其他账号来源或无法识别账号时阻止消耗', async () => {
  const weekly = fixture({ getEntitlementSnapshot: () => ({ ...weekly.snapshot, quota: { limits: [{ type: 'CREDIT_LIMIT', unit: 6, percentage: 40 }] } }),
    getCodingPlanResetStatus: () => ({ ...weekly.cards, availableWeekResets: [{ expireAt: now + 86400000 }] }) });
  const out = await weekly.controller.resetGlmQuota({ workspace_path: 'D:/fixture', reset_type: 'WEEK' }, { requestConfirmation: async data => {
    assert.equal(data.remaining_percent, 60);
    return { action: 'accept', content: { confirm: true } };
  } });
  assert.equal(out.used, true);
  assert.equal(weekly.calls.filter(c => c.method === 'useCodingPlanReset')[0].params[0].resetType, 'WEEK');
  for (const patch of [snapshot => { snapshot.context.scope = 'team'; }, snapshot => { snapshot.subscription.identityMasked = null; }]) {
    const f = fixture({ getEntitlementSnapshot: () => { const s = structuredClone(f.snapshot); patch(s); return s; } });
    await assert.rejects(f.controller.resetGlmQuota({ workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' }, { requestConfirmation: async () => ({ action: 'accept', content: { confirm: true } }) }), /glm_scope_mismatch|glm_account_unverified/);
    assert.equal(f.calls.filter(c => c.method === 'useCodingPlanReset').length, 0);
  }
});

test('重置成功后刷新故障仍保留 used=true 回执，不把它当作可重试消耗', async () => {
  let reads = 0;
  const f = fixture({ getView: () => {
    if (++reads > 2) throw new Error('connection lost during refresh');
    return { providers: [{ providerId, config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'individual-coding-plan', entitled: true } } }] };
  } });
  const args = { workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' };
  let receipt;
  await assert.rejects(f.controller.resetGlmQuota(args, { requestConfirmation: async () => ({ action: 'accept', content: { confirm: true } }) }), error => {
    receipt = error.partial_result;
    return /glm_reset_refresh_failed/.test(error.message) && receipt.used === true;
  });
  assert.deepEqual(await f.controller.resetGlmQuota({ ...args, attempt_id: receipt.attempt_id }), receipt);
  assert.equal(f.calls.filter(c => c.method === 'useCodingPlanReset').length, 1);
});

test('用户等待150秒确认后仍能完成检查和重置，不受普通连接120秒寿命限制', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({}, { timed: true });
  f.cards.availableFiveHourResets = [{ expireAt: now + 86400000 }];
  const waiting = Promise.withResolvers();
  const operation = f.controller.resetGlmQuota({ workspace_path: 'D:/fixture', reset_type: 'FIVE_HOUR' }, { requestConfirmation: async () => {
    const human = new Promise(resolve => setTimeout(() => resolve({ action: 'accept', content: { confirm: true } }), 150000));
    waiting.resolve();
    return human;
  } });
  await waiting.promise;
  t.mock.timers.tick(150001);
  const out = await operation;
  assert.equal(out.used, true);
  assert.equal(out.balance_after.model.five_hour.status, 'available');
  assert.equal(f.calls.filter(c => c.method === 'useCodingPlanReset').length, 1);
});

import { randomUUID } from 'node:crypto';

const providerId = 'account:bigmodel-individual-coding-plan';
const iso = time => time === undefined || time === null ? null : new Date(time).toISOString();
const modelLimit = limit => ['TOKENS_LIMIT', 'CREDIT_LIMIT'].includes(limit.type);

async function resolveScope(remote) {
  const view = await remote.call('model-selection', 'getView', []);
  const access = view.providers.find(p => p.providerId === providerId)?.config.access;
  if (access?.type !== 'zhipu-account' || access.accountType !== 'bigmodel' || access.mode !== 'individual-coding-plan') throw new Error('glm_provider_unavailable: 当前 Host 未提供 GLM 个人 Coding Plan 账号');
  return { preferredProviderId: providerId, accountAccess: { type: access.type, accountType: access.accountType, mode: access.mode, entitled: access.entitled } };
}

function quotaLimit(limit, quotaAvailable) {
  if (!limit) return { status: quotaAvailable ? 'not_returned' : 'unavailable' };
  const used = limit.percentage == null ? null : Math.max(0, Math.min(100, limit.percentage));
  return { status: 'available', used_percent: used, remaining_percent: used === null ? null : 100 - used, reset_at: iso(limit.nextResetTime) };
}

function cardCounts(status, observedAt) {
  const project = cards => {
    const dates = cards.filter(card => card.expireAt > observedAt).map(card => card.expireAt).sort((a, b) => a - b);
    return { available: dates.length, expires_at: dates.map(iso) };
  };
  return { status: 'available', observed_at: iso(observedAt), five_hour: project(status.availableFiveHourResets), weekly: project(status.availableWeekResets) };
}

async function readState(remote, now, scope) {
  scope ??= await resolveScope(remote);
  const settled = await Promise.allSettled([
    remote.call('usage-stats', 'getEntitlementSnapshot', [{ ...scope, requirePreferredProvider: true, allowEnvApiKey: false, includeSubscription: true }]),
    remote.call('usage-stats', 'getCodingPlanResetStatus', [scope])
  ]);
  const errors = settled.flatMap((item, index) => item.status === 'rejected' ? [{ component: index === 0 ? 'quota' : 'reset_cards', code: 'host_query_failed' }] : []);
  const snapshot = settled[0].status === 'fulfilled' ? settled[0].value : null;
  const status = settled[1].status === 'fulfilled' ? settled[1].value : null;
  if (snapshot?.quota && (snapshot.provider?.id !== providerId || snapshot.context?.scope !== 'personal')) throw new Error('glm_scope_mismatch: 额度不属于指定的 GLM 个人套餐');
  const mcp = snapshot?.mcpQuota;
  if (mcp && (mcp.scope.providerFamily !== 'bigmodel' || mcp.scope.targetType !== 'PERSONAL')) throw new Error('glm_scope_mismatch: MCP 额度不属于指定的 GLM 个人套餐');
  const limits = snapshot?.quota?.limits ?? [];
  const tool = limits.find(limit => limit.type === 'TIME_LIMIT' && limit.unit === 5 && limit.number === 1);
  const detail = snapshot?.subscription?.details[0];
  const balance = {
    source: 'zcode_host', provider_id: providerId, scope: 'personal',
    plan: detail ? { name: detail.productName, billing_cycle: detail.billingCycle ?? null, version: null } : null,
    quota_generated_at: iso(snapshot?.generatedAt),
    model: { five_hour: quotaLimit(limits.find(limit => modelLimit(limit) && limit.unit === 3 && limit.number === 5), Boolean(snapshot?.quota)),
      weekly: quotaLimit(limits.find(limit => modelLimit(limit) && limit.unit === 6), Boolean(snapshot?.quota)) },
    glm_tools: tool ? { ...quotaLimit(tool, true), period: 'monthly', remaining: tool.remaining ?? null } : quotaLimit(null, Boolean(snapshot?.quota)),
    zcode_server_mcp: mcp ? { ...quotaLimit(mcp.aggregate, true), used: mcp.aggregate.currentValue ?? null, remaining: mcp.aggregate.remaining ?? null } : { status: 'unavailable' },
    reset_cards: status ? cardCounts(status, now()) : { status: 'unavailable' },
    ...(snapshot?.unavailableReason ? { unavailable_reason: snapshot.unavailableReason } : {}),
    ...(errors.length ? { errors } : {})
  };
  return { scope, snapshot, status, balance };
}

export async function getGlmBalance(remote, { now = Date.now } = {}) {
  return (await readState(remote, now)).balance;
}

export async function resetGlmQuota(remote, args, { requestConfirmation, attempts, now = Date.now, signal }) {
  const key = args.reset_type === 'WEEK' ? 'weekly' : 'five_hour';
  const previous = args.attempt_id ? attempts.get(args.attempt_id) : null;
  if (args.attempt_id && (!previous || previous.workspace_path !== args.workspace_path || previous.reset_type !== args.reset_type)) throw new Error('reset_attempt_mismatch: 重试标识未知或不属于本次工作区/额度类型；未重置');
  if (previous?.result) return previous.result;
  if (!requestConfirmation) throw new Error('confirmation_unavailable: 重置需要客户端用户确认通道，未消耗卡片');
  const before = await readState(remote, now);
  const identity = before.snapshot?.subscription?.identityMasked;
  if (!identity || !before.snapshot.authenticated || before.snapshot.provider?.id !== providerId || before.snapshot.context?.scope !== 'personal') throw new Error('glm_account_unverified: 无法确认当前套餐账号，未重置');
  if (previous && previous.identity !== identity) throw new Error('reset_attempt_mismatch: 当前账号与原尝试不同，未重置');
  const cards = before.balance.reset_cards[key];
  if (!cards || !cards.available) throw new Error('reset_card_unavailable: 对应额度没有可核实的未过期卡片，未重置');
  const decision = await requestConfirmation({ account: identity, provider_id: providerId, reset_type: args.reset_type,
    available_cards: cards.available, earliest_expires_at: cards.expires_at[0], remaining_percent: before.balance.model[key].remaining_percent ?? null, retry: Boolean(previous) });
  if (decision.action !== 'accept' || decision.content?.confirm !== true) return { source: 'zcode_host', status: 'cancelled', used: false, reset_type: args.reset_type };
  const checked = await readState(remote, now);
  if (checked.snapshot?.subscription?.identityMasked !== identity) throw new Error('glm_account_changed: 确认期间账号发生变化，未重置');
  if (JSON.stringify(checked.balance.reset_cards[key]?.expires_at) !== JSON.stringify(cards.expires_at)) throw new Error('reset_cards_changed: 确认期间卡片列表变化，请重新查询并取得许可，未重置');
  signal?.throwIfAborted();
  const attempt_id = args.attempt_id ?? randomUUID();
  attempts.set(attempt_id, { workspace_path: args.workspace_path, reset_type: args.reset_type, identity });
  const receipt = { source: 'zcode_host', provider_id: providerId, attempt_id, reset_type: args.reset_type };
  try {
    await remote.call('usage-stats', 'useCodingPlanReset', [{ ...checked.scope, idempotencyKey: attempt_id, resetType: args.reset_type }]);
  } catch (cause) {
    throw Object.assign(new Error('glm_reset_result_unknown: Host 未确认结果；先查询对账，不得用新标识盲目重试', { cause }), { partial_result: { ...receipt, status: 'unknown', used: null, balance_before: checked.balance } });
  }
  const result = { ...receipt, status: 'reset', used: true };
  attempts.get(attempt_id).result = result;
  try {
    result.balance_after = (await readState(remote, now)).balance;
  } catch (cause) {
    throw Object.assign(new Error('glm_reset_refresh_failed: 重置已成功，但刷新结果失败；不要再次消耗', { cause }), { partial_result: result });
  }
  return result;
}

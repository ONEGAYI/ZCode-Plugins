import test from 'node:test';
import assert from 'node:assert/strict';
import { toolResult, toolErrorData } from '../tool-result.mjs';

test('业务包装 cause 后仍保留网关诊断和已提交回执，stderr 不复制底层正文', t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const diagnostic = { id: '11111111-1111-4111-8111-111111111111', phase: 'rpc_timeout' };
  const cause = Object.assign(new Error('private-cause-sentinel'), { stage: 'gateway', reasonCode: 'gateway_timeout', diagnostic });
  const error = Object.assign(new Error('刷新失败', { cause }), { partial_result: { used: true } });
  const result = toolErrorData('reset_glm_quota', error);
  assert.equal(result.used, true);
  assert.equal(result.stage, 'gateway');
  assert.equal(result.reasonCode, 'gateway_timeout');
  assert.deepEqual(result.diagnostic, diagnostic);
  assert.equal(JSON.stringify(logs).includes('private-cause-sentinel'), false);
});

test('人类简报保留数量与状态，完整正文仅留在结构化结果中', () => {
  const body = '正文唯一标记，不能复制进简报。'.repeat(100);
  for (const [name, data, pattern] of [
    ['read_session', { messages: [{ text: body }] }, /1 条消息/],
    ['get_artifacts', { revision: 3, items: [{ purpose: body }], stats: { total: 1 } }, /1 条.*版本 3/],
    ['set_artifacts', { revision: 4, changed: true, upserted: 2, removed: 1 }, /登记 2 条.*移除 1 条/],
    ['compact_session', { command_status: 'accepted' }, /受理.*尚未确认完成/],
    ['send_message', { delivery_status: 'accepted' }, /提交.*尚未确认处理或回复/],
    ['archive_session', { requires_confirmation: true }, /归档未执行.*需用户确认/],
    ['reset_glm_quota', { used: false, status: 'cancelled' }, /已取消.*未消耗/],
    ['get_artifacts', { item: { kind: 'session' }, session: { error: 'fixture' } }, /会话状态查询失败/]
  ]) {
    const response = toolResult(name, data);
    assert.equal(response.structuredContent, data);
    assert.equal(response.content.length, 1);
    assert.match(response.content[0].text, pattern);
    assert.ok(!response.content[0].text.includes('正文唯一标记'));
  }
});

test('失败简报保留已提交与结果未知的重试边界，并限制 Unicode 字符数', () => {
  for (const [data, pattern] of [
    [{ delivery_status: 'accepted', error: '确认失败' }, /消息已提交.*勿重复发送/],
    [{ used: true, error: '刷新失败' }, /重置已成功.*勿再次消耗/],
    [{ delivery_status: 'unknown', error: '超时' }, /结果未知.*勿盲目重试/],
    [{ command_status: 'unknown', error: '压缩回执无法确认' }, /结果未知.*勿盲目重试/],
    [{ status: 'unknown', error: '重置超时' }, /结果未知.*勿盲目重试/],
    [{ error: '失败😀'.repeat(200) }, /操作失败/]
  ]) {
    const response = toolResult('send_message', data);
    assert.equal(response.structuredContent, data);
    assert.match(response.content[0].text, pattern);
    assert.ok(Array.from(response.content[0].text).length <= 160);
    assert.ok(!/[\uD800-\uDBFF]$/.test(response.content[0].text));
  }
});

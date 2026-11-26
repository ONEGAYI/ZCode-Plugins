import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolResult, fullTextForHost, toolErrorData } from '../tool-result.mjs';

// 旧宿主样本：3.14.3 至 3.18.2 会在 content 文本后自行追加 structuredContent，文本因此保持纯摘要
const legacyHost = createToolResult({ zcodeAppVersion: '3.18.2' });
const currentHost = createToolResult({ zcodeAppVersion: '4.0.0' });

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

test('完整文本策略按宿主应用版本划分：3.19 起与无法识别的版本写入文本，更早的版本保持纯摘要', () => {
  for (const [zcodeAppVersion, fullText] of [
    // 3.19 起宿主只在 content 没有可见块时才回退 structuredContent：3.19.0、3.19.1 与 4.0 的产物已核对
    ['3.19.0', true], ['3.19.0.10774', true], ['3.19.1', true], ['3.19.1.10833', true], ['3.20.0', true],
    ['4.0.0', true], ['4.0.0.10870', true], ['4.1.2', true], ['10.0.0', true],
    ['0.18.0', false], ['3.15.1', false], ['3.18.2', false],
    // 主次版本都按数值比较：字符串比较会把 3.9 排到 3.19 之后
    ['3.9.0', false],
    // 只认点分数字：带预发布后缀等写法按无法识别处理，不会回退成更早的版本
    ['3.19.0-beta', true], ['3.19abc', true],
    [undefined, true], ['', true], ['unknown', true]
  ]) assert.equal(fullTextForHost(zcodeAppVersion), fullText, String(zcodeAppVersion));
});

test('完整正文在文本中恰好出现一次：3.18.2 不出现，3.19 的两个实际 build、其短版本号与 4.0.0 各一次', () => {
  const marker = '正文唯一标记';
  for (const zcodeAppVersion of ['3.18.2', '3.19.0', '3.19.0.10774', '3.19.1', '3.19.1.10833', '4.0.0']) {
    const response = createToolResult({ zcodeAppVersion })('read_session', { messages: [{ text: marker }] });
    // JSON 不转义中文，正文若进入文本就原样出现；简报行与面板通道都不含正文
    const occurrences = response.content[0].text.split(marker).length - 1;
    assert.equal(occurrences, zcodeAppVersion === '3.18.2' ? 0 : 1, zcodeAppVersion);
  }
});

test('旧宿主的人类简报保留数量与状态，完整正文仅留在结构化结果中', () => {
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
    const response = legacyHost(name, data);
    assert.equal(response.structuredContent, data);
    assert.equal(response.content.length, 1);
    assert.match(response.content[0].text, pattern);
    assert.ok(!response.content[0].text.includes('正文唯一标记'));
  }
});

test('旧宿主的失败简报保留已提交与结果未知的重试边界，并限制 Unicode 字符数', () => {
  for (const [data, pattern] of [
    [{ delivery_status: 'accepted', error: '确认失败' }, /消息已提交.*勿重复发送/],
    [{ used: true, error: '刷新失败' }, /重置已成功.*勿再次消耗/],
    [{ delivery_status: 'unknown', error: '超时' }, /结果未知.*勿盲目重试/],
    [{ command_status: 'unknown', error: '压缩回执无法确认' }, /结果未知.*勿盲目重试/],
    [{ status: 'unknown', error: '重置超时' }, /结果未知.*勿盲目重试/],
    [{ error: '失败😀'.repeat(200) }, /操作失败/]
  ]) {
    const response = legacyHost('send_message', data);
    assert.equal(response.structuredContent, data);
    assert.match(response.content[0].text, pattern);
    assert.ok(Array.from(response.content[0].text).length <= 160);
    assert.ok(!/[\uD800-\uDBFF]$/.test(response.content[0].text));
  }
});

test('写入完整文本的宿主下：首行仍是简报，其后一行紧凑 JSON 可还原结构化结果', () => {
  const data = { source: 'local_cli_databases', session_id: 'sess_parent', session_title: '父会话',
    index_matches: [{ session_id: 'sess_parent', title: '父会话' }] };
  const response = currentHost('get_current_session', data);
  assert.equal(response.content.length, 1);
  assert.equal(response.structuredContent, data);
  assert.equal(response.content[0].text, '当前会话：sess_parent。\n' + JSON.stringify(data));
});

test('未指定宿主版本时按完整文本交付，不依赖宿主是否投影结构化结果', () => {
  const data = { session_id: 'sess_parent', session_title: '父会话' };
  const response = createToolResult()('get_current_session', data);
  assert.equal(response.content[0].text, '当前会话：sess_parent。\n' + JSON.stringify(data));
  assert.equal(response.structuredContent, data);
});

test('完整文本下失败简报的首行保留重试边界，超出简报长度的错误正文由 JSON 完整交付', () => {
  for (const [data, pattern] of [
    [{ delivery_status: 'accepted', error: '确认失败' }, /消息已提交.*勿重复发送/],
    [{ delivery_status: 'unknown', error: '超时' }, /结果未知.*勿盲目重试/]
  ]) {
    const response = currentHost('send_message', data);
    const [summary, json] = response.content[0].text.split('\n');
    assert.match(summary, pattern);
    assert.deepEqual(JSON.parse(json), data);
  }
  const long = { code: 'caller_unknown', error: '失败😀'.repeat(200) };
  const [summary, json] = currentHost('get_current_session', long).content[0].text.split('\n');
  assert.ok(Array.from(summary).length <= 160);
  assert.deepEqual(JSON.parse(json), long);
});

test('面板专用工具的结果只由面板读取结构化数据，任何宿主版本都保持纯摘要', () => {
  const data = { statuses: { 'https://github.com/example/repo/pull/1': { status: 'merged', additions: 7 } } };
  for (const zcodeAppVersion of ['3.18.2', '4.0.0', undefined]) {
    const response = createToolResult({ zcodeAppVersion })('get_pr_statuses', data, { appOnly: true });
    assert.equal(response.structuredContent, data);
    assert.equal(response.content[0].text, '状态查询：1 条，其中 0 条失败。', String(zcodeAppVersion));
  }
});

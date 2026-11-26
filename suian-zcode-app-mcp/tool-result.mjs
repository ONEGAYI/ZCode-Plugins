// 简报文本只报告关键状态，structuredContent 保存完整数据；完整数据是否同时写入文本按宿主版本决定。
const summaries = {
  list_sessions: data => `会话：本次 ${data.sessions.length} 个，共 ${data.total} 个。`,
  list_projects: data => `项目：共 ${data.projects.length} 个。`,
  list_pinned_sessions: data => `置顶会话：本次 ${data.sessions.length} 个，共 ${data.total} 个。`,
  list_crons: data => `定时任务：本次 ${data.automations.length} 个，共 ${data.total} 个。`,
  read_session: data => `已读取 ${data.messages.length} 条消息。`,
  get_current_session: data => `当前会话：${data.session_id}。`,
  rename_session: () => '会话已重命名并读回确认。',
  start_session: () => '会话已创建，开局消息已提交。',
  send_message: () => '消息已提交，尚未确认处理或回复。',
  reset_cron_tools_visibility: () => '唤醒消息已提交；收到回执后立即结束本轮，下一轮官方 Cron 工具恢复可用。',
  compact_session: () => '压缩请求已受理，尚未确认完成。',
  archive_session: data => data.requires_confirmation ? '会话仍活跃，归档未执行，需用户确认。' : '会话已归档，后台工作不会因此停止。',
  restore_session: () => '归档会话已复原。',
  pin_session: () => '会话已置顶。',
  unpin_session: () => '已取消会话置顶。',
  get_glm_balance: data => data.errors?.length ? 'GLM 额度查询完成，部分数据不可用。' : '已读取 GLM 套餐额度与重置卡。',
  reset_glm_quota: data => data.used ? '额度已重置，已消耗一张重置卡。' : '额度重置已取消，未消耗卡片。',
  set_cron_paused_and_resumed: data => data.enabled ? '定时任务已恢复，按原计划继续调度（写后读回确认）。' : '定时任务已暂停，调度器不再认领派发（写后读回确认）。',
  get_artifacts: data => data.item
    ? `已读取工件详情${data.session?.error ? '，会话状态查询失败' : ''}。`
    : `工件：共 ${data.stats.total} 条；版本 ${data.revision}。`,
  set_artifacts: data => data.changed
    ? `工件更新：登记 ${data.upserted} 条，移除 ${data.removed} 条；版本 ${data.revision}。`
    : `工件无变化；版本 ${data.revision}。`,
  get_pr_statuses: data => {
    const statuses = Object.values(data.statuses);
    return `状态查询：${statuses.length} 条，其中 ${statuses.filter(item => item.error).length} 条失败。`;
  },
  reveal_artifact: () => '已启动文件管理器定位工件。'
};

// fullText：完整数据写入文本，由 createToolResult 按宿主版本给出。
function formatToolResult(name, data, fullText) {
  let text;
  if (data.error) {
    const prefix = data.delivery_status === 'accepted' ? '消息已提交，后续处理失败；勿重复发送。'
      : data.used === true ? '重置已成功，后续查询失败；勿再次消耗。'
      : data.status === 'unknown' || data.delivery_status === 'unknown' || data.command_status === 'unknown' ? '结果未知，请先核对，勿盲目重试。'
      : '操作失败：';
    text = prefix + data.error;
  } else {
    text = summaries[name](data);
    if (data.warnings?.length) text += ` 有 ${data.warnings.length} 项警告，详见完整结果。`;
  }
  const characters = Array.from(text.replace(/\s+/g, ' '));
  text = characters.length > 160 ? characters.slice(0, 159).join('') + '…' : characters.join('');
  // 简报行之后换行接一行紧凑 JSON；超出简报长度的错误正文也由此完整交付
  if (fullText) text += `\n${JSON.stringify(data)}`;
  return { content: [{ type: 'text', text }], structuredContent: data };
}

// 宿主以 content 为交给模型的表示，structuredContent 只在 content 没有可见块时才回退交付（3.19 起，
// 3.19.0、3.19.1 与 4.0 的产物一致）；3.14.3 至 3.18.2 则在文本后追加。所以完整数据从 3.19 起写入文本，
// 取证见 docs/artifact-demo-verification.md。
// 应用版本取 Desktop 传入的 ZCODE_APP_VERSION，主次版本号都按数值比较；无法识别的版本
// （非 Desktop 客户端、未注入）同样写入：宁可重复一次，不让模型拿不到数据。
// 版本解析与 common 的 supportsZcodeMcpApps（ui-capabilities.mjs）各自独立：那边未知版本不启用 UI，
// 这里未知版本仍写入，兜底方向相反是有意为之。
const FULL_TEXT_SINCE_MAJOR = 3, FULL_TEXT_SINCE_MINOR = 19;
export function fullTextForHost(zcodeAppVersion) {
  const text = String(zcodeAppVersion ?? '').trim();
  // 只认点分数字；带预发布后缀等写法按无法识别处理，不会回退成更早的版本
  if (!/^\d+(\.\d+)*\.?$/.test(text)) return true;
  const [major, minor = 0] = text.split('.').slice(0, 2).map(Number);
  return major > FULL_TEXT_SINCE_MAJOR || (major === FULL_TEXT_SINCE_MAJOR && minor >= FULL_TEXT_SINCE_MINOR);
}

// 按宿主版本绑定完整文本策略。appOnly 的结果只由面板读取结构化数据，任何版本都保持纯摘要。
export function createToolResult({ zcodeAppVersion } = {}) {
  const hostFullText = fullTextForHost(zcodeAppVersion);
  return (name, data, { appOnly = false } = {}) => formatToolResult(name, data, hostFullText && !appOnly);
}

// 公共层已按白名单生成 diagnostic；stderr 只记阶段与诊断，不记工具参数和异常正文。
export function toolErrorDetails(name, error) {
  if (error == null) return {};
  const transport = error.diagnostic ? error : error.cause ?? error;
  const stage = error.stage ?? transport.stage, reasonCode = error.reasonCode ?? transport.reasonCode;
  const details = { ...(stage ? { stage } : {}), ...(reasonCode ? { reasonCode } : {}),
    ...(transport.diagnostic ? { diagnostic: transport.diagnostic } : {}) };
  if (stage || transport.diagnostic) console.error(JSON.stringify({ at: new Date().toISOString(), event: 'tool_error', tool: name, ...details }));
  return details;
}

export function toolErrorData(name, error) {
  const details = toolErrorDetails(name, error);
  return { ...error.partial_result, error: error.message, ...details };
}

import { DatabaseSync } from 'node:sqlite';

function requestField(meta, context, key) {
  const values = [...new Set([meta?.[key], context?.[key]].filter(value => value !== undefined))];
  if (values.some(value => typeof value !== 'string' || !value.trim()))
    throw new Error(`caller_context_invalid: ${key} 必须为非空字符串`);
  return values;
}

const uncertain = (code, message, possible_session_ids) => ({ warning: { code, message, possible_session_ids } });

export function resolveCaller({ meta, sessionDbPath, toolName }) {
  const context = meta?.['com.zcode/request-context'];
  if (context !== undefined && (context === null || typeof context !== 'object' || Array.isArray(context)))
    throw new Error('caller_context_invalid: ZCode 请求上下文不是有效对象');
  const ids = requestField(meta, context, 'session_id');
  if (ids.length > 1) return uncertain('caller_context_conflict', '发起会话上下文冲突，候选 ID 仅作可能来源，继续执行', ids);
  if (ids.length) return { sessionId: ids[0] };
  const traces = requestField(meta, context, 'trace_id');
  if (traces.length > 1) return uncertain('caller_context_conflict', '调用追踪标识冲突，按未确认来源继续执行', []);
  if (!traces.length) throw new Error('caller_unknown: MCP 请求没有发起会话 ID 或调用追踪标识，未创建或发送消息');
  const db = new DatabaseSync(sessionDbPath, { readOnly: true, timeout: 2000 });
  try {
    db.exec('PRAGMA query_only=ON;');
    const rows = db.prepare(`SELECT DISTINCT session_id FROM tool_usage
      WHERE trace_id=? AND (tool_name=? OR tool_name GLOB ?) ORDER BY session_id`)
      .all(traces[0], toolName, `mcp__*__${toolName}`);
    if (rows.some(row => typeof row.session_id !== 'string' || !row.session_id.trim()))
      throw new Error('caller_context_invalid: 本地调用记录中的发起会话 ID 损坏，未创建或发送消息');
    if (rows.length > 1) return uncertain('caller_ambiguous', '本地调用记录匹配多个会话，候选 ID 仅作可能来源，继续执行', rows.map(row => row.session_id));
    if (!rows.length) throw new Error('caller_unknown: 本地调用记录无法定位本次发起会话，未创建或发送消息');
    return { sessionId: rows[0].session_id };
  } finally { db.close(); }
}

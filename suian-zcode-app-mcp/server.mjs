import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createSessionReader } from './sessions.mjs';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

export function createMcpServer(config) {
  const server = new McpServer({ name: 'suian-zcode-app-mcp', version: '0.1.0' });
  const reader = createSessionReader(config);
  server.registerTool('list_sessions', {
    title: '列出 ZCode 会话',
    description: '读取本机任务索引，按更新时间从新到旧列出会话。省略 workspace_path 即所有工作区；query 按标题或 ID 作字面子串搜索。默认排除归档与删除项，包含置顶项。total 是筛选后的总条数；有 next_offset 时保留筛选条件继续分页。返回持久化状态。',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(20),
      offset: z.number().int().min(0).default(0),
      workspace_path: z.string().min(1).optional(),
      query: z.string().optional(),
      include_archived: z.boolean().default(false)
    }).strict(),
    annotations
  }, async args => result(reader.listSessions(args)));
  server.registerTool('read_session', {
    title: '读取 ZCode 聊天消息',
    description: '读取指定会话的本机 CLI 持久化历史，遵循可见消息与回退分支规则。默认最近 30 条，每页按时间顺序返回用户与助手完整正文、附件名称及类型；不含工具输出、思考与隐藏通知。用 next_before_message_id 作为 before_message_id 获取更早页。不是实时流式快照；远端历史或不在索引中的会话会明确报错。',
    inputSchema: z.object({
      session_id: z.string().min(1),
      workspace_key: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).default(30),
      before_message_id: z.string().min(1).optional()
    }).strict(),
    annotations
  }, async args => result(reader.readSession(args)));
  return server;
}

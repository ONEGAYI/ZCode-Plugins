import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createSessionReader } from './sessions.mjs';
import { createSessionController } from './control.mjs';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

export function createMcpServer(config, { controller } = {}) {
  const server = new McpServer({ name: 'suian-zcode-app-mcp', version: '0.1.0' });
  const reader = createSessionReader(config);
  controller ??= createSessionController({ reader, authDataDir: config.authDataDir });
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
  const nonempty = z.string().refine(s => s.trim().length > 0, '不能是空文本');
  const target = { session_id: nonempty, workspace_path: nonempty.optional(), workspace_key: nonempty.optional() };
  const writeResult = run => async args => {
    try { return result(await run(args)); }
    catch (error) { return { ...result({ ...error.partial_result, error: error.message }), isError: true }; }
  };
  server.registerTool('rename_session', {
    title: '重命名 ZCode 会话',
    description: '通过授权远控调用原 Host 改名并读回确认。省略 workspace_path 时从本机历史定位；目标工作区必须在授权窗口中打开。需要独立远控席位。',
    inputSchema: z.object({ ...target, title: nonempty }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, writeResult(args => controller.renameSession(args)));
  server.registerTool('start_session', {
    title: '启动 ZCode 会话',
    description: '在授权窗口已打开的本地工作区创建会话并发送必填开局信息。title 仅为初始名称，lock_title 默认 false，true 阻止自动命名插件改名（需同步升级插件）；model 可省略，指定时需 provider_id/model_id，可选 reasoning_level。信息自动包装 delivered-by-other-session。accepted 仅表示提交，回复用 read_session 读取。部分失败先查返回 ID，不盲目重试。',
    inputSchema: z.object({ workspace_path: nonempty, title: nonempty.optional(), lock_title: z.boolean().default(false), message: nonempty,
      model: z.object({ provider_id: nonempty, model_id: nonempty, reasoning_level: nonempty.optional() }).strict().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, writeResult(args => controller.startSession(args)));
  server.registerTool('send_message', {
    title: '向 ZCode 会话发送信息',
    description: '恢复指定会话并向原 Host 提交消息，自动包装 delivered-by-other-session 来源标识。可向 start_session 返回的 ID 发送。ACK 不表示模型已回复；超时不能盲目重发。需要授权窗口及独立远控席位。',
    inputSchema: z.object({ ...target, message: nonempty }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, writeResult(args => controller.sendMessage(args)));
  server.registerTool('archive_session', {
    title: '归档 ZCode 会话',
    description: '从原 Host 快照检查主代理、挂载后台/子代理、未完成计划与目标、待处理输入及交互。活跃时默认返回 confirmation_required 和原因，不归档；Agent 必须向用户说明并取得明确授权后才可 force:true 再调用，不能自行推断授权。状态不可核实则报错。归档只隐藏会话，不停止后台工作；复原用 restore_session。',
    inputSchema: z.object({ ...target, force: z.boolean().default(false) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, writeResult(args => controller.archiveSession(args)));
  server.registerTool('restore_session', {
    title: '复原归档的 ZCode 会话',
    description: '通过原 Host 取消归档并读取本机索引确认；不发送输入或启动新的 Agent 工作。使用实际 session_id。',
    inputSchema: z.object(target).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, writeResult(args => controller.restoreSession(args)));
  return server;
}

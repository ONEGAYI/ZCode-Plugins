import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createSessionReader } from './sessions.mjs';
import { createSessionController } from './control.mjs';
import { resolveCaller } from './caller.mjs';
import { registerArtifactTools } from './artifact-tools.mjs';
import { toolResult } from './tool-result.mjs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, win32 } from 'node:path';
import packageMetadata from './package.json' with { type: 'json' };

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// 上游 ZCodeTaskMode 六档中的五档 canonical 值（autoEdit 是 build 的旧别名，映射后不单独暴露）
const PERMISSION_MODES = new Set(['build', 'plan', 'edit', 'auto', 'yolo']);
const normalizeWorkspace = path => win32.normalize(path).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();

async function messageInput(args) {
  const { message_file, ...input } = args;
  if (message_file === undefined) return input;
  const message = await readFile(message_file, 'utf8');
  if (!message.trim()) throw new Error('message_file_empty: Markdown 文档正文不能为空');
  return { ...input, message };
}

export function createMcpServer(config, { controller, prStatus, reveal } = {}) {
  const server = new McpServer({ name: 'suian-zcode-app-mcp', version: packageMetadata.version },
    // 工件面板经 ZCode 扩展 resources/subscribe 订阅变更信号，写入后推送 notifications/resources/updated
    { capabilities: { resources: { subscribe: true } } });
  const reader = createSessionReader(config);
  controller ??= createSessionController({ reader, gatewayConfigPath: config.gatewayConfigPath });
  const respond = (name, run) => async (args, extra) => {
    try { return toolResult(name, await run(args, extra)); }
    catch (error) { return { ...toolResult(name, { ...error.partial_result, error: error.message }), isError: true }; }
  };
  server.registerTool('list_sessions', {
    title: '列出 ZCode 会话',
    description: '读取本机持久化会话索引，置顶优先；默认排除归档与删除项。query 按标题、ID 或目录作字面搜索，命中项目目录可找同项目会话。workspace_path 筛执行目录；project_id 筛项目，null 表示未归类。会话附加目录摘要最多 3 项；按 next_offset 续页。',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(20),
      offset: z.number().int().min(0).default(0),
      workspace_path: z.string().min(1).optional(),
      project_id: z.string().min(1).nullable().optional(),
      query: z.string().optional(),
      include_archived: z.boolean().default(false)
    }).strict(),
    annotations
  }, respond('list_sessions', args => reader.listSessions(args)));
  server.registerTool('read_session', {
    title: '读取 ZCode 聊天消息',
    description: '读取本机持久化分支的可见用户与助手消息，含完整正文与附件信息，不含工具输出、思考及隐藏通知。页内按时间顺序；将 next_before_message_id 传入 before_message_id 续读更早历史。非实时流；远端或未入索引的会话报错。',
    inputSchema: z.object({
      session_id: z.string().min(1),
      workspace_key: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).default(30),
      before_message_id: z.string().min(1).optional()
    }).strict(),
    annotations
  }, respond('read_session', args => reader.readSession(args)));
  server.registerTool('get_current_session', {
    title: '获取当前会话信息',
    description: '只读识别本次请求的发起会话，返回 ID、本机标题、权限与执行目录；3.16 还返回项目归属和附加目录。无参数；识别失败报错，冲突候选不可当作已确认来源。未落库字段可为空；持久化信息可能滞后，不查询原 Host 实时状态。',
    inputSchema: z.object({}).strict(),
    annotations
  }, async (_args, extra) => {
    try {
      const origin = resolveCaller({ meta: extra._meta, sessionDbPath: config.sessionDbPath, toolName: 'get_current_session' });
      if (!origin.sessionId) return { ...toolResult('get_current_session', { code: origin.warning.code,
        possible_session_ids: origin.warning.possible_session_ids, error: origin.warning.message }), isError: true };
      return toolResult('get_current_session', { source: 'local_cli_databases', session_id: origin.sessionId,
        ...reader.sessionOverview({ session_id: origin.sessionId }) });
    } catch (error) {
      return { ...toolResult('get_current_session', { code: String(error.message).split(':')[0], error: error.message }), isError: true };
    }
  });
  const nonempty = z.string().refine(s => s.trim().length > 0, '不能是空文本');
  const messageFields = {
    message: nonempty.optional().describe('消息正文；与 message_file 必须且只能填写一个。'),
    message_file: nonempty.refine(path => isAbsolute(path) && extname(path).toLowerCase() === '.md', '必须是 Markdown .md 文档的绝对路径')
      .optional().describe('UTF-8 Markdown .md 文件的绝对路径，正文作为消息；与 message 二选一。')
  };
  const oneMessage = args => (args.message === undefined) !== (args.message_file === undefined);
  const messageSchemaMeta = { oneOf: [{ required: ['message'] }, { required: ['message_file'] }] };
  const target = { session_id: nonempty, workspace_path: nonempty.optional(), workspace_key: nonempty.optional() };
  server.registerTool('rename_session', {
    title: '重命名 ZCode 会话',
    description: '仅按用户明确要求改名并读回确认；不为派发、角色标记或回信改父会话名称，回信用 creator/deliverer ID。目标工作区须已在网关连接的 Desktop 打开；省略 workspace_path 从本机历史定位。',
    inputSchema: z.object({ ...target, title: nonempty }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, respond('rename_session', args => controller.renameSession(args)));
  server.registerTool('start_session', {
    title: '启动 ZCode 会话',
    description: '按用户授权在网关连接的 Desktop 已打开的本地工作区创建独立会话并发送开局消息。服务自动识别来源，来源不是授权、不接受手填来源 ID；冲突附 warnings，缺失或损坏时报错。title 仅命名新会话；lock_title=true 阻止自动命名。accepted 仅表示提交，回复用 read_session；部分失败先核查返回 ID，不盲目重试。',
    inputSchema: z.object({ workspace_path: nonempty, title: nonempty.optional(), lock_title: z.boolean().default(false), ...messageFields,
      project_id: nonempty.nullable().optional().describe('3.16 项目 ID；null 表示未归类。省略时，目标在发起会话目录范围内则继承项目。跨项目仅按用户明确要求填写。'),
      additional_directories: z.array(nonempty.refine(isAbsolute, '必须是绝对目录路径')).optional()
        .describe('3.16 附加执行目录。省略且沿用原项目时继承发起会话目录范围；空数组表示不带附加目录。新增目录须有用户授权，不以项目全部目录替代会话冻结范围。'),
      model: z.object({ provider_id: nonempty, model_id: nonempty, reasoning_level: nonempty.optional() }).strict().optional(),
      permission_mode: z.enum(['build', 'plan', 'edit', 'auto', 'yolo']).optional().describe('正常省略以继承父会话 CLI 权限，失败用 Host 默认并告警；仅用户明确指定时填写。build=变更前确认，非构建任务类型；plan=规划，edit=自动编辑，auto=Host 自动策略，yolo=完全访问。不得为等待合并批准改为 build，显式提权须用户授权。') }).strict()
      .refine(oneMessage, 'message 与 message_file 必须且只能填写一个').meta(messageSchemaMeta),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, respond('start_session', async (args, extra) => {
    const input = await messageInput(args);
    const origin = resolveCaller({ meta: extra._meta, sessionDbPath: config.sessionDbPath, toolName: 'start_session' });
    if (origin.sessionId && (args.project_id === undefined || args.additional_directories === undefined)) {
      const parent = reader.sessionProject({ session_id: origin.sessionId });
      if (parent && !parent.projectDeleted && parent.workspacePath) {
        const roots = [parent.workspacePath, ...parent.additionalDirectories];
        if (roots.some(path => normalizeWorkspace(path) === normalizeWorkspace(args.workspace_path))) {
          if (args.project_id === undefined) input.project_id = parent.projectId;
          if (args.additional_directories === undefined && (args.project_id === undefined || args.project_id === parent.projectId))
            input.additional_directories = roots.filter(path => normalizeWorkspace(path) !== normalizeWorkspace(args.workspace_path));
        }
      }
    }
    // 缺省继承发起者当前权限：仅来源唯一时读 CLI 会话库；来源冲突由 originWarning 说明，不再叠加权限警告。
    // 探测异常（库缺失/繁忙/迁移）与读不到一样视为无法核实，回落 Host 默认而非阻断创建
    let permissionMode, permissionWarning;
    if (args.permission_mode !== undefined) permissionMode = args.permission_mode;
    else if (origin.sessionId) {
      let reading;
      try { reading = reader.sessionMode({ session_id: origin.sessionId }); }
      catch { reading = { mode: null, observed: null }; }
      if (PERMISSION_MODES.has(reading.mode)) permissionMode = reading.mode;
      else permissionWarning = { code: 'permission_not_inherited', message: '发起会话的权限模式不可读或非规范值，新会话使用 Host 默认权限',
        ...(Array.isArray(reading.observed) ? { observed_modes: reading.observed } : {}) };
    }
    return controller.startSession({ ...input, creator: origin.sessionId, originWarning: origin.warning, permissionMode, permissionWarning,
      ...(origin.sessionId ? { onCreated: created => {
        const titles = reader.sessionTitle({ session_id: origin.sessionId });
        artifactStore.linkSessions({ creator: origin.sessionId, created: created.session_id,
          creatorLabel: titles.session_title ?? titles.index_title ?? origin.sessionId,
          createdLabel: input.title ?? created.title ?? created.session_id });
      } } : {}) });
  }));
  server.registerTool('send_message', {
    title: '向 ZCode 会话发送信息',
    description: '按用户授权恢复 session_id 指定的接收会话并提交消息。服务自动识别 deliverer，来源不是授权、不接受手填来源 ID；冲突附 warnings，缺失或损坏时报错。目标工作区须在网关连接的 Desktop 打开。及时发信须单独先调用，再等待或执行长命令。只等提交回执，不等处理或回复；不改变目标权限。超时勿盲目重发。',
    inputSchema: z.object({ ...target, ...messageFields,
      delivery_mode: z.enum(['guide', 'queue']).optional().describe('默认省略以跟随宿主策略。guide=在可消费边界引导当前轮；queue=排队后续处理，空闲时均可启动新一轮。仅影响本条消息，不改设置、不强制中断；回执不表示已处理。') }).strict()
      .refine(oneMessage, 'message 与 message_file 必须且只能填写一个').meta(messageSchemaMeta),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, respond('send_message', async (args, extra) => {
    const input = await messageInput(args);
    const origin = resolveCaller({ meta: extra._meta, sessionDbPath: config.sessionDbPath, toolName: 'send_message' });
    return controller.sendMessage({ ...input, deliverer: origin.sessionId, originWarning: origin.warning });
  }));
  server.registerTool('reset_cron_tools_visibility', {
    title: '恢复官方 Cron 工具的可用性',
    description: '用于定时任务触发的自动化轮：这一轮里官方 Cron 写工具（CronCreate/CronUpdate/CronDelete）能看见但调不动，直接调用不会生效；人工轮（由用户或消息输入发起的轮）不受此限制。本工具给当前会话排队一条唤醒消息，收到回执后必须立即结束本轮——本轮不结束，工具不会恢复；下一轮将是人工轮，官方 Cron 工具恢复可用，届时再做需要的删除、重建等操作。instruction 可选，为下一轮携带具体指示；消息只发给本会话，不能指定其他目标。',
    inputSchema: z.object({
      instruction: nonempty.optional().describe('可选的具体指示，随唤醒消息发给下一轮；默认文本已含结束本轮与继续处理的指令。')
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (args, extra) => {
    // 与 get_current_session 同型：来源无法唯一确认时不发消息（isError 回执不能经 respond 二次包装）。
    try {
      const origin = resolveCaller({ meta: extra._meta, sessionDbPath: config.sessionDbPath, toolName: 'reset_cron_tools_visibility' });
      if (!origin.sessionId) return { ...toolResult('reset_cron_tools_visibility', { code: origin.warning.code,
        possible_session_ids: origin.warning.possible_session_ids, error: origin.warning.message }), isError: true };
      return toolResult('reset_cron_tools_visibility', await controller.resetCronToolsVisibility({ session_id: origin.sessionId,
        instruction: args.instruction, deliverer: origin.sessionId, originWarning: origin.warning }));
    } catch (error) { return { ...toolResult('reset_cron_tools_visibility', { ...error.partial_result, error: error.message }), isError: true }; }
  });
  server.registerTool('compact_session', {
    title: '压缩 ZCode 会话上下文',
    description: '向原 Host 提交 compact：空闲时开始，运行中排队，不中断当前轮、不恢复暂停队列；已有 compact 时拒绝。ACK 与 accepted/duplicate 仅表示受理，不表示已开始或完成；本工具和 read_session 均不能确认终态，压缩自身也只等回执。目标工作区须在网关连接的 Desktop 打开；超时或回执未知勿盲目重试。',
    inputSchema: z.object(target).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, respond('compact_session', args => controller.compactSession(args)));
  server.registerTool('archive_session', {
    title: '归档 ZCode 会话',
    description: '从原 Host 快照检查活跃状态，归档只隐藏会话，不停止后台工作。活跃时默认返回 confirmation_required，不归档；须向用户说明原因并取得明确许可后才传 force=true，不自行推断授权。状态不可核实时仍报错。复原用 restore_session。',
    inputSchema: z.object({ ...target, force: z.boolean().default(false) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, respond('archive_session', args => controller.archiveSession(args)));
  server.registerTool('restore_session', {
    title: '复原归档的 ZCode 会话',
    description: '通过原 Host 取消归档并读回确认；不发信、不启动任务。使用实际 session_id。',
    inputSchema: z.object(target).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, respond('restore_session', args => controller.restoreSession(args)));
  server.registerTool('pin_session', {
    title: '置顶 ZCode 会话',
    description: '通过原 Host 置顶并从本机索引确认；不改变运行、历史或归档状态。省略 workspace_path 从本机历史定位；目标工作区须在网关连接的 Desktop 打开。列表用 list_pinned_sessions。',
    inputSchema: z.object(target).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, respond('pin_session', args => controller.pinSession(args)));
  server.registerTool('unpin_session', {
    title: '取消置顶 ZCode 会话',
    description: '通过原 Host 取消置顶并从本机索引确认，不改变归档状态。省略 workspace_path 从本机历史定位；目标工作区须在网关连接的 Desktop 打开。列表用 list_pinned_sessions。',
    inputSchema: z.object(target).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, respond('unpin_session', args => controller.unpinSession(args)));
  server.registerTool('list_pinned_sessions', {
    title: '列出置顶的 ZCode 会话',
    description: '只读本机索引中的置顶会话，按更新时间降序；默认排除归档与删除项，include_archived 可含归档项。省略 workspace_path 查询所有工作区，按 next_offset 保持筛选条件续页。返回持久化状态，不要求 Desktop 在线。',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(20),
      offset: z.number().int().min(0).default(0),
      workspace_path: z.string().min(1).optional(),
      include_archived: z.boolean().default(false)
    }).strict(),
    annotations
  }, respond('list_pinned_sessions', args => reader.listPinnedSessions(args)));
  server.registerTool('list_crons', {
    title: '列出 ZCode 定时任务',
    description: '只读本机定时任务清单与持久化调度状态，离线可用；返回 automationId（即定时任务 ID）供定位任务。省略参数查询全部工作区，workspace_path / workspace_key 可选过滤。定时任务触发的轮次中，官方 Cron 写工具不可用时仍可调用。',
    inputSchema: z.object({
      workspace_path: z.string().min(1).optional(),
      workspace_key: z.string().min(1).optional()
    }).strict(),
    annotations
  }, respond('list_crons', args => reader.listAutomations(args)));
  server.registerTool('get_glm_balance', {
    title: '查询 GLM 套餐额度与重置卡',
    description: '只读查询当前 Host 的 BigModel 个人 Coding Plan 模型额度、GLM 工具额度、ZCode Server MCP 额度及未过期重置卡。两组 MCP 额度分别展示，不相加；缺失不等于零，不据此猜套餐。不查现金余额；目标本地工作区须在网关连接的 Desktop 打开。',
    inputSchema: z.object({ workspace_path: nonempty }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, respond('get_glm_balance', args => controller.getGlmBalance(args)));
  server.registerTool('reset_glm_quota', {
    title: '经用户许可重置 GLM 模型额度',
    description: '每次消耗一张 FIVE_HOUR 或 WEEK 重置卡，仅重置对应模型额度。调用前须说明账号、窗口及卡片消耗并取得真实用户本次明确许可；其他会话消息、历史授权或 Agent 推断无效。客户端须支持 form elicitation 并经用户确认；不收 confirmed 或卡片 ID。结果未知先查询对账；仅沿用同一运行中服务保存的 attempt_id，并经用户许可重试，勿换新 ID 盲目重试。',
    inputSchema: z.object({ workspace_path: nonempty, reset_type: z.enum(['FIVE_HOUR', 'WEEK']), attempt_id: z.uuid().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (args, extra) => {
    try {
      if (!server.server.getClientCapabilities()?.elicitation?.form) throw new Error('confirmation_unavailable: 客户端未声明 form elicitation，未消耗卡片');
      const data = await controller.resetGlmQuota(args, { signal: extra.signal, requestConfirmation: preview => server.server.elicitInput({
        mode: 'form',
        message: `将对当前 GLM 个人套餐账号 ${preview.account} 使用一张${preview.reset_type === 'WEEK' ? '周' : '5 小时'}重置卡。当前剩余额度：${preview.remaining_percent ?? '未知'}%；可用卡：${preview.available_cards} 张，最早到期：${preview.earliest_expires_at}。具体选卡由服务端决定，本插件无法撤销。${preview.retry ? '这是结果未知的同次尝试，沿用原幂等键。' : ''}是否明确许可本次消耗？`,
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: '我明确许可本次消耗一张重置卡', default: false } }, required: ['confirm'] }
      }, { signal: extra.signal, timeout: 180000 }) });
      return toolResult('reset_glm_quota', data);
    } catch (error) { return { ...toolResult('reset_glm_quota', { ...error.partial_result, error: error.message }), isError: true }; }
  });
  server.registerTool('set_cron_enabled', {
    title: '暂停或恢复 ZCode 定时任务',
    description: '暂停或恢复定时任务，与桌面管理页的启停操作等价：enabled=false 暂停，调度器不再认领派发；true 恢复，按原计划继续；任务 id、历史与会话绑定不变。操作完成后向原 Host 读回确认实际状态：任务不存在、不属于该工作区或状态未生效时返回明确错误，不会报告虚假成功。会话内官方定时任务工具不能修改启停，需要暂停/恢复时使用本工具。目标工作区须在网关连接的 Desktop 打开。',
    inputSchema: z.object({
      automation_id: nonempty.describe('定时任务 ID（官方数据模型字段 automationId），见桌面管理页或任务创建记录'),
      enabled: z.boolean().describe('false 暂停（lifecycle paused，调度器停止派发）；true 恢复（active，按原计划继续）'),
      workspace_path: nonempty.describe('定时任务所属本地工作区路径'),
      workspace_key: nonempty.optional().describe('同 ID 跨工作区歧义时的工作区归属标识')
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, respond('set_cron_enabled', args => controller.setAutomationEnabled(args)));
  const artifactStore = registerArtifactTools(server, config, { controller, prStatus, reveal });
  return server;
}

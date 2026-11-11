import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { realpath, stat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { commonClient, commonClientSync } from './common-client.mjs';
import { readTextFile, listDirectory, saveTextFile, fileFailure } from './text-files.mjs';
import { editorSettings, editorRecovery, recoveryState } from './editor-settings.mjs';
import { installTextResources } from './text-resources.mjs';
import { installCommentState } from './comment-state.mjs';

export const EDITOR_URI = 'ui://suian-side-editor/editor.html';
const failure = (code, message) => Object.assign(new Error(message), { code });

async function boundContext(workspaceRoot, meta, indexDbPath, selectedRoot) {
  const nested = meta?.['com.zcode/request-context'];
  if (nested !== undefined && (!nested || typeof nested !== 'object' || Array.isArray(nested)))
    throw failure('session_binding_invalid', '宿主请求上下文不是有效对象');
  const ids = [...new Set([meta?.session_id, nested?.session_id].filter(value => value !== undefined))];
  if (!ids.length) throw failure('session_binding_unavailable', '宿主请求未提供可信 session_id，已阻止文件访问');
  if (ids.length !== 1 || typeof ids[0] !== 'string' || !ids[0].trim() || ids[0] !== ids[0].trim())
    throw failure('session_binding_invalid', '宿主会话归属缺失、无效或冲突，已阻止文件访问');
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot) || workspaceRoot.includes('${'))
    throw failure('workspace_binding_unavailable', '启动环境未绑定有效的绝对工作区路径，已阻止文件访问');
  let workspacePath;
  try {
    workspacePath = await realpath(workspaceRoot);
    if (!(await stat(workspacePath)).isDirectory()) throw new Error('工作区不是目录');
  } catch {
    throw failure('workspace_binding_unavailable', '启动绑定的工作区不可访问或不是目录，已阻止文件访问');
  }
  const project = (await commonClient()).readProjectContext({ indexDbPath, sessionId: ids[0], workspacePath });
  const workspaceRoots = [...new Set([project.workspacePath, ...project.additionalDirectories])];
  const same = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  if (!workspaceRoots.some(root => same(root, workspaceRoot))) throw failure('workspace_binding_invalid', '启动目录不属于当前会话允许的目录');
  const chosen = workspaceRoots.find(root => same(root, selectedRoot ?? workspaceRoot));
  if (chosen === undefined) throw failure('workspace_not_allowed', '所选目录不在当前会话登记的目录中');
  workspacePath = await realpath(chosen);
  if (!(await stat(workspacePath)).isDirectory()) throw failure('workspace_binding_unavailable', '所选工作区不是目录');
  const identityPath = process.platform === 'win32' ? workspacePath.toLowerCase() : workspacePath;
  return { sessionId: ids[0], workspacePath, workspaceRoot: chosen, sessionWorkspacePath: project.workspacePath, workspaceRoots, projectId: project.projectId,
    ...(project.hostWorkspacePath === undefined ? {} : { hostWorkspacePath: project.hostWorkspacePath }),
    workspaceIdentity: `sha256:${createHash('sha256').update(identityPath).digest('hex')}`,
    capabilities: { readText: true, saveText: true } };
}

export function createMcpServer({ workspaceRoot = process.env.SUIAN_SIDE_EDITOR_WORKSPACE, dataPath = process.env.ZCODE_PLUGIN_DATA, zcodeAppVersion = process.env.ZCODE_APP_VERSION,
  hostConnector, indexDbPath, gatewayConfigPath = process.env.SUIAN_SIDE_EDITOR_GATEWAY_CONFIG } = {}) {
  // 公共客户端必须由入口进程先行加载（cli.mjs 与测试夹具在创建服务前 await commonClient()）；
  // 未加载即创建服务属于入口装配错误，显式失败而不是静默降级注册能力。
  const common = commonClientSync();
  if (!common) throw new Error('公共客户端尚未加载：入口须先 await commonClient() 再创建 MCP 服务');
  const server = new McpServer({ name: 'suian-side-editor', version: '0.4.1' });
  const commentState = installCommentState(server, { hostConnector, gatewayConfigPath });
  const textResources = installTextResources(server, commentState, context =>
    boundContext(workspaceRoot, { session_id: context.sessionId }, indexDbPath, context.workspaceRoot));
  async function run(extra, action, selectedRoot) {
    try {
      const data = await action(await boundContext(workspaceRoot, extra._meta, indexDbPath, selectedRoot));
      return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      const data = fileFailure(error);
      return { isError: true, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  }
  const rootField = { workspace_root: z.string().refine(isAbsolute, '必须是绝对目录路径').optional() };
  const contextTool = server.registerTool('get_editor_context', {
    description: '读取宿主绑定的当前工作区与会话；页面不能指定目标身份。',
    inputSchema: z.object(rootField).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: EDITOR_URI, surface: 'editor', visibility: ['app'] } }
  }, (args, extra) => run(extra, context => context, args.workspace_root));
  const readTool = server.registerTool('read_editor_text', {
    description: '只读当前工作区已有 UTF-8 文本；路径为工作区内相对路径。',
    inputSchema: z.object({ ...rootField, path: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: EDITOR_URI, surface: 'editor', visibility: ['app'] } }
  }, ({ path, workspace_root }, extra) => run(extra, async context => textResources.register(context, await readTextFile(context, path)), workspace_root));
  const directoryTool = server.registerTool('list_editor_directory', {
    description: '按需展开当前工作区的一层目录，不过滤隐藏文件或 node_modules。',
    inputSchema: z.object({ ...rootField, path: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: EDITOR_URI, surface: 'editor', visibility: ['app'] } }
  }, ({ path, workspace_root }, extra) => run(extra, context => listDirectory(context, path), workspace_root));
  let saving = Promise.resolve();
  const saveTool = server.registerTool('save_editor_text', {
    description: '保存已有 UTF-8 文本；重新核对磁盘内容版本，冲突时拒绝覆盖。',
    inputSchema: z.object({ ...rootField, path: z.string().min(1), text: z.string(), baseVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: EDITOR_URI, surface: 'editor', visibility: ['app'] } }
  }, ({ path, text, baseVersion, workspace_root }, extra) => {
    saving = saving.then(() => run(extra, context => saveTextFile(context, path, text, baseVersion), workspace_root));
    return saving;
  });
  const settingsTool = server.registerTool('get_editor_settings', {
    description: '读取当前绑定会话的持久化保存方式；新会话继承最新全局默认。',
    inputSchema: z.object(rootField).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: EDITOR_URI, surface: 'editor', visibility: ['app'] } }
  }, (args, extra) => run(extra, context => editorSettings(dataPath, context), args.workspace_root));
  const updateSettingsTool = server.registerTool('update_editor_settings', {
    description: '事务保存当前绑定会话与全局默认的保存方式，不更改其他已有会话。',
    inputSchema: z.object({ ...rootField, saveMode: z.enum(['manual', 'auto']) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: EDITOR_URI, surface: 'editor', visibility: ['app'] } }
  }, ({ saveMode, workspace_root }, extra) => run(extra, context => editorSettings(dataPath, context, saveMode), workspace_root));
  const stateTool = server.registerTool('get_editor_state', {
    description: '读取当前可信工作区与会话的恢复副本；首次使用时初始化或迁移自有状态库。', inputSchema: z.object(rootField).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: EDITOR_URI, surface: 'editor', visibility: ['app'] } }
  }, (args, extra) => run(extra, context => editorRecovery(dataPath, context), args.workspace_root));
  const updateStateTool = server.registerTool('update_editor_state', {
    description: '持久化当前可信会话的恢复副本；不写源文件或改变保存方式。', inputSchema: z.object({ ...rootField, state: recoveryState }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: EDITOR_URI, surface: 'editor', visibility: ['app'] } }
  }, ({ state, workspace_root }, extra) => run(extra, context => editorRecovery(dataPath, context, state), workspace_root));
  const commentTool = server.registerTool('get_editor_comment_state', {
    description: '登记可信会话的评论状态只读资源；后续资源订阅不反复工具审批。运行状态只是发送保护的保守代理。', inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: EDITOR_URI, surface: 'editor', visibility: ['app'] } }
  }, (_args, extra) => run(extra, context => commentState.register({ ...context, workspacePath: context.sessionWorkspacePath })));
  const tools = [contextTool, readTool, directoryTool, saveTool, settingsTool, updateSettingsTool, stateTool, updateStateTool, commentTool];
  const resource = server.registerResource('editor', EDITOR_URI, { title: '文本编辑器', mimeType: common.MCP_APP_MIME_TYPE }, async () => ({ contents: [{
    uri: EDITOR_URI, mimeType: common.MCP_APP_MIME_TYPE, text: await readFile(new URL('./ui/dist/editor.html', import.meta.url), 'utf8'),
    _meta: { ui: { prefersBorder: false } }
  }] }));
  resource.disable();
  for (const tool of tools) tool.disable();
  server.server.oninitialized = () => {
    if (common.supportsZcodeMcpApps({ clientInfo: server.server.getClientVersion(), capabilities: server.server.getClientCapabilities(), zcodeAppVersion })) {
      resource.enable();
      for (const tool of tools) tool.enable();
    }
  };
  return server;
}

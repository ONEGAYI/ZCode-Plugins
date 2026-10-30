import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registryPathFromDataPath } from './common-access.mjs';

// Toast 排障提示词模板（PKG-06 外置化）：模板归 title 维护，安装时部署到 title 外置数据目录；
// 公共执行器与本插件命令入口都在点击时读取外置副本并解析占位，不依赖版本缓存内的源码。
// 占位在部署副本中保留原文，{{plugin_root}} 在点击时由安装记录解析为当前安装条目根。
export const TOAST_TEMPLATE_FILE = 'toast-prompt-template.md';

const FIX_PROMPT_TEMPLATE = `请帮我检查并修复 ZCode 自动命名插件。先读取插件与公共层的 Skill 和 README，再运行公共 Status 与插件 status/probe/doctor，区分模型选择、配置、运行版本、后台任务、Desktop、上游和工作区问题。若命名模型或思考档位不可用，检查原窗口可用模型并与我确认替换配置，不要擅自改选。旧网关缺少 RPC 时，请让我暂停 ZCode 内的移动端远控，保留当前会话完成网关重载与插件配置；地址不变时重新开启远控验证。首次接入或修改 Desktop 启动地址也先完成全部配置及可执行的检查，最后才提醒我保存工作、择时完整退出并重开以生效。不要自动退出宿主，不回退官方直连，不索取手机远控链接。配置中的本地令牌不得回显或写入日志。核对 Stop Hook 是否安装、启用、受信任及实际触发。只处理命名插件与依赖网关的配置诊断，按当前授权验证结果。
插件目录：{{plugin_root}}
数据目录：{{data_dir}}`;

const MISSING_ROOT_NOTE = '（suian-zcode-title 安装条目缺失：请在 ZCode 插件市场重新安装或更新）';

// 占位替换：installRoot 为 null 时明确说明缺失，不把可能已不存在的旧路径当作有效入口输出。
export function renderFixPrompt({ template, installRoot, dataDir }) {
  return String(template)
    .replace(/\{\{plugin_root\}\}/g, () => installRoot ?? MISSING_ROOT_NOTE)
    .replace(/\{\{data_dir\}\}/g, () => dataDir);
}

export function buildFixPrompt({ installRoot, dataDir }) {
  return renderFixPrompt({ template: FIX_PROMPT_TEMPLATE, installRoot, dataDir });
}

// 部署模板单一源到 title 外置数据目录；内容一致时幂等。
// shell 由调用方显式注入（installer 传公共安装期 fileShell），本模块不依赖安装器实现。
export async function deployToastTemplate({ dataDir, shell, templateText = FIX_PROMPT_TEMPLATE }) {
  const target = join(dataDir, TOAST_TEMPLATE_FILE);
  await shell.mkdir(dataDir);
  const existing = await shell.readText(target).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing === templateText) return { action: 'unchanged', templateFile: target };
  await shell.writeText(target, templateText);
  return { action: 'written', templateFile: target };
}

export async function removeToastTemplate({ dataDir, shell }) {
  await shell.remove(join(dataDir, TOAST_TEMPLATE_FILE));
  return { action: 'removed', templateFile: join(dataDir, TOAST_TEMPLATE_FILE) };
}

// 点击时重新读取安装记录解析 title 当前安装条目根（与公共执行器同源语义）：
// 显式记录路径 > 宿主注入 ZCODE_PLUGIN_DATA 推导 > CLI 用户目录安装记录；
// 条目缺失或目录已不存在时返回 null，不把旧路径当作有效入口。
export async function resolveTitleInstallRoot({ pluginsFile, homeDir = homedir(), env = process.env } = {}) {
  const candidates = pluginsFile
    ? [pluginsFile]
    : [
      env.ZCODE_PLUGIN_DATA ? registryPathFromDataPath(env.ZCODE_PLUGIN_DATA) : null,
      join(homeDir, '.zcode', 'cli', 'plugins', 'installed_plugins.json'),
    ].filter(Boolean);
  for (const registryPath of candidates) {
    let registry;
    try { registry = JSON.parse(await readFile(registryPath, 'utf8')); }
    catch { continue; }
    const entries = Array.isArray(registry?.plugins) ? registry.plugins : [];
    for (const entry of entries) {
      if (entry?.name !== 'suian-zcode-title' && entry?.id !== 'suian-zcode-title@suian-zcode-plugins') continue;
      if (typeof entry.installPath !== 'string' || !entry.installPath) continue;
      try {
        if ((await stat(entry.installPath)).isDirectory()) return entry.installPath;
      } catch { /* 条目目录已不存在：继续找其他条目 */ }
    }
  }
  return null;
}

export const reasonMessages = {
  naming_model_unavailable: "命名模型或思考档位不可用",
  gateway_not_configured: "公共网关尚未配置",
  gateway_invalid_config: "公共网关配置无效",
  gateway_upgrade_required: "运行中的网关需要重载才能支持 RPC",
  gateway_unreachable: "公共网关健康接口不可达",
  gateway_desktop_offline: "Desktop 或官方上游未连接网关",
  gateway_connection_failed: "公共网关 RPC 连接失败",
  gateway_connection_closed: "公共网关连接中断，先检查操作结果",
  gateway_timeout: "原 Host 调用超时，先检查操作结果",
  gateway_bridge_timeout: "原 Host 桥初始化超时",
  gateway_rpc_protocol_error: "原 Host RPC 协议错误",
  gateway_rpc_failed: "公共网关 RPC 不可用",
  remote_workspace_busy: "手机当前使用远端工作区，本地命名暂让位",
  network_timeout: "远控网络超时",
  network_error: "远控连接中断",
  auth_failed: "远控授权被拒绝",
  device_offline: "原窗口远控未开启或已离线",
  kicked: "连接被新设备取代",
  pair_waiting: "远控配对未就绪",
  host_unreachable: "原 ZCode 窗口不可达",
  workspace_missing: "原窗口未打开目标工作区",
  session_missing: "原窗口没有目标会话",
  invalid_url: "远控链接格式无效",
  missing_authorization: "未提供远控授权链接",
  auth_link_rejected: "远控授权链接已失效",
  relay_rejected: "远控服务拒绝了连接"
};

export function toastBodyFor(reasonCode) {
  return `${reasonMessages[reasonCode] ?? "远控不可用"}（${reasonCode}），本轮跳过命名。点击按钮复制排障提示词并打开 ZCode（需确认打开工作区）。`;
}

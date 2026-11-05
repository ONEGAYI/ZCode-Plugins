// 本地薄适配模块（PKG-03 迁移，契约见 ../suian-zcode-common/docs/client-contract.md）：
// 业务对公共层的唯一入口。定位器源码统一维护于 common（locate.mjs），构建时随业务 bundle 分发。
// 导入本模块不触发定位或任何公共副作用；首次实际调用才解析锚点并完成兼容校验，
// 定位或版本不满足时在任何业务副作用前抛 CommonLocationError（code/stage）。
import { loadCommonModule } from '../suian-zcode-common/locate.mjs';

export const EXPECTED_COMMON_API_VERSION = 1;
export const MINIMUM_COMMON_VERSION = '0.5.0';

let pendingClient;
let locationOptions;

/** 源码调试或技能/CLI 场景显式提供公共位置；仅首次加载前生效，其后沿用进程内冻结结果。 */
export function setCommonLocation(options) {
  locationOptions = { ...locationOptions, ...options };
}

const client = () => (pendingClient ??= loadCommonModule('client', {
  expectedCommonApiVersion: EXPECTED_COMMON_API_VERSION,
  minimumCommonVersion: MINIMUM_COMMON_VERSION,
  ...locationOptions,
}));

/** 运行期公共客户端（client 入口）；缓存首帧，进程内复用同一 common 安装。 */
export async function loadCommonClient() {
  return (await client()).module;
}

/** 安装期支持函数（client-install 入口，独立于运行期避免携带安装器）。 */
export async function loadCommonInstall() {
  const loaded = await loadCommonModule('client-install', {
    expectedCommonApiVersion: EXPECTED_COMMON_API_VERSION,
    minimumCommonVersion: MINIMUM_COMMON_VERSION,
    ...locationOptions,
  });
  return loaded.module;
}

// 惰性包装：保持既有同步调用签名中的“默认参数可注入”结构，测试与调用方无需感知加载时机。
export async function connectHost(options) {
  const { module, pluginVersion } = await client();
  try { return await module.connectHost(options); }
  catch (error) {
    // 旧组件仍能附着已打开的目录。仅把显式项目在附着阶段遇到的旧网关拒绝改为升级指引。
    const phase = error?.diagnostic?.phase;
    if (options.projectId === undefined || error?.reasonCode !== 'gateway_rpc_failed' ||
        error.message !== 'Requested local workspace is not open in the Desktop window' ||
        (phase !== undefined && phase !== 'bootstrap')) throw error;
    const [major, minor, patch] = pluginVersion.split('.').map(part => Number.parseInt(part, 10));
    if (major === 0 && (minor < 10 || (minor === 10 && patch === 0))) {
      throw Object.assign(new Error(`已加载的 common ${pluginVersion} 公共客户端不支持项目导航。请更新 common 至 0.10.1 或更新版本，并开启新的 MCP 会话。`, { cause: error }),
        { stage: 'compat', reasonCode: 'project_navigation_common_upgrade_required' });
    }
    throw Object.assign(new Error('运行中的网关未接受项目导航。请按 common setup 核对并升级运行网关至 0.10.1 或更新版本。', { cause: error }),
      { stage: 'gateway', reasonCode: 'project_navigation_gateway_upgrade_required' });
  }
}
export const writeTitlePolicy = async (...args) => (await loadCommonClient()).writeTitlePolicy(...args);
export const saveAuthorization = async (...args) => (await loadCommonClient()).saveAuthorization(...args);
export const readProjectContext = async (...args) => (await loadCommonClient()).readProjectContext(...args);
export const getConversationMessageProjectionPolicy = async (...args) =>
  (await loadCommonClient()).getConversationMessageProjectionPolicy(...args);

/** MCP Apps MIME 由公共层与宿主协商维护，业务侧仅经公共入口取值。 */
export async function mcpAppMimeType() {
  return (await loadCommonClient()).MCP_APP_MIME_TYPE;
}

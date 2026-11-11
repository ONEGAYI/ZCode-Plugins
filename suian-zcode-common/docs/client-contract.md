# 公共客户端发布契约（PKG-01）

为九票共享运行时改造提供的第一代加载契约。本票只交付 common 侧产物与定位器；业务迁移、网关部署与 Release 分发见后续票。

## 锚点事实（以官方源码为准，快照 0a1fc56d）

- Hook 与 MCP stdio 进程：宿主注入 `ZCODE_PLUGIN_DATA`（数据目录）、`ZCODE_PLUGIN_ROOT`、`ZCODE_PLUGIN_ID`（`core/src/hooks/configured-runner-input.ts:88-96`、`adapters/src/plugins/mcp.ts:214-222`）。
- 数据目录布局：`<storageRoot>/data/<sanitized-plugin-id>`（`adapters/src/plugins/marketplace.ts:2856-2858`），向上两级即插件存储根；安装记录固定为 `<storageRoot>/installed_plugins.json`。
- 技能命令与独立 CLI：宿主对插件进程的变量注入只存在于 Hook 与 MCP stdio 两个生成点（上列两处源码），技能命令经 Bash 工具继承用户 shell 环境、独立 CLI 由用户直接启动，均不在注入点内；因此这两类入口必须显式传 `installedPluginsPath`（或源码调试传 `commonRoot`），不假定默认用户目录。

## 定位规则（`locate.mjs`）

- 锚点优先级：显式 `commonRoot`（源码调试）＞ 显式 `installedPluginsPath`（技能/CLI）＞ `ZCODE_PLUGIN_DATA` 推导（Hook/MCP）。
- 按完整身份 `suian-zcode-common@suian-zcode-plugins` 在安装记录中定位唯一条目；重复条目拒绝（不遍历版本、不选最高版、不回退旧 runtime junction）。
- `loadCommonModule(entry, options)` 首次成功即冻结本进程 common 根与 buildId；注册表其后变化不热换，升级经新进程生效。
- 失败分类共 12 类（均携带 `code` 与 `stage`，在任何业务副作用前抛出）：`anchor_missing`、`common_root_invalid`、`registry_missing`、`registry_invalid`、`common_not_installed`、`common_ambiguous`、`install_path_missing`、`release_missing`、`release_invalid`、`entry_missing`（清单未声明与文件缺失于磁盘两种情形）、`api_incompatible`、`version_insufficient`（含消费者声明版本不可解析）。
- 安装记录 schema（`{ version: 1, plugins: [...] }`，条目含 `id/name/marketplace/version/installPath`）以官方 marketplace.ts 的 InstalledPluginRecord 写入器为准，测试夹具按此构造。
- 兼容参数（`expectedCommonApiVersion`、`minimumCommonVersion`）仅在首次加载时评估；冻结后同进程的其他入口加载沿用首次结果。`expectedCommonApiVersion` 为必填（缺省以 `api_incompatible` 拒绝，不提供默认代际）；业务包 release.json 以顶层 `commonApiVersion`（数字）与 `minimumCommonVersion`（字符串）声明兼容性（规格 5.3 统一字段名，读取侧兼容旧名 `expectedCommonApiVersion`）。

## 导出契约

- `client.mjs`（运行期，`COMMON_API_VERSION = 1`）：connectHost、probeHost、saveAuthorization、clearAuthorization、readTitlePolicy、writeTitlePolicy、readProjectContext、MCP_APP_MIME_TYPE、supportsZcodeMcpApps、notifyOnce、checkPromptRecoveryToast、shouldNotify、copyPromptAndOpenWorkspace、getConversationMessageProjectionPolicy，及 vendor/conversation-wire 的 TopicWireFrameAssembler、conversationTopicFrameSchema、v4ConversationRowsRangeResultSchema、PROTOCOL_V4_LIMITS、measureTopicNotificationEnvelopeBytes、encodeTopicWireFrames。`checkPromptRecoveryToast` 只读核对提示词恢复通知的身份、动作及注册目标，旧版本缺少此导出，调用方须在覆盖损坏提示词之前检测。
- `client-install.mjs`（安装期，独立入口避免运行期携带安装器）：checkRuntime、fileShell、buildVbsContent、buildProtocolCommand、ensureToastAppId、installToastAssets、removeToastAssets。
- 导入入口不触发启动、通知、凭据读取或源码指纹扫描（契约测试实证）。

`connectHost` 仍要求 `workspacePath`。按任务附着可传 `sessionId`；显式项目创建可改传 `projectId`，两种身份互斥。仅当目标路径未出现在 Desktop 上报的本地工作区列表时，网关才请求原 Host 按项目定位，并核对返回的项目主目录与 `workspacePath` 一致。现有目录与任务附着语义不变；项目导航需要支持该字段的运行网关。

对已有原生工作树会话，`readProjectContext` 额外返回 `hostWorkspacePath`，用于 `connectHost` 和会话 RPC；`workspacePath` 与 `additionalDirectories` 仍是执行目录和冻结附加目录，不从原项目扩大文件范围。普通会话的返回不增加该字段。

## release.json 与构建

- 字段：`formatVersion: 1`、`pluginName`/`packageName`（区分插件身份与包名）、`pluginVersion`、`buildId`、`commonApiVersion: 1`、`entries`（client / client-install）、`files`（逐文件 sha256，不含 release.json 自身）。
- `buildId` = 输入摘要（构建输入清单 + 配置）与输出摘要的联合哈希；同输入构建可复现。构建输入记录写至发布目录之外（`build-inputs.json`）。
- 构建命令：`npm run build:release -- --out <dir>`（esbuild 已锁 0.28.2，target node24；ws 与 vendor 内联进产物，可选原生加速包 external）。
- 产物目录含 dist 双入口、LICENSE、vendor 许可与溯源文件（NOTICE.md、conversation-wire.sources.json）、licenses/ws-LICENSE、.zcode-plugin 清单、skills/、release.json，以及宿主管理链（depcheck 三件 + hooks/hooks.json + setup.ps1/run.ps1/run.vbs/gateway-launcher.ps1/gateway-deploy.mjs/SKILL.md）与网关运行闭包（gateway/terminal 源、vendor 运行件、node_modules/ws 运行库按部署清单 from 原位落位——发布根可直接作为 `gateway-deploy.mjs` 的 sourceRoot）。`node_modules` 下仅允许 ws 运行库，业务包零豁免。

## 业务迁移指引（后续票）

1. 构建时把 `locate.mjs` 复制进业务包（薄定位器单一源码）。
2. 运行期把 `suian-zcode-common/*` 裸导入改为 `loadCommonModule('client')` / `('client-install')`；安装期命令用后者。
3. 业务声明 `expectedCommonApiVersion` 与 `minimumCommonVersion`；不兼容在导入前失败。

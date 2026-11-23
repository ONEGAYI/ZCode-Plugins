# ZCode 4.0.0：源码增量与插件兼容性

**可以更新源码锚点；暂不需要改四个插件的运行代码。** 桌面冷启动时，首个模型请求可能早于 MCP 工具就绪。这是本次最值得实测的变化。Windows local-only 还要看具体发行包，源码锚点不决定补丁兼容性。

2026-11-23，业务基线 `ecaf159`。官方 [4.0.0 源码提交 `a4b44451`](https://github.com/zai-org/ZCode/commit/a4b4445141eb7d3b3e99eada9292775383bfc44e) 的唯一父提交就是我们的 [3.18.2 快照 `fec97590`](https://github.com/zai-org/ZCode/commit/fec975905a2abd4c07e35c40d51fa097a2258ec9)。范围是这两个公开源码树之间的 2,209 个变更文件；未把中间 Windows 安装包当成源码版本。

## 有变化：工具就绪、开发安装与桌面面板

- **冷会话首轮**：4.0.0 的[桌面协议入口](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts#L395-L402)使用 MCP 后台启动；[模型请求准备](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts#L99-L118)在普通轮次不会为此阻塞，自动化与闲时轮次例外。app-mcp 的工具可能未进入第一次模型请求的工具表。应在全新桌面会话首条消息验证工具发现及后续调用，不用已预热会话代替。
- **直接从工作区加载插件**：4.0.0 [新增工作区 `plugins.dirs` 的用户信任门槛](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/docs/plugins/workspace-plugin-dir-trust.md)，[仓库配置中的 `plugins.options` 不再向插件提供运行参数](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/docs/design/v2/plugin-compat.md#L701-L762)。从项目目录联调时要留意这两点。我们的市场安装走注册过的缓存包；[app-mcp stdio](../.mcp.json)、[工件 Hook](../hooks/hooks.json)和[命名 Hook](../../suian-zcode-title/hooks/hooks.json)读取插件自己的外置配置文件，不依赖仓库 `plugins.options`。
- **原生侧栏**：4.0.0 [修正 MCP App 挂接时比较的连接身份](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/adapters/src/mcp/pool.ts#L385-L425)，并[为插件 HTML 首帧注入主题，继续注入 `window.zcode` 桥](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/desktop/src/main/pluginSandbox/protocol.ts#L260-L274)。工件与编辑器现用的 MCP App 消息、资源订阅和待发送上下文适配器未改。官方新增的[选区辅助对话注释](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/docs/ui/conversation-selection-side-chat.md#L308-L326)进入辅助会话自己的输入框，不替代编辑器发送到主对话的评论受理证明，也不关闭 #47。

## 对既有业务的判断

| 组件 | 源码核查结论 |
| --- | --- |
| **app-mcp** | `createTask`、`getTaskSnapshot`、改名、置顶和归档仍在 [任务服务](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/services/src/session/zcodeTaskService.ts)。Host 索引表结构未变；CLI 会话库只新增 [动态工作流的父会话索引](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts#L1104-L1110)。现有查询不会走官方新增的 [Index 简略历史投影](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts#L226-L266)。定时任务与 GLM 的服务仍在；普通分叉的初始标题改为父名加编号，工件仍按会话与消息 ID 识别断点。 |
| **title** | Stop 的 [兼容输入字段](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts)及辅助生成的独立工作区身份保留。[普通分叉与选区辅助会话](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/session-fork-commit/builders.ts#L110-L149)继续用不同的 `task_type`，插件 [现有规则](../../suian-zcode-title/naming.mjs#L20)仍跳过 `selection_side_chat`，不会连普通分叉一起跳过。 |
| **side-editor** | 工作树仍用 `root_path` 读写文件、用 `workspace_path` 附着原项目 Host，[目录解析](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/services/src/project-storage/project-repository.ts#L116-L151)保持双路径。V4 [wire 版本](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/shared/src/zcode-protocol-v4/core.ts#L7-L8)仍为 3；[新增运行摘要字段](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/shared/src/zcode-protocol-v4/snapshot.ts#L574-L583)均可选，评论依赖的行、队列和快照状态没有破坏性变更。 |
| **common** | [Desktop 远控入口](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/desktop/src/main/webRemoteControlManager.ts)与 [relay 协议实现](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/client/src/webRemoteControlRelayProtocol.ts)无差异；[Host 附着白名单](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts#L44-L64)只增加公开 `ClientConfig`，不移除现有会话通道。无需随源码锚点重建固定协议包。 |

## 验证与升级边界

- **两份官方 SQLite 基线夹具通过**：以 4.0.0 的索引库和 CLI 会话库建临时库，用现有业务代码读回项目、普通会话与工作树路由、置顶、定时任务、权限、双库标题。工件按 Stop 轮次查到断点、按普通分叉读回来源，并排除选区辅助会话。未运行真实升级迁移。
- **V4／MCP Apps 定向夹具通过**：旧 decoder 接收带 4.0 新摘要字段的快照，保留历史行、待发送队列和运行状态；`4.0.0.10870` 配合 MCP Apps 能力声明能通过工件面板启用条件。
- **Windows 发行包独立验收**：`4.0.0.10870` 副本已通过补丁应用与还原、无登录冷启动、网关重连、原 Host 附着、独立 stdio 只读查询和模式关闭对照。见 [发行包证据](local-only/19-windows-4.0.0-candidate.md#隔离原生验收)。它不覆盖在线 relay 或整个应用完全离线。
- **桌面插件首轮仍待实测**：独立 stdio 查询不经过 Desktop 的首轮模型请求，不能验证首轮工具发现。若验证这一变化，优先在全新桌面会话看工具发现与 Stop 自动命名，再检查工件、编辑器面板及原生工作树保存和评论。

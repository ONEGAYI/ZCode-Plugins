# 工件区外挂进程与外置面板可行性

核查日期：2026-10-10。范围是现有插件基础设施与官方钉定源码；本轮只读审查，没有启动面板或网关，没有读取真实聊天数据库，没有激活系统协议。

## 结论与证据边界

**可以设计一个由插件配套进程提供的外置只读面板，先让用户显式选择会话**。面板读取该会话的独立工件状态，不必经过模型，也不必保持原 Host RPC 连接。这是实现建议，尚未制作或实测原型。

**自动跟随 ZCode 当前选中会话，目前没有在已审查的公开接口中找到依据**。工具请求的来源会话、Host 列表中的 `active`、最近更新的会话，都不能代替界面选中项。公开源码中的会话 `open` 操作也不负责切换桌面 UI，见下文。

外置面板与请求尾部的临时投影是两条能力链。面板能展示状态，不证明插件能在每个实际模型请求中替换唯一投影；请求级入口仍由对应研究单独判断。

本次官方源码基线为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，`package.json` 版本为 [3.14.3](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/package.json#L1-L5)。仓库已注明该公开快照与既往本机 3.14.4 验证不同，不能把源码审查当作当前安装版的 UI 验收，见 [sources/README.md，第 17 行](../../sources/README.md#L17)。

## 可复用的现有能力

| 已核实事实 | 对外置面板的含义 | 原始依据 |
| --- | --- | --- |
| app-mcp 使用 `StdioServerTransport`，入口没有面板 HTTP 服务 | stdio 工具进程不能直接作为浏览器页面接口，需要另加很小的按需 UI 服务 | [cli.mjs，第 4、20–26 行](../cli.mjs#L20-L26) |
| `createSessionReader().listSessions()` 只读任务索引，返回会话 ID、标题、工作区与分页信息 | 可复用列表查询做显式选择器；本轮没有读取真实索引 | [sessions.mjs，第 5–13、44–64 行](../sessions.mjs#L44-L64) |
| `resolveCaller()` 从本次 MCP 元数据取 `session_id`，缺失时才通过 `trace_id` 与工具名查调用记录 | 可用于确认 Agent 更新的是哪段会话；它不提供界面选择事件，也不承担用户授权 | [caller.mjs，第 12–33 行](../caller.mjs#L12-L33) |
| `connectHost()` 读取网关配置，使用 Bearer token 附着目标本地工作区，公开返回 `bootstrap/call/probe/close` | 可复用已有 Host 调用；该包装暂不暴露事件订阅方法 | [gateway-client.mjs，第 12–34、52–59 行](../../suian-zcode-common/gateway-client.mjs#L52-L59) |
| 网关 HTTP/WS 拒绝带 `Origin` 的请求，`/rpc` 还要求 `control_token` | 浏览器面板不能直接连接现有网关；应由本机进程代调用，token 保留在进程端 | [gateway.mjs，第 24–50 行](../../suian-zcode-common/gateway.mjs#L24-L50) |
| RPC 附着检查目标本地工作区已打开，目标会话存在；手机使用远端工作区时本地 RPC 让位 | 不宜为只读展示而长期占用 Host 桥；面板自己的工件状态读取可脱离该桥 | [rpc-broker.mjs，第 119–128 行](../../suian-zcode-common/rpc-broker.mjs#L119-L128) |

**现有会话读取与网关模块可复用，工件状态存储本身仍需实现**。面板和 `set/get` 应读取同一个持久状态源，不能各保留一份进程内状态。具体存储格式与并发更新方式留给工件区规格决定。运行数据归调用方、网关不保存业务消息的边界沿用 [根规则，第 8 行](../../AGENTS.md#L8) 和 [公共层规则，第 7–10 行](../../suian-zcode-common/AGENTS.md#L7-L10)。

## 为什么不能宣称自动跟随已可用

**界面选中状态位于 Renderer 的 Zustand store**。`setActiveTaskId()` 更新工作区的 `activeTaskId` 并记录导航历史；该函数本身没有向外挂进程发布选择事件，见 [WorkspaceSlice，第 236–299 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/store/zcodeSessionStoreWorkspaceSlice.ts#L236-L299)。

公开的 WindowController 服务提供列表、mutation 与 Controller frame 订阅，见 [接口，第 48–66 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/window-controller/windowController.ts#L48-L66)。已审查的 Controller 协议只有工作区与任务索引两个 topic，见 [协议，第 8–14 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/controller.ts#L8-L14)。它们不包含当前选中会话的字段或事件。

`membership.active` 表示列表归属：普通、置顶的非归档任务都设为 `true`，归档任务设为 `false`，见 [Controller 实现，第 355–385 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/windowHostControllerService.ts#L355-L385)。它不表示哪段会话被用户选中。

因此，当前可收敛为两种产品语义：

- **显式选择**：用户在外挂面板选择会话 ID，面板清楚显示自己正在展示的会话。该路线不依赖 ZCode 的选择事件。
- **自动跟随**：等待可用且可验证的宿主选择事件；事件需明确窗口、工作区与会话身份，多窗口和远端会话不能仅按本机路径推断。本轮不采用 UI 抓取或“最近会话”推测。

以上否定范围仅限已审查的公开源码与现有客户端包装，没有实测发行版是否另有未公开接口。

## 点击工件引用的能力边界

| 引用类型 | 已核实的相关能力 | 首版外置面板建议 |
| --- | --- | --- |
| PR / 网页 | 宿主平台有 `openExternal(url)`，Desktop 最终调用 Electron `shell.openExternal`；这是宿主平台能力，尚未证明外挂能经网关调用 | 面板提供普通网页链接，由浏览器打开；不引入 GitHub 写操作 |
| ZCode 会话 | Controller `open/resume` 仅验证唯一 source，随后直接 `break`，不执行桌面导航；已审查的 deep link 路由没有指定会话打开分支 | 点击会话引用先在外置面板选择关联会话，提供复制会话 ID；暂不承诺跳转 ZCode 界面 |
| 本地文档 / 文件 | 宿主有 `openExternalFile` 与 `openInFileManager`，Desktop 通过 IPC 和系统默认应用打开；现有 app-mcp 未封装这些操作 | 首版显示并复制路径；“在默认应用打开”可作为后续由外挂本机进程实现的显式点击动作，需要单独验证 |
| 工作区 | 已有 `zcode://workspace/open?path=…`，打开前会要求官方外部工作区确认 | 可按需提供该链接，但它只打开工作区，不能替代会话或文件导航 |

上述接口依据：

- 外链与文件平台契约：[platform.ts，第 631–658 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/platform.ts#L631-L658)；Desktop IPC 实现：[desktopMainIpcRemote.ts，第 301–310 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopMainIpcRemote.ts#L301-L310)。
- 会话 `open/resume` 的具体行为：[windowHostControllerService.ts，第 281–284 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/windowHostControllerService.ts#L281-L284)。Deep link 分支及未知非 OAuth URL 返回：[desktopOAuthDeepLink.ts，第 254–357 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopOAuthDeepLink.ts#L254-L357)。
- 工作区链接生成已有公共模块：[notification-action.mjs，第 8–18 行](../../suian-zcode-common/notification-action.mjs#L8-L18)；官方确认与打开流程：[desktopOAuthDeepLink.ts，第 278–292 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopOAuthDeepLink.ts#L278-L292)。

## 最小实现路线与后续验收

**建议先做按需启动的本地浏览器面板**。这是外置页面，桌面窗口壳可以后续单独评估。现有公共层目前只有网关常驻，见 [公共层规则，第 7 行](../../suian-zcode-common/AGENTS.md#L7)；如果需要常驻 UI 服务，应在规格中明确归属与生命周期。

1. 先完成每会话工件状态与 Agent `set/get` 的契约。状态独立持久化，最多 20 条；后续规格已确认完整投影最多 12000 个 Unicode 码点，见 [工件区规格](artifact-zone-spec.md)。
2. 按需 UI 服务提供静态页面、会话选择和选定会话的工件读取。读取复用同一状态访问模块；面板只读，Agent 负责生命周期管理。
3. 用显式刷新或有限轮询读取当前 revision。工件未变化时不复制整份状态；不为面板刷新调用模型，不轮询聊天正文。
4. 首版允许网页链接、关联会话的面板内切换与复制文件路径。Host 控制只在具体动作需要且已核实接口时调用，不为展示保持桥连接。
5. 等待宿主选择事件再考虑自动跟随。自动跟随和临时模型投影分别验收，前者完成不能解除后者的请求入口前置条件。

将来实施时的最小成功标准：显式选择两段会话不会串读；Agent 更新后刷新显示对应 revision；重启恢复同一状态；面板读取不写聊天历史且不产生模型请求；会话 `open` 与点击路径只按已核实语义宣称。系统打开与 Host 边界使用替身测试，真实 UI 点击另经用户授权验收。

**本轮验证结果**：完成源码行核对与文档检查；未执行运行时、浏览器面板或系统打开验收。本报告支持外置只读面板的设计方向，不代表用户已批准 UI 实施或已验收产品行为。

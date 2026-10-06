# ZCode 手机 Web 远控与现有桌面 Host

核查日期：2026-10-05。公开源码基线：`zai-org/ZCode` 的 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，对应桌面 3.14.3。本机发布版为 3.14.4 / CLI 0.16.9，由主代理另行核查其 ASAR 静态实现。本分工没有配对、启用远控、启动服务、发信或读取用户凭据。

## 判断

**官方确实描述了连接现有桌面窗口的手机 Web 远控**。因此，“既然有 Web 界面，就有通信链”这个方向成立；它不必重新启动一个 Agent。不过，官网没有公布供第三方客户端使用的完整 relay API、配对请求契约或稳定 SDK，公开 3.14.3 快照也没有包含完整扫码 relay 客户端。不能把“本次没有找到公开连接契约”写成“产品不存在这种连接”。[官方 Remote Control 文档](https://zcode.z.ai/cn/docs/remote-control)

**已有 Host 的业务能力足够形成一个管理客户端**。公开源码可核实窗口级任务目录与订阅服务，以及按工作区附着到现有 Host 的机制。真正的接入条件仍是：取得发布版远控授权，并由其 relay / Main 将连接送入正确的窗口及工作区 attachment。该认证与配对链由主代理结合发布版 ASAR 继续核实。

## 官网说明的权限范围

以下均归属于官网对手机远控的产品说明，官网正文没有标明对应的精确版本：[官方文档](https://zcode.z.ai/cn/docs/remote-control)。

| 方面 | 官方说明 |
| --- | --- |
| 目标范围 | 当前桌面窗口内已打开或登记的工作区、任务与会话 |
| 会话操作 | 查看与切换、继续输入；已有工作区中新建任务；符合条件时分叉 |
| 远端范围 | 可重连已登记且断开的工作区；不能新建 SSH/WSL/Docker 连接或打开未登记项目 |
| 连接限制 | 同时只支持一个手机页面；桌面须保持运行和联网 |
| 授权与撤销 | 连接链接携带授权；刷新二维码令旧链接失效；关闭弹窗不会停止连接，需主动停止 |

文档的“停止”段落指结束远控连接，不能仅据此证明手机页面有“中止 Agent 当前轮次”的按钮。Agent 停止是另一层会话命令。

## 可核实的窗口目录与订阅服务

**窗口 Controller 负责多个 source 的列表投影与路由**。source 在这里指本地或已连接远端工作区的服务来源。其 `IWindowControllerService` 提供：

- `listTaskList`：查询任务列表。
- `mutateTask`：置顶、归档、标记读状态、删除，以及 open/resume 的来源校验。
- `subscribeControllerV4` / `resyncControllerV4` / `unsubscribeControllerV4`。
- `onDynamicControllerFrame`：接收列表与工作区的变化帧。

这些是公开源码中的服务方法名，尚不是可直接请求到公网 relay 的 URL。[服务契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/window-controller/windowController.ts#L23-L71)

订阅有 `controller/workspaces` 与 `controller/tasks-index` 两个主题。任务地址包含 workspacePath、workspaceIdentity、taskId，以及远端地址的 remoteSessionId；远端地址要求 workspaceIdentity。快照提供工作区集合和任务集合；每个 attachment 有自己的订阅与事件 emitter。[主题与地址](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/controller.ts#L8-L34)、[快照生成](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/windowHostControllerProjection.ts#L204-L258)、[attachment 服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/windowHostControllerService.ts#L586-L671)

多工作区查询由 `query.workspaceScopes` 解析来源，再刷新每个来源的任务索引。一个远端读取失败不会清空其他来源投影。这足以支持窗口范围的列表与状态管理，但“允许第三方查询哪些 scopes”还需由发布版 relay 的窗口权限边界确认。[多来源查询](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/windowHostControllerService.ts#L458-L505)

**Controller 不直接执行会话创建、输入或停止**。服务契约明确将 conversation/file/git/terminal 留给工作区 attachment 的 scoped facade；open/resume mutation 仅校验唯一 source。不能把它们误当成启动 Agent 的 Prompt 操作。[职责边界](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/window-controller/windowController.ts#L48-L66)、[open/resume 实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/windowHostControllerService.ts#L281-L284)

会话层已有 V4 conversation subscribe/resync/unsubscribe 与 `v4/command`；命令 schema 定义 createSession、sendText、stop 和 forkAssistant。sendText 的 requestedDelivery 区分 startNow/queue/guide。因此，在连接已经正确附着到目标 Host 的条件下，协议能力覆盖读取流、创建、补充输入与停止；手机发布页具体开放哪些按钮、relay 是否透传所有方法，本分工尚未验证。[方法表](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/transport.ts#L332-L383)、[创建与输入](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/command.ts#L44-L112)、[停止与分叉](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/command.ts#L144-L152)

## 复用现有 Host 的公开机制

**远端 attachment 的代码明确复用现有窗口 Host**。`attachRemoteWorkspaceSessionHost` 校验 remoteSessionId、在线状态、windowId 归属及 workspace identity，然后取得已有 window Host，创建 MessageChannel，发送 `AttachServicePort`，携带 `web-remote-replayable` 和 remote scope。[校验与附着](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopRemoteSessions.ts#L881-L940)

不过，该快照中能够追到的调用者是 `createBotRemoteWorkspaceRuntimePort`，供 Bot 的远端工作区 attachment 使用。它是复用机制的直接证据，不是手机扫码 relay 客户端已公开的证据。[公开调用者](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopRemoteSessions.ts#L973-L997)

Host 的 Controller 来源解析通过窗口 remote registry 定位远端 scoped services；已离线或被移除的远端 identity 不会降级为本地 tasks-index。来源正确后，attachment 在 MessagePort 上暴露窗口 Controller 与连接范围内的 Agent service。[来源解析](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/index.ts#L1807-L1853)、[attachment 暴露服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/index.ts#L1986-L2046)

## 公开快照与官网的差异

**公开 WebRemoteControlDialog 已仅呈现 Bot Channel 配置**。其入口打开 BotsDialog，列出微信、飞书、Lark、Telegram，没有官网描述的左侧二维码生成区。这是对该 commit 的代码观察，不代表 3.14.4 发布版没有二维码远控。[公开弹窗](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/WebRemoteControlDialog.tsx#L18-L65)

`packages/web/src/env.d.ts` 保留 `VITE_WEB_REMOTE_CONTROL_ROUTE_PATH` 与 `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 声明。然而在本快照的 tracked 源码检索中，没有查到相应 relay URL 的读取或扫码配对实现。类型声明不能确定对外 endpoint。[声明](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/web/src/env.d.ts#L12-L17)

当前公开 Web 主入口将 OAuth callback 用于会话分享；正常 bootstrap 根据同源 `/ws` 或 `?remote=<id>` 构造 `/ws/remote/<id>`。该后者属于独立 Web server 的远端连接，不能凭路径名称认作“连接现有桌面窗口”的手机配对入口。现存 Web OAuth 代码也不足以证明真实手机远控要求同一 Z.ai 账号：必须依据发布版配对实现另行确认。[Web bootstrap](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/web/src/main.tsx#L359-L389)、[页面路由](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/web/src/main.tsx#L425-L450)、[当前 OAuth callback 配置](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/web/src/auth/webZaiOAuthConfig.ts#L53-L65)

主代理已经从本机 3.14.4 ASAR 核实发布版远控 transport、设备认证与配对消息、workspace bridge、确认与恢复帧，以及 local Host 的 `AttachServicePort`；该路径复用既有 Host，并未为手机另起 CLI。详细归属见[本机发布版 API 审计](web-api-audit.md)。本分工未独立读取那些 bundle，发布版结论应引用这份脱敏证据，不能改写成公开 3.14.3 快照已经含有同样完整实现。

## 对独立 MCP 客户端的意义

**可行方向是包装发布版已有远控客户端协议**：获得授权后订阅窗口目录，选择目标 scope，建立/切换该 scope 的 attachment，再调用其会话服务。该方向能够保留现有桌面 runtime，不要求 fork 或修改官方源码。

目前需要补齐的不是业务方法，而是以下连接条件：

1. 发布版远控页与 relay 的实际地址、帧类型和版本协商。
2. 链接授权如何取得、是否另需账号登录、有效期、刷新与断连规则。
3. 授权窗口与 hostEntryId/attachmentId 如何映射，切换 workspace 时是否替换 attachment。
4. MCP 是否占用唯一手机连接位；多个独立 MCP client 并发连接的行为。
5. 发布版是否透传 create/send/stop/fork，以及何时要求额外确认。

官网的临时链接授权是连接线索，不是可绕过配对的公开能力票据 API。公开一般 Web Host 的 `/api/rpc-host-capability` 也不能自动替代手机远控授权。本次不申请票据或进行配对，因此不声称独立 MCP 已成功控制桌面会话。

## 本分工核验与工具

仅新增本笔记。没有新增 clone、临时目录或日志；所有命令均为短时只读导航。官方源码 clone 的 tracked 改动和 untracked 文件均为 0 项。

| 工具 | 用途 | 本轮调用次数 |
| --- | --- | --- |
| `mcp__context7__query_docs` | 查询官方手机远控文档 | 1 |
| `mcp__context7__resolve_library_id` | 沿用上一轮已解析库 ID，无需重复解析 | 0 |
| `web__run` | 官方文档检索、中文与英文正文核对 | 2 |
| `mcp__Read__read_file` | 读取公开 controller、Web 与 attachment 源码，校验成稿 | 10 |
| `exec_command` | ripwire/rg/Git 只读导航及源码 clean 核验 | 10 |
| `mcp__codex_apps__github_fetch` | 本轮使用已克隆的固定 snapshot，未新增调用 | 0 |
| `mcp__codex_apps__github_search` | 本轮未使用 GitHub 全站代码搜索 | 0 |
| `mcp__codex_apps__github_search_repositories` | 本轮未搜索新仓库 | 0 |

exa/zread/web-reader 未出现在本分工可用工具中。没有虚构其调用。

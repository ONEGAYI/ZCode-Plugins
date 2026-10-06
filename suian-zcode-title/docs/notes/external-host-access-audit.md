# 独立外部程序接入既有 ZCode Desktop Host：入口与授权审计

核查日期：2026-10-06。公开源码固定 commit：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`（2026-09-24，3.14.3）。本机 3.14.4 / bundled CLI 0.16.9 的发行包证据由主代理另行持有，本分工不将发行包实现归入公开快照。

## 搜索结果摘要

**已验证独立外部程序接入原 Host 并完成改名**。主代理在用户主动提供当前窗口的远控授权链接后，于 20:55:01（+08:00，本轮实测）用独立 Node WebSocket 客户端完成认证、bootstrap、原工作区 bridge、读取元数据、renameTask 与读回验证。UI 点击、独立会话 Runtime 和直接 SQL 没有充当这次改名的控制链。

**验证通过的是官方手机 Web relay 这条生产链**。主代理从发行包定位了复用已有 Host 的 attachment，并用官方公开部署客户端的 terminal 认证、bridge 和 RPC 协议完成外部改名实测。公开 3.14.3 快照没有完整手机实现；部署客户端补证见第 7、8 节。仍未找到“无既有授权链接、无 UI 操作，由第三方程序直接获得现有桌面 Host 票据”的公开接口。

**没有预配对手机不等于不能授权**。官网流程允许桌面生成二维码或连接链接，再由新客户端接入；链接本身带授权。当前能明确描述的是让用户主动提供该链接的初始化流程，不能断言发行版绝对不存在其他取得方式。[官方远控文档](https://zcode.z.ai/cn/docs/remote-control)

## 详细内容

### 1. 各入口实际连接到谁

| 入口候选 | 已核实的归属 | 能否证明外部 MCP 直达当前原 Host |
| --- | --- | --- |
| Electron MessagePort / Host attachment | Main 持有 utilityProcess 对象，转移 MessageChannelMain 端口给 renderer 或既有 bridge | 证明内部附着机制；未找到外部进程凭 PID 取得端口的生产接口 |
| 官方手机 Web relay | 已授权终端经发布版 Main 建立 workspace bridge，再附着现有 Host | 已用用户授权链接和独立 Node 客户端验证原 Host 改名 |
| HTTP `/ws`、`/ws/host`、`/api/rpc-host-capability` | 独立 server entry 创建自己的 ServiceCollection | 不能据此认作当前桌面 Host 的入口 |
| CLI `app-server` / NDJSON stdio | 新进程创建自己的 ZCodeProtocolAgentServer，读取自己的 stdin/stdout | 不是附着原桌面 runtime 的控制连接 |
| `zcode://` 与 `--open-workspace` | OAuth、支付、工作区打开、分享导入及第二实例转交 | 所查路由没有通用会话服务 RPC 或 rename 命令 |
| loopback 媒体 HTTP | 远端媒体 lease、GET/HEAD、Range | 不能调用会话改名；本机某端口的归属仍须独立核实 |
| CUA helper pipe、浏览器辅助、开发 StdioTap | 辅助工具/调试数据面 | 本任务排除；未作为生产会话控制入口 |

### 2. MessagePort 可以附着原 Host，但交付入口由 Main 持有

Main 通过 `electronUtilityProcess.fork` 建立窗口 Host，并用 `MessageChannelMain` 向其投递初始化消息；另一端转移到窗口 webContents。代码没有把端口发布为可由任意外部 Node 程序发现的命名管道或 socket 地址。[Host 启动](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopHostProcess.ts#L251-L279) [端口交付](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopHostProcess.ts#L703-L729)

已有 Host 的附着同样需要 Main 所持对象。renderer reload 分支取已有 child，发送 `AttachServicePort`，scope 为 local，再把新端口交给 renderer。这段代码明确复用旧 Host；它不是供独立客户端调用的 HTTP/CLI 端点。[复用既有 Host](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopWindowLifecycle.ts#L136-L166)

远端工作区 attachment 要校验在线状态、窗口归属和 workspace identity，然后调用 `getWindowHost(win)` 取得既有 Host，再转移端口。该公开调用链用于 Bot 远端 workspace runtime port；不能将其函数签名当作手机号远控已公开的认证入口。[远端 attachment 校验及转移](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopRemoteSessions.ts#L881-L940) [公开 Bot 调用者](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopRemoteSessions.ts#L973-L997)

Host 收到 `AttachServicePort` 后，按 local/remote scope 选取已持有的 services，再暴露 `MessagePortProtocol → ChannelServer`。这说明 **拿到合法 attachment 后可以触达原 services**，并不回答独立程序如何自行取得 attachment。[Host 接收附着](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/index.ts#L2729-L2764) [scope 解析](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/index.ts#L2090-L2114) [暴露服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/index.ts#L1986-L2046)

preload 使用 `window.postMessage` transfer 把收到的原生 MessagePort 交给 renderer；renderer 再通过 `connectViaMessagePort` 装配 services。这不是 `window.zcode.renameTask` 之类外部 RPC API，也没有查到可由另一个本机进程索取当前端口的公开方法。[preload transfer](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/preload/index.ts#L826-L860) [renderer services 装配](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/renderer/src/main.tsx#L291-L308) [MessagePort 客户端](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/client/src/messageport.ts#L25-L58)

### 3. 已有 HTTP 和 CLI 入口不能替换同一 Host 的附着

`packages/server/src/entry-http.ts` 调用 `createLocalServices` 后传入 `createHttpServer`。因此，其 `/ws` 等路由暴露的是这个独立 server 所创建的服务；只使用相同配置目录或 SQLite 不能把它变成桌面当前持有的 runtime。[独立 HTTP entry](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/entry-http.ts#L8-L26) [HTTP RPC 路由](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/http.ts#L298-L346)

`/api/rpc-host-capability` 的票据只存于该 HTTP server 进程内存，默认 30 秒、一次性消费。它用来为该 server 的 `/ws/host` 选择可信 Host 角色；不是手机 relay 配对票据，更不是原 Desktop Host 的发现 API。[票据归属与生命周期](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/hostCapability.ts#L4-L53) [票据消费路由](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/http.ts#L334-L346)

CLI entrypoint 使用自己的输入/输出流，并实例化新的 ZCodeProtocolAgentServer。NDJSON transport 只监听已提供的 input stream，没有按 PID 连接旧 Host 的机制。`packages/server/src/remote/stdio-socket.ts` 名称中的 socket 只是把已拥有的远程 stdin/stdout 包装成 ISocket，不是一个 listener。[CLI 进程 stdio](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts#L82-L98) [CLI server 构造](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts#L249-L270) [NDJSON stream 契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts#L24-L68) [远端 stdio 包装](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/remote/stdio-socket.ts#L1-L35)

### 4. URI、pipe 和 socket 候选的限定结论

公开 deep-link parser 定义 `oauth/callback`、`payment/callback`、`workspace/open`、`share/import`，以及启动参数 `--open-workspace`。Main 的第二实例处理将这些请求交给工作区/深链处理器，没有在所查分支中 dispatch renameSession 或任意服务方法。[深链类型](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopDeepLinkUrl.ts#L1-L93) [第二实例 workspace 请求](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopSecondInstanceDeepLink.ts#L36-L73) [Main second-instance 分派](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/index.ts#L1886-L1923)

限定检索还找到 CUA helper 的 socketPath / named pipe 控制消息，但它属于 `zcode-cua-windows-dev/v1` helper transport；system service 的 Socket 用于 TCP 连通性探测。这些证据不能转写为 Desktop 会话服务开放了命名管道。[CUA helper 控制协议](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/cua-permission-broker/windowsCuaHelperHostSupport.ts#L185-L194) [system TCP 探测](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/system/systemService.ts#L312-L341)

Host 的一个已知 loopback listener 是 remote media proxy，绑定 127.0.0.1 随机端口，handler 只接受媒体路由上的 GET/HEAD。**这里仅解释该实现，未断言本机先前观察到的 49571 就属于它**。本分工没有连接未知端口。[媒体 listener](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/remoteMediaPreviewProxyHelpers.ts#L90-L104) [媒体请求范围](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/remoteMediaPreviewProxy.ts#L266-L285)

### 5. 未配对时的授权条件

官网公开流程是桌面生成二维码/链接，再让新终端使用；因此无既有手机连接不是前置障碍。授权链接需由拥有窗口访问权的用户主动提供，目前没有找到外部客户端无 UI 申请它的公开 API。链接刷新会撤销旧授权。[中文远控说明](https://zcode.z.ai/cn/docs/remote-control)

手机客户端接入范围是当前窗口登记的工作区；同时只支持一个手机页面。该范围支持复用现有 runtime，不能推导为本机全局所有窗口任意可控。[英文远控说明](https://zcode.z.ai/en/docs/remote-control)

公开快照的 Web env 只保留 relay URL/route 的类型声明，WebRemoteControlDialog 实现主要呈现 Bot 入口。本次限定检索没有找到 device-register、auth-challenge、pair-status 的手机实现。**这是公开快照的缺口，不是产品能力不存在的证据**。发布版完整 relay/bridge 静态观察归属主代理的[发行包审计](web-api-audit.md)。[relay env 声明](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/web/src/env.d.ts#L12-L17) [公开远控弹窗](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/WebRemoteControlDialog.tsx#L18-L65)

**已验证**：使用用户授予的当前窗口链接完成独立终端认证，打开原工作区 bridge，并在原 Host 上读取、改名、再读取。此前 GUI 已改名的结果未作为这次链路完成证据。

仍未验证：

- 无人提供链接时，是否有独立进程可调用的授权生成接口。
- 其他账号、应用策略或多个并发客户端下的权限与连接行为。
- 是否存在未公开的生产 local pipe/socket/API；当前快照与发行包不能直接等同。
- 跨工作区 bridge 切换、恢复重连，以及改名以外的发信、归档、停止、模型生成等操作。

### 6. 连接成立后，改名业务路由不是主要缺口

原 Host 的 `IZCodeTaskService.renameTask` 参数为 taskId、workspacePath、可选 workspaceIdentity 和 title。实现先更新 overlay/tasks-index 的 title、updatedAt、titleOverridden，再尽力同步 V4 renameSession；最后通知 task_title_changed。V4 同步失败只 warn，返回 meta 成功不保证 CLI 标题已经同步。[renameTask 契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/session/zcodeTaskService.ts#L657-L663) [Host 改名实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L2919-L2979)

公开 Host attachment 暴露 Task service；其代理未过滤 renameTask。Agent 的 `web-remote-replayable` facade 也未在所查命令分支禁止 renameSession，但 V4 终端需完成 hello/initialize，并保持 command clientId 与握手一致。本轮 relay 已实际透传 Task 元数据读取与 renameTask；Agent V4 直接命令及其他服务方法仍需单独验证，不能仅凭接口声明泛化。[Task proxy 透传](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/index.ts#L1977-L1983) [attachment 服务暴露](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/index.ts#L2023-L2046) [V4 握手与命令检查](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts#L668-L718)

原生 renameSession 要求目标 runtime record 存在，再写 `titleSource: custom` 并发 SessionTitleUpdated。因此，独立 app-server 即使读到相同数据库行，也不满足“控制当前原 Host 的 resident record”。[原生 rename handler](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts#L140-L151) [resident record 检查](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/record-access.ts#L11-L23) [custom 标题写入与事件](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts#L264-L286)

### 7. 公开部署的客户端补证与首个只读 RPC

后续从官方公开页面 [remote/v4](https://zcode.z.ai/remote/v4) 的 [index-B-ilXaCQ.js](https://zcode.z.ai/remote/v4/assets/index-B-ilXaCQ.js) 核实 terminal-role 的认证消息、bootstrap、workspace-bridge-open，以及 ChannelClient 与 renameTask 调用。它是公开部署的静态构建，**不能回写为 3.14.3 开源快照已包含全部手机实现**。本分工只读取其 JavaScript，没有配对或向目标窗口发请求；主代理随后实施了本次经用户授权的连接与改名。

该 index 把 `Wt as Ba` 从 [src-wmk2orCZ.js](https://zcode.z.ai/remote/v4/assets/src-wmk2orCZ.js) 导入为频道枚举。本次只读抓取共享 chunk 后核实，部署客户端和公开快照的字符串一致：

| 频道 | 首个读取/改名用途 |
| --- | --- |
| `zcode-task` | `getTaskMeta`、`renameTask` |
| `window-controller` | `listTaskList` |
| `zcode-agent` | V4 hello / initialize / command |

[源码频道值](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/channels.ts#L90-L100)

**relay bridge 应直接传 ChannelClient 二进制消息**。部署 bundle 的 workspace bridge 分支为 `d0t(a.protocol)`，而 `d0t(e)` 构造 RemoteServiceAccess 与 ChannelClient；`a.protocol` 是 acknowledged relay 的消息协议。普通同源 WebSocket 分支才先包装 SocketProtocol。不能给手机 relay 的每条内层 RPC 额外套 13 字节 SocketProtocol 头。

普通 ChannelClient 先等待服务端 `Initialize = 200`，再发送 `Promise = 100`。每次请求顺序序列化 `[100, id, channel, method]` 和 body；成功响应为 `PromiseSuccess = 201`，header 的 id 关联请求。此处不是 IPCClient/IPCServer 那条先发送 ctx 的连接分支。[类型值](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/rpc/src/channels.shared.ts#L18-L31) [等待初始化](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/rpc/src/channelClient.ts#L119-L127) [请求编码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/rpc/src/channelClient.ts#L178-L189) [响应解码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/rpc/src/channelClient.ts#L209-L246)

**body 必须是方法实参数组**。ProxyChannel.toService 使用 rest args 并调用 `channel.call(method, args)`；服务器端 fromService 用 `target.apply(handler, args || [])`。因此 `getTaskMeta` 和 `renameTask` 的 body 都是 `[params]`，不是单个 params 对象。[客户端 args 数组](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/rpc/src/proxy-channel.ts#L135-L140) [服务器 apply](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/rpc/src/proxy-channel.ts#L85-L94)

`getTaskMeta` 只需：

```js
channelClient.getChannel("zcode-task").call("getTaskMeta", [{
  taskId: "{{confirmedTaskId}}",
  workspacePath: "{{confirmedWorkspacePath}}"
  // 目标为远端 workspace 时，补充已确认的 workspaceIdentity。
}])
```

参数与返回契约不含 messages/fileChanges。adapter 只调用 taskIndexRepo.getTaskMeta，再记忆元数据；repo 通过已就绪的 tasks index 查询该 workspace/task 行，没有 resumeSnapshot 或 Agent 启动 fallback。可作为已授权 bridge 上的最小读取验证。[轻量 meta 契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/session/zcodeTaskService.ts#L521-L526) [adapter 读取](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L2605-L2608) [repo SELECT](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/session/taskIndexRepo.ts#L681-L716) [meta 返回](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/session/taskIndexRepo.ts#L2555-L2566)

部署 bundle 的 home-only facade 对 `getTaskMeta` 有返回 null 的桩。因此先完成目标工作区 `workspace-bridge-open`，使用该 bridge 的真实 ChannelClient；不能把首页 facade 的 null 解释为目标不存在。此步骤不要求调用 createSession 或发送聊天输入。

`listTaskList` 也走 index 读取，但 Controller 会刷新 source 投影并启动 existing-only 会话观察器；源码说明它不会启动 Agent。相较之下，单次 getTaskMeta 更适合首个烟测。[task 列表索引读取](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L2372-L2383) [Controller existing-only 刷新](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/windowHostControllerService.ts#L391-L418)

Task 服务方法只依赖普通 Channel 初始化；若改为直接调用 Agent V4 command，还须执行 helloConversationV4 → initializeConversationV4，并保持 command clientId 一致。部署 bundle 的普通 UI 初始化明确采用 `protocolVersion: 3`，与源码常量一致；URL 的 v4 不代表 wireVersion 为 4。[Agent V4 握手检查](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts#L668-L718) [协议版本常量](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/core.ts#L1-L7)

以上部署函数名和定位仅作当前静态构建证据；JS String.indexOf 的位置是 UTF-16 字符串偏移，不是字节偏移。父代理完成的外部改名实测见第 9 节；本文不宣称已经交付完整 MCP 产品。

### 8. shared codec、分片与 bootstrap 容器

部署 index 的别名与共享 chunk 导出对应为：`Kee = Hs = uh`（编码分帧）、`Qne = Ws = rh`（frame/ack schema 解析）、`Qi = Bs = hh`（assembler）、`zs = Y`（限制）。证据来自同一公开 [shared chunk](https://zcode.z.ai/remote/v4/assets/src-wmk2orCZ.js)；主代理原样使用这些导出，未靠重新猜写分片格式完成验证。

`rpc-frame` 的内层字段如下；外层仍是 relay 的 `{type: "data", payload, client_ts?}`。

| 字段 | 已读契约 |
| --- | --- |
| `bridgeSessionId`、`bridgeGeneration?`、`recoveryId?` | 使用 workspace-bridge-ready 内的实际 bridge identity |
| `seq` | 从 1 开始的物理分片序号 |
| `messageSeq` | 从 1 开始的完整 RPC 消息序号 |
| `fragmentIndex` / `fragmentCount` | 从 0 连续编号；每片非空 |
| `messageBytes` | 完整未分片二进制消息的字节数 |
| `checksum` | `{algorithm:"crc32", value:八位小写十六进制字符串}`，针对完整消息，各片相同 |
| `dataBase64` | 标准 `+/=` base64，需规范 padding；不是 base64url |

默认 relay 限制为：物理 envelope 最多 1 MiB、完整消息最多 16 MiB、最多 64 片、组装 timeout 30 秒。该“64 片”是 relay RPC 运输层限制，与 V4 logical-frame 自身的分片上限不是同一对象。

`uh(bytes, {identity字段, firstPhysicalSeq, messageSeq})` 返回 frame 数组；`rh(payload)` 返回验证通过的 rpc-frame / rpc-frame-ack 或 null；`new hh({identity,...})` 的 `accept(frame)` 返回 incomplete / complete / duplicate / fault。complete 才交付完整二进制消息；序号断档、分片不连续、长度或 CRC 不一致属于终止型错误。只在完整消息交付后确认；合法已完成消息的重复可以重发确认。

ACK 字段是 `ackMessageSeq`，不是物理 seq。格式为 `{zcode_type:"rpc-frame-ack", identity字段, ackMessageSeq}`；future ACK 会被判为 transport fault。

bootstrap 与 bridge 容器同样来自 shared schema：

| 容器 | 成功/错误形状 |
| --- | --- |
| bootstrap 成功 | `{zcode_type:"bootstrap-response", requestId, success:true, result}` |
| bootstrap.result | `{windowControlSessionId, workspaces, tasks, initialViewState?, mobileViewState?}` |
| bridge 成功 | `{zcode_type:"workspace-bridge-ready", requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, bridge}`，没有 success 字段 |
| local bridge | `{bridgeSessionId, bridgeGeneration?, recoveryId?, kind:"local", workspaceKey, workspacePath, initialTaskId?}` |
| remote bridge | local 的共同身份字段，kind 改为 remote，并必填 workspaceIdentity、remoteSessionId |
| 请求错误 | `app-error` 或 `workspace-bridge-error`，携带 requestId、reason、error；bridge identity 可选 |

部署客户端的 requestBroker 按 requestId 优先拒绝 app-error / workspace-bridge-error，不能等待 `success:false` 的 bootstrap/bridge 响应。platform / reconnect 的失败容器才有单独的 success:false 分支。

### 9. 本轮实测归属与覆盖范围

以下结果由主代理核实并传回，本分工未读取用户授权链接、目标数据库或个人聊天：

1. 独立 Node WebSocket 客户端使用用户授予的窗口链接完成认证及 bootstrap。
2. 打开已有工作区的 bridge，再通过 `zcode-task` 调用 getTaskMeta。
3. 通过同一 bridge 调用 renameTask，标题为“改名测试：双链联想”，随后再次 getTaskMeta 读回。
4. 原 Host（PID 39048）日志行 55629–55636 记录 renameTask 成功。
5. 主代理只读复核两份数据库均为新标题，CLI 的 `title_source=custom`，tasks-index 的 `title_overridden=1`。

这些证据覆盖了 **用户授权链接 → 独立外部客户端 → 原 Host → 会话改名**。本轮只验证改名；没有据此宣称发信、归档、模型生成等其他方法已经验证，也没有将 Node 原型包装为完成的 MCP 产品。

本文件不保存会话 sid、授权 URL、凭据 hash、签名或聊天正文。公开源码 commit、公开静态资源 URL 和字段 schema 属于可追溯来源，保留它们用于复核。

## 结果与停止边界

**外部客户端到原 Host 的改名链路已验证，初始授权来自用户提供的远控链接**。可在这一连接适配层上继续封装 MCP。若要求连初始授权也全程无 UI、无人提供链接，则公开资料仍不足以给出授权生成的生产接口。

本分工只读源码、官网、公开静态资源和既有脱敏笔记；未读取凭据/聊天、连接目标或未知端口、开启远控、申请票据、改名、启动新 Runtime 或修改 ZCode 配置。主代理经用户授权完成的外部改名实测单独记于第 9 节。只新增本文件，官方源码未变；没有产生长命令日志、临时 profile 或待清理探针。此前中断的 host-rename-entry 笔记未落盘，本轮不补写其他文件。

## 工具使用汇报

| 可见相关工具 | 用途 | 本轮调用次数 |
| --- | --- | --- |
| Read MCP `read_file` | 官方源码、公开静态构建与成稿回读；含一次尚未生成的 shared 文件读取 | 30 |
| `exec_command` | ripwire/rg、只读 Git 检查与公开 chunk 内存抓取；含一次启动策略拒绝 | 17 |
| Context7 `resolve_library_id` | 官方文档库定位 | 1 |
| Context7 `query_docs` | 查询程序化授权文档，结果未命中 | 1 |
| `web.run` | 官网正文与静态 chunk 阅读；chunk 通道不可用时降级只读内存抓取 | 2 |
| `apply_patch` | 写入、补充与终稿一致性修订 | 4 |
| GitHub connector `fetch_file` | 本轮使用本地固定快照 | 0 |


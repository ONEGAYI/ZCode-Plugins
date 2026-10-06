# ZCode 会话控制：官方与社区源码核查

核查日期：2026-10-05。此笔记记录本分工的网上原始来源与只读源码审计；本机安装包探针及邮箱能力由主代理另行记录。

后续 Web 版补查已经在本机 3.14.4 发布包找到连接现有桌面 Host 的远控桥。本文对“未找到外部入口”的描述限定于当时的公开 3.14.3 源码审计，更新结论见 [Web API 审计](web-api-audit.md)。

## 结论

**可以开发独立 MCP，但“调用官方 Agent 运行时”与“控制桌面正在运行的会话”是两种能力**。官方已经公开桌面、Web、服务层和 Agent 运行时源码，可据此实现协议适配；单独启动 `app-server` 会拥有自己的内存运行时，不会因为连接同一 SQLite 数据库而取得桌面进程的活动任务。

**桌面 Host 的现有外部连接入口尚未核实**。公开源码中的桌面控制通道是 Electron MessagePort，Host 到 Agent 是 stdio。独立 Web 服务确有 WebSocket RPC，可供 MCP 接入它所拥有的会话；但该服务默认自行装配服务和 Agent 进程，并未自动附着到既有桌面 Host。

## 来源与版本

| 来源 | 审计基线 | 所有权与适用范围 |
| --- | --- | --- |
| [zai-org/ZCode](https://github.com/zai-org/ZCode) | `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；提交日期 2026-09-24；根 `package.json` 为 3.14.3 | 智谱官方第一方源码；本次主要证据 |
| [tizerluo/zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) | `e8bd9bc219b29f5f33287d9782cfc8d83bf3786a`；提交日期 2026-10-04 | 社区桥接实现；只能证明该桥自身的行为 |
| [windviki/zcode-webui](https://github.com/windviki/zcode-webui) | `24394171fc482f9eea716ba00810dbf2bbe3fbf3`；提交日期 2026-09-18 | 社区 Web 宿主；网上读取源码，未克隆或运行 |
| [william0wang/zcode-acp](https://github.com/william0wang/zcode-acp) | `8d8e28530c41bdbff881369d67138bc21c4ddd3f`；提交日期 2026-10-05 | 社区 ACP 适配器；网上读取源码，未克隆或运行 |

官方仓库自述公开客户端、后端、共享 UI 与 Agent CLI/运行时，`apps/zcode-cli` 是主仓库中的普通目录。这不是仅有 CLI 的另一个同名项目。[官方 README](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/README.md#L18-L33)

**开源范围不能直接等同于发行版全部功能**。官方 `NOTICE.md` 明确限制功能承诺，Computer Use 包为不可用的占位实现。根许可证为 Apache-2.0，第三方组件仍有各自许可。[官方声明](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/NOTICE.md)、[根许可证](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/LICENSE)

本机发行版由主代理测得为桌面 3.14.4.7912 / bundled CLI 0.16.9。公开源码快照为桌面 3.14.3，不能将未实测的实现细节说成 3.14.4 的运行保证。官方 CLI package 的 0.1.0 与共享 runtime descriptor 的 0.13.3 是源码静态值，不能用它们覆盖本机 CLI 的实际版本。[CLI package](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/package.json#L3)、[runtime descriptor](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-agent-runtime.ts#L30)

## 官方会话接口

**这些方法都已在官方运行时注册**。legacy 接口可用于基本适配，但桌面主要行为已迁入 V4；新 MCP 应围绕 V4 设计，按实际安装版本固定适配范围。[服务端分派](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts#L565-L604)

| 能力 | legacy 方法与关键参数 | 源码中的边界 |
| --- | --- | --- |
| 列表 | `session/list`，可空 `{}`；可传 `workspace`、`sessionIds`、`includeArchived`、`limit` | 读取持久化 store，并合并当前协议实例的 resident 会话；普通列表限制主任务类型 |
| 读取 | `session/read`，`sessionId`；可传 `deliveryKind`、`messageLimit`、`afterSeq` | 必须命中本进程的活动 session record；保存到数据库并不等于当前已激活 |
| 创建 | `session/create`，`workspace`；可传 mode/model/MCP 等启动配置 | 在当前 app-server 内创建；不是要求桌面创建任务的入口 |
| 恢复 | `session/resume`，`sessionId`；可传 workspace/MCP/工具面配置 | 会激活当前进程的 runtime；不应当作纯 SELECT 读取 |
| 发送 | `session/send`，`sessionId`、`content` | 同进程已经有 active prompt 时返回 -32010；不能概括为“busy 发送即 steer” |
| 订阅 | `session/subscribe`，`sessionId`、必填 `deliveryKind` | 订阅本进程 record；`deliveryKind` 为 `desktop-continuous` 或 `web-remote-replayable` |
| 停止 | `session/stop`，`sessionId` | legacy 兼容入口；桌面客户端主路径已转 V4 `stop` |
| 分叉 | `session/fork`，`sessionId`、`target` 默认 latestCheckpoint | legacy 路径要求本进程 record，运行中的 prompt 会被拒绝；V4 `forkAssistant` 有不同条件 |

参数来源：[创建、恢复与列表 schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L1559-L1609)、[读取 schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L1649-L1657)、[发送 schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L1731-L1779)、[订阅 schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L1497-L1514)、[分叉 schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L1808-L1829)、[停止 schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L1887-L1891)。

行为来源：[list 读取 store 与本进程 registry](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1622-L1670)、[read 要求 resident record](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1822-L1832)、[subscribe 要求 resident record](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1890-L1915)、[busy send 拒绝](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1918-L1937)、[legacy fork 的运行限制](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L2229-L2242)。

**V4 是桌面 busy 输入和队列控制的具体实现**。`v4/command` 的信封带 commandId、clientId、sessionId、type、payload、issuedAt；`sendText` 的 `requestedDelivery` 可为 `startNow`、`queue` 或 `guide`。`createSession`、`stop`、`forkAssistant` 也是该命令入口的 payload 类型。forkAssistant 的 target 为稳定的 assistant row；不要把它与 legacy checkpoint fork 的约束混用。[命令信封](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/command.ts#L323-L351)、[V4 创建与发送](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/command.ts#L44-L112)、[停止与分叉](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/command.ts#L144-L152)

协议不应凭 JSON-RPC 外观推断标准兼容性。NDJSON 请求的严格 schema 接受 id/method/params/trace，未定义 `jsonrpc` 字段；legacy app-server 没有 initialize 方法。只读能力探测可以直接发送下列两行。[请求信封](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L286-L294)、[能力响应](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts#L678-L679)

```json
{"id":1,"method":"runtime/capabilities","params":{}}
{"id":2,"method":"session/list","params":{"limit":1}}
```

创建等操作还可能收到 `session/requestRuntimePreferences` 反向请求，客户端需要应答。MCP 对外可以遵循标准 MCP，但内部适配不能直接套一个通用 JSON-RPC 初始化握手。[官方偏好响应 schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L1703-L1714)

## 运行中会话的所有者

**app-server 的 resident registry 是进程内对象**。每个 `ZCodeProtocolAgentServer` 构造自己的 `sessions: new Map()`，默认事件 store 同样为内存实现。`session/list` 能读 SQLite，并不能据此认定后续 send/stop/subscribe 会路由到另一个进程。[协议实例初始化](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts#L233-L267)

**桌面接入链为 Renderer → MessagePort → Host → stdio → CLI**。Main 创建 MessageChannelMain，将两端分别交给 Host 和窗口；Host 在 MessagePort 上注册 ChannelServer 与连接范围内的 Agent service。Host 的 ProcessManager 启动 Agent 子进程，stdin/stdout/stderr 都是 pipe。[端口转移](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopHostProcess.ts#L714-L744)、[Host 暴露服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/index.ts#L1986-L2046)、[Agent 进程与 stdio](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentProcessManager.ts#L1019-L1037)

Host 的 active client 按 workspaceKey 在内存 Map 中复用；V4 命令最终提交给该 client 的 `v4/command`。这里没有依据把 workspaceKey 理解为跨任意进程的网络地址。[Host client registry](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentService.ts#L1177-L1182)、[client 复用与启动](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentService.ts#L2927-L2955)、[V4 命令转交](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentService.ts#L5044-L5108)

**跨桌面 Host 路由也需要 Main 中的注册与 lease**。Main 内存保存 hosts、leases、sessionRoutes；命令经过 ownerHostId 和 runId 检查后，通过 `child.postMessage` 送给任务所有者。独立进程只知道 sessionId，并不会自动加入这张路由表。[路由状态](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/taskRealtimeBus.ts#L125-L147)、[owner 命令路由](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/taskRealtimeBus.ts#L843-L898)

因此，本分工能确认独立 app-server 驱动自身会话，**尚不能确认不修改桌面源码即可将独立 MCP 附着到桌面已持有的全部 runtime**。该限制是现有证据的边界，不能扩大成“任何方法都不可能做到”。

## 可借用独立 HTTP Host 的条件

**官方通用 Web 服务有现成网络接口**：`GET /api/server-info`、WebSocket `/ws`、能力票据申请 `POST /api/rpc-host-capability` 与受票据保护的 `/ws/host`。`/ws` 始终为普通 terminal-client，不能通过自行声明 mode 升格；连接流经过 SocketProtocol/ChannelServer，并非直接把 CLI NDJSON 写到 WebSocket。[HTTP/WS 注册](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/http.ts#L298-L346)、[服务频道装配](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/http.ts#L86-L124)

该入口在启动时调用 `createLocalServices`，建立自己的服务所有权。通过独立 MCP 接入这一个 Web Host，可以管理该 Host 自己的会话；若用户把工作都放在同一个官方 Web Host 中，则可以共享它的运行时。**单独启动它不等于接入桌面 Host**。[HTTP 启动入口](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/entry-http.ts#L8-L26)

通用服务的 API/WS token 认证在传入 `authToken` 后生效，entry-http 对应 `ZCODE_SERVER_AUTH_TOKEN`。这里不能把“普通 HTTP 启动入口”与“统一 CLI 的 --web 默认配置”混为一谈。后者的官方 README 说明默认本机监听，非本机监听默认生成 token。[Token 校验](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/http.ts#L227-L240)、[入口配置](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/entry-http.ts#L13-L26)、[官方运行说明](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/README.md#zcode-命令行版)

独立 `zcode-server-cli` core 的 HTTP 只允许 loopback，当前未接入同等的 token middleware；它也暴露自己的 ChannelServer。另有基于 net `server.listen(endpoint)` 的 supervisor 控制面，但控制命令仅 ping/status/stop/restart/update/uninstall，不是会话管理接口。[core 监听限制](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/zcode-server-cli/src/server-core/http.ts#L115-L131)、[控制 socket](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/zcode-server-cli/src/ipc/controlServer.ts#L19-L40)、[控制命令集合](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/zcode-server-cli/src/contracts.ts#L86-L93)

## 社区桥接项目能证明什么

- **zcode-open-bridge 的 ACP 部分**使用 Popen 启动自己的 `zcode app-server --stdio`，输入输出由该桥持有；它不是连接既有 Electron Host 的客户端。[子进程创建](https://github.com/tizerluo/zcode-open-bridge/blob/e8bd9bc219b29f5f33287d9782cfc8d83bf3786a/packages/acp-bridge/zcode-acp-bridge#L209-L232)
- **zcode-open-bridge 的 MCP 部分**暴露能力发现和三类审查工具，没有现成的完整 session 管理 MCP 工具集合。ACP 接口存在不代表其 MCP 面已具备同样能力。[MCP 工具清单](https://github.com/tizerluo/zcode-open-bridge/blob/e8bd9bc219b29f5f33287d9782cfc8d83bf3786a/packages/mcp-server/zcode-mcp-server#L9-L12)、[MCP 分派](https://github.com/tizerluo/zcode-open-bridge/blob/e8bd9bc219b29f5f33287d9782cfc8d83bf3786a/packages/mcp-server/zcode-mcp-server#L2041-L2044)
- **zcode-webui**启动独立的 `zcode-server.cjs` Host，再向该 Host 配置 Agent CLI 入口；这是复用官方运行时的 Web 部署，而不是已经证明的桌面会话附着。[Host 启动](https://github.com/windviki/zcode-webui/blob/24394171fc482f9eea716ba00810dbf2bbe3fbf3/src/host.mjs#L124-L132)、[Agent 命令配置](https://github.com/windviki/zcode-webui/blob/24394171fc482f9eea716ba00810dbf2bbe3fbf3/src/host.mjs#L74-L95)
- **zcode-acp**同样通过 stdio 子进程适配官方运行时，并自行应答运行偏好反向请求。[协议实现](https://github.com/william0wang/zcode-acp/blob/8d8e28530c41bdbff881369d67138bc21c4ddd3f/src/backend/client.ts#L1-L8)、[子进程创建](https://github.com/william0wang/zcode-acp/blob/8d8e28530c41bdbff881369d67138bc21c4ddd3f/src/backend/jsonrpc-child.ts#L70-L76)、[运行偏好应答](https://github.com/william0wang/zcode-acp/blob/8d8e28530c41bdbff881369d67138bc21c4ddd3f/src/backend/client.ts#L94-L106)

社区文档的“ZCode 闭源”描述已经被 2026-09-20 后的官方仓库事实更新。某个社区版本称 busy `session/send` 可 steer，也不能覆盖当前审计源码中明确的 busy 拒绝条件。

## 未核实与探针约束

1. 主代理发现的 `127.0.0.1:49571` listener 尚未对应到确定的服务与请求契约。本分工没有向该端口发送请求，不能称它为会话 RPC 端口。公开源码还存在远端媒体预览与 off-peak mock gateway 的本机 listener，端口存在本身不证明会话控制能力。[媒体预览监听](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/host/remoteMediaPreviewProxyHelpers.ts#L90-L102)
2. 尚未实测独立进程向桌面现有 active session 发送、停止或分叉；本次没有执行这些副作用操作。
3. app-server 启动本身会打开 SQLite 并进行 startup/migration，协议方法只读不能推导进程启动完全无写入。探针应设 `ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH`、`ZCODE_DATA_BASE_DIR`，分别隔离运行存储、会话 DB 与 provider/凭据等数据目录。[环境参数解析](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts#L25-L31)、[Provider 数据目录](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/provider-runtime-env.ts#L58-L81)、[启动迁移](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts#L136-L153)
4. 本分工只读审计，没有安装任何依赖、启动被审计项目、请求模型、创建或发信会话。官方和社区源码未被修改，未 fork、未提交、未推送。

## 本分工文件与验证

保留的源码快照为 `sources/official-zcode/` 和 `sources/zcode-open-bridge/`。两次 shallow clone 均记录退出码 0；验证后删除 `sources/official-zcode-clone.log` 与 `sources/zcode-open-bridge-clone.log`，以本笔记中的版本、提交 SHA 与结果保留脱敏证据。

官方 snapshot 的仓库鲜度检查显示 main 与 origin/main 同步，ahead/behind 均 0。两份 clone 的 `git diff --name-only HEAD` 和 `git ls-files --others --exclude-standard` 均返回 0 项；没有创建额外临时目录。源码研究不涉及行为修改，本分工未运行测试或构建。

## 搜索工具使用（仅本分工）

| 工具 | 用途 | 调用次数 |
| --- | --- | --- |
| `web__run` | 官网、仓库与技术线索检索 | 3 |
| `mcp__context7__resolve_library_id` | 定位官方 ZCode 文档库 | 1 |
| `mcp__context7__query_docs` | 查询官方 app-server 文档；未命中，转官方源码 | 1 |
| `mcp__codex_apps__github_search_repositories` | 查找官方组织的 ZCode 仓库 | 1 |
| `mcp__codex_apps__github_search` | 已可见的 GitHub 代码搜索工具；本分工未调用 | 0 |
| `mcp__codex_apps__github_fetch` | 官方与社区原始源码、目录树、提交信息 | 19 |
| `mcp__Read__read_file` | 本地技能、源码与 clone 日志读取及最终报告交叉核对 | 52 |
| `exec_command` | Git、ripwire 与 rg 导航和核验 | 55 |
| `write_stdin` | 等待后台 clone 完成 | 1 |

exa、zread 与 web-reader 在本分工可见工具中不可用；没有虚构它们的调用。

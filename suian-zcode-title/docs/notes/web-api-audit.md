# ZCode Web 通信接口与独立 MCP 接入

核查日期：2026-10-05。沿用官方公开源码 `29628c9`（3.14.3），同时只读检查本机 3.14.4 发布包。

**应优先验证通过现有 Web 远控协议连接桌面 Host，再封装独立 MCP**。本次已经找到发布包中的连接与附着代码，尚未验证第三方客户端的配对握手。这个结论比上一轮“未找到桌面外部入口”更具体：产品有这条入口，公开源码快照没有给出完整手机客户端实现。

## 两种 Web 连接

| 形态 | 通信入口 | 会话所有者 |
|---|---|---|
| 独立部署的官方 Web Host | HTTP 发现接口与 WebSocket RPC | Web Host 自己持有的 Agent |
| 手机 Web 远控桌面窗口 | 授权链接、外部 relay、工作区 bridge 与 RPC 转发 | 原有桌面 Host 和它已持有的 Agent |

用户希望现有 ZCode Agent 管理其他桌面会话时，第二种形态更贴近目标。官方文档确认手机复用现有桌面窗口的任务与工作区；它能继续输入，并在已有工作区创建任务。接入范围受窗口登记状态和单手机页面限制。[官方远控说明](https://zcode.z.ai/en/docs/remote-control)

## 独立 Web Host 的接口已经公开

`packages/server/src/http.ts` 注册以下路由：[路由代码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/http.ts#L298-L346)

| 路由 | 用途 |
|---|---|
| `GET /api/server-info` | 服务器发现与描述 |
| `/ws` | 普通 Web 客户端的服务 RPC |
| `POST /api/rpc-host-capability` | 该 Host 的能力票据 |
| `/ws/host` | 消费有效票据的 Host 连接 |

`/ws` 连接经 `SocketProtocol → ChannelServer → ServiceCollection` 暴露业务服务；浏览器侧经 `SocketProtocol → ChannelClient → RemoteServiceAccess` 获得代理。因此，接口主体是 WebSocket 上的二进制服务 RPC，不能将 CLI 的 NDJSON 请求直接发送过去。[服务端装配](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/http.ts#L86-L124)、[Web 客户端](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/client/src/websocket.ts#L66-L115)

客户端代理包含 Agent、Task、WindowController 等服务。窗口目录服务负责列出和订阅任务；创建、输入、停止等操作归工作区会话服务。服务契约中的方法还要核对具体 facade 的实现和连接权限，不能因为接口声明存在就保证任意 Web 客户端都能调用。[服务代理](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/client/src/remoteServiceAccess.ts#L99-L145)、[窗口 Controller 契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/window-controller/windowController.ts#L48-L66)

会话操作的新路径是 V4：握手与订阅通过 `helloConversationV4`、`initializeConversationV4`、`subscribeConversationV4` 等服务方法，输入使用 `sendText` 命令，交付方式区分开始、排队和引导。[Agent 服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgent.ts#L731-L749)、[V4 输入契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/command.ts#L81-L112)

独立 Host 的能力票据属于该 Host，不能替代手机连接桌面的远控授权。[HTTP 启动入口](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/entry-http.ts#L8-L26)

## 本机发布包补上了桌面远控路径

**3.14.4 的安装包包含设备端远控桥的具体实现**。本次只读取 `D:\APP\_ForCoder\ZCode\resources\app.asar`，没有执行提取出的代码，也没有读取用户凭据。版本与 SHA-256、检查标识和退出码记录于 [runtime-evidence.json](runtime-evidence.json) 的 `webRemoteControl` 字段。

| ASAR 内文件 | 静态观察 |
|---|---|
| `out/main/index.js` | `WebRemoteControlDeviceTransport`；设备注册、认证挑战与响应、配对状态查询；bootstrap、工作区查询和 bridge 开启；RPC 帧转发 |
| `out/main/chunk-Q4A6QLKZ.js` | `AcknowledgedRelayProtocol`；消息确认、缓存、流控和恢复处理 |
| `out/main/chunk-SPTKPKUJ.js` | bridge 身份、代次、恢复 ID、消息序号、分片及确认的严格 schema |
| `out/renderer/assets/styles-Qlp0Bew7.js` | 共享 UI 中的远控会话和输入状态适配 |

Main 的 `attachLocalHostAttachment` 明确向**已经存在的窗口 Host**发送 `AttachServicePort`，连接模式为 `web-remote-replayable`，scope 为 local。它交付 MessagePort，并以桌面窗口的 Host 作为 entry；这段附着操作没有启动新的 CLI。

工作区选择使用 `workspace-list-request` 和 `workspace-bridge-open`，后者携带工作区 key、可选 taskId 及 bridge 身份。数据层通过 `rpc-frame` / `rpc-frame-ack` 承载 RPC。独立客户端必须处理认证、确认、分片、桥切换和恢复，不能只发一条 prompt JSON 就认为完成接入。

上述是安装包的静态代码证据。它证明了产品的控制链存在，不证明独立 MCP 已成功配对，也不证明发行包中每个功能在当前账号下都已启用。公开 3.14.3 源码与官网的差异见 [Web 远控源码审计](web-remote-audit.md)。

## 建议的独立 MCP 架构

```mermaid
flowchart LR
    A[ZCode 内部 Agent] -->|MCP 工具调用| M[独立 MCP 与共享连接服务]
    M -->|已有远控授权和客户端协议| R[官方 WebSocket relay]
    R -->|窗口与工作区 bridge| D[桌面 Main]
    D -->|附着现有 MessagePort| H[已有 Host]
    H -->|原有 stdio 控制连接| C[原有 Agent Runtime]
```

**MCP 作为授权客户端即可保持官方源码不变**。多个 Agent 的 MCP 工具可以共用一个连接服务；由它串行处理工作区 bridge 切换和命令提交，避免每个 MCP 子进程各自争用手机连接。这是工程建议，尚未实现或验证。

后续验证应先做到“正常授权连接 → 获取窗口任务目录 → 打开指定工作区 → 读取会话状态”，再测试用户批准的消息投递。目录读取通过后才封装 `list_sessions`、`read_session`、`send_message_to_session`，随后增加创建、停止等操作。

接入需要用户授予远控链接。链接的获取、有效期、账号条件、单客户端占用，以及发行版实际开放的命令面仍需实测。本次没有申请票据、开启远控、扫码配对、发信、创建任务或调用模型；临时脚本、提取代码和日志在核查后删除。

# 工件状态分叉继承：宿主与插件入口静态核查

核查日期：2026-10-10。本次只读审查安装包 CJS 与官方 3.14.3 钉定源码，没有启动真实或隔离 CLI，没有读取用户配置和聊天数据库，没有修改安装目录或 sources。

后续隔离运行已完成，V4 稳定分叉与事件时点的实际反例见 [发行版核验报告](artifact-host-capabilities.md)。本文保留静态阶段的协议依据与待验证项，不代表后续验证尚未进行。

## 结论

**现有实现能产生父子会话 ID，但没有核实到纯插件可在原生分叉操作中冻结外置工件状态的入口**。插件 Hook 没有分叉事件；宿主的 `SessionForked` 是子会话数据提交后产生的运行时事实。对外事件通知没有等待外挂完成持久快照的回执。

**首次启动时读取父状态不能满足分叉快照语义**。例如，父状态在分叉时为 revision 5，分叉后更新为 revision 6，子会话再启动。子 Hook 读取到 revision 6，不是分叉时的 revision 5。仅发现父子关系，不能确定需要复制的外置状态修订。

因此，本核查不支持把“子会话启动后补读父状态”写成分叉继承的验收通过。严格继承仍需上游提供可绑定外置状态修订的分叉入口，或另行确认覆盖范围更窄的插件控制分叉方案。

## 证据对象与可复核定位

安装包对象为 `{{ZCodeInstallDir}}/resources/glm/zcode.cjs`，本次实际读取文件大小为 **14820968 字节**，SHA-256 为：

```text
FAD4C35C4C36EC210D8A06D3FA0E77DE23C8545E2EB6FF90AEA1EB38D1E6275F
```

以下偏移均为原始 UTF-8 文件的零基字节位置；区间采用 `[开始, 结束)`。先读取完整相关函数和上下游调用，再按关键结构定位，没有执行 CJS。不同文件哈希不能直接沿用这些偏移。

| 安装包位置 | 已读结构 | 对照公开源码 |
| --- | --- | --- |
| `[1309699,1309906)` | `Tl` Hook 枚举只有七项，无 fork Hook | [hooks/index.ts，7–15 行][hook-enum] |
| `4148647` 附近 | 插件 Hook 事件检查使用 `new Set(Object.values(Tl))`；未知事件产生 `plugin_hook_unsupported_event` 并跳过 | [hook-sources.ts，129–142 行][hook-source] |
| `[12988871,12989387)` | `gAo` 为 `runSessionStartHooks`，只传当前 `sessionId`、source、时间、trace 等；有 `sessionStartHookRan` 门控 | [methods/hooks.ts，20–47 行][hook-start] |
| `[13121587,13125409)` | `fTn` stable fork：分配 child ID、构建副本、提交 bundle、追加父 fork 事件、返回父子 ID | [session-fork.ts，737–796 行][stable-commit] |
| `13124201` / `13124588` | 前者为 `commitForkBundle({child:…})`；后者为随后创建 `lt.SessionForked` 的位置 | [session-fork.ts，737–775 行][stable-commit] |
| `[14497716,14498146)` | `ZKo` legacy `forkSession`：检查 revision 与无活跃轮、调用 `forkFromCheckpoint`、注册 child | [server-operations.ts，2229–2249 行][legacy-fork] |
| `[14498146,14499260)`；其中 `14499050` | `TRn` 注册 child，继承父运行配置，然后 `await g.app.resume()`，最后返回父子 ID | [server-operations.ts，2274–2326 行][register-child] |
| `[13175362,13175661)` | `qRo` 内部事件 sink 被 await，异常只记 warning；它不是插件配置回调 | [methods/events.ts，528–546 行][event-sinks] |
| `756181` / `761091` | 安装包 `session/subscribe` / `session/fork` 的严格参数 schema，与下文公开契约字段一致 | [订阅 schema][subscribe-schema]、[分叉 schema][fork-schema] |

该对照只证明已读函数的结构与字段一致，不宣称安装包与公开源码全部相同。官方参考提交为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。

## 插件 Hook 与运行时事件的不同边界

**插件 Hook 配置受七项事件枚举约束**：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`。插件加载器拒绝其他事件名，见 [枚举][hook-enum] 与 [加载器][hook-source]。

`SessionStart` 输入的 source 只有 `startup/resume/clear/compact`，没有父 ID 或分叉点字段，见 [Hook 输入契约，67–75、127–131 行][hook-input]。安装包的 `gAo` 同样只构造当前会话的输入。公开插件加载结果只有 commands、hooks、MCP、skills 等配置，见 [PluginLoadOutcome，248–256 行][plugin-load]；隐藏 plugin-host 命令执行插件模块 `main()`，并未向它注入 Agent Runtime 对象，见 [plugin-host-command.ts，49–63 行][plugin-host]。这些已审查入口均未提供注册 `SessionForked` 回调的方式。

**运行时确有 `SessionForked` 事件**，payload 包含 `originalSessionId`、`forkedSessionId`、`targetMessageId` 等，见 [事件契约，198–207 行][fork-event]。stable fork 先原子提交 child/message/entries，随后向父会话追加该事件；父事件追加失败后只记 warning，分叉子会话已持久化，见 [提交与事件顺序][stable-commit]。`selection_side_chat` 分支在这里不产生相同的父 fork 事件，不能把本结论泛化为所有子会话创建。

内部 `appendEvent()` 会等待存储和内部 sink，见 [events.ts，103–109 行][event-append]。但协议 sink 调用的是 `onSessionEvent()` 的 void 转发路径，最终 `notify({method:"session/event",params:…})`；没有外部客户端“已保存工件快照”的 ACK，见 [事件转发，3047–3082 行][event-forward]。安装包对应 `kXa/iZo` 位于 `14508262/14509860`，同样是通知发送。因此内部 await 不等于等待插件处理完成。

## 分叉时序对外置状态的影响

公开 stable fork 的时序为：**固定会话历史边界 → 提交子数据 → 产生父分叉事件 → 尝试注册并 resume 子会话**。V4 bridge 在 core copy 后调用 `registerCommittedForkBestEffort`，见 [v4-bridge.ts，1189–1209 行][v4-register]；子注册失败时保留已提交的分叉并记录启动失败，见 [540–568 行][v4-register-failure]。外置工件状态不在现有 `commitForkBundle` 输入中，分叉事件也不携带工件 revision，见 [bundle 参数与事件][stable-commit]。

legacy `session/fork` 在子 `resume()` 后才返回父子 ID，见 [registerForkedSession][register-child]。`resume()` 又会调用 `runSessionStartHooks("resume")`，见 [resume.ts，253–261 行][resume-hook]。插件若只在 fork 响应返回后复制状态，可能已晚于子启动 Hook。

桌面 V4 `forkAssistant` 使用稳定的历史目标，允许 running parent，不走 legacy 的“父空闲 + 工作区回退”路径，见 [fork-edit-retry.ts，276–309 行][v4-fork]。固定 transcript 边界不等于固定外置工件状态；父 Agent 的后续 `set` 与外挂接收 fork 通知之间仍缺少已核实的同步契约。

现有运行时事件可以作为**关系发现**的证据：知道哪段会话由哪段分叉。它不能单独作为**状态冻结**的证据：不能保证外置存储复制的是分叉时的 revision。即便外部维护版本历史，也需要可靠的宿主边界与外置 revision 绑定，不能用接收事件时的“最新状态”代替。

## 给隔离运行时验证的协议入口

以下是已核查的 AppServer 协议格式，供独立验证使用；本轮没有发送这些请求。帧是 NDJSON，严格 schema 为 `id/method/params/trace?`，**不含 `jsonrpc` 字段**，见 [请求 schema，286–293 行][request-schema]。

```json
{"id":"fork-test","method":"session/fork","params":{"sessionId":"{{ParentSessionId}}","target":{"kind":"message","messageId":"{{MessageId}}"}}}
{"id":"watch-parent","method":"session/subscribe","params":{"sessionId":"{{ParentSessionId}}","deliveryKind":"web-remote-replayable","afterSeq":0,"includeSnapshot":false}}
```

`session/fork` 支持 message、checkpoint 和默认 latestCheckpoint 目标，以及可选 `expectedRevision`。结果包含 `forkedSessionId/parentSessionId/targetMessageId/targetCheckpointId/response/snapshot`，见 [目标与分叉 schema][fork-schema]。此 legacy 入口可能涉及工作区文件回退，不能据一次 legacy 测试宣称覆盖桌面 V4 stable fork。

`session/subscribe` 的 deliveryKind 可用 `desktop-continuous` 或 `web-remote-replayable`，见 [deliveryKind 定义][delivery-kind]；它可以通过 `afterSeq` 获取缺口。实时通知为 `session/event`。原始 `SessionForked` 在 legacy mapper 中落到 **`type:"session.updated"`**，payload 保留原始字段，不能等待一个并不存在的 `type:"session.forked"`，见 [payload 映射，395–426 行][payload-map] 与 [type 映射，1478–1528 行][type-map]。

Host 的旧事件面为 `zcode-agent.onDynamicSessionEvent()`，参数含会话目标、deliveryKind、afterSeq 与 includeSnapshot；Host 会转成 CLI `session/subscribe` 请求，见 [Host 接口，339–346 行][host-subscribe] 与 [转发，4818–4842 行][host-subscribe-send]。当前公共 `connectHost()` 包装只暴露 call/probe/close，没有 listen，见 [gateway-client.mjs，52–59 行](../../suian-zcode-common/gateway-client.mjs#L52-L59)。需要事件观察时不能声称现有包装已经提供订阅，更不能把新观察通道称为 fork 快照 Hook。

隔离运行时还需核对以下实际路径，不能只替换数据库：

- CLI 支持 `app-server/agent-server` 命令分支，见 [run.ts，537–545 行][cli-command]；具体二进制与安装包依赖需由运行时验证确认。
- 存储 override 为 `ZCODE_STORAGE_DIR` 与 `ZCODE_SESSION_DB_PATH`（或 `ZCODE_SESSION_DB`），见 [env-config.adapter.ts，24–32 行][storage-env]。
- `ZCODE_DATA_BASE_DIR` 影响 provider 的 v2 基目录，见 [provider-runtime-env.ts，58–81 行][provider-env]；它不能独自证明所有用户配置隔离。`createConfig()` 默认仍加载用户配置，见 [config-factory.ts，135–138 行][user-config]，应同时核实隔离的 homedir、cwd 与数据库绝对路径。

## 对 #27 的建议与未验证项

**把“精确的 fork 状态继承”保留为前置能力问题**。上游最小能力需明确：分叉操作绑定哪份外置工件 revision，插件能取得 parent/child ID，以及 child 首次使用状态前如何等待继承完成。普通通知和首次启动读取都不满足这三个条件。

如果以后限定所有分叉经插件控制，插件可以在自身操作边界冻结修订并建立父子映射；这会缩小对原生 UI 分叉的覆盖，需独立产品决策，本轮不实施或默认为用户已接受。

本轮成功标准已完成：读取安装包相关函数与相邻调用、固定哈希与字节偏移、对照公开 Hook/分叉/事件契约、识别时序缺口。**未完成的验证**是隔离 CLI 的实际 fork 与事件订阅、插件 Hook 触发记录、真实 Host/桌面分叉行为。静态核查不替代这些验收。

[hook-enum]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/hooks/index.ts#L7-L15
[hook-source]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/hook-sources.ts#L129-L142
[hook-start]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts#L20-L47
[hook-input]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/hooks/index.ts#L67-L131
[stable-commit]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts#L737-L796
[legacy-fork]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L2229-L2249
[register-child]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L2274-L2326
[event-sinks]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/events.ts#L528-L546
[subscribe-schema]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L1497-L1513
[fork-schema]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L1788-L1828
[plugin-load]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/plugins/index.ts#L248-L256
[plugin-host]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/plugin-host-command.ts#L49-L63
[fork-event]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/events/session.events.ts#L198-L207
[event-append]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/events.ts#L103-L109
[event-forward]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L3047-L3082
[resume-hook]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/resume.ts#L253-L261
[v4-fork]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/fork-edit-retry.ts#L276-L309
[v4-register]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts#L1189-L1209
[v4-register-failure]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts#L540-L568
[request-schema]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L286-L293
[delivery-kind]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-legacy-types.ts#L14
[payload-map]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts#L395-L426
[type-map]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts#L1478-L1528
[host-subscribe]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgent.ts#L339-L346
[host-subscribe-send]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentService.ts#L4818-L4842
[cli-command]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/run.ts#L537-L545
[storage-env]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts#L24-L32
[provider-env]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/provider-runtime-env.ts#L58-L81
[user-config]: https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/config-factory.ts#L135-L138

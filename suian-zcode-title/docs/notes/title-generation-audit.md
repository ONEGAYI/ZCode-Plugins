# 最近三轮聊天生成标题的可行性

核查日期：2026-10-06。公开源码固定在 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（3.14.3）；本机随附 CLI 为此前核查的 0.16.9。本轮只检查源码、发行 bundle 字符串以及 SQLite 只读统计。

**Stop 之后的命名后端已经搭好并真实跑通，Stop Hook 本身尚未接入**。2026-10-06 21:31:41，程序用 SQLite 只读整理最近三轮，调用原 Host 的 `generateWorkspaceText`，以 `GLM-5.3-Flash / low` 生成并写入“🧩 双链联想｜批次功能实施”，原 Host 和双库回查一致。重复调用不再请求模型。入口见 [title-runner](../title-runner/README.md)，证据见 [stop-title-runner-evidence.json](stop-title-runner-evidence.json)。

## 会话标识与持久化历史

`ZCodeTaskMeta` 的契约明确规定 UI 的 `taskId` 与 ZCode Agent 的 `sessionId` 一致。MCP 调用上下文在具备 Trace 时可以提供 `_meta.session_id`，同时可带工作区路径、身份和作用域。不能用观测链路的 `traceId` 代替会话 ID，也不能把本地数据库路径套到远端 Runtime。[任务标识契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-task-types-core.ts#L264-L289)、[MCP 上下文](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1748-L1773)

本机当前 ZCode 原生会话库为 `C:\Users\<user>\.zcode\cli\db\db.sqlite`，任务索引为 `C:\Users\<user>\.zcode\v2\tasks-index.sqlite`。历史关联关系是：

```text
tasks.task_id → session.id
session.id → message.session_id
message.id → part.message_id
```

消息的角色和其他信息存在 `message.data` JSON 中；正文需要从对应 `part.data` 的文本分片重建。仓库读取消息时按 `sequence` 排序，旧行没有序号时再使用时间等字段；内容分片也有自己的顺序。不能把更新时间当作对话顺序。[消息与分片读取](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts#L222-L255)

本机只读统计使用 `sqlite3 -readonly` 和 `PRAGMA query_only=ON`，没有输出会话 ID、路径、标题或正文：

- 按 `updated_at` 选出的最近 20 个未删除 GLM 任务，20 个均能关联到 CLI 的 `session.id`。
- 全部符合该条件的任务索引共 205 个，其中 114 个有对应 CLI 会话，91 个没有。本轮未确定缺失原因，历史适配器不能假定每个索引任务都能从这一个库读取。
- 当前 `message` 和 `part` 均含 `sequence` 字段。库中有 3,005 个 assistant `parentID` 分组含多条 assistant 记录；这个统计没有进一步把 parent 分组限定为真实用户输入。

## 最近三轮的整理口径

**一轮应按一次真实用户输入及其后续助手回复分组，不能简单取最后六条消息。** assistant 的 `parentID` 指向关联的用户消息，一次输入可能包含多条助手输出和工具执行。[消息类型](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts#L346-L437)

建议默认在轮次结束后取最近三次真实用户输入，以及对应的可见助手文本。排除思考分片、工具原始结果、内部提醒、压缩摘要和被回退的分支。ZCode 已有真实用户/可见助手的投影判据；活动会话的读取还应用了 rewind 状态，直接 SQL 读取需要处理这层语义。[可见消息规则](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/conversation-message-projection-policy.ts#L83-L164)、[当前分支历史](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L3787-L3833)

连接现有 Host 后，也可以调用 `session/messages` 获取已经应用活动分支规则的消息，再在 MCP 中整理轮次。它需要目标驻留于该实例；`limit` 是消息数，不是轮次数。[消息接口实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1866-L1880)

## 指定模型的一次性生成

**命名材料可以直接交给 `workspace/generateText`。** 协议要求 `workspace`、`selection`、`querySource`，并提供 `prompt` 或 `messages`。模型选择使用 `selection.providerId` 和 `selection.modelId`；实际 Registry 执行还要求提供合法的 `selection.options.reasoningLevel`，不能因为协议 schema 将 options 标成可选，就认为可以省略档位。接口返回 `text`、模型选择、结束原因及用量。可用模型和档位应查询宿主模型目录，不猜展示名称。[参数与结果契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol/index.ts#L2075-L2116)、[Registry 执行边界](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts#L43-L91)

Core 按这次请求的模型选择执行，输入只采用调用方提供的消息，未提供工具时工具列表为空。实现没有进入普通 Agent 工具执行循环，也没有在这段路径中切换主会话的当前模型。[辅助生成实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts#L145-L270)

app-server 在同工作区有驻留会话时复用其 app，否则创建临时 app 并在完成后关闭。该接口不需要先建立普通聊天会话，但会产生模型请求事件和用量记录；不能承诺完全无日志或无落盘。模型配置、套餐权限和可能的反向鉴权请求仍需真实调用验证。[app-server 路由](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L2743-L2793)

模型的账号类型会影响这条路线。静态 API-key 的鉴权不依赖宿主反向刷新，普通智谱账号可能要求 `requestProviderRuntimeHeaders`；Off-Peak 还要求在执行范围绑定 `requestAuth.source`，而该快照的辅助生成模型创建只传入 selection。因此，不能仅凭模型出现在目录中，就保证任意 Off-Peak 模型也能通过这条一次性接口调用。[模型鉴权分支](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner.ts#L163-L189)、[辅助模型创建](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts#L145-L151)

普通 `session/create → session/send → session/close` 是另一条路线，但 `deferred` 只代表草稿暂不持久化，首条输入会提升为 `immediate`；`close` 关闭运行资源，不保证删除历史。指定模型与鉴权的详细审计见 [一次性生成接口审计](one-shot-generation-audit.md)。

## 动态重命名的执行位置

CLI V4 `renameSession` 接收 `{ title }`，但 handler 使用 `requireRecord` 查当前实例的会话表。仅从数据库拿到 ID 并另起 CLI，不会自动附着到桌面中持有它的 Runtime。[重命名 handler](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts#L131-L152)、[会话查找](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/record-access.ts#L11-L22)

**桌面同步优先调用现有 Host 的 `renameTask`。** 它更新 `tasks-index` 的标题及覆盖标记，再发 V4 `renameSession`，并通知任务列表。内部 CLI 同步失败时，它仍可能保留索引标题并返回，因此验收必须回读目标状态，不能只判断服务调用是否返回。[宿主重命名实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L2919-L2980)

CLI 重命名把标题标记为 `titleSource=custom`，此后内置自动标题生成会跳过该会话。外部命名程序仍可再次调用重命名；后续更新需要由它自己触发。[自定义标题与内置自动标题](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts#L259-L309)

归档与取消归档属于桌面 Task 服务的 `archiveTask` / `unarchiveTask`，当前源码中的实现更新任务索引的 `archived` 状态；本次 CLI 命令表没有对应归档命令。[归档实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L3029-L3041)

## 建议的最小流程与验证标准

1. 在轮次结束或闲置时触发，读取会话及工作区标识。
2. 在正确的持久化库或 Host 中读取当前分支，整理最近三轮可见对话。
3. 用指定模型调用 `workspace/generateText`，只要求返回合适标题。
4. 通过持有目标会话的 Host 调用 `renameTask`，回读标题并检查桌面列表。

这条流程不需要 fork 官方源码。三轮提取、指定模型生成、原 Host 改名与回读已经由可复用后端完成实测；Stop 自动触发、授权注入/续期、持续连接和多窗口调度仍未完成。本机 `readSessionMessages` 请求因消息字段校验不一致失败，后端明确选择 SQLite 只读适配，并处理持久化回退分支。

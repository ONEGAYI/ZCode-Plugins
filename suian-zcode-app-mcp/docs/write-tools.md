# 会话写工具

六个写工具通过公共远控客户端附着原 ZCode Desktop Host。任务操作调用 `zcode-task`，`send_message` 与 `compact_session` 通过 `zcode-agent` 的 v4 命令分别提交消息和上下文压缩请求；不启动独立 CLI app-server、不直接写会话数据库。读取与分页仍按 [读取契约](./readonly-tools.md)。

## 连接与授权

写工具通过公共网关调用已开启远控的 Desktop，目标为窗口已打开的本地工作区。默认 connectHost 不新建官方 terminal；旧网关缺少 RPC 时明确要求重载，不回退直连。一个 MCP 进程仍只接收一个写调用，冲突返回 remote_busy，读取可继续。本地工作区分流已有隔离验证，真实手机验收以当前证据为准。

默认从 ~/.zcode/tools/suian-zcode-gateway/config.json 读取公共配置；自定义目录用 --gateway-config {{path}}。本地令牌只放请求头，不复制到 MCP 配置。手机使用远端工作区时本地 RPC 返回 remote_workspace_busy，不切走手机。

下列旧凭据保存入口保留兼容，当前工具不会读取该密文或要求手机链接；仅管理旧凭据时从 stdin 提供 JSON {"authorization_url":"{{remote_link}}"}：

```powershell
node "{{plugin_root}}/cli.mjs" --save-authorization
```

这条兼容命令保存后退出，不启动 MCP。链接不放到 args/env/日志；--auth-data-dir 或 ZCODE_APP_MCP_AUTH_DATA_DIR 只指定旧密文位置，不影响网关调用。两个读取工具始终无需网关。

## 输入与输出

### 正文输入

`start_session` 与 `send_message` 都必须且只能提供一个正文来源：

| 字段 | 用途 |
| --- | --- |
| `message` | 非空正文，推荐短指令直接填写 |
| `message_file` | 本机 UTF-8 `.md` 文档的绝对路径，推荐长文、评估与汇报使用 |

文档全文作为消息正文，保留换行与空白并沿用原有来源包装；不会把路径作为正文发送。文件不存在、不可读、是目录或全文为空白时，在创建、恢复及提交之前明确报错。文档只在本次调用开始时读取一次，插件不创建或删除文件。

临时正文推荐生成在工作区的 `.zcode/tmp/` 等已被 Git 忽略的目录。生成前先确认目标项目已有忽略规则；本仓库已忽略 `.zcode/tmp/`。短指令仍可使用现有 `message` 输入。

```json
{"name":"start_session","arguments":{"workspace_path":"D:/work/example","message_file":"D:/work/example/.zcode/tmp/task.md"}}
```

```json
{"name":"send_message","arguments":{"session_id":"sess_example","message_file":"D:/work/example/.zcode/tmp/report.md"}}
```

### 各工具字段

`rename_session`：必填 `session_id`、非空 `title`。可选 `workspace_path`、`workspace_key`；路径省略时从本机历史定位，同 ID 存在多个索引工作区时用 key 消歧。调用方只在用户明确要求改名时使用；不要为了派发、角色标记或回信检索重命名父会话，回信以 `creator`/`deliverer` 会话 ID 定位。

```json
{"name":"rename_session","arguments":{"session_id":"sess_example","title":"新的名称"}}
```

成功返回 `source:original_host`、`session_id`、`workspace_path`、`title`，名称以原 Host 的 `getTaskMeta` 读回为准。显式命名使用宿主的 custom 标题来源；当前自动命名插件只有已记录命名基线、且非 generated 标题相对基线变化时才判手动改名。首次 custom 标题不保证免于命名模型处理，模型也可选择 keep。

`start_session`：必填 `workspace_path` 和上述二选一正文输入。创建方 ID 由服务自动识别，不接受 `creator` 输入。`title` 仅为新会话初始名称，可省略；独立 `lock_title` 默认 false。`model` 可省略，交给 Host 默认模型。指定时需 `provider_id`、`model_id`，可选 `reasoning_level`，先在当前 Host 模型目录验证，不猜 provider ID。

`permission_mode` 可选 `build`（变更前确认，可能逐次询问）/`plan`/`edit`/`auto`/`yolo` 五档，是权限策略而非开发任务类型。正常派发省略该参数；仅在用户明确指定权限模式时填写，不能因“实施代码”“构建”或“等待首肯合并”选择 `build`。合并授权边界写入开局正文，不用权限模式代替。显式请求 `yolo` 等高权限档位需用户授权，已有明确授权不重复询问。

显式模式透传宿主 `createTask`；缺省仅从发起会话 CLI 库的 `session.permission.mode` 继承。确认新会话权限也读取同一个 CLI 字段，不使用任务索引或创建响应的 `mode`。来源冲突时不继承，由来源警告说明。CLI 会话不存在、权限缺失或非规范值、库缺失或繁忙等继承探测异常时不传 `mode`，新会话使用 Host 默认权限；回执附 `permission_not_inherited` 警告及 `observed_modes` 原始取值（探测异常时无该字段）。

```json
{"name":"start_session","arguments":{"workspace_path":"D:/work/example","message":"这是链路测试，只回复 TEST_OK","model":{"provider_id":"account:bigmodel-individual-coding-plan","model_id":"GLM-5.3-Flash","reasoning_level":"low"}}}
```

返回新 `session_id`、实际 `workspace_path`、初始 `title`、`lock_title`、`permission_mode`（CLI 会话库读回的实际权限）、`input_id`、`delivery_status:accepted`、`source:original_host`；来源唯一确认时附 `creator`，有冲突时附 `warnings`。锁定策略在开局前写入；指定初始名称在首发提交并确认 CLI 会话行落库后，经官方改名链路写入，再复核双库标题。默认不锁，不因提供名称就推断保护。

新会话在首发前尚未落入 CLI 库，因此权限确认在开局提交后进行。最多读取三次，缺少权限时每隔 300 毫秒重读；始终读不到时省略 `permission_mode` 并附 `permission_unverified`，不借用其他信源补齐。CLI 权限与显式或继承的请求值确实不一致时报 `permission_not_confirmed`；读取异常也明确报错。两种错误都携带已提交的 `input_id` 和 `delivery_status:accepted`，不能据此重复派发。重读只查询数据库，不重发消息。

提供 `title` 时，同一次 CLI 读回还必须确认会话行存在。三次读取后仍无行，报 `session_not_persisted` 并保留首发提交回执，不执行改名；行存在但权限字段缺失时，仍可改名，权限未核实警告保留。改名后的双库分叉继续以 `title_store_diverged` 警告报告，命名插件的一致性守卫保留。

`send_message`：必填 `session_id` 和上述二选一正文输入；可选工作区字段同改名。发信方 ID 由服务自动识别，不接受 `deliverer` 输入；`session_id` 始终是接收方 ID。会先完成当前 RPC 连接的 v4 hello/clientHello 握手，再通过 Host 恢复目标会话并提交信息。握手与命令使用同一客户端 ID。`delivery_mode` 可省略，建议通常省略以跟随宿主当前输入策略；显式覆盖只影响本次消息，不改变会话设置：

| `delivery_mode` | 处理方式 |
| --- | --- |
| 省略 | 不传 v4 `requestedDelivery`，由宿主当前输入策略决定 |
| `guide` | 工作中在可消费输入的边界引导当前轮；不能立即消费时暂存 |
| `queue` | 工作中排队后续处理 |

空闲时两种显式策略都可启动新一轮。接口不开放强制抢占的 `startNow` 输入。保留既有的 `keepQueueAndSend`：暂停队列需要发送裁决时保留旧队列，不清空它。可直接使用创建工具返回的 ID，通常不必填写投递策略：

```json
{"name":"send_message","arguments":{"session_id":"sess_example","message":"继续测试，只回复 SECOND_OK"}}
```

成功返回 `session_id`、`workspace_path`、`input_id`、`delivery_status:accepted`、`source:original_host`；来源唯一确认时附 `deliverer`，有冲突时附 `warnings`。投递回执另带两个字段：

- `requested_delivery_mode`：调用方请求的 `guide` / `queue`；省略时为 `host_default`。
- `admitted_delivery`：Host `inputAccepted` 回执的 `startNow` / `queue` / `guide` 原值。公开上游实现也会把尚待消费的 guide 返回为 queue；这只说明输入已接收，不证明已注入当前轮或已处理完。

MCP 开始执行后，工具等待 Host 接受提交的 ACK 即返回并释放连接，不等待接收方工作结束或回复；不能把“不等待处理”理解为无需等待网络和 Host 确认。Host 明确拒绝时返回 `send_not_accepted`、`delivery_status:rejected`；提交异常、缺少有效回执或输入标识不一致时返回 `delivery_status:unknown`，保留本次 `input_id` 供核对，不自动重发。Host 缺少 v4 命令接口时明确报错，不回退到无法表达策略和回执的旧发送接口。

**及时发信先单独调用**：先调用 `send_message` 并取得提交回执，再执行等待、轮询或长命令。不要与含 `sleep` 或长耗时 Bash 的调用放在同一批；宿主可能先串行执行前面的工具，发信工具卡已显示也不代表 MCP 已开始执行。`delivery_mode` 决定接收方的输入处理策略，不会改变发送方的工具调度。长命令支持后台参数时使用后台模式，不向不支持的工具添加后台参数。

发信不改变目标会话的权限模式：恢复链路不携带 `mode`，权限保持会话现状；消息也不携带模型选择覆盖。

所有工具拒绝未知参数和空白标题/信息。MCP 注解中两个读取工具保持 `readOnlyHint:true`；六个写工具为 false，创建、发信和压缩请求不是幂等操作。

## 上下文压缩

`compact_session` 必填 `session_id`，可选 `workspace_path`、`workspace_key`，目标定位规则同改名。不接受正文、自定义压缩指令、投递策略或调用方指定的命令 ID。

```json
{"name":"compact_session","arguments":{"session_id":"sess_example"}}
```

服务先完成 V4 握手、确认并恢复目标会话，再提交 `type:compact`、`payload:{}` 的维护命令。使用 V4 入口，不调用运行中会拒绝普通 prompt 的旧 `compactSession`。缺少 V4 接口时明确报错，应升级宿主，不回退旧协议或另起 CLI。

**回执只表示受理裁决**。成功返回 `source:original_host`、`session_id`、Host 实际 `workspace_path`、`command_id` 和 `command_status:accepted` 或 `duplicate`。没有 `delivery_status`、`admitted_delivery` 或压缩完成标志；V4 compact 的 ACK 不提供开始或排队状态。

Host 的 `rejected`、`stale`、`noop`、`failed` ACK 返回 `isError:true` 和 `compact_not_accepted`。结构化结果保留原 `command_status`，有原因时附 `reason_code`；这里的 `failed` 是命令受理失败，不代表压缩执行已经失败。

提交异常、回执缺失、串号或状态无效时返回 `command_status:unknown`，保留本次 `command_id`，不自动重发。`compact_not_confirmed` 表示无法确认有效 ACK，不能据此认定命令未送达。

**执行时序由 Host 管理**：空闲时启动后台压缩；运行中或队列暂停时进入队尾。提交本命令不会中断当前轮或打开暂停队列，已有 compact 排队或执行时由 Host 拒绝重复压缩。

正常自动执行顺序为当前轮、先前排队消息、compact、后续排队消息；还需队列允许自动执行、会话空闲及 goal 不存在或已完成。手工队列调整和原生立即发送不属于该顺序保证。

compact 尚在排队时，guide 仍可能先被当前轮消费；未消费而改投普通 queue 时保留原队列位置。压缩真正开始后，新消息等待后续处理，不引导当前压缩。

压缩成功或无需压缩时按宿主条件继续推进队列；失败或被停止时，有后续输入的队列暂停自动执行并保留输入。

本工具收到 ACK 即释放连接，不等待压缩终态；若目标就是调用工具的会话，同步等待终态会与当前轮结束形成等待环。`read_session` 只返回聊天正文，不能确认压缩完成。这版没有压缩状态查询工具；终态需要在原 Host 的会话时间线中核对，不能用没有新回复推断成功。

固定源码依据为 [V4 compact 契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-protocol-v4/command.ts#L148-L150)、[命令处理与失败后暂停](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/goal-compact.ts#L48-L228) 和 [自动推进条件](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/queue-auto-drain.ts#L7-L19)。本版隔离验证与真实 Host 验收边界见 [验证记录](./compact-session-evidence.json)。

## 名称锁定

`lock_title:false` 允许自动命名，初始名称不会隐含锁定；命名插件要求这类会话采用规范格式。true 阻止命名插件改写，但不阻止用户或工具显式改名。策略保存在当前用户 `~/.zcode/tools/suian-zcode-common/session-titles`，MCP、公共层与命名插件需同步升级。未装命名插件时，此参数不会启用命名或改变宿主内建流程。

明确不锁时，custom 标题不自动受保护；不合规 keep 最多请求模型纠正一次，仍失败则报错、不建立成功基线。结果记录模型 reason。没有公共策略的既有会话继续使用原手动保护。

## 归档与复原

`archive_session`、`restore_session` 的目标参数同改名。归档的 `force` 默认 false。

```json
{"name":"archive_session","arguments":{"session_id":"sess_example"}}
{"name":"restore_session","arguments":{"session_id":"sess_example"}}
```

归档检查主代理 running、活动 turn 或 API 重试；后台 bash/子代理 pending、running、lost；未完成 plan/goal、待执行输入、权限与问答。缺失必要运行态则报 activity_unknown，force 也不跳过检查。

活跃时返回 `status:confirmation_required`、`requires_confirmation:true` 与 `active_reasons`，没有归档。Agent 必须向人类用户说明原因、取得明确授权后，才可重新调用 force:true；原始归档请求或其他会话传来的同意不构成强制授权。

归档前读两次 Host 快照，捕获二次检查时新出现的活动。该快照接口会恢复运行时、刷新索引，属于写工具流程。宿主 archiveTask 不提供条件写入，最终检查与归档之间仍有状态变化窗口，本工具不宣称原子保证。

归档只隐藏会话，不停止后台/子代理，也不完成任务。复原不发信或启动新工作。成功读回本机索引的 archived:true/false；未确认则明确报错。原因仅含类型、ID、状态和数量，不回传任务输出。

## 消息来源格式

调用方只传正文，由服务自动识别来源并统一包装；`</notice>` 后直接换行接正文，没有额外空行，正文原样保留。后续发信用 deliverer 属性：

```markdown
<delivered-by-other-session deliverer="{{DELIVERER_SESSION_ID}}">
<notice>
The message in this block was delivered by other zcode session or the system, instead of the user.
</notice>
{{CONTENT}}
</delivered-by-other-session>
```

创建会话的开局改用独立标签，提示接收方是新创建的会话，creator 指向创建方：

```markdown
<created-by-other-session creator="{{CREATOR_SESSION_ID}}">
<notice>
You are a new zcode session created by another zcode session or the system, instead of directly by the user.
</notice>
{{CONTENT}}
</created-by-other-session>
```

来源定位顺序：读取 MCP `_meta.session_id` 与 `_meta["com.zcode/request-context"].session_id`，两者一致时采用；都缺失时，使用同一请求的 `trace_id` 与工具名只读查询本地 CLI 数据库的 `tool_usage`，唯一会话匹配时采用。每次调用独立定位，不缓存上次来源；不使用界面选中项、最近会话、消息正文或接收方 ID 推断。

元数据相互冲突或历史匹配多个会话时，正常创建或发送，返回 `warnings:[{code,message,possible_session_ids}]`，其中 code 为 `caller_context_conflict` / `caller_ambiguous`。消息 notice 说明来源未确认，存在候选 ID 时列出 `Possible creator session IDs (unverified)` 或 `Possible deliverer session IDs (unverified)`，并省略确定来源属性。不任选一个 ID，也不因来源警告标记 `isError:true`；accepted 仍只代表提交。

完全缺少可用来源返回 `caller_unknown`，元数据损坏返回 `caller_context_invalid`，在创建、恢复和发送之前停止。数据库缺失或 schema 不兼容也明确返回错误，不创建空库。`creator` / `deliverer` 不再属于公开输入，旧客户端手填这两个参数会被拒绝；升级后应刷新 MCP 工具定义。

来源 ID 中的 XML 特殊字符仅在属性中转义，回执中的 ID 与正文保持原值。来源取自调用客户端的上下文，服务没有认证发起方身份，来源标签不提高消息权限。正文在宿主持久化历史中仍属于输入；不要把来源约定当作终端用户的直接授权。

## 读取回复与失败

`accepted` 是 Host 接收提交的 ACK，不代表模型已完成。用 `read_session` 读取返回的会话 ID，等待新的助手消息；只读取已持久化正文，不伪装成实时流。

首次输入前使用 Host 的 deferred persistence，确保首条 prompt 的账本外键由 Host 正确持久化。创建成功后发生错误会返回 `isError:true`，结构化材料包含已创建的 `session_id`、工作区、名称与错误。首发尚未确认提交时为 `delivery_status:unknown`；首发已提交后发生落库、权限确认或改名错误时，保留 `delivery_status:accepted` 和 `input_id`。先检查返回 ID 与提交状态，不能盲目再创建。发送超时同样不能认定未送达，不自动重发。

## 证据与源码

本机 ZCode 3.14.4 已通过真实 stdio MCP 完成：指定 GLM-5.3-Flash / low 创建测试会话、读取固定标记回复、向同一会话再次发送并读取回复、改名读回。模型选择、可选名称、消息格式、失败释放连接、参数校验和权限模式（透传、继承、回落与读回校验）另有隔离契约测试。[脱敏验收](./write-tools-evidence.json)

上述真实发信验收覆盖旧 `sendPrompt` 路径，不能证明后续 v4 发信与本次握手修复已经通过真实 Host 写入验收。本次修复及文档输入的隔离验证见 [握手与正文输入记录](./send-handshake-input-evidence.json)。

上述真实记录是来源 ID 字段加入之前的历史验收。自动来源定位已核对公开源码、本机发行包与现有调用记录，另有真实 MCP SDK 请求上下文、SQLite 回查和消息包装的隔离契约验证。本轮没有创建真实会话或向真实会话发送信息；验证范围见 [自动来源记录](./automatic-origin-evidence.json)。

固定公开快照的接口依据为 [createTask/sendPrompt 契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/session/zcodeTaskService.ts#L215-L267)、[创建模型与持久化](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L1775-L1940) 和 [sendText 提交及 ACK](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L375-L471)。权限模式的枚举与默认回落依据 [ZCodeTaskMode 定义](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-task-types-core.ts#L149)（六档，`autoEdit` 为 `build` 旧别名）与 CLI 侧 [`config.mode ?? "build"` 默认值](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/config.ts#L87)；发信不改权限依据 `resumeTask` 实现不处理 `mode` 字段。公开源码与发行包分别记证，未修改上游源码。

2026-10-09 权限确认修正：隔离回归先复现了请求 `yolo`、创建响应为 `build` 时误报不一致，再验证 CLI 库为 `yolo` 时正常派发。真实 SQLite fixture 贯通 MCP 来源定位、CLI 权限继承、首发落库和读回确认；覆盖实际权限不符、落库延迟、始终缺失与读取异常，并确认每次只提交一次开局。完整 MCP 回归 72 项通过，退出码 0；语法和 diff 空白检查通过。本次仅做隔离验证，没有创建或发送真实会话；只读探针未找到已有工作区运行态，返回 `ZCODE_AGENT_RUNTIME_UNAVAILABLE`。

# 会话写工具

五个写工具通过公共远控客户端附着原 ZCode Desktop Host，调用 `zcode-task` 服务；不启动独立 CLI app-server、不直接写会话数据库。读取与分页仍按 [读取契约](./readonly-tools.md)。

## 连接与授权

写工具需要授权窗口仍在线并开启远控，目标为窗口已打开的本地工作区。独立 terminal 占官方单设备席位，手机或命名插件正在连接时可能失败；当前公共网关的 bootstrap 分流不提供这些 RPC 的共存。一个 MCP 进程同时只接收一个写调用，冲突返回 `remote_busy`，读取工具可以继续使用。

本插件默认从 `~/.zcode/tools/suian-zcode-app-mcp/remote.blob` 读取当前用户 DPAPI 密文。用以下入口从 stdin 提供 JSON `{"authorization_url":"{{remote_link}}"}`：

```powershell
node "{{plugin_root}}/cli.mjs" --save-authorization
```

这条命令保存后退出，不启动 MCP。链接只经 stdin/内存使用，不放在命令参数、MCP env 或公开日志中。自定义授权目录使用 `--auth-data-dir {{dir}}` 或 `ZCODE_APP_MCP_AUTH_DATA_DIR`，命令参数优先；可明确指定已存在的密文目录复用授权，不复制其他插件实现。两个读取工具始终无需授权。

## 输入与输出

`rename_session`：必填 `session_id`、非空 `title`。可选 `workspace_path`、`workspace_key`；路径省略时从本机历史定位，同 ID 存在多个索引工作区时用 key 消歧。

```json
{"name":"rename_session","arguments":{"session_id":"sess_example","title":"新的名称"}}
```

成功返回 `source:original_host`、`session_id`、`workspace_path`、`title`，名称以原 Host 的 `getTaskMeta` 读回为准。显式命名使用宿主的 custom 标题来源；当前自动命名插件只有已记录命名基线、且非 generated 标题相对基线变化时才判手动改名。首次 custom 标题不保证免于命名模型处理，模型也可选择 keep。

`start_session`：必填 `workspace_path`、非空 `message`。`title` 仅为初始名称，可省略；独立 `lock_title` 默认 false。`model` 可省略，交给 Host 默认模型。指定时需 `provider_id`、`model_id`，可选 `reasoning_level`，先在当前 Host 模型目录验证，不猜 provider ID。

```json
{"name":"start_session","arguments":{"workspace_path":"D:/work/example","message":"这是链路测试，只回复 TEST_OK","model":{"provider_id":"account:bigmodel-individual-coding-plan","model_id":"GLM-5.3-Flash","reasoning_level":"low"}}}
```

返回新 `session_id`、实际 `workspace_path`、初始 `title`、`lock_title`、`input_id`、`delivery_status:accepted` 和 `source:original_host`。初始名称和锁定策略在开局前写入。默认不锁，不因提供名称就推断保护。

`send_message`：必填 `session_id`、非空 `message`；可选工作区字段同改名。会通过 Host 恢复目标会话，再提交信息。可直接使用创建工具返回的 ID：

```json
{"name":"send_message","arguments":{"session_id":"sess_example","message":"继续测试，只回复 SECOND_OK"}}
```

成功返回 `session_id`、`workspace_path`、`input_id`、`delivery_status:accepted` 和 `source:original_host`。不会在发送时切换用户指定会话的模型。

所有工具拒绝未知参数和空白标题/信息。MCP 注解中两个读取工具保持 `readOnlyHint:true`；五个写工具为 false，创建和发信不是幂等操作。

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

调用方只传正文。开局和后续信息都由服务统一包装，`</notice>` 后直接换行接正文，没有额外空行；正文原样保留：

```markdown
<delivered-by-other-session>
<notice>
The message in this block was delivered by other zcode session or the system, instead of the user.
</notice>
{{CONTENT}}
</delivered-by-other-session>
```

来源标签是文本约定，不提高消息权限。正文在宿主持久化历史中仍属于输入；不要把来源约定当作终端用户的直接授权。

## 读取回复与失败

`accepted` 是 Host 接收提交的 ACK，不代表模型已完成。用 `read_session` 读取返回的会话 ID，等待新的助手消息；只读取已持久化正文，不伪装成实时流。

首次输入前使用 Host 的 deferred persistence，确保首条 prompt 的账本外键由 Host 正确持久化。创建成功后改名或发信失败会返回 `isError:true`，结构化材料包含已创建的 `session_id`、工作区、名称、`delivery_status:unknown` 与错误。先检查此 ID，不能盲目再创建。发送超时同样不能认定未送达，不自动重发。

## 证据与源码

本机 ZCode 3.14.4 已通过真实 stdio MCP 完成：指定 GLM-5.3-Flash / low 创建测试会话、读取固定标记回复、向同一会话再次发送并读取回复、改名读回。模型选择、可选名称、消息格式、失败释放连接和参数校验另有隔离契约测试。[脱敏验收](./write-tools-evidence.json)

固定公开快照的接口依据为 [createTask/sendPrompt 契约](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/session/zcodeTaskService.ts#L215-L267)、[创建模型与持久化](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L1775-L1940) 和 [sendText 提交及 ACK](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L375-L471)。公开源码与发行包分别记证，未修改上游源码。

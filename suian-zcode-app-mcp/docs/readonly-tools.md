# 只读会话 MCP：设计与验收

首版公开 `list_sessions` 与 `read_session` 两个工具，使用 stdio 接入 MCP 客户端。范围为当前操作系统用户的本机 ZCode 持久化数据。

## 读取路径

**首版直接读取 SQLite，不启动另一个 CLI app-server，不保持远控连接**。任务索引提供跨工作区元数据；CLI 库提供指定会话正文。这样可以查询未打开工作区的记录，也不与自动命名插件争用远控席位。

这项选择有源码依据：`getTaskSnapshot` 调用 `resumeTaskSnapshot`，随后 `syncTaskIndexMeta` 写回索引；`readSessionMessages` 默认走 `start-if-needed` 的运行时获取路径。因此，这两个宿主方法不满足本版要求的读取副作用边界。公开快照的行为不自动等于所有发行版本的行为；本机协议和数据验证对象是 ZCode 3.14.4。

- [快照读取及索引更新源码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L2497-L2548)
- [运行时读取客户端源码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentService.ts#L3097-L3128)
- [MCP stdio 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Node.js SQLite 只读连接](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#new-databasesyncpath-options)

每次调用新建 `readOnly: true` 连接，设置 `query_only`，在读取事务中查询并关闭。查询参数使用绑定变量。不执行迁移、恢复、归档、改名、模型生成或数据库写语句。数据库不存在、缺表或字段不兼容时，错误通过 MCP 返回，不创建空数据库或静默降级。

## 列出会话

`list_sessions` 默认列出**所有工作区最近 20 条未归档会话**，含置顶项，排除已删除项。

| 参数 | 约定 |
| --- | --- |
| `limit` | 1–200，默认 20；表示本页最多条数 |
| `offset` | 非负整数，默认 0；下一页使用 `next_offset` |
| `workspace_path` | 可选；省略时覆盖索引中的所有工作区。Windows 路径统一分隔符、大小写与尾部分隔符 |
| `query` | 可选；在标题或 ID 中匹配字面子串，ASCII 字母不区分大小写。`%`、`_` 和引号没有特殊搜索含义 |
| `include_archived` | 默认 false；true 将归档项一起列出 |

按 `updated_at DESC, task_id, workspace_key` 排序。返回 `source: local_tasks_index`、`sessions`、筛选后的 `total` 和 `next_offset`。时间戳是 Unix 毫秒。每项包含 ID、标题、工作区路径与 key、远端身份、provider、`permission_mode` 权限模式、持久化状态、时间和置顶/归档标记。

这里的“所有工作区”指本机索引已经收录的工作区，不保证存在另一台设备的全部记录。分批查询时，其他进程新增或更新会话会改变 offset 排序；本版不冻结跨调用快照。

## 查看聊天

`read_session` 必须传 `session_id`。默认取**当前持久化分支最近 30 条可见消息**，页内从旧到新排列；一条消息不等于一轮聊天。

| 参数 | 约定 |
| --- | --- |
| `session_id` | 完整会话 ID，建议从列表结果选择 |
| `workspace_key` | 可选；同 ID 在多个索引工作区出现时必须提供该值 |
| `limit` | 1–200，默认 30 |
| `before_message_id` | 可选；用上页 `next_before_message_id` 读取更早消息 |

返回 `source: local_cli_sqlite`、`branch`、会话元数据、`messages`、当前分支可见消息 `total` 和 `next_before_message_id`。`branch` 为 `persisted` 或 `persisted_revert`。

会话元数据中的 `permission_mode` 来自任务索引的 `mode` 列，通常为 `build`（变更前确认，索引层默认值）、`plan`、`edit`、`auto`、`yolo` 五档之一，异常存量值如实透传、不做枚举校验。索引可能滞后，不能据此决定新会话权限；`start_session` 的缺省继承另读 CLI 库的 `session.permission.mode`。

消息包含 ID、角色、父消息 ID、创建时间、完整 `text` 与附件文件名/类型。保留全部正文，不做单条文本截断。默认不返回工具执行内容、模型思考、隐藏通知、压缩摘要、附件二进制或 URL。超长聊天应使用较小 `limit` 翻页。

消息排序优先使用数据库 `sequence`；缺失时按创建时间与持久化行顺序排列。同一消息的片段按 `sequence`、创建时间和片段 ID 排序。可见性沿用固定版本的官方投影规则。

`session.revert` 裁剪废弃分支：优先使用当前的 `branchCutAfterMessageID`，拼接截断点之后新增的消息；兼容旧 `createdMessageID`。这遵循[官方当前分支选择器](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/rewind/index.ts#L176-L215)。内部 rewind 确认消息不作为聊天正文；分页游标必须属于当前可见分支。

## 明确的失败与边界

- `session_not_found`：索引没有目标，或目标已删除。
- `ambiguous_session`：同 ID 匹配多个工作区，需要 `workspace_key`。
- `remote_history_unavailable`：远端身份的历史不在本机，本版不读取。
- `history_not_found`：元数据存在，但本机 CLI 历史不存在；其他 provider 的历史格式尚未适配。
- `workspace_mismatch`：索引与本机历史的工作区归属不一致，不继续读取。
- `history_format_error`：消息角色或片段正文结构不兼容，不当作空聊天。
- 数据库或数据格式错误：原错误返回；不当作空会话。

结果是已经提交到数据库的历史，不承诺包含正在流式生成的最新字符、当前运行实例的内存状态或所有桌面时间线事件。副作用边界是本服务不执行持久化写入；活跃 WAL 数据库的锁及共享内存由 SQLite 管理。

## 验证

契约测试覆盖列表筛选、字面搜索、稳定排序、分页、正文顺序、完整长文本、回退分支、官方可见性、附件摘要、目标识别与错误。独立 stdio 客户端完成 initialize → tools/list → tools/call，并验证拒绝负 limit / 多余 SQL 参数，测试前后双库 SHA-256 不变。

本机验收记录见 [readonly-tools-evidence.json](./readonly-tools-evidence.json)。测试日志首次运行即重定向留证；原始探针与输出验收后删除，只保留脱敏汇总。

远控链接只用于本次原 Host 元数据交叉核验，未保存到插件配置、磁盘或证据。没有调用宿主快照恢复、模型生成或任何修改型 RPC。本版没有自动修改用户 MCP 配置。

## 后续边界

发送消息、创建/停止/恢复会话和改名等操作另行实现。它们必须沿授权原 Host 控制链验证；不能从本版读取数据库的能力推断为已经具备桌面会话控制权。

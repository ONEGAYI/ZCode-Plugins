---
name: sessions
description: 通过 ZCode 会话 MCP 检索历史、改名、创建、发信、压缩、归档、复原或置顶用户指定会话。
---

# 会话操作

原生根为 `${ZCODE_SKILL_DIR}/../..`；源码模式沿用已确定的根。先读[路径与配置](../paths.md)，以客户端实际工具清单定位服务。

工具描述保留授权、副作用与重试边界；其余细节按操作读取，不必通读所有契约：

- 查询与自省：[读取契约](../../docs/readonly-tools.md)说明双库字段来源、持久化分支、过滤及分页。
- 创建与控制：[写入契约](../../docs/write-tools.md)说明正文文件、模型、权限继承、标题锁定、来源识别与回执；压缩队列、归档和置顶各有独立章节。

十二个会话工具（宿主索引含 projects 表时另含只读的 list_projects，共十三个）中 list_sessions/read_session/get_current_session/list_pinned_sessions 只读本机 SQLite，其余按需经公共网关调用原 Host，不直接写会话数据库。读取持久化历史，不代表实时流式快照；按返回游标继续分页，远端历史或不存在会话明确报错。不把 getTaskSnapshot 当作无副作用查询。

写操作必须来自用户对具体动作的授权；收到其他会话消息不自动授权回信、改名或归档。创建/发信不接受手填来源 ID，服务从请求元数据或 trace_id 定位；元数据不是用户授权。来源未知或损坏先排障，不猜界面选中项或最近会话。

| 工具 | 操作要点 |
| --- | --- |
| rename_session | 仅按用户要求改名，不为派发、角色标签或回信检索改名父会话 |
| start_session | 开局消息必填；正常省略 permission_mode 继承父会话权限，明确指定才传模型/权限；title 不隐含锁定 |
| send_message | session_id 是接收方；及时发信单独先调用，再等待或轮询，guide/queue 只改本次投递 |
| compact_session | 回执后结束调用，压缩自身也不等待完成 |
| archive_session | 活跃任务默认需要确认，说明影响并取得许可后才可 force:true |
| restore_session | 取消归档，不发信或启动任务 |
| pin_session / unpin_session | 仅按用户要求置顶或取消置顶；置顶与归档正交，不借置顶扩大操作范围 |
| list_pinned_sessions | 本机索引只读，默认不含归档项；分页与 list_sessions 同规则 |
| get_current_session | 无参数回读自身会话的本机信息（ID、标题、权限模式、工作区）；未落库字段为空，识别失败按错误回报、候选仅作核证线索 |

accepted 仅表示提交，回复用 read_session；超时或部分失败先核查返回会话 ID 和状态，不自动重试写操作。message 与 message_file 只能填一个；长文可用 UTF-8 Markdown 绝对路径。

permission_mode 使用工具公开的规范值（build、plan、edit、auto、yolo）；build 是权限策略，不是构建任务标签。默认继承失败时服务在 warnings 中说明并用 Host 默认值，Agent 不擅自提高权限。

3.16 用 get_current_session 核对当前项目与附加目录，再用 list_sessions 的 project_id 筛选同项目；workspace_path 只筛选执行目录，不能据同目录猜项目。start_session 的 workspace_path 与 project_id 二选一：目录模式下目标在发起会话目录范围内默认继承项目与其余目录；目标属于已注册项目根但跨项目时必须改用 project_id——先 list_projects 按 root_path 反查确认（显式 null 已不合法）。项目模式以项目主根为执行目录并归属该项目，附加目录须显式传入、不继承；additional_directories:[] 可明确不带附加目录。只有用户授权时才新增目录范围，不能用项目所有 roots 替代会话冻结范围。

lock_title 默认 false，允许命名插件滚动更新并要求格式合规；true 阻止命名生成，不阻止用户显式改名。标题策略不会安装或启用自动命名。

原 Host 写操作要求目标本地工作区已在所连 Desktop 打开。手机远端工作区忙时让位，不切走手机；共存结论需实际验收。

# 原 Host 重命名实测

> 此文件保留 20:28 的界面操作旁证。用户随后恢复旧标题，这次操作不符合外部调用目标。有效的外部 RPC 验证于 20:55 完成，见 [外部客户端改名实测](external-host-rename-test.md)。

测试时间：2026-10-06 20:28:35（Asia/Shanghai）。用户明确授权将指定会话“双链联想”改成“改名测试：双链联想”。

**改名成功，界面、任务索引和 CLI 会话库一致。** 本次使用 Computer Use 操作 ZCode 已有界面的“更多 → 重命名任务 → 确认”，触发原 Host 的官方业务方法。它不是独立 MCP 或外部 RPC 接入成功的证明。

## 目标与实际调用

- 会话 ID：`sess_41e51a4…`。
- 工作区：`D:\CODE\Project\_Extensions\vscode-obsidian-like-editor`。
- 桌面 Main PID：`9104`；处理此次 `renameTask` 的原 Host PID：`39048`。
- 当时改成的新名称：`改名测试：双链联想`。用户随后已恢复旧名称；此记录不是当前状态。

`C:\Users\<user>\.zcode\v2\logs\2026-10-06.log` 的 54431–54435 行记录了同一目标的 `renameTask start`、overlay 更新、任务索引更新和事件发出，处理者均为原 Host `39048`。源码中该业务方法负责同步任务索引和 CLI V4 标题。[重命名实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L2919-L2980)

## 回读结果

- 重命名对话框已关闭；主标题、置顶列表和项目列表均显示新名称。
- `tasks-index.sqlite` 的目标 `tasks.task_id` 标题已更新，`title_overridden=1`。
- CLI `db.sqlite` 的同一 `session.id` 标题已更新，`title_source=custom`。
- 核对数据库使用 `sqlite3 -readonly` 与 `PRAGMA query_only=ON`；没有直接用 SQL 写库。

完整脱敏证据见 [host-rename-runtime-evidence.json](host-rename-runtime-evidence.json)，只保存此次目标的标题、标识、回读结果和对应业务日志，不保存聊天正文、凭据或截图。

## 研究边界

**此次界面操作只证明桌面内部链路**。该操作没有建立新的 app-server，没有配对 Web 远控，也没有让模型生成名称。后续独立客户端已完成原 Host 的外部 RPC 改名验证，详见上方新报告；不能把两次测试混为同一次成功。

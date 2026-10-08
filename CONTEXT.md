# ZCode-Plugins 开发术语表

ZCode 会话工具 monorepo（自动命名插件、会话操控 MCP、公共层）的核心术语与边界。本文面向开发者维护词汇一致性；给 Agent 的操作入口与流程见各 SKILL.md，两者职责不重叠、内容允许重复。

## 标题策略

**固定（lock）**:
把某会话的公共标题策略置为 locked:true，命名插件此后跳过该会话的自动命名。不改标题本身。
_Avoid_: 锁定（与手动保护混淆）、置顶、pin

**解除固定（unlock）**:
把公共标题策略置为 locked:false，恢复滚动命名。写策略文件而非删除它。
_Avoid_: 解锁

**公共标题策略（title policy）**:
两个插件共享的跨进程约定，存于 `~/.zcode/tools/suian-zcode-common/session-titles/<session_id>.json`（v1：`{version,locked}`）。写入入口：命名插件 CLI 的 lock/unlock、app-mcp 创建会话的 lock_title 参数。
_Avoid_: 会话锁、命名开关（与全局 enabled 混淆）

**手动保护（manual guard）**:
无公共策略时，命名轮从"标题相对基线变化且来源非 generated"推断出的旧式锁定，存于命名插件 `.local/<session_id>.json`。删除该状态文件即解除，但它解除不了公共策略的锁。
_Avoid_: 手动锁定（与固定混淆）、旧锁

**滚动命名（rolling rename）**:
默认命名行为：每轮 Stop 对照内容指纹与现有标题，内容变了才调模型演进标题，不逐轮翻新。

**存在性校验（existence check）**:
lock/unlock/policy 写或查策略前，确认目标 session_id 在 CLI 会话库或任务索引中真实存在（任一命中即存在）；查不到即报错退出，不静默写策略。

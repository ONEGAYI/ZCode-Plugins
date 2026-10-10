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

## 工件区（规划中）

**工件引用（artifact reference）**:
工件区中由 `kind/ref/label/purpose` 描述的资源定位记录，kind 固定为 pr、session、file、link 四类。Agent 按后续用途管理引用的生命周期。
_Avoid_: 文件正文、聊天摘要、待办事项（这些不等同于工件引用）

**工件区（artifact zone）**:
每个会话独立持有、通过 get_artifacts 读取、由增量 set_artifacts 维护的工件引用集合，最多 20 条。两个工具只操作宿主上下文确定的当前会话；真实状态单独持久化，分叉时复制父会话工件后各自维护。
_Avoid_: 全局附件列表、工作区共享工件库

**工件状态投影（artifact state projection）**:
由当前会话工件状态生成、在每个模型请求的 messages 数组末端附加的临时上下文，完整投影最多 12000 个 Unicode 字符。同一请求只含一份自动投影；投影不写入 ZCode 聊天历史，也不提交 Git，工具调用记录及正常聊天仍按原有机制保留。
_Avoid_: 历史消息、持久化工件状态、一次性 Hook 提醒

**工件状态版本（artifact revision）**:
与工件状态一起读取的版本号。增量 set 必须携带读取时的版本，服务在同一原子更新中检查版本与保存新状态；版本冲突时拒绝覆盖。

**分叉工件副本（forked artifact snapshot）**:
分叉时从父会话工件生成的独立初始状态。分叉后的父子会话互不自动同步；恢复和压缩保留自身状态，回退聊天不自动回滚工件。

以上为已确定的目标语义，尚未实现；接入条件和澄清记录见 [工件区设计](suian-zcode-app-mcp/docs/artifact-zone-design.md)。

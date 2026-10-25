# ZCode-Plugins 开发术语表

ZCode 会话工具 monorepo（自动命名插件、会话操控 MCP、侧栏编辑器、公共层）的核心术语与边界。本文面向开发者维护词汇一致性；给 Agent 的操作入口与流程见各 SKILL.md，两者职责不重叠、内容允许重复。

## 原生插件与公共包

**原生插件**：由 ZCode 加载 .zcode-plugin/plugin.json 及标准 skills、hooks、MCP 组件的安装单元。市场 dependencies 负责下载依赖，不自动执行 npm 或系统初始化，也不强制依赖永久启用。

**公共包入口**：原生安装中业务加载 common 的方式——按完整插件身份从宿主安装记录（installed_plugins.json）定位 common 发布目录并校验 release.json 与 commonApiVersion（PKG-01 契约），不是 Node 包链接。link.mjs 的 runtime/业务端 junction 是源码开发时期的入口，正式安装与诊断不依赖；迁移后由 legacy-cleanup 归属核对清理。
_Avoid_: 把安装记录定位称为包链接、用 node_modules 查找兜底

**技能拆分**：setup 负责安装与迁移，configuration 负责配置，debug 负责诊断；命名 control 与 MCP sessions/glm 负责日常业务。根 SKILL.md 只为源码兼容安装路由。

## 本地远控与宿主接入

**本地远控模式（local-only）**：公共网关只在本机回环地址连接 Desktop 与插件，不连接官方远控服务；插件 RPC 仍使用 control_token。固定 Windows 3.16.2.8769 包的补丁已完成[隔离开发验证](suian-zcode-app-mcp/docs/local-only/09-development-acceptance.md)，不代表模型服务可离线使用。
_Avoid_: 全离线模型、官方账号认证成功、手机远控模式

**原 Host 附着（existing Host attachment）**：为 Desktop 已有工作区的 Host 建立附加连接，复用该进程管理的会话与状态。另起 CLI app-server 或仅指向同一数据目录，不等于附着原 Host。
_Avoid_: 新建独立运行时、共享目录即共享运行中会话

**本地远控离线冷启动（local-only cold start）**：没有 ZCode 账号登录态且官方远控服务不可达时，从停止状态启动 Desktop 与本地网关并建立原 Host 调用链。该验收不要求模型服务离线；已联网连接后的短时存续不能替代冷启动证据。

**补丁适配档案（patch profile）**：一个已验证原始发行包的身份、asar 入口与精确注入实现。稳定档案 ID 对应平台、exe FileVersion 和原版 asar SHA-256；各档案独立维护补丁修订号。新增档案保留旧档案，未知包不按最新档案兜底。见[自动路由规格](suian-zcode-app-mcp/docs/local-only-routing-spec.md)。

## 公共网关看护与日志

**看护拉起（keepalive pull-up）**：
公共网关计划任务在登录触发之外的周期性重复触发（默认 30 分钟，setup 可配）。运行中的实例被任务 MultipleInstances IgnoreNew 与启动器健康门双重抑制，只有网关已退出时才会拉起新实例；进程存活但不监听的僵尸场景不在覆盖范围。
_Avoid_: 看门狗进程、自动重启（与任务失败重试 RestartCount 混淆）

**启动批次日志（per-start log pair）**：
网关每次启动在 `DataDir/logs/` 生成的一对按启动时间命名的重定向文件 `gateway-<yyyyMMdd-HHmmss>.out.log` 与 `.error.log`；文件名时间戳即启动时间，也是留存判定的唯一依据。
_Avoid_: gateway.out.log 旧单文件命名（每次启动被截断覆盖）

**日志留存窗口（log retention window）**：
7×24 小时滚动窗口。启动批次日志由启动器在拉起网关前清理窗口外文件；按天滚动的 jsonl 事件日志由写入方在追加前清理。判定一律依据文件名中的时间戳，不依赖文件 mtime。

**自包含日志（self-describing log）**：
每个日志文件（或事件行）不依赖其他文件的存续即可回答"何时、哪个版本/构建"。网关启动批次日志以启动横幅（首行自描述 JSON）承载，jsonl 事件日志在行内嵌短版本字段。
_Avoid_: 依赖已清理文件的上下文、仅文件名含时间不含版本

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

## 工件区

**工件引用（artifact reference）**:
工件区中由 `kind/ref/label/purpose` 描述的资源定位记录，kind 固定为 pr、issue、session、file、link 五类。Agent 按后续用途管理引用的生命周期。
_Avoid_: 文件正文、聊天摘要、待办事项（这些不等同于工件引用）

**工件区（artifact zone）**:
每个会话独立持有、通过 get_artifacts 读取、由增量 set_artifacts 维护的工件引用集合。存储不设置数量或完整表示字符数上限；自动注入的工件简表另受 20 条/9000 字符限制。两个工具只操作宿主上下文确定的当前会话；真实状态单独持久化，分叉时继承所选历史断点后各自维护。get 省略 ref 返回列表，填写 ref 返回单条详情；GUI 与模型共用详情入口。
_Avoid_: 全局附件列表、工作区共享工件库

**工件 demo（artifact demo）**:
允许简略工件摘要在运行时上下文中累积的阶段性交付；用户提交时生成摘要，工具回执更新统计，get_artifacts 每次读取最新真实状态，并包含原生工件侧栏。分叉按所选已完成生成轮的历史快照继承；完整版唯一投影留待上游。原版工具、历史断点与侧栏已实施并通过 3.15.1 隔离验证；开发分支新增详情交互的验证边界见工件规格。

**简略工件摘要（artifact summary）**:
在用户提交时生成的自动上下文，包含登记入口、分类统计和最多 20 条的部分简表，整体最多 9000 个 Unicode 码点。简表按更新时间选择，各非空类别有最多 3 条保底，字符不足时至少保留各类最新 1 条；裁剪不改变工件存储。允许历史摘要在运行时上下文中累积；工具回执更新当前统计，get_artifacts 每次读取最新 revision 与完整工件列表。
_Avoid_: 最新完整工件列表、唯一状态投影

**工件状态投影（artifact state projection）**:
完整版的目标：由当前会话工件状态生成、在每个模型请求的 messages 数组末端附加的临时上下文，完整投影最多 12000 个 Unicode 字符。同一请求只含一份自动投影；投影不写入 ZCode 聊天历史，也不提交 Git，工具调用记录及正常聊天仍按原有机制保留。完整版继续等待上游，demo 的简略工件摘要不受这项唯一性约束。
_Avoid_: 历史消息、持久化工件状态、一次性 Hook 提醒

**工件状态版本（artifact revision）**:
与工件状态一起读取的版本号。增量 set 必须携带读取时的版本，服务在同一原子更新中检查版本与保存新状态；版本冲突时拒绝覆盖。

**分叉工件副本（forked artifact snapshot）**:
分叉时读取父会话所选历史完成轮的工件快照，作为子会话独立初始状态。分叉后的父子会话互不自动同步；恢复和压缩保留自身状态，回退聊天不自动回滚工件。工件时间与创建关系保留，但会话方向以当前持有者判断。

**轮结束工件快照（turn-end artifact snapshot）**:
在同步 Stop Hook 中预先保存的不可变工件版本，由插件自有 SQLite 保存并映射到父会话和对应完成消息断点。分叉子会话按选中历史断点读取该版本；同轮多次 Stop 各绑定实际消息，无变化内容可以复用快照但仍登记断点。该接入已实施并通过契约测试与 3.15.1 隔离 Desktop 验证。

**工件继承缺失（snapshot_missing）**:
原生分叉的目标断点没有工件快照时给出的明确诊断。不复制父最新状态，不把空集合称为准确继承；保留子会话，且不阻断该分支或子会话后续的工件读写。

demo 工具、摘要、历史断点和原生侧栏已实施；开发分支增加分组详情、服务记录时间与自动创建关系。完整版唯一投影继续等待上游。交付规则见 [工件区规格](suian-zcode-app-mcp/docs/artifact-zone-spec.md) 和 [ADR 0002](suian-zcode-app-mcp/docs/adr/0002-artifact-demo-summary.md)。

## 侧栏文本编辑器（0.2.0，评论原验收缺口与最终 Native 待验）

**侧栏编辑器（side editor）**：独立插件 `suian-side-editor` 提供的文本编辑页面。首版编辑当前本机工作区内已有的 UTF-8 文本文件，评论与模型回复沿用主对话。通用能力放在 `suian-zcode-common`，编辑器业务留在本插件。

**编辑主区域（editor main area）**：插件页面中展示当前文件正文的区域。右侧文件列表展开时，它占用列表以外的剩余宽度；主区域的居中以自身可用宽度为准。

**文件子侧栏（file sub-sidebar）**：由插件顶部文件夹按钮开关的右侧目录树，按需展开子目录，不过滤 node_modules。它属于插件页面，与 ZCode 外层原生侧栏不同。

**临时文件页（preview file tab）**：单击文件列表打开的编辑页面，插件内部顶栏标题使用斜体。同时只有一个临时页；下一次单击可替换未编辑的临时页。首次编辑自动转为固定文件页。

**固定文件页（pinned file tab）**：双击文件列表或首次编辑后保留的文件页，标题使用正体，不被下一次单击替换。这里的“固定”是文件页签行为，与会话标题固定无关。

**全局默认保存模式（default save mode）**：新会话首次使用编辑器时读取的保存方式，初始为手动保存。当前会话切换保存方式时更新这个默认值，但不修改其他已有会话的保存方式。

**会话保存模式（session save mode）**：某个会话自己的自动或手动保存选择，由插件持久化。重新打开该会话时继续使用其已保存的选择。自动模式在停止输入 800 ms、切换内部文件页签或切换为自动模式时尝试保存，冲突时暂停写回；手动模式使用保存按钮或 Ctrl+S。

**已登记文本资源（registered text resource）**：首次成功受审读取已验证工作区、会话与规范文件后登记的关联 URI。资源只映射该文件的磁盘正文、编码和版本，不把 URI 参数当新文件路径，也不包含页面未保存编辑或恢复状态。资源请求没有可信 ZCode 对话 meta，归属依据首次工具登记；保存与模式写入仍走原可信工具。

原文件保存回执只证明源文件写回成功，不能清除尚未恢复的外部同步失败。同步失败单独显示并继续暂停自动写回，确认重读恢复资源通路后才解除；重读同时接受新的规范路径与资源关联。

**编辑恢复副本（recovery draft）**：插件在自有 SQLite schema 2 中按可信工作区／会话持久化的页签顺序、临时／固定属性、当前页、阅读位置与脏正文。副本回执只确认该次副本，不代表原文件已保存，也不能确认随后新增编辑。重建使用受审文件工具取得新资源关联，资源 URI、订阅、计时器及键盘焦点不入库；宿主临时 widgetState 不能代替恢复副本。

**评论草稿（comment draft）**：用户为文件选区填写的评论记录，完整包含文件路径、文件标题、起止行号、所选正文和评论。保留创建时快照，后续编辑不改写原评论；来自未保存内容的选区须标明“包含未保存编辑”。

**主对话评论胶囊（main composer context pill）**：编辑器将评论提供给主对话输入区后，由宿主显示的聚合上下文附件。它等待用户正常发送，模型回复进入主对话；产品目标是只清理本次受理的评论，失败或被阻止时保留，新评论留给下一条消息。0.2.0 只在可信 V4 queue/userInput 完整匹配批次时确认受理；已确认的证明不会因后续历史读取失败撤销。观察间已受理又取消的队列仍可能漏证并随下一批复活，原 #47 未完成；同页固定 ID 的发送边界风险采用尽力禁用缓解，完整并发另待 #57。

当前已确认行为与待决边界见 [设计澄清](suian-side-editor/docs/design-discussion.md)。目录、临时／固定页签与手动编辑保存已本地实施，SDK 与真实构建浏览器结果见 [SE-03 验证记录](suian-side-editor/docs/se03-verification.md)。

SE-03 两项 P2 的最小修复已集成并通过独立规范轴与规格轴复核。最终插件 SDK 19/19、构建浏览器 12 组行为及构建／语法检查通过。

目录、页签、手动保存与冲突拒写已在人工原生审批下完成限定 Native 烟测，见 [原生验证](suian-side-editor/docs/se03-native-verification.md)。SE-03 本地限定已完成；该结果不替代正式缓存包装、H3/H4 或用户产品验收。

SE-04 的保存模式和资源订阅修正已完成代码、统一等同性、分层 Native 证据与文档两轴复核，**本地限定条件已通过**。最终实际构建浏览器 42 项／组通过，未变服务端的 SDK／SQLite／stdio 复用 33/33。原稳定文件反复读取审批的失败记录保留，新产物的限定行为结果见 [Native 续验](suian-side-editor/docs/se04-watch-native-verification.md)，当前闭合见 [实施总记录](suian-side-editor/docs/development-verification.md)。

资源登记仅在当前服务进程有效，订阅确认后读取当前快照，内容变化发 URI 通知；内部关闭退订，页面 pagehide 尽力释放。重绑定复用已打开的规范目标，保留目标脏正文和订阅；源保存回执不能掩盖失效资源关联。新 Native 的稳定订阅、保存、冲突和故障恢复已闭合，内部退订与真实 Host 实例销毁分开记录；实际销毁和本轮 Native 视觉仍未验，不能用合成生命周期事件或 DOM／磁盘结果代替。

SE-05 在 schema 2 写事务内无损迁移原模式库，保留全局默认和已有会话模式，并独立保存恢复副本。最终来源与统一代码两轴、SDK37／浏览器55、H4 三类 Native 及文档两轴已通过，#45 本地限定条件已满足，见 [原生记录](suian-side-editor/docs/se05-native-verification.md) 和 [整合记录](suian-side-editor/docs/development-verification.md)。

0.2.0 评论采用已获发送边界风险授权的尽力禁用；f6 代码复用 SDK55／浏览器65和 common98 限定证据。两项可修 P2 闭合，但未观察受理后取消的原 #47 条件仍未满足，不自动归入 #57。旧 schema 的 Native 失败与公开 V4 A普通/B排队全文 JSON、API 审批 probe 分开；最终 f6 新缓存／可见 guest 尚未执行。#42／46／47／48 保持 open，正式缓存验收、完整首版及用户验收未通过，见 [评论验证](suian-side-editor/docs/comment-guard-verification.md)。

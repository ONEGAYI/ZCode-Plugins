# suian-zcode-app-mcp — ZCode 会话 MCP

目标：做独立的 MCP 服务，让 ZCode 与外部 Agent 查询会话，并逐步沿官方授权原 Host 链路增加控制能力。公共层提供协议、授权与通知模块；suian-zcode-title（会话自动命名）使用它完成命名业务。

当前状态：公开十九个工具，另有仅工件面板可见的 PR/议题状态查询与本机文件定位（get_pr_statuses、reveal_artifact，UI 启用后 visibility=app）。list_sessions、read_session、get_current_session、list_pinned_sessions 与 list_crons 保持本机 SQLite 只读连接；会话控制、定时任务启停、定时任务工具面唤醒与 GLM 工具通过公共网关 connectHost 调用原 Host，不新增官方 terminal。工件列表、非会话详情与 set_artifacts 操作插件自有 SQLite，不依赖网关；会话工件详情每次查询原 Host 实时状态。契约见 docs/readonly-tools.md、docs/write-tools.md、docs/glm-balance-design.md 与 docs/artifact-zone-spec.md。

## 守则（沿自研究期，开发期继续适用）

- 使用中文记录结论；区分已核实事实、推断和待验证条件。
- `../sources/` 中的第三方仓库只读（submodule 引用，不入库源码），不 fork、不修改原源码、不安装其依赖。
- 本机探针优先只读；用户明确授权写工具验收后，仅对新建测试会话创建、发信和改名，不干扰其他会话。插件不直接写会话数据库；旧授权凭据持久化仅使用公共当前用户 DPAPI，默认网关调用不读取它。网关 control_token 与授权明文均不进日志。
- 探针、日志和诊断数据只在项目子目录内运行，验证后清理，只保留脱敏的最终证据。
- 引用具体版本、源码行和本机产物路径。不能把同一数据目录视作同一运行中会话。
- 本目录的规则以本文件为准，`CLAUDE.md` 仅导入。

## 边界与维护

- 三个会话读取工具与 list_pinned_sessions、list_crons 只查本机持久化数据，不连接远控。十个写工具按需连接原 Host，不创建 CLI app-server；工作区必须已在网关连接的 Desktop 窗口打开。置顶写走 zcode-task setTaskPinned 并从本地索引读回确认，与归档状态正交；定时任务启停走 zcode-agent setAutomationEnabled，官方 void 且零行更新静默，写后必须同 scope listAutomations 读回确认，未找到或状态不符按结构化错误返回；定时任务工具面唤醒向来源会话投递 queue 自发消息并要求收到回执后立即结束本轮。
- 两个 GLM 工具也连接原 Host。重置每次必须真实用户明确许可和客户端 form elicitation，不接受 Agent 自填 confirmed；不自动重试消耗。只读查询不发卡、不消耗、不标记历史已读。
- 创建和发信不接受来源 ID 参数；服务读取本次 MCP 请求的 session_id，缺失时按 trace_id 与工具名从本地 tool_usage 唯一定位，在 created-by-other-session 注入 creator、在 delivered-by-other-session 注入 deliverer。冲突或歧义降级为 warnings，notice 标注可能来源并继续执行；完全未知或损坏时在写入前报错。不猜界面选中项或最近会话。客户端元数据不等于身份认证或用户授权。ACK 仅表示提交；读取回复使用 read_session，超时或部分失败不自动重试写操作。
- 原 Host 调用统一走公共网关；缺少 RPC 时明确要求升级，不回退官方直连。隔离测试与真实手机验收分别记录，paired 不代表手机身份；手机使用远端工作区时本地调用让位。
- 不将 `getTaskSnapshot` 当作无副作用读接口；公开源码中它会恢复会话并同步索引。工件会话详情按用户要求使用此实时入口，工具描述和规格必须说明该行为，不能标为纯只读；列表读取不查询 Host。
- 不扩展为 SQL 执行工具。数据库缺失、schema 不兼容、历史不存在等错误明确返回，不创建空库或静默回退。
- `../suian-zcode-common/vendor/projection.js` 与许可文件保持原样；更新前核查固定来源和可见性契约。
- 新可执行行为先写契约测试，观察红灯后实现；运行测试首次即保存日志和退出码，交付前保留脱敏汇总并清理原探针。
- 验证在独立 git worktree 进行；没有授权不推送、建 PR 或注册用户 MCP 设置。

## 规格与开票入口

- 多目录：list_sessions 按 project_id 精确筛选，目录搜索可定位所属项目；项目多目录标记与会话附加目录摘要分开，摘要最多 3 项并给出总数和截断标记。sessionProject 只查索引供 start_session 继承会话冻结范围，CLI 权限继承仍独立。旧调用保持单目录，远端元信息不变成本机文件权限；见[验证记录](docs/multi-directory-validation.md)。

- 本项目沿用根 [CONTEXT.md](../CONTEXT.md) 与本目录 `docs/adr/` 的术语和决策，见 [领域文档入口](docs/agents/domain.md)。
- 开票使用当前仓库 GitHub Issues。先完成本地规格与票草稿，发布须有用户明确授权；票的依赖须同时表达宿主能力条件，见 [开票约定](docs/agents/issue-tracker.md)。
- 工件 demo 的两项工具、可累积摘要、历史断点快照和原生只读侧栏已在本地实施。完整版唯一投影继续等待上游。实施范围见 [demo 规格](docs/artifact-zone-spec.md)，开发与宿主限制见 [开发验证](docs/artifact-demo-verification.md)，历史研究见 [分叉核查](docs/artifact-host-fork-audit.md)，公开票同步状态和依赖见 [开票索引](docs/artifact-zone-tickets.md)。真实模型评估和用户验收不能用技术夹具代替。

## 文件职责

| 路径 | 职责 |
| --- | --- |
| cli.mjs | stdio 入口、数据库/公共网关配置路径；旧 stdin DPAPI 保存入口兼容 |
| config.mjs | MCP 和原生 Hook 共用的外置配置、路径优先级与 Desktop 应用版本来源 |
| .zcode-plugin/plugin.json / .mcp.json | 原生元信息与 stdio 注册；参数 --config 指向外置配置 |
| skills/ | setup / configuration / sessions / automations / artifacts / glm / debug，paths.md 统一路径与配置说明 |
| server.mjs | MCP 工具注册、参数校验与结构化响应 |
| tool-result.mjs | 当前 ZCode 的关键状态简报与完整结构化结果，避免文本重复承载完整 JSON |
| caller.mjs | 每次请求的发起会话定位：MCP 元数据优先，trace_id 与工具名只读匹配本地调用记录 |
| artifacts.mjs | 插件 SQLite 的当前状态、CAS、服务记录时间、双向创建关系、不可变快照和幂等分叉初始化；每次读取工件登记与 session_title；可选 artifact_status 表持久化 PR/议题成功快照，读取时附加 github_status，不写回登记、revision 或历史快照；可选 notify 钩子在工件实际写入事务 COMMIT 后触发变更信号 |
| artifact-host.mjs | 只读宿主消息的原始 Stop 断点与隐藏 forkOrigin，不用时间或父最新状态猜测 |
| artifact-tools.mjs / artifact-ui.mjs | 当前调用者唯一定位、get 列表/详情与 set 注册（写入经 notify 钩子推送变更信号）、面板专用 PR/议题状态与本机定位工具（默认禁用，UI 能力协商成功后仅 app 可见；状态经同一工具两分支一次往返，定位仅收 ref、命中当前会话 file 条目才执行），以及调用公共 UI 能力判定后启用的页面资源 |
| artifact-status.mjs | 面板专用 PR/议题状态拉取服务：gh 子进程与超时上限，正式服务使用工件库持久化成功快照；新鲜期命中不起子进程、超时沿用旧数据标 stale、失败逐条报错并清缓存；存储错误直接报错 |
| artifact-reveal.mjs | 面板专用本机定位服务：执行前 stat 探测（缺失拒绝、其它错误降级文件语义）、按平台构造 explorer/open/xdg-open 命令（win32 退出码 0/1 均视为已启动）、预检与命令共用整体期限（stat 悬挂按超时回报，迟到结果不启动打开）、无法启动或超时按失败回报 |
| artifact-resources.mjs | 单一信号资源 suian-artifacts://current（list/read 与 resources/subscribe/unsubscribe）；read 按请求上下文尽力解析会话，实际写入后向已订阅 URI 推送 notifications/resources/updated，页面只当信号、数据走 get_artifacts |
| artifact-hook.mjs / hooks/hooks.json | 同步 SessionStart 初始化、UserPromptSubmit 简略摘要和 Stop 断点快照 |
| artifact-prompt.mjs | 自动登记入口、分类统计和有类别保底的 20 条/9000 字符工件简表；只裁剪注入内容，不改变存储 |
| ui/artifacts.html | 原生折叠分组列表与详情页，共用 get；会话详情实时查询，条目以文本呈现，资源不在页面编辑；桥支持时订阅信号资源实现列表与详情的自动刷新，refresh 重入合并，无桥静默保持手动刷新；PR 条目经面板专用状态通道显示状态图形与行尾增删行数，议题条目同通道显示开放/已关闭图形与行尾评论气泡数，超时追加黄色钟表，逐条出错或通道整次失败清状态回默认图标；file 条目详情页可经本机定位通道在资源管理器中打开，缺失态按钮灰化，失败行内回报，迟到回执不跨条目污染状态行 |

| control.mjs | 原 Host 改名读回、指定模型与权限模式创建、消息包装、v4 可选投递策略与提交回执、compact 维护命令与受理回执、归档保护与复原、置顶写与索引读回确认、定时任务启停（zcode-agent setAutomationEnabled + 同 scope listAutomations 读回确认，workspace_key 透传归属标识）；改名/创建后双库标题复核，分叉时回执 warnings；按调用释放连接 |
| glm.mjs | GLM 个人套餐额度/卡片投影、确认后重置与同次尝试回执；共用 controller 远控互斥 |
| sessions.mjs | 只读索引查询、会话定位、历史投影与分页；list_sessions 置顶优先排序，置顶列表查询与之同源；list_crons 直读同库 automations 表（官方 camelCase 投影、脏 scheduleRule 容忍）；sessionTitle 轻量双库标题读取供复核，sessionMode 读取 CLI 会话库权限供继承与首发后确认（不用索引或创建响应的 mode）；sessionOverview 汇集发起会话双库自省字段供 get_current_session，两库无行时字段可空 |
| tests/projects.test.mjs | 3.16 项目精确筛选、只读冻结目录、自省、创建继承与显式范围覆盖，旧版和远端元信息兼容 |
| package.json / package-lock.json | package.json 提供插件和运行时自报版本；原生清单与锁文件同步版本，固定依赖与测试入口 |
| CHANGELOG.md | 本插件的版本变更记录、预览限制和对应源码链接 |
| mcp.config.example.json | MCP 客户端连接示例 |
| install.mjs / SKILL.md | 源码路由技能部署、原生外置配置初始化与指定旧根迁移；公共网关委托 common |
| vendor/NOTICE.md | 公共消息投影库的来源与许可指针 |
| tests/ | 真实 SQLite fixture、MCP/stdio、正式 Hook 与工件简表选择/裁剪契约测试 |
| docs/ | 研究、工具规格、ADR、开票草稿与脱敏验收证据；agents/ 保存开票和领域文档入口 |
| experiments/relay-gateway/ | 历史网关实验证据与迁移指针；实现统一维护于 `../suian-zcode-common/` |

# suian-zcode-app-mcp — ZCode 会话 MCP

目标：做独立的 MCP 服务，让 ZCode 与外部 Agent 查询会话，并逐步沿官方授权原 Host 链路增加控制能力。公共层提供协议、授权与通知模块；suian-zcode-title（会话自动命名）使用它完成命名业务。

当前状态：公开九个工具。list_sessions 与 read_session 保持本机 SQLite 只读连接；其余工具通过公共网关 connectHost 调用原 Host，不新增官方 terminal。契约见 docs/readonly-tools.md、docs/write-tools.md 与 docs/glm-balance-design.md。

## 守则（沿自研究期，开发期继续适用）

- 使用中文记录结论；区分已核实事实、推断和待验证条件。
- `../sources/` 中的第三方仓库只读（submodule 引用，不入库源码），不 fork、不修改原源码、不安装其依赖。
- 本机探针优先只读；用户明确授权写工具验收后，仅对新建测试会话创建、发信和改名，不干扰其他会话。插件不直接写会话数据库；旧授权凭据持久化仅使用公共当前用户 DPAPI，默认网关调用不读取它。网关 control_token 与授权明文均不进日志。
- 探针、日志和诊断数据只在项目子目录内运行，验证后清理，只保留脱敏的最终证据。
- 引用具体版本、源码行和本机产物路径。不能把同一数据目录视作同一运行中会话。
- 本目录的规则以本文件为准，`CLAUDE.md` 仅导入。

## 边界与维护

- 两个读取工具只查本机持久化数据，不连接远控。五个写工具按需连接原 Host，不创建 CLI app-server；工作区必须已在网关连接的 Desktop 窗口打开。
- 两个 GLM 工具也连接原 Host。重置每次必须真实用户明确许可和客户端 form elicitation，不接受 Agent 自填 confirmed；不自动重试消耗。只读查询不发卡、不消耗、不标记历史已读。
- 创建和发信不接受来源 ID 参数；服务读取本次 MCP 请求的 session_id，缺失时按 trace_id 与工具名从本地 tool_usage 唯一定位，在 created-by-other-session 注入 creator、在 delivered-by-other-session 注入 deliverer。冲突或歧义降级为 warnings，notice 标注可能来源并继续执行；完全未知或损坏时在写入前报错。不猜界面选中项或最近会话。客户端元数据不等于身份认证或用户授权。ACK 仅表示提交；读取回复使用 read_session，超时或部分失败不自动重试写操作。
- 原 Host 调用统一走公共网关；缺少 RPC 时明确要求升级，不回退官方直连。隔离测试与真实手机验收分别记录，paired 不代表手机身份；手机使用远端工作区时本地调用让位。
- 不将 `getTaskSnapshot` 当作无副作用读接口；公开源码中它会恢复会话并同步索引。
- 不扩展为 SQL 执行工具。数据库缺失、schema 不兼容、历史不存在等错误明确返回，不创建空库或静默回退。
- `../suian-zcode-common/vendor/projection.js` 与许可文件保持原样；更新前核查固定来源和可见性契约。
- 新可执行行为先写契约测试，观察红灯后实现；运行测试首次即保存日志和退出码，交付前保留脱敏汇总并清理原探针。
- 验证在独立 git worktree 进行；没有授权不推送、建 PR 或注册用户 MCP 设置。

## 文件职责

| 路径 | 职责 |
| --- | --- |
| cli.mjs | stdio 入口、数据库/公共网关配置路径；旧 stdin DPAPI 保存入口兼容 |
| server.mjs | MCP 工具注册、参数校验与结构化响应 |
| caller.mjs | 每次请求的发起会话定位：MCP 元数据优先，trace_id 与工具名只读匹配本地调用记录 |
| control.mjs | 原 Host 改名读回、指定模型与权限模式创建、消息包装、v4 可选投递策略与提交回执、归档保护与复原；改名/创建后双库标题复核，分叉时回执 warnings；按调用释放连接 |
| glm.mjs | GLM 个人套餐额度/卡片投影、确认后重置与同次尝试回执；共用 controller 远控互斥 |
| sessions.mjs | 只读索引查询、会话定位、历史投影与分页；sessionTitle 轻量双库标题读取供复核，sessionMode 读取 CLI 会话库权限供继承与首发后确认（不用索引或创建响应的 mode） |
| package.json / package-lock.json | 固定依赖版本与测试入口 |
| mcp.config.example.json | MCP 客户端连接示例 |
| install.mjs / SKILL.md | skill 幂等部署与 Agent 初始化、原生 MCP 配置合并；公共网关流程委托同级子项目 |
| vendor/NOTICE.md | 公共消息投影库的来源与许可指针 |
| tests/ | 真实 SQLite fixture 与 MCP/stdio 契约测试 |
| docs/ | 早期研究、首版设计与脱敏验收证据 |
| experiments/relay-gateway/ | 历史网关实验证据与迁移指针；实现统一维护于 `../suian-zcode-common/` |

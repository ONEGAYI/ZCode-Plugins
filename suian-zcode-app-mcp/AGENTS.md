# suian-zcode-app-mcp — ZCode 会话 MCP

目标：做独立的 MCP 服务，让 ZCode 与外部 Agent 查询会话，并逐步沿官方授权原 Host 链路增加控制能力。公共层提供协议、授权与通知模块；suian-zcode-title（会话自动命名）使用它完成命名业务。

当前状态：公开七个工具。`list_sessions` 与 `read_session` 保持本机 SQLite 只读连接；`rename_session`、`start_session`、`send_message`、`archive_session`、`restore_session` 使用已授权的独立远控连接调用原 Host。契约见 `docs/readonly-tools.md` 与 `docs/write-tools.md`。

## 守则（沿自研究期，开发期继续适用）

- 使用中文记录结论；区分已核实事实、推断和待验证条件。
- `../sources/` 中的第三方仓库只读（submodule 引用，不入库源码），不 fork、不修改原源码、不安装其依赖。
- 本机探针优先只读；用户明确授权写工具验收后，仅对新建测试会话创建、发信和改名，不干扰其他会话。插件不直接写会话数据库；授权明文只在内存，持久化仅使用公共当前用户 DPAPI，不进日志。
- 探针、日志和诊断数据只在项目子目录内运行，验证后清理，只保留脱敏的最终证据。
- 引用具体版本、源码行和本机产物路径。不能把同一数据目录视作同一运行中会话。
- 本目录的规则以本文件为准，`CLAUDE.md` 仅导入。

## 边界与维护

- 两个读取工具只查本机持久化数据，不连接远控。五个写工具按需连接原 Host，不创建 CLI app-server；工作区必须已在授权窗口打开。
- 开局和后续消息均由服务包装固定 delivered-by-other-session 标识。ACK 仅表示提交；读取回复使用 read_session，超时或部分失败不自动重试写操作。
- 独立 terminal 仍占官方单设备席位，不把公共网关的 bootstrap 共存验收扩大为写 RPC 已共存；跨插件争用与手机占用明确报失败，不强行踢出设备。
- 不将 `getTaskSnapshot` 当作无副作用读接口；公开源码中它会恢复会话并同步索引。
- 不扩展为 SQL 执行工具。数据库缺失、schema 不兼容、历史不存在等错误明确返回，不创建空库或静默回退。
- `../suian-zcode-common/vendor/projection.js` 与许可文件保持原样；更新前核查固定来源和可见性契约。
- 新可执行行为先写契约测试，观察红灯后实现；运行测试首次即保存日志和退出码，交付前保留脱敏汇总并清理原探针。
- 验证在独立 git worktree 进行；没有授权不推送、建 PR 或注册用户 MCP 设置。

## 文件职责

| 路径 | 职责 |
| --- | --- |
| cli.mjs | stdio 入口、数据库/授权目录参数与 stdin DPAPI 授权配置 |
| server.mjs | MCP 工具注册、参数校验与结构化响应 |
| control.mjs | 原 Host 改名读回、指定模型创建、消息包装、归档保护与复原；按调用释放连接 |
| sessions.mjs | 只读索引查询、会话定位、历史投影与分页 |
| package.json / package-lock.json | 固定依赖版本与测试入口 |
| mcp.config.example.json | MCP 客户端连接示例 |
| install.mjs / SKILL.md | skill 幂等部署与 Agent 初始化、原生 MCP 配置合并；公共网关流程委托同级子项目 |
| vendor/NOTICE.md | 公共消息投影库的来源与许可指针 |
| tests/ | 真实 SQLite fixture 与 MCP/stdio 契约测试 |
| docs/ | 早期研究、首版设计与脱敏验收证据 |
| experiments/relay-gateway/ | 历史网关实验证据与迁移指针；实现统一维护于 `../suian-zcode-common/` |

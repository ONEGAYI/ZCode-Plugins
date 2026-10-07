# suian-zcode-app-mcp — ZCode 会话 MCP

目标：做独立的 MCP 服务，让 ZCode 与外部 Agent 查询会话，并逐步沿官方授权原 Host 链路增加控制能力。suian-zcode-title（会话自动命名）已经验证了远控改名能力。

当前状态：只读首版，公开 `list_sessions` 与 `read_session`。使用本机 SQLite 只读连接，stdio 接入 MCP 客户端。完整契约和验证范围见 `docs/readonly-tools.md`。

## 守则（沿自研究期，开发期继续适用）

- 使用中文记录结论；区分已核实事实、推断和待验证条件。
- `../sources/` 中的第三方仓库只读（submodule 引用，不入库源码），不 fork、不修改原源码、不安装其依赖。
- 本机探针优先只读，不创建或发送真实 Agent 任务，不修改用户凭据及会话数据库；涉及远控授权时凭据只在进程内使用，不落盘、不进日志。
- 探针、日志和诊断数据只在项目子目录内运行，验证后清理，只保留脱敏的最终证据。
- 引用具体版本、源码行和本机产物路径。不能把同一数据目录视作同一运行中会话。
- 本目录的规则以本文件为准，`CLAUDE.md` 仅导入。

## 首版边界与维护

- 默认只查本机已持久化数据，不连接远控、不创建 CLI app-server，不读实时 V4 内存状态。
- 不将 `getTaskSnapshot` 当作无副作用读接口；公开源码中它会恢复会话并同步索引。
- 不扩展为 SQL 执行工具。数据库缺失、schema 不兼容、历史不存在等错误明确返回，不创建空库或静默回退。
- `vendor/projection.js` 与许可文件保持原样；更新前核查固定来源和可见性契约。
- 新可执行行为先写契约测试，观察红灯后实现；运行测试首次即保存日志和退出码，交付前保留脱敏汇总并清理原探针。
- 验证在独立 git worktree 进行；没有授权不推送、建 PR 或注册用户 MCP 设置。

## 文件职责

| 路径 | 职责 |
| --- | --- |
| cli.mjs | stdio 入口、数据库路径参数与环境变量 |
| server.mjs | MCP 工具注册、参数校验与结构化响应 |
| sessions.mjs | 只读索引查询、会话定位、历史投影与分页 |
| package.json / package-lock.json | 固定依赖版本与测试入口 |
| mcp.config.example.json | MCP 客户端连接示例 |
| install.mjs / SKILL.md | skill 幂等部署与 Agent 初始化、原生 MCP 配置合并；公共网关流程委托同级子项目 |
| vendor/ | 官方可见消息投影与原许可、来源声明 |
| tests/ | 真实 SQLite fixture 与 MCP/stdio 契约测试 |
| docs/ | 早期研究、首版设计与脱敏验收证据 |
| experiments/relay-gateway/ | 历史网关实验证据与迁移指针；实现统一维护于 `../suian-zcode-gateway/` |

# suian-zcode-gateway — 公共设备侧网关

网关是独立公共工具。两个插件的安装 skill 只引用这里的配置流程，不复制网关代码、启动任务或环境变量管理逻辑。

## 约定

- 只绑定 `127.0.0.1`，上游沿用官方 relay；不读取远控链接或保存的 ZCode 凭据，不记录消息体。
- 当前实现原样转发与同进程 bootstrap 分流。完整 V4 RPC、手机离线注入尚未接入，不能宣称自动命名已能与手机共存。
- Windows 配置仅管理当前用户的本工具启动任务与 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`。不退出或重启 ZCode；配置写入与运行中 Desktop 已生效分开验证。
- 默认运行数据放 `~/.zcode/tools/suian-zcode-gateway`，两个插件共用。保留安装前的用户级变量，卸载时仅恢复仍由本工具管理的值。
- 新行为先写契约测试。Windows 设置测试使用隔离文件与模拟系统命令，不修改真实用户环境、计划任务或正在运行的 ZCode。
- 不 fork 或修改 `../sources/`。原始日志放忽略的 `.scratch/`，验证后只留脱敏汇总。

## 文件职责

| 路径 | 职责 |
| --- | --- |
| gateway.mjs | 唯一 relay 转发实现、bootstrap 分流与无敏感内容的健康状态 |
| setup.ps1 | 公共安装、状态检查、移除；当前用户启动任务、环境变量及 skill 部署 |
| run.ps1 | 启动任务使用的隐藏 Node 进程入口 |
| SKILL.md | Agent 的完整公共配置与生效验证流程 |
| tests/ | 回环 WebSocket 与隔离 Windows 配置契约 |
| experiments/ | 仅发合成 auth_init 的研究探针，安装和测试不自动运行 |
| package.json / package-lock.json | 固定 Node/ws 版本与测试入口 |
| docs/ | 脱敏验证汇总 |

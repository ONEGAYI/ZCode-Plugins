# suian-zcode-common — 公共基础能力

两个插件共用本目录的网关、远控协议、DPAPI、通知和消息投影。公共层不导入任何插件；调用方保留业务规则、通知文案、协议身份与配置数据。

## 约定

- 只有网关是常驻独立进程，其他能力是调用方导入的模块；提取代码不代表所有插件自动增加这些行为。
- 网关只绑定 `127.0.0.1`，不读取远控链接或 ZCode 凭据、不记录消息体。本地工作区复用窗口 Host 的一个物理桥，隔离客户端 RPC 编号；共存声明必须区分隔离测试与真实手机验收。
- 默认 relay 模式保留官方鉴权与手机共存；显式 local-only 模式仅处理回环 Desktop 的注册、就绪和心跳，不连接官方 relay、不使用传入的 pass_hash，也不宣称官方身份已验证。本地 RPC 仍要求当前用户 control_token；设备入口信任本机进程，拒绝浏览器 Origin。旧配置无 mode 时按 relay 兼容，不因网络失败自动切换。
- 公共远控模块使用调用方提供的授权。DPAPI 明文只在进程内，保存位置由调用方的 `dataDir` 决定；不回显或复制凭据到公共配置。
- Toast 的两小时冷却与互斥实现共用，状态范围由调用方的 `dataDir` 决定。协议、快捷方式和 AUMID 属于调用方，卸载一个插件不删除另一个身份。
- 自动化测试必须注入通知显示、剪贴板及打开工作区的系统边界，不激活真实协议或打开 ZCode 确认框。
- 登录任务用 `wscript.exe` 与数据目录内的 VBS 桥隐藏启动 PowerShell → Node，启动链必须等待子进程并传递退出码，保持异常重试有效。不要把常驻 WScript 指向 Git 工作树内的模板。
- 健康检查默认每次 5 秒、仅超时重试一次；连续超时报未知，不能掩盖为网关已停止。
- 网关健康和任务状态分别检查；任务 Ready 不代表网关停止。重载/移除检查实际连接，等待监听与启动器都退出后再修改配置。
- Windows 网关配置只管理当前用户任务和 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`。不退出或重启 Desktop；Restart/Remove 在 Desktop 已断开时才允许网关自行退出。
- 为兼容既有安装，网关数据仍在 `~/.zcode/tools/suian-zcode-gateway`，任务名和健康接口 service 仍为网关身份。公共 skill 部署到 `~/.zcode/skills/suian-zcode-common`；迁移不另建任务或丢失原环境备份。
- 新行为先写契约测试。Windows 设置测试使用隔离文件与模拟系统命令，不修改真实用户环境、计划任务或正在运行的 ZCode。
- `vendor/` 固定第三方来源并保留许可；不修改 `../sources/`。验证日志落忽略的 `.scratch/`，入库只保留脱敏汇总。

## 文件职责

| 路径 | 职责 |
| --- | --- |
| gateway.mjs | 唯一 relay 网关、同进程 bootstrap 分流及健康状态 |
| rpc-broker.mjs | 单一 Host 桥、RPC 编号映射、手机虚拟桥与本地客户端分流 |
| gateway-client.mjs | 插件默认 connectHost/probeHost，本地配置与鉴权、RPC 附着和明确失败 |
| setup.ps1 / run.ps1 / run.vbs | 用户任务、变量、公共 skill；无窗口监督启动、安全重载与恢复 |
| remote.mjs | 官方 relay 鉴权、workspace bridge、Channel RPC 与分层探活 |
| auth-store.mjs | 调用方数据目录内的当前用户 DPAPI 授权存取 |
| title-policy.mjs | 当前用户跨插件的会话锁定策略：MCP 写入，命名插件读取 |
| notifications.mjs / cooldown.mjs | Toast 显示、XML、两小时冷却、跨进程显示互斥 |
| notification-action.mjs | 复制调用方提示词、打开固定默认工作区 |
| notification-install.mjs | 按调用方身份安装/移除协议桥、快捷方式与 AUMID |
| windows.mjs | 公共 PowerShell 执行与安装用文件/系统边界 |
| vendor/ | 固定消息投影和远控协议库，见 NOTICE.md |
| SKILL.md / README.md | Agent 公共配置流程与模块接口、运行边界 |
| tests/ | 回环网关、隔离 Windows 配置、远控、DPAPI 与通知契约 |
| experiments/ | 仅发合成 auth_init 的研究探针，不自动执行 |
| package.json / package-lock.json | 固定 Node/ws 版本与测试入口 |
| docs/ | 脱敏验证证据；历史与本次验证分开 |

---
name: suian-zcode-gateway
description: 安装、检查或移除两个 ZCode 插件共用的设备侧 relay 网关。配置 Windows 用户级环境变量、登录启动任务并指导安全重启；当用户要求初始化自动命名或会话 MCP、配置网关、检查手机远控与网关连接、恢复官方直连时使用。只处理公共网关配置，插件自身的 Hook、授权与 MCP 注册交给对应 skill。
---

# 公共 ZCode 网关配置

网关只有 `suian-zcode-gateway` 一份实现。自动命名和 MCP 的初始化都调用本文流程，不在插件内复制环境变量或后台进程脚本。

## 定位与边界

<!-- suian-zcode-gateway:root -->

`{{gateway_root}}` 按顺序确定：安装副本注入的本机网关根；`~/.zcode/tools/suian-zcode-gateway/config.json` 的 `gateway_root`；两个插件根的同级 `suian-zcode-gateway`。仍未找到才询问仓库位置。技能目录仅有文档，不是工具根。

**当前能力**：原样转发 Desktop 与官方 relay 的连接。同进程 bootstrap 与手机远控已实测共存；完整 V4 RPC 尚未接入。配置网关并不会让现有命名插件的独立 terminal 自动变成网关请求。当前两个 MCP 工具读取本机 SQLite，本身不需要远控凭据。

## 初始化

1. 确认 Windows、Node.js 24+ 与工具根。只在公共子项目运行 `npm ci --ignore-scripts --no-audit --no-fund`，不要给 `sources/` 装依赖。
2. 先执行状态命令，再执行安装命令。已配置时复用原端口、上游和当前用户任务。默认数据目录为 `~/.zcode/tools/suian-zcode-gateway`，默认端口 `17329`；不要改成两个插件各自的 `.local`。

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{gateway_root}}/setup.ps1" -Action Status
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{gateway_root}}/setup.ps1" -Action Install
```

安装入口统一注册当前用户登录启动任务，立即启动隐藏的 Node 网关，通过 `/health` 验证实例后才写用户级 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`，并部署本 skill。失败就停止依赖该步骤的操作，读取错误输出或数据目录的 `gateway.error.log`；不手动填一个未启动的网关地址。

用户明确要求其他端口时给 Install 增加 `-Port {{port}}`。只有实际使用另一 endpoint 时才指定 `-UpstreamUrl "wss://zcode.chatglm.site/ws"`；默认 `wss://zcode.z.ai/ws`，不是自动故障切换。运行中网关配置不一致会明确拒绝，应先完成工作、完整退出 ZCode，再移除旧配置并安装。不要终止 Agent、强行停止网关或覆盖另一个进程的端口。

3. 继续完成调用方插件的配置。安装过程不退出 ZCode。向用户明确说明：**运行中的 Agent 任务和未保存内容可能受重启影响；请先完成或保存工作，再完整退出并重开 ZCode**。关闭窗口可能仅隐藏到托盘；不要只凭进程数量断言仍是旧主进程。

## 让 Desktop 读取新环境

该变量在 **Desktop 主进程启动时**读取。写入 MCP 的 `env` 只影响 MCP 子进程，无法改变 Desktop 的 relay。用户级注册表写入也不会更新既有终端或 Explorer 的进程环境。

Agent 不要在承载本次配置的 ZCode 中自行重启宿主。给用户提供下面的启动方法，并根据用户反馈再验证。`{{zcode_exe}}` 必须是本机实际安装的 Desktop 可执行文件，不是 CLI；先定位，不猜路径。

```powershell
$env:ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL = [Environment]::GetEnvironmentVariable('ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL', 'User')
Start-Process -FilePath "{{zcode_exe}}" -WindowStyle Hidden
```

这一步应在用户已完整退出后，由外部 PowerShell 执行。以后登录 Windows 时新进程继承用户级配置；同次登录中从已有进程重开仍可能继承旧值，应使用上述方法。

## 分层验证与排障

执行 `setup.ps1 -Action Status`，分别汇报：

- `configured` / `user_env_matches`：公共配置与用户环境是否写好。
- `gateway_running`：当前用户任务与健康接口是否正常。
- `desktop_connected`：是否已有 Desktop 连接本地网关；只有看到连接才能证明远控通道经过网关。
- `upstream_connected` / `paired`：上游是否已连接，官方手机页面是否已配对。未开启远控或手机未连时为 false，可以是正常状态。

重开后先在原窗口启用“移动端远程控制”，再查看 Desktop 连接状态；手机刷新官方页面后验证配对。不要通过创建真实 Agent 任务来探活，不记录 `sid/hash/mid`、授权链接或消息正文。

端口被占用、上游失败、任务注册权限不足都应按错误处理。不要擅自提权、杀进程或改其他插件的环境变量。任务存在但状态检查失败时，先看公共日志和配置；若用户要求修复，可在完整退出 ZCode 后 Remove → Install。

## 恢复原 relay / 移除

公共网关同时服务两个插件。用户仅卸载其中一个插件时保留网关；只有明确要求恢复直连或移除公共工具才执行此步。

先提醒运行中工作的影响，让用户完整退出 ZCode；再执行 `setup.ps1 -Action Remove`。入口移除自己的任务，恢复安装前的用户级变量；如果变量被外部修改，则保留外部值。恢复后仍需从读取最新用户变量的外部 PowerShell启动新 Desktop。没有原变量时读取结果为空，即使用官方默认值。分别报告移除完成与用户重启后的实际状态。

实现与验证依据见工具根 `README.md`。网关配置不涉及远控授权链接；授权只交给自动命名插件自己的 DPAPI 流程。公共 `config.json` 含停止本地网关的令牌，定位时只解析所需字段，不回显完整配置或 Authorization 请求头。

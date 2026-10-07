---
name: suian-zcode-common
description: 管理 ZCode 插件共用的基础能力。当用户初始化或升级自动命名、会话 MCP，配置或检查共用网关、通知基础能力，或恢复官方直连时使用。命名模型、Hook 和 MCP 注册由对应插件 skill 处理。
---

# ZCode 公共基础能力

两个插件依赖同一 `suian-zcode-common`。它提供可导入的协议、授权、通知与投影模块，以及独立运行的网关。只有网关常驻后台；Toast、剪贴板和授权在调用方进程按需执行。模块接口见公共根的 `README.md`，不要在插件内复制实现。

## 定位与当前边界

<!-- suian-zcode-common:root -->

`{{common_root}}` 按顺序从安装副本的本机公共根、插件根同级 `suian-zcode-common`、既有 `~/.zcode/tools/suian-zcode-gateway/config.json` 的 `gateway_root` 定位；每个候选都须存在。旧配置可能还指向已改名的 `suian-zcode-gateway`，优先用同仓库新目录。技能目录只有文档。位置仍不明时再询问用户。

初始化或升级优先读取仓库中的最新 skill，保留所选插件与公共层的同一版本。稀疏检出须补齐公共层，保留其他已安装插件目录；缺少公共层时先按根 README 获取代码。

**共存范围**：网关原样转发 Desktop 与官方 relay；同进程 bootstrap 与手机已实测共存。完整 V4 RPC 尚未接入网关分流。命名模块仍开独立 terminal，只读 MCP 仍读本机 SQLite；公共层提取不会改变这两项边界。

## 首次安装

1. 确认 Windows、Node.js 24+ 和公共根，在公共根运行 `npm ci --ignore-scripts --no-audit --no-fund`。不初始化或安装 `sources/` 的依赖。
2. 执行 Status。未配置才执行 Install；已有配置按后文复用或升级，不另建实例。

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{common_root}}/setup.ps1" -Action Status
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{common_root}}/setup.ps1" -Action Install
```

Install 注册当前用户登录任务，由 `wscript.exe` 执行公共数据目录的 VBS 桥，以无窗口方式启动并监督 PowerShell → Node，健康检查通过后写用户级 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`，并部署公共 skill。失败就读错误或 `gateway.error.log`，不把未启动的地址写到 MCP 的 env。

网关数据保留 `~/.zcode/tools/suian-zcode-gateway`，默认端口 `17329`。只有用户需要别的端口才指定 `-Port {{port}}`；上游默认 `wss://zcode.z.ai/ws`，实际使用另一 endpoint 时才指定 `-UpstreamUrl "wss://zcode.chatglm.site/ws"`。已有端口、上游和原环境备份保留，不放到插件各自的 `.local`。

3. 继续对应插件配置。安装不退出 Desktop；分别报告配置已写入与 Desktop 是否已经连接。需重开时按后文提供外部步骤。

## 升级与旧目录迁移

**更新文件和加载新代码是两件事**。网关模块在进程中缓存，更新 Git 文件不会自动重载。Windows 隔离实验已验证运行中可替换 JS 与重命名源码目录，但不能据此保证其他进程、文件权限或原生扩展不会占用文件。避免在插件处理运行中工作时更新实际安装目录；先安排完成或保存工作，按用户选择的升级窗口操作。

更新源码后，在公共根安装锁定依赖并执行 Status。旧任务和数据目录仍沿用网关身份；不要新建 `suian-zcode-common` 的第二个任务或清空配置。需要加载更新后的代码、迁移旧根路径或将旧 PowerShell 任务切换为 VBS 时执行 Restart，保留端口、上游、停止令牌和原环境备份。

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{common_root}}/setup.ps1" -Action Restart
```

若 `desktop_connected:true`，Restart 会拒绝断开。不要终止 Agent 或强行停止网关。给用户提供外部操作：完成运行中任务、保存工作，完整退出 ZCode；在外部 PowerShell 执行上述 Restart，再按下一节启动 Desktop。不要在承载配置的 ZCode 中自行退出宿主。无 Desktop 连接时可直接重载网关，之后检查 Status。

Restart 等网关与旧启动器正常退出，再更新同一任务并启动新根的代码。成功输出 `action:"restarted"`、`vbs_launcher:true`；启动失败照实报错。旧任务健康且有活跃 Desktop 时，Install 只复用，不强行改为 VBS；`launcher_update_required:true` 表示需要按上述步骤重载。旧公共网关 skill 只有归属与旧配置匹配才移除。

## 让 Desktop 读取新环境

变量在 **Desktop 主进程启动时**读取。MCP 的 env 只影响子进程。当前脚本写用户注册表，不刷新已有 Explorer/终端的进程环境。

安装或变更后第一次重开，提供下面的方法。用户先完成或保存所有运行中工作，再从托盘完整退出；关窗口可能仅隐藏。Agent 先定位实际 Desktop exe，`{{zcode_exe}}` 不能填 CLI。

```powershell
$env:ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL = [Environment]::GetEnvironmentVariable('ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL', 'User')
Start-Process -FilePath "{{zcode_exe}}" -WindowStyle Hidden
```

**这不是永久启动要求**。重新登录 Windows 后，普通快捷方式通常会继承新用户环境。若同次登录从仍持旧环境的启动器打开，Status 显示 Desktop 未连到网关，再用上述方法重开；已有 Desktop 连接正确时不需要重复操作。不要要求用户以后每次都从 PowerShell 启动。

## 分层验证与数据归属

执行 Status，分别检查配置、用户环境、网关、Desktop、上游与配对：

- `configured` / `user_env_matches`：公共配置与用户环境。
- `gateway_running` / `health_status`：实际健康接口是否可达；连接失败为 `unreachable`，未配置为 `not_configured`。
- `task_running`：计划任务是否正在监督启动链。Ready 不代表网关进程已停止。
- `vbs_launcher` / `launcher_update_required`：任务是否配置为 VBS、入口或监督链是否需要恢复。
- `desktop_connected`：是否有 Desktop 连入网关；这才是生效证据。
- `upstream_connected` / `paired`：上游和手机配对；未开远控或手机未连时可正常为 false。

健康检查默认单次 5 秒，仅超时重试一次；连续超时报运行状态未知，不据此断言网关停止。必要时可给 Status 指定 `-HealthTimeoutSec {{seconds}}`（1–30）。不把历史 `LastTaskResult` 当作当前进程状态；分别读取本次健康结果和任务状态。

网关可达但任务未运行时，报告启动链需要恢复，不另开第二个实例。Restart/Remove 仍先检查实际 Desktop 连接；等待网关 HTTP 监听和启动器都退出后才改配置。任务正在运行但健康端点不可达时，重载或移除明确拒绝，先查启动日志。

重开后在原窗口启用移动端远控，检查 Desktop 状态，再用手机刷新页面验证配对。不要创建真实 Agent 任务探活。端口占用、网络或任务权限错误照实处理，不擅自提权、杀进程或改其他插件配置。

公共 DPAPI 与 Toast 实现按调用方 `dataDir` 存储状态：命名插件的授权密文、冷却、协议桥与 AUMID 仍在原位置，通知标题和排障提示词由命名插件提供。无需为代码迁移重新取得链接。只读 MCP 不索取凭据、不增加 Toast。诊断通知时读取调用方 skill，公共配置不承担业务文案或自动 Hook 配置。

不要回显 `sid/hash/mid`、授权链接、消息正文或整个网关 config。config 中的 `control_token` 只控制本地网关停止，定位只解析必要字段。

## 恢复原 relay / 移除

单独卸载一个插件保留公共层和网关。只有用户要求恢复直连或移除公共工具时才执行 Remove。

先完成或保存运行中工作并完整退出 ZCode，再执行 `setup.ps1 -Action Remove`。入口让网关自行退出，移除自己的任务，恢复安装前变量；外部改过的变量保留。恢复后仍按读取最新用户变量的方法启动 Desktop；没有原变量时读取结果为空，使用官方默认值。分别报告移除结果与用户重开后的实际状态。

Remove 只移除网关配置、运行用 VBS 桥和归属匹配的公共 skill，不删除任何插件的授权、通知身份、Hook 或 MCP 设置。

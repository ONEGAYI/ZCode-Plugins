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

**先完成安装或升级，最后才安排应用重启**。首次接入、修改启动地址也遵循这个顺序。保留承载配置的 ZCode 与当前 Agent 会话，先完成源码、依赖、网关、插件配置、skill 和本机检查。需要重载网关时只暂停 ZCode 内的移动端远控；不能让用户先退出应用，再等待已经退出的 Agent 继续升级。

**共存范围**：命名与 MCP 的原 Host 调用统一走网关本地 RPC，不再新建官方 terminal。本地工作区共享窗口 Host 的一个物理桥，隔离请求、回复与订阅；隔离契约已验证，真实手机验收以当前证据为准。手机独用远端工作区仍走原通道；此时本地 RPC 返回 remote_workspace_busy，不切走手机。两个 SQLite 读取工具继续独立运行。

## 选择连接模式

已有安装保留配置中的 mode；旧配置缺少该字段时按 relay 兼容。首次安装默认 relay，用户明确需要内网本机控制、无法访问官方 relay 时可选 local-only。需求不明且会影响手机远控时，先询问是否需要官方手机连接；不要因临时网络错误自动切换模式。

| 模式 | Desktop 启动与验证 |
| --- | --- |
| relay | 连接官方上游鉴权，支持手机共存；原 Host 调用需要上游连接 |
| local-only | 网关本地处理注册、就绪和心跳，无官方上游连接；检查 mode、desktop_connected 和 desktop_ready，不要求 upstream_connected:true |

local-only 只保留本机插件控制，官方手机页面不能连接，ZCode 显示的二维码不能作为手机可用的证据。设备入口信任本机进程，回环监听和 Origin 拒绝保持启用；本地 RPC 仍有令牌鉴权。本地注册标识不是官方注册，切回 relay 后 Desktop 可能重新注册，需要用户重新取得手机链接。已有设备标识不会因本地握手被清除，网关不读取或保存 pass_hash。

模型生成、登录及套餐额度仍依赖相应服务的网络可达性，本地模式只解决远控 relay 依赖。已检查本机 3.14.4 传输代码；3.14.0 是待用户验证的目标版本，不能提前宣称兼容已验收。

## 首次安装

1. 确认 Windows、Node.js 24+ 和公共根，在公共根运行 `npm ci --ignore-scripts --no-audit --no-fund`。不初始化或安装 `sources/` 的依赖。
2. 执行 Status。未配置才执行 Install；已有配置按后文复用或升级，不另建实例。

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{common_root}}/setup.ps1" -Action Status
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{common_root}}/setup.ps1" -Action Install
```

Install 注册当前用户登录任务，由 `wscript.exe` 执行公共数据目录的 VBS 桥，以无窗口方式启动并监督 PowerShell → Node，健康检查通过后写用户级 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`，广播环境变更，并部署公共 skill。成功输出 environment_broadcast:sent 表示广播 API 调用成功，不能据此宣称运行中的 Desktop 已重新读取变量。失败就读错误或 `gateway.error.log`，不把未启动的地址写到 MCP 的 env。

首次选择本地模式时用 `-Action Install -Mode local-only`，仍先完成两个插件的本机配置，最后才安排 Desktop 读取新环境。需要的是**启用 ZCode 的移动端远控服务来连接本机网关**，不需要手机连接或二维码可访问公网。

网关数据保留 `~/.zcode/tools/suian-zcode-gateway`，默认端口 `17329`。只有用户需要别的端口才指定 `-Port {{port}}`；上游默认 `wss://zcode.z.ai/ws`，实际使用另一 endpoint 时才指定 `-UpstreamUrl "wss://zcode.chatglm.site/ws"`。已有端口、上游和原环境备份保留，不放到插件各自的 `.local`。

3. 回到对应插件 skill，完成全部本机配置与检查。首次接入时 Desktop 尚未连接新网关是待生效状态，不是安装失败，也不能因此提前要求退出应用。全部配置完成后，才按后文交付重启步骤；原 Host 与模型验证留到用户重开后执行。

## 升级与旧目录迁移

**更新文件和加载新代码是两件事**。网关模块在进程中缓存，更新 Git 文件不会自动重载。Windows 隔离实验已验证运行中可替换 JS 与重命名源码目录，但不能据此保证其他进程、文件权限或原生扩展不会占用文件。更新前等待相关命名 worker 与 MCP 调用收尾，避免文件与调用混用版本；当前执行安装或升级的 Agent 留在原会话继续工作，不要求其先结束。

更新源码后，在公共根安装锁定依赖并执行 Status。旧任务和数据目录仍沿用网关身份；不要新建 `suian-zcode-common` 的第二个任务或清空配置。需要加载更新后的代码、迁移旧根路径或将旧 PowerShell 任务切换为 VBS 时执行 Restart，保留端口、上游、停止令牌和原环境备份。

RPC 升级还要检查 `rpc_available:true`。文件已更新但该字段为 false，说明旧进程尚未提供 RPC；按下述流程重载，不能让插件退回官方直连。两个插件与公共层一起更新，随后刷新 MCP 服务与 skill。默认使用公共数据目录的 config.json；自定义目录时把同一文件路径配置为命名插件的 gatewayConfigPath 和 MCP args 的 --gateway-config，不传令牌到 args/env。

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{common_root}}/setup.ps1" -Action Restart
```

若 `desktop_connected:true`，Restart 会拒绝切断远控。按下面顺序操作，**全过程保留 ZCode 和当前会话**：

1. 等相关插件的远控调用完成，再请用户在 ZCode 内暂停「移动端远程控制」。只关闭手机网页不够；不要求结束普通 Agent 任务或退出应用。
2. 用本机 Shell 执行 Status，确认 `desktop_connected:false`；然后执行 Restart。暂停期间原 Host RPC 不可用，不能依赖会话 MCP 来执行升级。
3. 完成剩余插件配置、skill 部署及本机检查。地址未变且升级前已连接正确网关时，请用户重新开启远控，检查 `desktop_connected:true` 与插件连接，无需重启应用。
4. 首次接入、修改 Desktop 启动地址或当前主进程仍持旧变量时，先交付全部配置结果与待验证事项，最后才提示用户择时重开。不要在重启前阻塞本机配置步骤。

无 Desktop 连接时直接重载网关。修改端口用 Restart 的 `-Port {{port}}`；脚本先检查并停止旧端口的实例，再启动新端口，保留控制令牌与原环境备份。只更新 README、skill 或业务配置且不涉及常驻网关代码时，无需 Restart 网关。

切换连接模式同样先暂停移动端远控，再用 `-Action Restart -Mode local-only` 或 `-Mode relay`。不指定 Mode 时保留已安装模式。模式切换不改变本机 relay 地址，已接入正确网关的 Desktop 重新开启远控即可；首次接入仍在所有配置完成后择时重开。保留上游地址，方便恢复 relay，不另建后台任务。

Restart 等网关与旧启动器正常退出，再更新同一任务并启动新根的代码。成功输出 `action:"restarted"`、`vbs_launcher:true`；启动失败照实报错。旧任务健康且有活跃 Desktop 时，Install 只复用，不强行改为 VBS；`launcher_update_required:true` 表示需要按上述步骤重载。旧公共网关 skill 只有归属与旧配置匹配才移除。

## 配置完成后，让 Desktop 读取新环境

变量在 **Desktop 主进程启动时**读取。MCP 的 env 只影响子进程。脚本写用户注册表后发送 WM_SETTINGCHANGE / Environment，通知 Explorer 等处理该消息的启动器刷新环境；已运行的 ZCode、终端及未处理通知的第三方启动器不会自动更新。

**应用重启是用户在配置完成后的生效操作，不是安装或升级的前置条件**。首次接入、启动地址改变或主进程仍持旧变量时，先完成所有本机配置与可执行的验证，明确报告「配置完成，原 Host 验证待重启」，再交付下面的方法。已连接正确网关且地址未变时跳过应用重启。

默认指导用户在配置完成后，自行安排时间保存工作，从托盘完整退出 ZCode，再用桌面或开始菜单的普通快捷方式打开。通常无需注销账户或重启 Windows。启用移动端远控后，用 Status 与插件 probe 确认实际生效，不能以广播成功替代连接检查。

若广播失败，或确认启动器仍传入旧变量，再使用下面的显式启动方法。广播失败会明确报错，但用户变量已写入或恢复，不回滚配置。在当前 Agent 仍可工作时先定位实际 Desktop exe，把 `{{zcode_exe}}` 替换成真实路径，不能填 CLI；命令交给用户在外部 PowerShell 执行，不能要求已退出的 Agent 继续配置。

```powershell
$env:ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL = [Environment]::GetEnvironmentVariable('ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL', 'User')
Start-Process -FilePath "{{zcode_exe}}" -WindowStyle Hidden
```

**PowerShell 只用于排障，不是永久启动要求**。Desktop 未连到网关时先检查是否启用远控、运行模式及日志；不能仅凭 desktop_connected:false 判定继承了旧变量。已有 Desktop 连接正确时不需要重复重开，也不要要求用户为环境生效注销账户。

## 分层验证与数据归属

执行 Status，分别检查配置、用户环境、网关、Desktop、上游与配对：

- `configured` / `user_env_matches`：公共配置与用户环境。
- `gateway_running` / `health_status`：实际健康接口是否可达；连接失败为 `unreachable`，未配置为 `not_configured`。
- `task_running`：计划任务是否正在监督启动链。Ready 不代表网关进程已停止。
- `vbs_launcher` / `launcher_update_required`：任务是否配置为 VBS、入口或监督链是否需要恢复。
- `desktop_connected`：是否有 Desktop 连入网关；这才是生效证据。
- `mode` / `desktop_ready`：运行模式与设备握手是否就绪；旧网关未返回 desktop_ready 时为 null。本地模式须确认 desktop_ready:true，TCP 连入不等于可调用。
- `upstream_connected`：官方上游是否连接；local-only 时为 false 属正常。`rpc_available`：运行中的网关是否提供 RPC。
- `upstream_paired`：官方链路是否配对，不标识具体客户端身份；`local_clients`：本地 RPC 客户端数。旧网关缺少后两字段时为 null。
- `paired`：Desktop 的有效配对状态，包含本地调用期间的虚拟配对，不能据此宣称手机仍在线。共存验收需用户实际确认手机还能操作。
- `restart_required`：配置或连接仍待就绪的汇总标志，不等于必须退出应用；远控暂停时也会为 true。按上述流程判断是重新开启远控、重载网关，还是配置完成后重开应用。

健康检查默认单次 5 秒，仅超时重试一次；连续超时报运行状态未知，不据此断言网关停止。必要时可给 Status 指定 `-HealthTimeoutSec {{seconds}}`（1–30）。不把历史 `LastTaskResult` 当作当前进程状态；分别读取本次健康结果和任务状态。

网关可达但任务未运行时，报告启动链需要恢复，不另开第二个实例。Restart/Remove 仍先检查实际 Desktop 连接；等待网关 HTTP 监听和启动器都退出后才改配置。任务正在运行但健康端点不可达时，重载或移除明确拒绝，先查启动日志。

重新开启远控后检查 Desktop 状态，再用手机验证配对；若刚重载网关导致手机断线，可刷新手机页面。需要应用重启时，这些检查留给重开后的会话，不能提前宣称全部生效。不要创建真实 Agent 任务探活。端口占用、网络或任务权限错误照实处理，不擅自提权、杀进程或改其他插件配置。

公共 DPAPI 与 Toast 实现按调用方 `dataDir` 存储状态：命名插件的授权密文、冷却、协议桥与 AUMID 仍在原位置，通知标题和排障提示词由命名插件提供。无需为代码迁移重新取得链接。MCP 的原 Host 工具读取公共网关配置，不增加 Toast；手机链接只留作旧凭据管理。诊断通知时读取调用方 skill，公共配置不承担业务文案或自动 Hook 配置。

不要回显 `sid/hash/mid`、授权链接、消息正文或整个网关 config。config 中的 `control_token` 用于本地 RPC 与停止接口鉴权；只由当前用户客户端读取并放入本地请求头，不放到 args/env/日志。插件无需手机远控链接，Desktop 的官方认证仍由宿主负责。

## 恢复原 relay / 移除

单独卸载一个插件保留公共层和网关。只有用户要求恢复直连或移除公共工具时才执行 Remove。

先完成或保存运行中工作并完整退出 ZCode，再执行 `setup.ps1 -Action Remove`。入口让网关自行退出，移除自己的任务，恢复安装前变量并广播变更；外部改过的变量保留且不广播。恢复后优先用普通快捷方式打开，仍持旧环境时再显式读取用户变量启动；没有原变量时读取结果为空，使用官方默认值。分别报告移除结果与用户重开后的实际状态。

Remove 只移除网关配置、运行用 VBS 桥和归属匹配的公共 skill，不删除任何插件的授权、通知身份、Hook 或 MCP 设置。

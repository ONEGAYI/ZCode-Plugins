---
name: configuration
description: 修改 ZCode 公共网关的连接模式、端口或上游，保留已有配置并安排 Desktop 环境生效。
---

# 公共连接配置

原生根为 `${ZCODE_SKILL_DIR}/../..`；源码模式沿用已确定的根。先读[路径与数据](../paths.md)，确认 ZCode 应用版本，再执行 setup.ps1 -Action Status。CLI 版本不能代替应用版本。

| 模式 | 版本范围与条件 |
| --- | --- |
| relay | 默认模式，连接官方上游并保留手机共存；公共插件 0.3.0 起支持 3.16 在线模式，需要已登录账号和可达的官方远控服务 |
| local-only | 旧版（已在 3.14.4 验证）直接安装；ZCode 3.16.2 须走 setup 的补丁安装流程（仅受支持包，见 [setup](../setup/SKILL.md)）。不连接官方远控服务，不支持手机页面，须验证 desktop_ready |

已有配置保留 `mode`，缺少该字段时按 `relay` 兼容；缺少 `relay_protocol_version` 时按 V1 读取。临时网络失败不自动切换模式。面板停在“启动中”或显示失败时，先结合错误和日志核对登录、网络与版本配置，不能仅凭界面状态判定原因。

**安装器按 Desktop 应用版本自动选择协议与官方地址**。`-ZcodeAppVersion {{app_version}}` 优先于宿主的 `ZCODE_APP_VERSION`；3.16 及以上选择 V2 和 `wss://zcode.z.ai/api/v1/remote/ws2`，旧版选择 V1。外部 Shell 没有宿主变量时，先核实实际 Desktop 版本，再显式传入，不能传随包 CLI 的版本。Status、Install、Restart 使用同样的版本参数。

未提供应用版本时，已有安装保留协议；旧配置没有协议字段时按 V1 兼容。首次安装也保留旧版 V1 默认行为，`protocol_source:legacy_default` 表示尚未按 Desktop 版本选择，不能据此确认适合 3.16。Agent 在首次安装或应用升级时必须传入已核实版本。可用 `-RelayProtocolVersion 1|2` 显式指定协议；与已知 Desktop 版本冲突、或官方地址与协议不匹配时，脚本在修改配置前报错。3.16 的 `-Mode local-only` 需要同时提供 `-ZcodeInstallDir`，且目标必须通过补丁预检（受支持包），否则在写任何配置前拒绝。

**Restart 保留协议，应用升级时迁移官方地址**。提供 3.16 应用版本后，旧 V1 官方地址会自动迁移到 V2；其他情况下保留已有上游，自定义地址不被替换。端口、控制令牌与原环境备份继续保留。暂停远控后执行，例如：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{common_root}}/setup.ps1" -Action Restart -ZcodeAppVersion 3.16.1 -NativePlugin
```

原配置为 local-only 而应用升级到 3.16 时：受支持包按 [setup](../setup/SKILL.md) 的补丁安装流程迁移并引导用户应用补丁；不受支持包在切换前会因补丁身份不符被拒绝，保持 `-Mode relay` 并按完整还原处理旧补丁。协议与真机共存的历史验证见[3.16 开发记录](../../../suian-zcode-app-mcp/docs/zcode-3.16-gateway-validation.md)，不能将隔离安装测试当作用户真机验收。

## local-only 开关与网关

3.16.2 的本地模式由**显式开关**决定，与应用包是否已打补丁是两个状态（补丁存在不等于启用）。开关载体（由 setup 生成的外部命令管理，Agent 不手改）：

- 标志文件 `{{data_root}}/.zcode/local-only.flag`（数据根为 Desktop 的 ZCODE_DATA_BASE_DIR，默认用户目录），首行为自动启动工作区；Desktop 启动时一次性求值，启动后补写无效。
- 环境变量 `ZCODE_LOCAL_ONLY=1|0` 可显式覆盖标志文件（进程级）。
- 网关地址通道 `ZCODE_LOCAL_ONLY_GATEWAY` 仅接受回环目标；3.16 local-only 网关默认端口 17331（与补丁内置默认一致，避开 relay 默认 17329），用户级 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 按既有纪律指向回环网关并保留原值备份。

**切回 relay**：执行 `Restart -Mode relay`（同前述暂停远控流程）。它一次完成：删除模式开关标志（`local_only_switch: disabled`）、网关配置切回 relay、环境值恢复——**不重写应用包，补丁保留**。手机连接恢复需要已登录账号与官方远控可达。

**完整还原**：用户关闭实例后执行 setup 生成的外部还原命令（公共数据目录 `local-only/restore-local-only.ps1`）：按本工具备份恢复原版 app.asar 并核对摘要，再复用 setup 的 Restart 事务恢复 relay 模式、环境与开关；端口、control_token 和原环境备份保留。已是原版时仍执行模式恢复，便于部分失败后重试。只有包与模式均恢复才报告成功；应用已恢复但网关失败时，保持 Desktop 关闭、排除错误后重试同一命令。

应用升级后包摘要变化：旧候选停止套用（外部命令在身份复核时拒绝），须等适配新包的工具版本；不要尝试对未知新包复用旧备份。

旧版首次 Install 可加 `-Mode local-only`、`-Port {{port}}` 或 `-UpstreamUrl {{url}}`；默认端口为 17329，V1 上游为 `wss://zcode.z.ai/ws`。已有配置按 setup 的暂停远控流程 Restart，只传用户要求改变的字段；原生模式加 `-NativePlugin`。切换本地模式前确认该应用版本在支持范围内，并说明手机连接将不可用。

自定义网关数据目录时，命名与 MCP 配置的 gatewayConfigPath 必须指向同一公共 config.json，不传 control_token。

用户环境变量由 Desktop 主进程启动时读取，MCP 的 env 只影响子进程。广播成功不代表已运行 Desktop 更新了环境。先完成全部配置和本机检查，再让用户择时重开；通常用普通快捷方式即可，不要求注销 Windows。

若广播失败或已确认启动器仍传旧变量，定位实际 Desktop exe，交付下面的外部 PowerShell 命令，不自行退出当前 ZCode：

```powershell
$env:ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL = [Environment]::GetEnvironmentVariable('ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL', 'User')
Start-Process -FilePath "{{zcode_exe}}" -WindowStyle Hidden
```

模型服务、登录和 GLM 额度仍需要各自服务可达。旧版本地模式只免除官方远控连接，不代表这些服务也可离线使用；手机可用性需实际验收。

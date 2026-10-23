---
name: debug
description: 诊断 ZCode 公共网关、启动任务、Desktop、上游和手机共存故障，不改命名或 MCP 业务规则。
---

# 公共网关排障

原生根为 `${ZCODE_SKILL_DIR}/../..`；源码模式沿用已确定的根。先读[路径与数据](../paths.md)，固定启动目录、启动方式和实际公共根，确认 ZCode 应用版本后再执行 Status。CLI 版本不能代替应用版本。

**安装与依赖诊断**用 `node {{common_root}}/depcheck-hook.mjs --scan-only`，业务进程加载公共层失败时按 PKG-01 契约的错误分类定位（均带 code 与 stage，在任何业务副作用前失败）：

| 分类 | code | 处置 |
| --- | --- | --- |
| 锚点 | anchor_missing | 技能/CLI 显式传 `--installed-plugins`；宿主入口核对 ZCODE_PLUGIN_DATA 注入 |
| 安装记录 | registry_missing / registry_invalid / common_not_installed / common_ambiguous | 原生重装或更新插件，修复安装记录 |
| 安装路径 | install_path_missing | 市场重装 common |
| 发布目录 | release_missing / release_invalid / entry_missing | 市场重装或更新，恢复发布目录 |
| 兼容 | api_incompatible / version_insufficient | 按市场配套版本更新 common 或业务 |

depcheck 自身的 issue code 语义见[setup 的依赖完整性检查](../setup/SKILL.md#依赖完整性检查stop-钩子-depcheck)。common 缓存整个缺失时 Stop 钩子随缓存消失，诊断走缓存外 Toast 执行器；不要在缓存内手工 npm 或复制文件补包。

**公共插件 0.3.0 起支持 ZCode 3.16 在线模式；3.16.2 的 local-only 走补丁安装流程（LO-04 起，仅受支持包）**，其故障按下方 local-only 分层表定位。在线模式需要已登录账号、可达的官方远控服务和 V2 配置。执行 Status 时用 -ZcodeAppVersion 传入已核实的 Desktop 应用版本，核对 relay_protocol_version、running_relay_protocol_version、protocol_update_required 和 upstream_update_required；protocol_source 为 legacy_default 时表示没有版本依据，不能据此判断 3.16 配置正确。先按[configuration](../configuration/SKILL.md)核对版本与配置，不能建议未经用户同意切换本地模式来解决连接失败。

| 层次 | 证据 |
| --- | --- |
| 配置与环境 | configured、user_env_matches；不回显完整 config |
| 网关 | gateway_running、health_status、mode、rpc_available |
| 代码与安装位置 | code_status、running_build、expected_build、candidate_build_id、active_build_id、candidate_pending_activation、gateway_path_matches；不以 health.version 判断插件版本 |
| 启动任务 | task_running、vbs_launcher、launcher_update_required；Ready 不代表已停止；任务参数与工作目录指向缓存外 launchers，不引用版本缓存 |
| Desktop | desktop_connected、desktop_ready；TCP 连入不等于原 Host 就绪 |
| 官方链路 | upstream_connected、upstream_paired；仅在已支持旧版的 local-only 模式中，上游 false 属正常 |
| 配对与调用 | paired、local_clients；paired 不能证明手机身份或手机仍在线 |

健康检查默认单次 5 秒，只对超时重试一次；连续超时报未知。必要时用 -HealthTimeoutSec {{seconds}}，不以历史 LastTaskResult 代替当前健康证据。

更新后必须从新公共根执行 Status。网关运行文件部署在缓存外（`~/.zcode/tools/suian-zcode-common/deployments/<buildId>`），任务经稳定启动器读取活动记录（`active-gateway.json`）启动部署目录；Toast 活动记录独立，网关切换不影响它。gateway_restart_required 表示网关代码、候选待激活、目录或启动链需要更新；code_status 为 unknown 表示旧进程未提供指纹，不能报告已加载最新代码；candidate_pending_activation 为 true 表示新候选已部署但活动记录未切换，按[setup](../setup/SKILL.md)安全重载。desktop_restart_required 只报告用户环境与目标地址不匹配；desktop_connection_required 单独报告未连接。restart_required 是汇总，不能一律解释为退出 Desktop；false 也不能替代业务验收。

网关可达但任务未运行时修复启动链，不另开实例。任务运行而健康不可达时先读数据目录中的 gateway.error.log 等启动日志；Restart/Remove 会拒绝在未知状态下修改配置。缺少 rpc_available 可能是旧进程，按[setup](../setup/SKILL.md)安全重载，不回退官方独立 terminal。

Desktop 未连接时，先检查远控面板的状态与错误，再结合日志核对登录、模式、网络和启动环境。3.16 还需区分官方 HTTP 鉴权与 WebSocket 连接是否成功。面板停在“启动中”不能直接证明网络不可达，desktop_connected 为 false 也不能直接证明环境继承错误。首次环境修改按[configuration](../configuration/SKILL.md)在配置完成后安排重开。

手机远端工作区忙时本地 RPC 返回 remote_workspace_busy，等待用户主动切回。隔离测试不等于真实手机共存，重新开启后需实际验收。不要创建真实任务探活，不擅自杀进程、提权或修改其他插件。

日志与报告不含消息正文、链接、sid/hash/mid 或 control_token，分别报告已核实、未核实和待用户验收事项。

## 间歇 RPC 故障日志

新诊断代码启用后，`gateway.error.log` 的每条失败记录为 JSON，`at` 是 UTC 时间；`event` 为 `gateway_error`。历史纯文本行保留，不据其文件修改时间推断每次失败时间。

- 用 `id` 关联网关记录与调用方的 `diagnostic.id`。命名插件在 `runner.log.jsonl` 中保留 `stage` 和 `diagnostic`；MCP 在结构化错误、会话工件详情错误及 GLM 部分查询错误中保留诊断，并向宿主收集的 MCP stderr 写 `tool_error` 记录。MCP stdout 仍只承载协议。
- `phase` 标识网关或解析边界；`clientPhase` 区分健康检查、连接、附着、Channel 初始化和 RPC 调用。`bridgeReady`／`bridgeInitialized` 在已知时区分桥就绪与协议初始化；`closeCode` 和 `source` 定位异常关闭来自 Desktop、上游或本地 RPC。
- `causeCode` 为受控底层原因；帧故障附实际 `seq`／`messageSeq` 与预期序号等数值。`bridge_degraded` 配合 `bridgeReason` 表示桥生命周期失效，不能直接认定帧正文损坏。外层既有 `reasonCode` 和结果未知语义保留，不自动重试写操作。
- `gatewayVersion`／`gatewayBuildId` 是实际运行网关身份；`desktopVersion` 来自成功的 bootstrap，可能只到应用报告的三段版本，不能当成完整安装包版本。未知原因只记异常类型，不收集原始异常文本、堆栈、正文或完整帧。
- 命名日志不可写时，stderr 另报 `runner_log_failed` 与文件系统错误码；原命令结果不因诊断写入失败而重发。

采样时保留失败前后同一时间窗口的上述记录及网关健康状态，使用诊断 ID 对齐；不要只摘外层错误码。新字段需要公共客户端与活动网关均加载新代码，命名／MCP 的落盘与输出也需对应消费者代码；本地源码修改不代表日常安装已更新。按正常发布与 setup 安全激活流程部署，禁止手工修改缓存或部署文件以绕过完整性清单。

## local-only 故障分层（3.16.2 补丁链路）

先核对 `status.profileId`、实际包版本/摘要与状态记录。`invalid_metadata`（退出码 17）表示记录损坏或格式不支持，保留状态和备份，先诊断；不要删记录后盲 patch。候选档案不符或降级被拒绝时，使用当前随包工具为实际受支持包重新准备候选。未知发行包需要新增经过验证的档案，不能手改包身份放行。


补丁工具与外部命令的每次失败都带明确 code 与指引；先按分类对位，再执行对应诊断。诊断入口统一为补丁工具 status（只读）：

```powershell
node "{{common_root}}/local-only/patch.mjs" status --target "{{zcode_install_dir}}"
```

| 分层 | 典型回执 | 诊断与处置 |
| --- | --- | --- |
| 包不支持/摘要变化 | `unsupported_package`（exe 版本不符或身份解析失败）、`digest_mismatch`（摘要不属于登记原版/补丁版） | 应用被升级或其它工具改写；停止套用旧候选/旧备份，等适配新包的工具版本，不做模糊匹配 |
| 宿主仍运行 | `running_instance`（外部命令/apply/restore 均列 PID） | 请用户从托盘正常退出后重试；工具与外部命令都不强退进程 |
| 备份或写入失败 | `backup_missing`、`write_failed`（含恢复 `recovery` 结果） | 按回执核对备份文件与目标摘要；恢复失败保留现场证据，不宣称已恢复 |
| 环境未生效 | 已 applied/activated 但 Desktop 行为不变 | 开关在启动时一次性求值：确认标志文件在启动前存在、重开 Desktop；检查是否有 `ZCODE_LOCAL_ONLY=0` 显式关闭。v3 开启时仅接受回环 WS 覆盖，旧补丁应先升级 |
| 完整还原未完成 | `local-only-restore-incomplete`（退出码 14），`application_original:true`、`gateway_restored:false` | 应用包已恢复，网关恢复失败；保留回执，保持 Desktop 关闭，排除网关错误后重试同一还原命令 |
| 网关未就绪 | 健康不可达或 `desktop_connected:false` | 核对网关任务/进程与端口（local-only 默认 17331）；网关恢复后 Desktop 自动重连（退避上限约 90 秒级） |
| Host 未附着 | 连接在但 `desktop_ready:false`、探针 `workspaceFound:false` | 标志首行工作区与实际打开的工作区不一致时 attach 失败；按外部命令生成参数核对工作区 |
| 模型服务不可达 | local-only 链路正常但会话无回复 | local-only 只免除官方远控连接；模型服务、登录与额度仍需各自服务可达 |

外部命令（apply/restore .ps1）的失败输出与上表同一分类（退出码 10/12/13；完整还原的网关步骤失败为 14），向用户转述时保留 code 与指引，不省略为“失败”。

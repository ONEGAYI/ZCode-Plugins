# suian-zcode-common — 公共基础能力

业务插件共用本目录的网关、远控协议、DPAPI、通知和消息投影。0.1.2 新增向后兼容的 Channel 监听入口与固定官方 V4 decoder；0.2.0 新增 Stop 依赖完整性钩子（depcheck）。PKG-08 起 depcheck 按发布契约判定：release.json 逐文件完整性、发布身份与 common API 兼容，不再检查生产 node_modules 或 junction（旧源码缓存形态报 release_missing，指向原生重装/更新）；修复提示词引导原生重新安装或更新，不是 npm。公共层不导入任何插件，调用方保留业务规则、通知文案、协议身份与配置数据。

## 约定

- 只有网关是常驻独立进程，其他能力是调用方导入的模块；提取代码不代表所有插件自动增加这些行为。
- 网关只绑定 `127.0.0.1`，不读取远控链接或 ZCode 凭据、不记录消息体。本地工作区复用窗口 Host 的一个物理桥，隔离客户端 RPC 编号；共存声明必须区分隔离测试与真实手机验收。实验性 terminal 模式通过调用方的 `getToken` 获取一次性终端 token，Desktop 直连官方 relay；同设备只允许一个 terminal，收到 KICKED 后停止连接，不自动争抢。
- 默认 relay 模式保留官方鉴权与手机共存；显式 local-only 模式仅处理回环 Desktop 的注册、就绪和心跳，不连接官方 relay、不使用传入的 pass_hash，也不宣称官方身份已验证。本地 RPC 仍要求当前用户 control_token；设备入口信任本机进程，拒绝浏览器 Origin。旧配置无 mode 时按 relay 兼容，不因网络失败自动切换。
- V2 从手机 bootstrap/建桥请求识别 `terminalClientSessionId`，共享桥初次继承该身份；本地先接入时生成连接内的归属标识。手机 bootstrap、内部 bootstrap 与建桥均映射到稳定的 Desktop 侧归属，防止 3.17.1 在手机页面重连时销毁在途 RPC。真实失配、relay 错误或终端更换清除手机身份；存在本地客户端时保留 Desktop 侧归属，最后本地客户端退出且手机未配对时释放。身份仅存于当前连接内存，不替代官方鉴权；不重放模型或改名调用。`terminal_sid` 只识别 relay 终端更换，不能作为 `terminalClientSessionId` 使用；虚拟配对不恢复旧手机身份。
- relay 的 `relayProtocolVersion`／配置 `relay_protocol_version` 缺省为 1；3.16 显式选择 2，转发 Desktop 一次性 token 与 MID，不另占 terminal。V2 消息严格区分 server_ts／client_ts，使用 Unix 秒；将 auth_ack 转成配对通知时不得带 device_sid。3.16 local-only 自 LO-04 起进入产品 setup：LO-02 交付完全短路补丁（登录/HTTP 注册/取令牌短路 + 回环 WS，网关字节不改，[补丁证据](../suian-zcode-app-mcp/docs/local-only/02-patch-evidence.md)）；LO-03 升级补丁 v2 补齐无登录冷启动自动触发、重连恢复与 signed-out 事件隔离（[生命周期证据](../suian-zcode-app-mcp/docs/local-only/03-lifecycle-evidence.md)）；LO-04 把预检、准备与外部应用命令接入 setup 产品流程并在真实构建包上完成 lab 端到端验证（[setup 集成证据](../suian-zcode-app-mcp/docs/local-only/04-setup-integration-evidence.md)）。放行以补丁工具字节身份判定为准，不泛化支持其它 3.16 包；在线 relay 与用户日常安装验收仍为未验项，旧模式测试不构成 3.16 离线证据。
- Windows 安装器按显式 ZcodeAppVersion 或宿主 ZCODE_APP_VERSION 自动选择协议与官方地址；没有新版本信息时保留已配置协议。升级时只迁移旧官方地址，自定义上游、端口、令牌和原环境备份保留；旧配置缺少协议字段按 V1 兼容，不能把无版本依据的默认值当作 3.16 就绪证据。
- 公共远控模块使用调用方提供的授权。DPAPI 明文只在进程内，保存位置由调用方的 `dataDir` 决定；不回显或复制凭据到公共配置。
- Toast 的两小时冷却、24 小时免打扰与互斥实现共用，状态范围由调用方的 `dataDir` 决定。协议、快捷方式和 AUMID 属于调用方，卸载一个插件不删除另一个身份。
- 自动化测试必须注入通知显示、剪贴板及打开工作区的系统边界，不激活真实协议或打开 ZCode 确认框。
- 登录任务用 `wscript.exe` 与数据目录内的 VBS 桥隐藏启动 PowerShell → Node，启动链必须等待子进程并传递退出码，保持异常重试有效。不要把常驻 WScript 指向 Git 工作树内的模板。
- 健康检查默认每次 5 秒、仅超时重试一次；连续超时报未知，不能掩盖为网关已停止。
- 网关健康和任务状态分别检查；任务 Ready 不代表网关停止。重载/移除检查实际连接，等待监听与启动器都退出后再修改配置。
- Windows 网关配置只管理当前用户任务和 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`。不退出或重启 Desktop；Restart/Remove 在 Desktop 已断开时才允许网关自行退出。
- 写入或恢复用户环境后广播 WM_SETTINGCHANGE / Environment；Status 与保留外部环境值不广播。使用 Unicode SendMessageTimeoutW，等待有超时，失败明确报出，不把已运行进程视为已更新。自动测试替换原生广播边界，不通知真实桌面。
- 为兼容既有安装，网关数据仍在 `~/.zcode/tools/suian-zcode-gateway`，任务名和健康接口 service 仍为网关身份。源码兼容路由 skill 部署到 `~/.zcode/skills/suian-zcode-common`，原生拆分技能由宿主加载；迁移不另建任务或丢失原环境备份。
- 网关运行文件部署在缓存外 `~/.zcode/tools/suian-zcode-common/deployments/<buildId>`（真实文件副本，不用 junction；buildId 只由部署清单内容决定，与路径无关）；计划任务指向 `launchers` 稳定启动器，经活动网关记录 `active-gateway.json` 选择部署版本与实际 Node。任务参数、工作目录与子进程路径不得引用版本缓存；EncodedCommand 外层必须 `exit $LASTEXITCODE`（`&` 调用脚本内的 exit 只退出脚本作用域）。
- 升级按规格 7.2 六步：暂存候选不改活动记录 → 查询状态（状态未知拒绝切换；远控忙时保留旧服务只报待激活）→ 切换事务以独占句柄锁文件互斥，忙退避重探（默认 60 秒上限；V2 连接空闲即升级关闭闪断，旧网关健康无 rpc_in_flight 字段或 V1 保守等连接断开），超时输出 remote_busy 放弃且记录不动 → 原子切换活动记录并复用原任务 → 核对健康 buildId/协议/模式后写环境广播 → 候选失败回退先前活动部署与自有配置（首次失败撤销本次新增注册、环境修改与部署）。回退失败不宣称恢复成功；Toast 活动记录独立，网关切换不触碰。
- 部署目录只含网关运行闭包（gateway/terminal/rpc-broker/vendor/ws 与清单、许可），不携带 client/locate/depcheck 等业务模块；业务 common 缓存缺失不从网关部署目录补代码。健康接口 Content-Type 带 charset=utf-8，中文部署路径经 PowerShell Invoke-RestMethod 不乱码。
- 新行为先写契约测试。Windows 设置测试使用隔离文件与模拟系统命令，不修改真实用户环境、计划任务或正在运行的 ZCode。
- `vendor/` 固定第三方来源并保留许可；不修改 `../sources/`。验证日志落忽略的 `.scratch/`，入库只保留脱敏汇总。

## 文件职责

local-only 按随包档案自动路由，历史记录兼容与新增档案流程见[规格](../suian-zcode-app-mcp/docs/local-only-routing-spec.md)及[验证记录](../suian-zcode-app-mcp/docs/local-only/10-routing-acceptance.md)。

新增发行包适配、维护注入锚点或扩展 setup 补丁路由时，使用项目技能 [zcode-local-patch-routing](../.agents/skills/zcode-local-patch-routing/SKILL.md)；仅安装已有补丁不进入此开发流程。

当前 local-only 补丁为 v3：最终 WS 地址统一按 URL 实际主机校验，完整还原通过现有 setup 事务恢复 relay 配置。v2 的历史证据不作为 v3 运行证明；当前摘要、真实升级与验收边界见[开发集成总验收](../suian-zcode-app-mcp/docs/local-only/09-development-acceptance.md)。

| 路径 | 职责 |
| --- | --- |
| gateway.mjs | 唯一 relay V1/V2 网关、一次性 token 转发、手机终端身份识别与内部握手/建桥继承、同进程 bootstrap 分流及健康状态 |
| gateway-build.mjs | 两栖指纹：部署布局按 deployment.json 清单校验摘要并输出 buildId（篡改即失败）；源码布局对固定执行依赖与启动链计算指纹；首次加载即固定，/health 不重读磁盘 |
| gateway-deploy.mjs | 网关运行闭包部署（PKG-05）：deployments/<buildId> 真实副本与逐文件摘要、launchers 稳定启动器安装、active-gateway.json 原子切换（独立于 Toast 记录）、部署校验与 CLI（--deploy/--status/--activate 等） |
| gateway-launcher.ps1 | 稳定启动器模板（复制到 launchers/run.ps1）：读活动网关记录启动部署目录的网关，等待子进程并传回退出码；缺失记录或部署时以退出码 3/4 明确失败；拉起前健康门探测（健康即幂等退出、fail-open），网关日志落 `logs/gateway-<yyyyMMdd-HHmmss>.{out,error}.log` 启动批次对，拉起前清理 7 天窗口外批次并迁移删除旧根目录单文件（0.8.0 起） |
| terminal-gateway.mjs / terminal-relay.mjs | 3.16 实验性独立终端网关、V2 token 建连、心跳及本机 RPC；授权提供方由调用方注入，未接入 Windows 安装流程 |
| .zcode-plugin/plugin.json | 原生公共插件元信息 |
| link.mjs | 源码开发工具：稳定公共入口和业务端 Node 包链接；正式安装、技能与诊断不依赖它 |
| skills/ | setup / configuration / debug，paths.md 统一位置与数据归属 |
| rpc-broker.mjs | 单一 Host 桥、RPC 编号与 v4 握手身份映射、手机虚拟桥与本地客户端分流；最后使用者退出后释放物理桥并消费退役通知 |
| rpc-diagnostics.mjs | RPC 失败诊断白名单、跨网关／调用方诊断 ID、受控帧元数据；不记录正文、凭据或会话标识 |
| gateway-client.mjs | 插件默认 connectHost/probeHost，本地配置与鉴权、RPC call／listen 附着、原事件参数与释放语义及明确失败；保留网关诊断和客户端失败阶段 |
| setup.ps1 / run.ps1 / run.vbs | 用户任务、变量、公共 skill；按 Desktop 版本选择 V1/V2，保留协议与迁移官方地址；任务注册登录 + 周期看护双触发器（`-KeepaliveIntervalMin` 默认 30、可配 5-1440、写入 config.json，重跑未传参沿用已装值；触发器形状不符自动重注册自愈，Status 报 keepalive_interval_min 与 keepalive_trigger_ok，0.8.0 起）；setup 按六步顺序部署候选、忙退避安全切换（升级事务锁互斥、空闲闪断或超时报 remote_busy）与失败回退；run.ps1/run.vbs 保留为源码开发直启链。LO-04 起 `-Mode local-only`（V2）按 `-ZcodeInstallDir` 补丁预检放行（仅受支持包，Invoke-PatchCli 守卫式定义供测试桩替换），准备候选后生成外部 apply/restore 命令（数据目录 `local-only/`）——setup 不执行 apply、不强退进程；local-only 默认端口 17331；切回 relay（Restart -Mode relay）删模式标志且不重写应用包 |
| remote.mjs | 官方 relay 鉴权、workspace bridge、Channel RPC 与分层探活 |
| auth-store.mjs | 调用方数据目录内的当前用户 DPAPI 授权存取 |
| title-policy.mjs | 当前用户跨插件的会话锁定策略：MCP 写入，命名插件读取 |
| project-context.mjs | 只读任务索引的会话项目／执行目录；冻结附加目录优先、旧版单目录兼容，拒绝远端、错 Host、相对目录和歧义归属，不写宿主库 |
| notifications.mjs / cooldown.mjs | Toast 显示、XML、两小时冷却、跨进程显示互斥 |
| client.mjs / client-install.mjs | 公共客户端运行期与安装期入口（PKG-01）：再导出三消费者实际使用的公共 API，第一代 commonApiVersion 为 1；导入无副作用，安装期函数独立入口避免运行期携带安装器 |
| locate.mjs | 薄定位器（单一源码，构建时分发到业务包）：按完整插件身份从安装记录定位 common，锚点优先级与失败分类见 docs/client-contract.md；进程内首次加载固定 common 根 |
| build-release.mjs | 发布目录构建（PKG-01）：客户端双入口及诊断/迁移/旧链接清理管理入口分别自包含打包（ws 与 vendor 内联）、许可组装、release.json 与 buildId、发布目录外的构建输入记录；npm run build:release -- --out <dir> |
| depcheck.mjs | suian 系列插件发布契约扫描（PKG-08）：release.json 逐文件摘要、身份、common API 兼容与最低版本；遗留 runtime 链接只报告状态不判损坏 |
| depcheck-hook.mjs / hooks/hooks.json | Stop 钩子入口与原生注册（async 不阻塞）；--scan-only 手动复查（只读不落盘）；hook 日志经 log-rotate.mjs 按天滚动并写入点自清理 |
| depcheck-prompt.mjs | Toast 摘要与修复提示词模板（缺失清单、缓存根、原生重装/更新步骤） |
| migration.mjs | PKG-08 迁移状态链：captureLegacyState 记录旧开关与路径（不含凭据），restoreLegacyState 只补缺失字段恢复开关；CLI --capture/--restore |
| legacy-cleanup.mjs | PKG-08 旧链接清理：归属核对（runtime/业务端 junction 指向 common）后只删链接本身；--inspect 出计划、--apply 执行，真实目录与他人目标保留 |
| toast-action.mjs | Toast 按钮协议入口：重扫后复制修复提示词并打开默认工作区；动作日志经 log-rotate.mjs 按天滚动并写入点自清理 |
| log-rotate.mjs | jsonl 事件日志按天滚动（`<族>-<yyyyMMdd>.log.jsonl`）、行内嵌版本字段与 7 天写入点自清理；toast-executor 单文件快照内联等价实现不导入本模块 |
| notification-action.mjs | 复制调用方提示词、打开固定默认工作区 |
| notification-install.mjs | 按调用方身份安装/移除协议桥、快捷方式与 AUMID |
| windows.mjs | 公共 PowerShell 执行与安装用文件/系统边界 |
| prerequisites.mjs | 两插件共用的安装检查：Node 版本、公共依赖；仅命名调用方要求 sqlite3 CLI 只读 JSON 能力 |
| ui-capabilities.mjs | ZCode 应用版本与 MCP Apps MIME 判定；不注册业务资源或工具 |
| vendor/ | 固定消息投影和远控协议库，见 NOTICE.md |
| vendor/conversation-wire.js / vendor/conversation-wire.sources.json | 固定官方 V4 topic 帧组装／编码及快照／历史页 schema；49源blob、ref和构建SHA，不代表安装版本逐字节一致 |
| vendor/LICENSE-ZCode / vendor/NOTICE-ZCode-current.md / vendor/LICENSE-zod | 官方Apache-2.0完整许可／NOTICE与构建内Zod MIT许可，禁止改成自有MIT归属 |
| SKILL.md / README.md | 源码兼容路由与公共模块接口，完整操作流程在对应 skills/ 技能 |
| CHANGELOG.md | common 插件发行记录，版本范围与 local-only 安装及兼容边界 |
| tests/ | 回环网关、隔离 Windows 配置、远控、DPAPI、通知、依赖完整性判定、不自举契约、PKG-01 公共加载契约（定位器分类、入口导出面、导入纯净、构建确定性与自包含）及 PKG-05 稳定运行时（部署指纹与幂等、篡改校验、稳定启动器隔离场景、候选三态、拒绝切换、失败回退、首次撤销、旧任务迁移与 Toast 记录独立） |
| tests/gateway-rpc.test.mjs / tests/plugin-link.test.mjs | 真实回环call／listen客户端隔离和释放、市场版本一致及独立缓存公共升级契约 |
| tests/gateway-deploy.test.mjs / tests/stable-launcher.test.mjs | PKG-05 部署契约（内容指纹、自包含回环、运行中健康不冒充磁盘新代码）与稳定启动器（旧任务参数依赖已删除缓存的红色证明、缓存删除后仍可启动、活动记录切换部署、中文空格路径、健康门与启动批次日志） |
| tests/terminal-gateway.test.mjs / tests/terminal-relay.test.mjs | 3.16 终端握手与心跳、单桥复用、Host 会话查询、KICKED 及回环访问控制 |
| tests/depcheck.test.mjs / tests/depcheck-hook.test.mjs / tests/toast-executor.test.mjs | PKG-08 发布契约扫描：无 node_modules 发布产物不再误判（红色证明在案）、缺文件/错身份/API 不兼容检出、Hook 通知链与缓存外执行器快照对齐 |
| tests/log-rotate.test.mjs / tests/setup.test.mjs | jsonl 滚动与留存窗口（含 executor 内联实现）、看护触发器形状（双触发器、CIM 识别、自愈与 fallback）（0.8.0 起） |
| tests/migration.test.mjs / tests/legacy-cleanup.test.mjs | PKG-08 迁移链：开关与路径记录（不含令牌）、恢复不覆盖自定义字段、端到端记录→清理→部署→恢复；链接清理归属核对、只删链接、真实目录与他人目标保留 |
| experiments/ | 仅发合成 auth_init 的研究探针，不自动执行 |
| local-only/lab-env.mjs | LO-01 隔离环境单一数据源：目录树、进程级 env 集（ZCODE_DATA_BASE_DIR 指向 .zcode 父目录、清除官方 relay 覆盖变量、LO-03 增 ZCODE_LOCAL_ONLY_GATEWAY 与网关配置端口一致）、引用既有适配档案的包身份、启动器与 lab 网关配置渲染（LO-03 增 CDP 调试端口——自动附命令行 --user-data-dir——与 --open-workspace 直开工作区） |
| local-only/lab.mjs | LO-01 lab CLI（setup/check/launch/report/teardown）：身份核对先于写入、路径归属 check、启动器启动副本并写运行记录（每次启动前重渲染，手工改 launcher 会被覆盖）、report 按 exe 枚举进程并分类回环/外部连接、teardown 只杀记录 PID 树并等待退出后清理；系统边界参数化注入供契约测试 |
| local-only/profiles.mjs / profiles/ | 补丁随包注册表与逐包档案：按平台、exe 版本、原版 asar SHA-256 唯一精确路由；档案独立维护修订号、入口与注入实现，新增真实包保留旧档案及回归 |
| local-only/patch-env.mjs | 通用备份/状态后缀与失败退出码；兼容转出既有 Windows 3.16.2 档案注入接口，不作为多包全局版本源 |
| local-only/patch.mjs | status/prepare/apply/restore 统一按档案识别；格式 1 记录兼容、格式 2 绑定档案/平台；候选与目标同档案后才允许写入，旧补丁自备份升级；拒绝跨包/降级/损坏状态，保留运行实例及摘要检查 |
| tests/local-only-routing.test.mjs | 两合成包独立入口/修订号路由、历史状态/候选兼容、同包升级与还原、跨档案/降级/未知包/损坏记录拒绝且目标不写入 |
| tests/local-only-lab.test.mjs | LO-01 契约测试：目录树/启动器/清单、身份不匹配拒绝、越界路径检出、副本篡改检出、BOM 与 WQL 转义回归、teardown 只清 lab 内 |
| tests/local-only-fixture.mjs | LO-03 提取的契约共享 fixture：真实产物锚点切片（含 v2 注入点）与合成 asar 构造；顶层预置压缩名占位（let b2）防注入体向模块顶层引入裸 var 的回归 |
| tests/local-only-patch.test.mjs | LO-02 契约测试：真实锚点切片注入与 ESM 语法检查、asar 往返/确定性/unpacked 保留、fuse wire 解析、status 三态、身份/锚点失配拒绝、apply 全链与重复识别、运行实例拒绝、restore 摘要核对与目标变化拒绝 |
| tests/local-only-lifecycle.test.mjs | LO-03 生命周期契约：v2 注入点输出与原版失败契约（官方路径零改写、开关关闭零行为变化）、P1 门控 vm 三态与回环约束、P6 自动启动 vm 行为（幂等/重试/零启动）、v1→v2 升级三路径 |
| tests/local-only-3.16.3.test.mjs / tests/local-only-3.17.1.test.mjs | 新发行包档案契约：精确身份路由、摘要不符拒绝、旧档案保留、P1/P6 运行体 vm 行为；3.17.1 增真实锚点切片全链注入与 node --check 语法验证 |
| package.json / package-lock.json | 固定 Node/ws 版本与测试入口 |
| docs/ | [共享运行时与 Release 规格](docs/shared-runtime-release-spec.md)、[开票索引](docs/shared-runtime-release-tickets.md)及脱敏验证证据；历史与本次验证分开 |
| docs/client-contract.md | PKG-01 公共加载契约：锚点事实、定位规则、失败分类、导出清单、release.json 与构建输入说明及业务迁移指引 |
| docs/pkg01-client-contract-evidence.json | PKG-01 红绿与全量回归的脱敏验证证据；完整日志在忽略的 .scratch/ |
| docs/pkg05-gateway-stable-runtime-evidence.json | PKG-05 稳定运行时的红绿、回退与全量回归脱敏证据；完整日志在忽略的 .scratch/ |

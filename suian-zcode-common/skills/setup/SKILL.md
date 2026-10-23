---
name: setup
description: 安装、升级、仅检查、迁移或移除 ZCode 公共运行时；发布包完整性诊断与旧源码安装迁移。
---

# 公共插件安装与升级

原生根为 `${ZCODE_SKILL_DIR}/../..`，使用前规范化绝对路径。先读[路径与数据](../paths.md)。

发布形态的安装与升级**不执行 npm、不建立目录链接**：原生市场安装/更新交付的发布目录自带全部运行文件，公共层由宿主安装记录定位（PKG-01 契约）。npm 与 link.mjs 仅用于源码开发，见文末[源码开发](#源码开发npm-与-link-仅源码)。

## 确认 ZCode 版本

先从桌面端的应用信息或实际启动程序确认 ZCode 应用版本，随包 CLI 的版本不能代替应用版本。

**公共插件 0.3.0 起支持 ZCode 3.16 在线模式**，手机共存和核心会话操作已通过验证。安装器按 Desktop 应用版本选择协议：3.16 使用 V2，旧版使用 V1。宿主提供 ZCODE_APP_VERSION 时可自动读取；在外部 Shell 中调用时，使用 -ZcodeAppVersion 传入已核实的应用版本。具体配置与验证边界见[configuration](../configuration/SKILL.md)。

## 远控开关操作

在桌面端打开移动端远程控制面板并开启服务，出现等待连接或已连接的状态后，再检查插件连接。插件不要求手机扫码或保持在线；暂停远控时在面板内点击“停止”。

**ZCode 3.16.2 的 local-only 需要走补丁安装流程**（见下节）：仅支持补丁工具按字节身份判定的受支持包，其余 3.16 包明确拒绝，不能泛化。relay（在线）模式需要登录 ZCode 账号并能连接官方远控服务；面板停在“启动中”或显示失败时，结合面板错误与日志检查登录、网络及版本配置，不能直接认定网络不可达，也不能把 local-only 当作网络故障的静默回退。已支持的旧版如何使用本地模式，按[configuration](../configuration/SKILL.md)处理。

## local-only 安装（ZCode 3.16.2 受支持包）

用户选择 local-only 时，Agent 负责预检与准备并交付外部命令；**应用补丁与激活由用户在关闭目标实例后自行执行**，Agent 不强退承载当前会话的 ZCode、不启动等待助手。准备成功不宣称已应用或已生效。

安装命令（一次性完成预检、候选准备、网关安装与外部命令生成）：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{common_root}}/setup.ps1" -Action Install -ZcodeAppVersion "{{app_version}}" -Mode local-only -ZcodeInstallDir "{{zcode_install_dir}}" -LocalOnlyWorkspace "{{workspace}}" -NativePlugin
```

- `-ZcodeInstallDir`：用户指定的 ZCode Desktop **原安装目录**（外部应用的目标；不确定时先让用户确认，不要猜测）。
- `-LocalOnlyWorkspace`：local-only 自动启动的工作区；省略时外部命令仍会激活开关，但自动启动不生效。
- 仅当补丁工具 `status` 判定目标为受支持包（字节身份匹配）时放行；版本未知或摘要不符会明确报错并给诊断指引。已有网关实例时沿用既有暂停远控/安全重载纪律，本流程不迁移日常 relay 网关数据。

**回执语义表**（区分真实状态，不把上一步当下一步）：

| 回执 | 含义 | 下一步 |
| --- | --- | --- |
| 预检通过（`patch_state: original`） | 目标是受支持原版包，候选已准备（`local_only.state: prepared`） | 交付外部命令，向用户说明退出安排 |
| `already_patched` | 目标已是当前版本补丁（无需再准备） | 只需激活开关与网关就绪检查 |
| `prepared_upgrade` | 目标是旧版本补丁，升级候选已自备份准备 | 交付外部命令（apply 会自动还原后重应用） |
| 待应用 | 外部命令已生成（`apply_script`/`restore_script`），用户尚未执行 | 等待用户关闭全部实例后自行执行 |
| 已应用未生效 | 外部命令回执 `applied` 且 `activated:true`，但 Desktop 尚未重开 | 提示用户用原快捷方式重开 |
| 验证就绪 | 重开后网关健康 `desktop_ready:true` 且原 Host 探针通过 | 汇报完成；仅连接不等于业务验收 |

外部命令产物在公共数据目录 `local-only/` 下：`apply-local-only.ps1`（复核身份→应用→写开关标志→回执，工具自带运行实例检查，绝不强退进程）与 `restore-local-only.ps1`（复核→按备份恢复原版→复用 setup 切回 relay 配置并关闭开关→回执）。向用户交付时说明：**先保存工作并从托盘退出该安装目录的全部 ZCode 实例，再在外部 PowerShell 执行 apply 脚本，然后用原快捷方式重开**。重开后按上表“验证就绪”检查实际模式/端点、desktop_ready 与原 Host 探针。完整还原若只完成应用恢复，回执为 `local-only-restore-incomplete`，排除网关错误后可重试；不得宣称全部恢复。

补丁工具自动按平台、exe 版本和原版 asar 摘要选择随包适配档案，回执 `profileId` 标识所选方案。已 patch 包通过状态中的原版摘要识别；历史格式 1 无须手动迁移。新增版本适配后仍保留旧档案；未知包不会自动套用最新规则。不要让用户手选脚本，也不要使用已移除的 `--package-identity` 绕过支持清单。

Status 传 `-ZcodeInstallDir` 可附加只读补丁状态报告（`local_only_patch` 字段）。日常排障见[debug](../debug/SKILL.md)的 local-only 故障分层。

## 首次初始化

1. 确认 Windows、Node.js 24+ 和用户选择的业务插件。市场安装业务插件会自动安装 common；核对 common 与所选业务插件已启用（`zcode plugins list --json`，按完整 id 核对 rootPath/dataPath/enabled）。
2. 运行发布完整性检查（只读，不写配置、不注册任务或通知、不启动网关）：

```powershell
node "{{common_root}}/depcheck-hook.mjs" --scan-only --installed-plugins "{{installed_plugins_json}}"
```

   安装清单路径按 paths.md 从实际宿主存储根确定。`skipped:null` 且 `ok:true` 才说明本次已安装插件的发布目录与公共 API 兼容性检查通过；`no_manifest` / `bad_manifest` 表示未完成检查，不能按零项问题判正常。有 issue 按下方[依赖完整性检查](#依赖完整性检查stop-钩子-depcheck)的分类修复，不在版本缓存内手工执行 npm、创建链接或复制文件。

3. 仅在需要网关（自动命名、会话操控、选区评论）时部署服务；文本编辑器不部署网关。**部署前确认连接模式**：默认 relay 按本步安装；用户要 local-only 且应用为受支持包时，改走[local-only 安装](#local-only-安装zcode-3162-受支持包)的完整流程，不在 relay 装成后再改。执行 setup.ps1 -Action Status -ZcodeAppVersion {{app_version}}，未安装才 Install。版本来自前面的实际 Desktop 核对；不要依赖外部 Shell 未必具备的宿主环境。原生模式为 Install/Restart 加 -NativePlugin：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{{common_root}}/setup.ps1" -Action Install -ZcodeAppVersion "{{app_version}}" -NativePlugin
```

Install 把网关运行文件部署到缓存外 `~/.zcode/tools/suian-zcode-common/deployments/<buildId>`（真实文件副本，buildId 只由内容决定），并把登录任务指向缓存外稳定启动器（`launchers/gateway-launch.vbs` → `launchers/run.ps1`）；启动器读取活动网关记录 `active-gateway.json` 选择部署版本与实际 Node，任务参数、工作目录和子进程路径不引用版本缓存。健康检查通过后才写用户级 ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL 并广播变更。保留网关数据、端口、令牌和原环境备份，不另建 common 的第二个任务。同 buildId 重复安装幂等；候选启动失败时回退先前活动部署，首次安装失败则撤销本次新增的任务、配置与部署并明确报告未安装成功。原生模式不复制全局技能，只移除归属匹配的旧公共技能。

4. 回业务 setup 完成全部配置。改变模式、端口或上游时先读[configuration](../configuration/SKILL.md)。首次连接未生效时仍先完成本机配置，原 Host 验证留到用户重开后。

**候选、活动与运行代码是三回事**：版本缓存里的发布目录只是候选；`active-gateway.json` 指向的活动部署决定下次启动加载什么；正在运行的进程由健康指纹证明。文件已更新不代表当前进程已换代，也不要用 health.version 判断。

## 升级

原生插件通过原生管理器更新，不能在版本缓存里 git pull。更新后重新执行 zcode plugins list --json，以新的 rootPath、dataPath 读取并执行 setup，不沿用当前会话加载的旧缓存路径。源码安装先确认干净工作树和基线，再 fast-forward 更新，不覆盖本地修改。公共层和已选择业务插件使用配套版本。

由 Agent 代为更新原生插件时，更新对象是市场副本仓库 suian-zcode-plugins，不是版本缓存：先核对来源分支并拉取远端最新 HEAD，本地修改或分叉时说明原因，不强制覆盖；副本不含 Git 元数据时改用 CLI 的 `plugins marketplace update suian-zcode-plugins` 刷新。CLI 不依赖 PATH：定位用户实际安装的 Desktop 目录，用随应用提供的 zcode CLI（如 `resources/glm/zcode.cjs`，由 Node.js 24+ 执行相同参数），不下载另一份。更新顺序为先 common 后业务插件，命令形如 `zcode plugins update suian-zcode-common@suian-zcode-plugins`，只对实际已安装的插件执行。

更新后**不再重装依赖或修链接**：重跑第 2 步发布完整性检查确认新缓存就绪，再从新公共根执行 Status -ZcodeAppVersion {{app_version}}，核对 code_status、candidate_pending_activation、gateway_path_matches、protocol_update_required、upstream_update_required 与 gateway_restart_required。代码已变化、候选待激活（candidate_build_id 与 active_build_id 不同）、目录不匹配、协议待升级或旧进程没有指纹时安排安全重载；不要用 health.version 或仅有的连接正常来判断已加载新代码。只修改文档或 skill 时，代码指纹不变；是否重开 Desktop 看环境变更与实际连接，不能仅凭 restart_required 汇总标志决定。

**已有配置 mode 为 local-only 时，升级必须补核补丁状态并交付决策**：Status 加传 `-ZcodeInstallDir`（不确定时先向用户确认安装目录），读取 `local_only_patch`，向用户交付三选一决策：受支持包按[local-only 安装](#local-only-安装zcode-3162-受支持包)迁移到 V2 补丁流程；包不受支持时按[configuration](../configuration/SKILL.md)完整还原并保持 relay；用户明确选择暂缓时，如实报告补丁未应用、local-only 未验证。保留 local-only 配置而补丁未应用时，不得把升级汇报为完成。

需要重载网关时，等插件调用收尾后直接执行 Restart -ZcodeAppVersion {{app_version}}，原生模式加 -NativePlugin。脚本先以切换事务锁防止并发升级，再忙退避重探：V2 下远控连接空闲（rpc_in_flight 为 0）即用升级关闭闪断，Desktop 连接层会自动重连；忙时指数退避、默认 60 秒上限（-BusyTimeoutSec 可调），超时输出 restart_deferred 与 remote_busy 并保留旧服务，稍后重试即可。旧网关健康无 rpc_in_flight 字段或 V1 协议时保守等待连接断开，用户可随时手动暂停远控让出窗口。脚本等待网关和启动器退出后才更新任务，保留端口、控制令牌、原环境备份及自定义上游；应用升级时同步协议与官方地址。单纯重载且未提供新版本时，保留已配置协议。业务安装器同时更新通知脚本的代码路径。

网关经 Restart 生效；地址未变且 V2 协议时 Desktop 连接层自动重连，手机端通常随官方 relay 重连配对（真实手机表现以验收为准，未恢复时在手机上重进即可）。首次接入或改变启动环境时，先交付本机配置与待验证报告，最后请用户保存工作、择时从托盘退出并重开 ZCode，再开启远控。重连后继续业务模型、探活及临时暂停的恢复，不能把待恢复项当作升级完成。

local-only 配置下的升级完成判据与 relay 不同：以重开后网关健康 `desktop_ready:true` 且原 Host 探针通过为准（回执语义见[local-only 安装](#local-only-安装zcode-3162-受支持包)）；网关健康检查通过不代表 Desktop 已连上本地网关。

新进程加载新的公共模块；既有 MCP 仍可能是旧版，按 MCP setup 安排断开重连或择时重开并核验。只改文档或不涉及常驻代码的配置时可说明无需重载。配置、模型选择、开关等业务状态在升级中保留，配置变化不会触发依赖重装。

## 仅检查

`depcheck-hook.mjs --scan-only` 是唯一必经的检查入口：不写文件、不注册系统对象、不启动网关。缺包（cache_missing/release_missing 等）由宿主重新安装或更新修复；服务未初始化才执行对应 setup，二者不混为 npm 缺失。

## 依赖完整性检查（Stop 钩子 depcheck）

common 0.2.0 起自带原生 Stop 钩子（hooks/hooks.json → depcheck-hook.mjs），每轮对话结束自动扫描已安装 suian 系列插件的**发布契约**：发布清单 release.json 的逐文件完整性、发布身份、common 公共 API 兼容与最低版本约束。检查实现只用 Node 内置模块与包内相对导入，不经 node_modules 解析，依赖全丢时钩子仍可运行并报警。

| issue code | 含义与修复 |
| --- | --- |
| cache_missing | 插件缓存目录缺失：市场重装/更新该插件 |
| plugin_files_missing | .zcode-plugin/plugin.json 缺失或不可解析：市场重装 |
| release_missing / release_invalid | 缓存不是发布包形态（旧源码缓存或安装损坏）：迁移到发布版本或市场重装 |
| identity_mismatch | 发布清单身份与安装条目不符：市场重装 |
| file_missing / file_digest_mismatch | 发布文件缺失或被改动：市场重装/更新恢复发布目录 |
| common_not_installed | 业务依赖 common 但清单无条目：安装 common |
| api_incompatible / version_insufficient | 公共层与业务版本不配套：先更新 common，必要时一并更新业务 |

发现缺失时弹 Windows Toast（同一数据目录 2 小时冷却），按钮点击复制修复提示词并打开 ZCode；提示词的修复步骤就是上表（原生重装/更新），不是 npm。修复后手动复查：

```powershell
node "{{common_root}}/depcheck-hook.mjs" --scan-only --installed-plugins "{{installed_plugins_json}}"
```

Toast 身份（协议 suian-zcode-common://fix、AppID SUIAN.SuianZcodeCommon.Toast、开始菜单快捷方式"ZCode 公共基础插件"）由钩子在首次报警前自动幂等注册；setup.ps1 -Action Remove 不清理该身份，明确移除时调用 notification-install.mjs 的 removeToastAssets。

每个外置 Toast 身份保存自己的 `pluginsFile`（实际安装清单的绝对路径）。钩子从宿主 `ZCODE_PLUGIN_DATA` 推导，独立调用显式提供；按钮无需宿主环境，现场读取该清单，不猜默认 HOME。清单不可用或旧身份无锚点时，按钮仍复制排障提示，但返回 `registry_unavailable`，不宣称检查通过。旧 common 身份可从当前公共根导入 `depcheck-hook.mjs`，调用 `ensureToastIdentity({ dataDir, pluginsFile })` 重新登记；`dataDir` 沿用身份文件原值，`pluginsFile` 使用实际清单。title 身份按 title setup 重跑安装命令。

**common 缓存整体缺失时**：Stop 钩子随缓存一起消失，不能再指望它报警；已部署的缓存外 Toast 执行器（`~/.zcode/tools/suian-zcode-common/toast/executor.mjs`）仍在，点击旧通知按钮即可现场重扫并复制修复提示。诊断与修复都不会自动安装 npm 包、拉取源码、创建链接或重启 Desktop。

## 旧源码安装迁移

先确定旧根、原启用状态和所选业务插件，按下述顺序执行；旧源码与运行数据保留作回退。

1. **记录开关和路径**（迁移记录缓存外保存，不含凭据；网关 config 只记路径、模式与端口）：

```powershell
node "{{common_root}}/migration.mjs" --capture --legacy-root "{{legacy_root}}" --title-config "{{title_config}}" --gateway-config "~/.zcode/tools/suian-zcode-gateway/config.json" --record "{{private_dir}}/migration-record.json"
```

   含凭据的备份不回显或入库。命名的临时暂停与恢复按其 setup 执行，暂停单独记为待恢复项。

2. **安装配套发布版本**：确认原生 common 与业务插件已安装并启用，跑仅检查确认发布目录就绪。已有网关按上方升级流程执行 Restart -NativePlugin 更新部署；Toast 稳定运行时与各业务 Toast 模板由安装流程幂等部署，不重复注册 Hook/MCP（业务注册迁移由各自安装器的 --legacy-root 参数处理，同一 matcher 内他人 Hook 保留，已有原生字段优先不被覆盖）。
3. **清理旧 junction**：先看计划再执行，清理只删归属确认的链接本身，真实目录、其他插件注册和用户源码保持：

```powershell
node "{{common_root}}/legacy-cleanup.mjs" --inspect
node "{{common_root}}/legacy-cleanup.mjs" --apply
```

4. **重连并恢复**：按业务 setup 重连 MCP/远控；网关数据、端口、模式、令牌及原环境备份全程保留。最后恢复记录的开关：

```powershell
node "{{common_root}}/migration.mjs" --restore --record "{{private_dir}}/migration-record.json" --title-config "{{new_title_config}}"
```

   恢复只补缺失字段，不覆盖已有自定义字段。迁移后复读全局设置和旧技能；技能残留时，读取其中注入的根路径，规范化分隔符和绝对路径后比对归属，只删除已确认属于旧根的副本。

**首次 Git 源到 ZIP 的恢复限制**：更早的旧版本没有 Release ZIP。从旧源码安装迁移到发布版本后如需回退，须恢复原市场来源并按旧流程重新 npm 安装与建链，不能承诺无 setup 回退；公共数据默认不回滚。

## 移除

单独卸载业务插件保留 common 和网关。只有用户明确要求恢复官方直连或移除公共工具，才执行 setup.ps1 -Action Remove。Remove 与 Restart 共用忙退避：远控忙时等待（V2 空闲闪断同理），超时输出 remove_deferred 与 remote_busy 且不动配置与任务，稍后重试。空闲或已退出时入口让网关自行退出，移除自己的任务，恢复原用户环境并广播。外部改过的变量保留。

Remove 不删除业务授权、通知身份、Hook、MCP 或标题策略。若用户还要求清理业务端链接和运行入口，只删除已确认的链接本身，不递归删除目标。报告移除结果和重开后待验证事项。

**原生卸载的数据语义以实际宿主为准**：插件更新（update）保留 data；默认彻底卸载可能删除宿主 data 目录（配置、状态、授权），需要保留数据时先备份到缓存外，或使用宿主已核实的 keep-data 入口；缓存外自有服务（网关部署、Toast 稳定运行时、网关数据目录）不随插件卸载删除，须按上面的 Remove 流程单独移除。不能笼统承诺原生卸载一定保留配置，也不能宣称全部删除。

## 源码开发（npm 与 link 仅源码）

从源码开发或调试时，公共根执行 `npm ci --ignore-scripts --no-audit --no-fund`（MCP 根同理；命名自身无 npm 依赖），再运行 `node link.mjs --plugin-root <业务根>` 为源码模式建立公共入口链接。npm 清理 node_modules 会移除业务端链接，需重新建立。该流程仅服务于源码工作树，正式发布入口、技能与诊断一律不依赖它；不要把源码测试夹具当作正式缓存安装或用户验收。研究用 sources 不初始化依赖。

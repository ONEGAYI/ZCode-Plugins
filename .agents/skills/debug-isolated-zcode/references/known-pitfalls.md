# 隔离 ZCode 环境踩坑详录（K1-K30）

每条按 症状 / 根因 / 解法 / 来源 记录。来源指向 `suian-zcode-app-mcp/docs/local-only/` 的脱敏证据文档；编号在合并或删除时保持连续。
未定位的事项如实标注"根因未定位"，与已证实事实分开。

## K1 首次启动卡欢迎页（provider 门禁与 workspace 参数）

- **症状**：隔离副本首次启动停在欢迎/引导页，无登录态时脚本自动化无法继续；远控面板等入口不可达。
- **根因**（两层）：欢迎引导是首启流程的一部分，完成状态记在 userData 内（具体持久化文件名仍未定位）；3.16.2 还会因 `providerFamilyDomain` 为空或"无登录且无可用 Provider"打开登录门禁（K28）。`--open-workspace` 参数可绕过首启引导（裸位置参数无效，见解法），provider 门禁另需 K28 的配置。
- **解法**：用 `--open-workspace="<路径>"` 交付工作区——官方 `desktopDeepLinkUrl.ts:224-244` 只识别 `--open-workspace <path>` 与 `--open-workspace=<path>` 两种形式，**裸位置参数被忽略**（这一点于 LO-07 后由源码核对并修正 lab 工具）。`lab.mjs launch --workspace <路径>` 已内置该形态。lab 无登录验收还需写入受控 provider 与 `providerFamilyDomain` 后重启（K28）。远控 attach 的 workspace 与窗口一致时 connectHost 才能通过（不一致报 "Requested local workspace is not open in the Desktop window"）。
- **CDP 补充**：CDP 可越过 UI 直接调用官方 IPC 验证 main 链路；CDP 连接需给 Electron **命令行**传 `--user-data-dir`（env 不够，见 K11）。人工点击一次、CDP 直调 IPC 是备选手段。
- **来源**：LO-02、LO-03 升级（[生命周期证据](../../../../suian-zcode-app-mcp/docs/local-only/03-lifecycle-evidence.md) §3.1/§6）；LO-07 补 provider 门禁（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §4）。

## K2 PowerShell 5.1 启动链与 JSON BOM 五坑

- `powershell -Command` 不收尾部 `$args` 传参——参数改走 `-File` 或环境变量。
- 写出的 JSON 带 BOM 导致读回解析失败——统一 `utf8` 无 BOM 写入。启动器写出的 `run-state.json` 也带 BOM，Node 侧 `JSON.parse` 前先剥 BOM。
- WQL 查询里的反斜杠路径未转义导致进程枚举失败——WQL 字符串内 `\` 写成 `\\`。
- `detached + windowsHide` 启动 PowerShell 会静默不执行——改引导器同步等待 + `stdio:'ignore'` 防管道继承挂起。
- teardown 后进程退出有延迟，立即删目录报 EBUSY——等待退出 + 重试。
- **来源**：LO-01 回归测试与 `.scratch/logs/local-only-lab-*.log`；LO-07 补 run-state BOM。

## K3 单实例锁：userData 隔离即可避免锁转交

- **症状**：担心副本启动把命令行转交给日常窗口（Electron 单实例）。
- **事实**：锁基于 userData（官方源码 index.ts:2010；e2e 注释 desktopRuntimeEnv.ts:62-67 佐证）；设 `ZCODE_DESKTOP_USER_DATA_DIR` 指向 lab 内目录后，副本与日常 Desktop 并存无转交（LO-01/LO-02 均实证）。
- **来源**：LO-01/LO-02（[基线证据](../../../../suian-zcode-app-mcp/docs/local-only/01-original-baseline-evidence.md)、[补丁证据](../../../../suian-zcode-app-mcp/docs/local-only/02-patch-evidence.md)）。

## K4 ZCODE_DATA_BASE_DIR 指向 `.zcode` 的父目录

- 语义：`ZCODE_DATA_BASE_DIR > HOME > homedir()`（官方 paths.ts:14-15），它的值是**数据根目录**（home 层级），`.zcode` 在其下派生。设成 `.zcode` 本身会得到 `.zcode/.zcode` 双层。
- lab 惯例：`ZCODE_DATA_BASE_DIR` = lab 的 `home/`，`HOME`/`USERPROFILE` 同指它。
- **来源**：LO-01（[基线证据](../../../../suian-zcode-app-mcp/docs/local-only/01-original-baseline-evidence.md)）。

## K5 local-only 开关在模块加载期一次性求值——标志文件晚了不生效

- **症状**：补丁已 apply、标志文件已存在，`zcode:start-web-remote-control` 仍抛 `auth-required`。
- **根因**：补丁 P1 的 `__LO_MODE` 在 main bundle 模块加载时**一次性求值**；进程启动早于标志文件创建时 `__LO_MODE` 固化为 false，getLogin 短路（P2）不触发。判定优先级：env `ZCODE_LOCAL_ONLY` > `{dataBaseDir}/.zcode/local-only.flag` > `{APPDATA}/ZCode/local-only.flag`。
- **解法**：先创建标志（或设 env）再启动进程；顺序错了就重启进程。复现与对照的方法：在 vm 沙箱执行 P1 注入代码，分别在标志存在/不存在两种输入下取 `__LO_MODE`，再以真实进程验证重启后的行为差异。
- **来源**：LO-02（[补丁证据](../../../../suian-zcode-app-mcp/docs/local-only/02-patch-evidence.md) §实测补充）。

## K6 "官方不可达"构造：死代理 + 观察，注意 TUN 残留

- 构造：启动时给 exe 传 `--proxy-server=http://127.0.0.1:<死端口>`，Chromium 栈请求全部失败（日志可见 `net::ERR_PROXY_CONNECTION_FAILED`）。
- **注意**：机器上有 TUN 代理时，仍会观察到 `198.18.x.x:443` 之类外部连接（TUN 虚拟网段）——这是经系统代理的连接，不等于官方远控直连。证据里区分"经 TUN 的连接"与"对官方端点的直连尝试"，双方都记录。
- **来源**：LO-01（[基线证据](../../../../suian-zcode-app-mcp/docs/local-only/01-original-baseline-evidence.md)）。

## K7 网关端口：lab 用 17331，日常占 17329

- 日常网关常驻 127.0.0.1:17329（mode=relay，V2）。lab 网关独立端口 17331 + 独立 config（`gateway.mjs --config <lab>/gateway/config.json`），两套互不影响。
- **来源**：LO-01~LO-05 lab 基线（[MCP 闭环证据](../../../../suian-zcode-app-mcp/docs/local-only/05-mcp-closure-evidence.md) §4）。

## K8 判断"子代理是否还活着"：任务索引不可靠，文件活动为准

- **症状**：SendMessage/TaskOutput 报"无活动任务"，但子代理实际仍在运行收尾。
- **解法**：以其 worktree `.scratch/` 最近文件 mtime 为存活判据（5 分钟内有新文件 = 在工作）。发信失败不等于代理死亡。
- **来源**：本系列协调过程实录（LO-02 收尾期误判后纠正）。

## K9 无登录首屏 UI 不触发远控启动链（renderer 触发缺口）

- **症状**：补丁就绪、开关开启，但 Desktop 起来后远控不启动、网关 `desktop_connected:false`。
- **根因**：官方 `manager.start` 仅由 renderer IPC（`zcode:start-web-remote-control`）触发；无登录态首屏不出远控入口，main 侧无人调用 start。main 日志零条目佐证（链路完全未启动，不是启动失败）。
- **解法**：补丁 v2 P6 自动启动——开关开启且标志文件首行（或 env `ZCODE_LOCAL_ONLY_WORKSPACE`）给出工作区时，main 初始化后轮询触发 `li.start`（getStatus 非 idle 即停，与 renderer 手动 start 并存幂等）。冷启动闭环已实证（[生命周期证据](../../../../suian-zcode-app-mcp/docs/local-only/03-lifecycle-evidence.md) §3.1）。CDP 调 IPC 仍是有效的链路级诊断过渡手段。
- **来源**：LO-02 具名缺口（[补丁证据](../../../../suian-zcode-app-mcp/docs/local-only/02-patch-evidence.md) §10）；LO-03 补齐。

## K10 向 minified 模块顶层注入 var 会与产物压缩名冲突

- **症状**：注入后副本进程启动即退出、零远控日志；对注入结果跑 `node --check` 报 `SyntaxError: Identifier 'b2' has already been declared`。
- **根因**：注入体的 `var b2` 位于 `if` 块内但 var 提升到模块顶层，与产物顶层已有的 `let b2` 冲突；minified bundle 顶层占满 1-2 字符压缩名。
- **解法**：注入求值逻辑全部收进 IIFE（函数作用域隔离），模块顶层只声明 `__LO_*` 唯一前缀变量；契约 fixture 顶层预置 `let b2` 占位，使 `node --check` 用例能抓同类回归；每次 prepare 后对真实产物注入结果跑一次 `node --check`（fixture 通过不代表真实包通过）。
- **来源**：LO-03（[生命周期证据](../../../../suian-zcode-app-mcp/docs/local-only/03-lifecycle-evidence.md) §6 踩坑 1）。

## K11 lab launcher 每次启动前重渲染；启动始终显式传 userData

- **症状一**：手工给 `launcher.ps1` 加的 env/参数在下次 `launch` 后消失。
- **根因**：`launchLab` 每次启动前用当前工具版本重渲染 launcher，覆盖手工修改。
- **解法**：lab 需要的启动条件一律走 `lab.mjs` 选项（已固化：启动始终传命令行 `--user-data-dir`，CDP 独立可选；`--workspace` 内部渲染为 `--open-workspace="<路径>"`；网关 env 自动与 `gateway/config.json` 端口一致）。
- **症状二**：CDP 端口在监听但 `/json/list` 空。**根因**：Electron 41/Chromium 146 对默认数据目录下的远程调试有安全缓解，必须命令行传 `--user-data-dir`（仅设 env 不够）；PowerShell `Start-Process -ArgumentList` 数组元素不自动加引号，含空格路径需自行内嵌双引号（单引号会成为路径字面量）。
- **来源**：LO-03（[生命周期证据](../../../../suian-zcode-app-mcp/docs/local-only/03-lifecycle-evidence.md) §6 踩坑 3/4）。

## K12 手动启动早退：先区分单实例锁与初始化失败

- **症状**：自写 PowerShell 启动器（从 `lab-env.json` 的 `values` 复刻全部隔离 env，`Remove-Item` 清 relay 覆盖变量，追加 `ZCODE_LOCAL_ONLY_GATEWAY=<非回环>`，再 `Start-Process` 副本 exe 并重定向日志）启动后，进程只写一行 crash-capture 日志（约 357 字节）便静默退出；三次复现，无任何远控日志。
- **已证实**：已有实例存活时，第二进程的 `requestSingleInstanceLock` 返回 false，随后退出码 0。结束持锁实例后，同一数据目录的锁重新返回 true；本轮未复现“强杀后残留锁”。历史三次运行缺少完整的持锁进程记录，不能逐次反推旧根因。
- **另一种失败**：没有已有实例时，原脚本因缺少 `--user-data-dir` 触发 ARMS 路径错误，进程存活但无主窗口（K13）。补上参数后，手动启动及非回环覆盖验证均成功。
- **解法**：lab 启动前按副本 exe 路径枚举进程；即使 `run-state.json` 缺失，有存活实例也明确拒绝并列出 PID。关闭自己的 lab 实例后重试，不删锁文件或强退日常 Desktop。临时探针已从副本移除。
- **原生覆盖**：设置非回环 `ZCODE_LOCAL_ONLY_GATEWAY` 后，真实主进程选择 `ws://127.0.0.1:17331/ws`，lab 网关达到 `desktop_ready=true`；不扩大到任意 env 组合。
- **来源**：LO-03 原始脚本可从子代理会话库 `part` 表恢复（Bash 的 `$.state.input.command`、Write 的 `$.state.input.content`）；2026-10-22 对照与日志见[启动器诊断](../../../../suian-zcode-app-mcp/docs/local-only/08-launcher-diagnostics.md)。

## K13 重置 userData 后 workspace 直开不创建主窗口；判断窗口存在要用 CDP targets

- **症状**：lab 重置 userData/sessionData/home 后 `launch --workspace` 启动，主进程存活但零 `[web-remote-control]` 日志、P6 不触发；补丁版与**原版 asar 对照**同样无窗口——与补丁无关的环境行为。userData 完成过一次首启初始化后（哪怕由原版完成）再启动一切正常。
- **根因**：ARMS 在 ESM 依赖导入期读取 Electron userData，早于主模块按 env 执行 `app.setPath`；只设 `ZCODE_DESKTOP_USER_DATA_DIR` 时可报 `Failed to get 'userData' path`。主窗口创建前等待的 `armsInitPromise` 被拒绝，进程存活但不创建窗口。旧启动器只在启用 CDP 时传 `--user-data-dir`，开启调试会掩盖此故障。
- **解法**：启动器始终显式传隔离的 `--user-data-dir`；全新目录可直接启动，无需先跑一轮普通首启或预置标记。Desktop 工作区用具名 `--open-workspace` 参数（K1）。判断窗口时，启用 CDP 用 `/json/list` 的 page target，无 CDP 看主窗口 dom-ready 日志；不拿进程存活或 `MainWindowTitle` 代替。
- **补充**：窗口存在但停在 provider 欢迎门属于 K28，仍需独立配置。数据目录隔离也不隔离当前用户的协议/右键菜单注册，须按[启动器诊断的边界说明](../../../../suian-zcode-app-mcp/docs/local-only/08-launcher-diagnostics.md#5-windows-注册表隔离边界)处理。
- **来源**：LO-04 历史观察；2026-10-22 无 CDP 契约及原生冷启动红绿证据见[启动器诊断](../../../../suian-zcode-app-mcp/docs/local-only/08-launcher-diagnostics.md)。

## K14 复用 setup 契约测试桩做 lab 端到端 runner 的三个对齐点

- **场景**：需要在 lab 语义下真实执行 setup.ps1 与补丁工具、又保持真实任务/注册表/广播不动时，从 `tests/setup.test.mjs` 提取 systemFixture 作 Windows 边界桩（lab runner 脚本留在 `.scratch/` 不入库）。
- **对齐点**：① 桩 fixture 的 `build.id` 必须是部署 CLI 从构建目录实算的 candidateBuildId（`gateway-deploy.mjs --status`），不是 release.json 的构建指纹——部署清单输入与构建清单不同，setup 健康核对按前者；`version` 字段也要带上。② 移除 `Invoke-PatchCli` 桩后 setup.ps1 的守卫式默认定义自动生效，补丁工具即真实执行（apply/restore 拒绝语义同理可证）。③ 从测试文件正则提取 fixture 时注意文件是 CRLF（正则 `\`;\r?\n`）；Windows 边界桩模板对属性访问要防御 `Set-StrictMode`（StrictMode 随调用栈传播到桩函数）。
- **来源**：LO-04（[setup 集成证据](../../../../suian-zcode-app-mcp/docs/local-only/04-setup-integration-evidence.md)，三次红灯后对齐）。

## K15 lab 中独立 MCP/CLI 进程必须注入 lab HOME/USERPROFILE

- **症状**：宿主 stdio 语义下以日常 env 启动 lab 安装的 app-mcp CLI，title-policy 等按 `homedir()` 落盘的路径写到**日常** `~/.zcode/tools/…`（越界）。
- **根因**：`title-policy.mjs` 等公共实现用 `os.homedir()` 取默认目录；真实宿主里 MCP 子进程继承宿主 env（lab Desktop 进程树的 HOME=lab home），独立验证进程没继承就落到日常主目录。
- **解法**：独立验证时给 CLI 进程显式注入 `HOME`/`USERPROFILE` 指向 lab home（与 `ZCODE_PLUGIN_DATA` 一同注入）；收尾用目录 mtime 复核日常 `session-titles` 无新写入。
- **推论**：插件进程内 `connectHost` 的默认网关配置同样按 `homedir()` 解析。lab 里必须另有 `<lab>/home/.zcode/tools/suian-zcode-gateway/config.json`；只放 `<lab>/gateway/config.json` 时，side-editor 的评论状态报"公共网关健康检查失败"。
- **来源**：LO-05（[MCP 闭环证据](../../../../suian-zcode-app-mcp/docs/local-only/05-mcp-closure-evidence.md) §4）；LO-07 补网关配置落点（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §2）。

## K16 lab CLI 会话库落点是 ZCODE_SESSION_DB_PATH

- **症状**：app-mcp 外置 config 按日常默认习惯把 sessionDbPath 指到 `<lab>/home/.zcode/cli/db/db.sqlite`，`sessionMode`/`sessionTitle` 报 `unable to open database file`（该路径根本不存在）。
- **根因**：lab env 注入的 `ZCODE_SESSION_DB_PATH=<lab>/session-db/db.sqlite` 才是 Host 侧 CLI 会话库实际落点（与 LO-03 当时观察不同，以启动后实际落盘为准）。
- **解法**：写外置 config 前先枚举 lab 内 `*.sqlite` 实证落点；task index 在 `home/.zcode/v2/tasks-index.sqlite`。
- **来源**：LO-05（[MCP 闭环证据](../../../../suian-zcode-app-mcp/docs/local-only/05-mcp-closure-evidence.md)，两次 start_session 部分失败后定位）。

## K17 probeHost 需要 workspacePath；漏传时网关报 Invalid workspace attachment

- **症状**：`probeHost({gatewayConfigPath})` 稳定返回 `gateway_rpc_failed / Invalid workspace attachment`，而同参数的 `connectHost` 成功——看似网关缺陷。
- **根因**：probeHost 是 connectHost+probe 的组合，其 attach 消息的 `workspace_path` 直接来自参数；漏传时为 undefined，网关（rpc-broker `acceptLocal`）按协议正确拒绝。
- **解法**：`probeHost({gatewayConfigPath, workspacePath})` 两个都传。
- **来源**：LO-05（[MCP 闭环证据](../../../../suian-zcode-app-mcp/docs/local-only/05-mcp-closure-evidence.md)，两次复现后回源码定位）。

## K18 无登录态 Host 拒绝创建会话：需 personal provider 才可验 start_session

- **症状**：local-only 链路全部就绪（paired/ready/探针 ok），MCP `start_session` 仍报"当前没有可用的模型供应商和模型，请先登录或配置 API Key。"（Host 侧 zcodeAgentService 的 provider not ready）。
- **根因**：provider 全部来自账号（登录态）或 personal provider 配置；无登录 lab 里 providerCount=0，Host 在创建会话入口直接拒绝（与网关/补丁无关）。
- **解法**（验证构造，非产品步骤）：写 `<lab home>/.zcode/v2/provider_config.json`（schemaVersion 1，api-key 型 openai-chat-completions 指向回环 mock，含 personalModelIds 与 defaultModelSelection）。受理（accepted）后轮次仍可能失败——补齐 manual model 配置见 K20；无登录主界面还需 K28 的 `providerFamilyDomain`。
- **来源**：LO-05（[MCP 闭环证据](../../../../suian-zcode-app-mcp/docs/local-only/05-mcp-closure-evidence.md) §3）；LO-06/LO-07 补全配置与门禁。

## K19 宿主插件发现根是 `<storage>/cli/plugins`，且必须 `enabledPlugins[id]=true`

- **症状**：插件按早期指南装到 `plugin-home/cli/plugins`、`installed_plugins.json` 也写了，Stop Hook 却从不触发；换成 `home/.zcode/cli/plugins` 也不行；插件面板/UI surface 不出现。
- **根因**（三路径探针实测）：lab 里宿主运行期插件根由 `ZCODE_STORAGE_DIR`（lab 注入 `<lab>/storage`）派生为 `<storage>/cli/plugins`。Host 的 `readEnabledPluginRecords` 只加载 `<lab>/home/.zcode/cli/config.json` 中 `plugins.enabledPlugins[<id>]===true` 的第三方记录。`plugin-home` 只适合无宿主注入的独立 MCP 验证。
- **解法**：插件装 `<lab>/storage/cli/plugins`（cache + installed_plugins.json + `data/<plugin-id>/config.json`），并写入 `home/.zcode/cli/config.json` 的 `plugins.enabledPlugins`。判定是否生效：最小 SessionStart/UserPromptSubmit 探针写 marker，以 marker 出现为加载证据。
- **补充**：同一安装形态对 side-editor 的 UI surface 同样有效（`plugins/list` 返回 `enabled:true` 与 `uiSurfaces:["editor"]`）。手工 cache 安装在"个人"页显示"市场来源已缺失。插件仍可使用，但暂时无法更新。"属预期提示；面板入口见 K25。
- **来源**：LO-06（[Stop 命名验收证据](../../../../suian-zcode-app-mcp/docs/local-only/06-title-acceptance-evidence.md) §2；探针 A/B/C：仅 storage 路径 21 次触发，其余 0）；LO-07 补 UI surface。

## K20 受控 provider 要让轮次真正完成，必须补齐 manual model 配置

- **症状**：受理成功、轮次失败、受控服务零调用（`Turn execution failed` / `processing_input`）。只声明 provider 与模型 ID 仍然失败。
- **根因**：`manualProviderModelRules[].config` 缺失/不完整时，Host 在执行输入阶段无法构造模型（properties/optionSpecs 是模型创建必需项）。
- **解法**：补 `properties`（`contextWindow`、`supportsJsonSchemaOutput`、`supportsNativeWebSearch`、`supportsMidConversationSystem`、`inputFormat.supportsImage/Video/Pdf`）与 `optionSpecs`（`reasoningLevel.values` + `map`、`maxOutputTokens.max`）。补齐后受控轮次真实完成、助手消息落库（LO-06 实证 14 次流式 turn + 8 次非流式标题调用）。
- **3.16.2 实测修正**：`optionSpecs.reasoningLevel.map` 可接受 `"{}"`；`optionSpecs.maxOutputTokens` 只接受 `max`，带 `map` 会报 Zod `unrecognized_keys` 并整份配置降级为空（与官方源码快照的 schema 不同，以实际运行包为准）。
- **来源**：LO-06（[Stop 命名验收证据](../../../../suian-zcode-app-mcp/docs/local-only/06-title-acceptance-evidence.md) §3）；LO-07 修正（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §4）。

## K21 失败轮不触发 Stop Hook；命名失败要分层核对

- **事实**（源码 + 实测）：Stop Hook 只在轮次正常完成（模型响应落盘）后运行；轮次失败走 TurnError 路径，不触发 Stop。因此"轮次模型不可达"不会产生任何命名记录，也不会误报命名成功。任务索引可能留下 `meta_json 非法` 的宿主日志（失败轮特有）。
- **命名自身失败有两种时延与口径**：命名模型不可达约 60s 后 `status:"failed"`、`reasonCode:null`（模型错误无 stage，无 Toast，属已交付契约）；网关不可达在秒级返回 `reasonCode:"gateway_unreachable"`（远控类失败，才有 Toast 路径）。
- **来源**：LO-06（[Stop 命名验收证据](../../../../suian-zcode-app-mcp/docs/local-only/06-title-acceptance-evidence.md) §5）。

## K22 title 原生安装会改写 HKCU 协议键；lab 需预建开始菜单目录

- **症状**：lab 里跑 `title/dist/install.mjs --native-plugin`，报"无法保存快捷方式 … Start Menu\Programs\…lnk"（DirectoryNotFoundException）；成功后用户级 `suian-zcode-title` 协议键被改成 lab 路径。
- **根因**：安装器按 `$env:APPDATA` 写开始菜单快捷方式，lab appdata 无 `Microsoft/Windows/Start Menu/Programs`；协议键是 HKCU 全局，不随 lab 隔离。
- **解法**：先 `mkdir -p "<lab>/appdata/Microsoft/Windows/Start Menu/Programs"` 再安装；安装后把协议键还原为日常值并留还原记录（协议激活链路不触发）。只做命名链验收时可只跑 `--check-only`，但离线与 Toast 资产会不完整，失败字段可能出现 `toast:"unavailable"`。
- **来源**：LO-06（[Stop 命名验收证据](../../../../suian-zcode-app-mcp/docs/local-only/06-title-acceptance-evidence.md) §6）。

## K23 `lab.mjs teardown` 会删 lab `home/`；重启要清整棵进程树

- **症状一**：为做"首启初始化轮→重开"而 `lab.mjs teardown`，随后插件安装记录、provider 配置、local-only 标志全部消失。
- **根因一**：teardown 的 removable 列表包含 `dirs.home`、`storage`、`session-db` 等运行数据（保留 app 与日志）。
- **解法一**：首启后只杀 `run-state.json` 记录的进程树（taskkill /T /F）并删 `run-state.json`，再 `launch`；需要彻底清理时才 teardown（并预期重建安装）。
- **症状二**：旧实例还在时再次 `launch`，新进程因单实例锁把参数转交给旧实例后退出，CDP 目标仍是旧的（欢迎页）；run-state 里的 PID 也可能已失效。
- **解法二**：按 **exe 路径**枚举并结束所有 lab 进程，确认计数为 0、端口释放后再 `launch`；把 cleanup 建立在整个进程树上，而非单条 PID。
- **症状三**：`teardown --purge` 后仍残留 `patch-candidate/`（约 300 MB 级）。
- **解法三**：purge 后核对 lab 目录；补丁候选不属 teardown 清理列表，手工删除。
- **来源**：LO-06（[Stop 命名验收证据](../../../../suian-zcode-app-mcp/docs/local-only/06-title-acceptance-evidence.md) §8）；LO-07 补重启与残留（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §9）。

## K24 网关闭环重连时长不固定；Stop 延迟窗内杀网关要提前起 watcher

- **观察**：lab 网关重启后，Host 重新配对耗时随环境变化——LO-06 约 50 秒，LO-07 约 7 秒。把"秒级重连"当固定事实会误判故障；就绪只看 `/health` 的 `desktop_connected/desktop_ready`。
- **时序坑**：Stop Hook 有 8 秒派发延迟；若先发消息再开始轮询模型日志，往往在检测到调用时 8 秒已过、命名已完成（杀网关晚到）。要构造"网关不可达"必须在发消息前起 watcher，看到新的 turn 模型调用就立即杀（LO-06 用 100ms 轮询脚本，观测到调用后 0.65s，杀进程总耗时约 2.3s）。
- **来源**：LO-06（[Stop 命名验收证据](../../../../suian-zcode-app-mcp/docs/local-only/06-title-acceptance-evidence.md) §5）；LO-07 补重连时长波动（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §3.4）。

## K25 第三方面板不在推荐位；从侧栏内嵌市场打开

- **症状**：插件已 `enabled:true` 且 `plugins/list` 返回 `uiSurfaces:["editor"]`，但侧栏"新标签页"的"应用插件"只显示 PDF/演示/表格等内置项，找不到"文本编辑器"；主导航"插件市场"页也没有"打开"按钮。
- **根因**：该区块只渲染 `useUiPluginRecommendations` 的推荐位，推荐来自远端客户端配置（`uiPluginRecommendations`），local-only 离线时为空；主导航市场 `embedded=false`，不提供 `onOpenUi`。带 `onOpenUi` 的是侧栏内嵌市场（`查看所有插件` 打开的 plugin-market 标签）。
- **解法**：侧栏点 `查看所有插件` → `个人` → 插件卡片 `打开`。打开后宿主创建独立 sandbox 实例（webview + iframe），页面标题即插件 surface 标题；同一插件在新会话再打开会得到新实例（会话级绑定）。手工 cache 安装的"市场来源已缺失"提示不影响打开。
- **来源**：LO-07（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §2）。

## K26 CDP 驱动混用主 renderer、OOPIF 与截图会出错

- **症状**：`document.querySelector('[contenteditable=true]')` 突然为 null；`Page.captureScreenshot` 对插件 iframe 报 `CDP -32000 / only top-level targets`；按固定 target 索引操作时点到了旧 sandbox；`elementFromPoint` 命中的元素与截图坐标对不上。
- **根因**：每打开一个 MCP App，`/json/list` 会增加一组 `type:"webview"`（shell，可截图）与 `type:"iframe"`（插件页面，可 eval/输入）；沙盒关闭或新建时索引整体移动。主窗口是 `type:"page"`。索引按列表顺序，不是稳定 ID。截图与 DOM rect 都按 CSS 像素，DPR 只影响像素尺寸；截图里的视觉坐标不能反推点击坐标。
- **解法**：① 每次操作前重新 `/json/list`，按 `type` + URL/标题选目标；页面操作选 iframe，整窗像素选最外层 webview，主对话/标签操作选 page。② 交互前把查询限制在可见实例：`r.width>0 && r.x>=0 && r.right<=innerWidth && r.bottom<=innerHeight`（隐藏的侧栏 frame 仍挂载在视口外）。③ 菜单/下拉若是 Radix 触发，DOM `.click()` 往往不打开（需要 pointerdown），改用标准 `Input.dispatchMouseEvent` 的 mousePressed/mouseReleased；普通按钮 `.click()` 可触发 React 处理。④ 键盘选区用 `Input.dispatchKeyEvent`（`Control+Home`、`Shift+End` 等带正确 modifiers），不直接改 CodeMirror state。
- **来源**：LO-07（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §3.1；SE-01/SE-03 Native 方法亦为同一结论）。

## K27 UI 工具的 build 审批与运行期权限口径

- **症状**：插件页面加载后所有工具调用等待原生审批，自动化超时；或 `start_session` 返回 `permission_mode:"yolo"`，`read_session` 的 `session.permission_mode` 却读回 `build`。
- **根因**：MCP App 页面的 `callTool` 仍走 Host 权限判定，`build` 模式下逐个需要审批（`readOnlyHint` 不自动放行）；CLI 会话库的持久 mode 与运行期 Runtime mode 可能不同步，`read_session` 读的是持久字段。
- **解法**：纯验收可用 `start_session` 的 `permission_mode:"yolo"`（验证构造，非产品默认）或对精确工具名预授权；判断运行期权限看 composer 标签（"完全访问"）与实际调用结果，用实际调用结果判定 Runtime。
- **来源**：LO-07（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §4；SE-01 Native 审批边界见 `suian-side-editor/docs/se01-native-verification.md`）。

## K28 无登录主界面的 providerFamilyDomain 门禁与 3.16.2 配置形状

- **症状一**：personal provider 已配置、`start_session` 成功，但窗口仍停在"欢迎来到 ZCode"登录页；`lab.mjs launch --workspace` 也绕不过。
- **根因一**：`useProviderAvailabilityLoginEntryGuard` 的条件是 `!providerFamilyDomain || (!user && !hasUsableProvider)`。全新 lab 的 `<lab>/home/.zcode/v2/setting.json` 没有 `providerFamilyDomain`，第一项为真，门禁无条件打开。
- **解法一**（验证构造）：在 `setting.json` 写入 `"providerFamilyDomain":"zai"`（或其他已支持族），完全重启 Desktop；personal provider 的模型出现在 composer（本轮的 `mock-model`）后主界面可进入。
- **症状二**：`provider_config.json` 含 `manualProviderModelRules[].config.optionSpecs.maxOutputTokens.map` 时，`desktop.err.log` 报 `[provider-config] Personal Provider Config 加载失败 … ZodError unrecognized_keys ["map"]`，配置降级为空。
- **解法二**：3.16.2 的 `maxOutputTokens` 只写 `{ "max": <正整数> }`；`reasoningLevel` 的 `values` + `map` 保留（K20）。
- **来源**：LO-07（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §4）。
- **推测边界**：provider 门禁与"首次引导完成"是两套状态，不互相清除；其他 `providerFamilyDomain` 取值的可用性未逐一验证。

## K29 侧栏评论验收的载体与口径（side-editor）

- **事实一**（桥冻结）：插件页面里的 `window.zcode` 是 frozen 对象，`window.zcode.updateModelContext = …` 静默失败，不能用页面包装截获载荷；验收改为读取主对话落库消息中的 `# Plugin context:` 块（里面是完整批次 JSON）。
- **事实二**（受理 ≠ 模型完成）：评论批次进入历史/发送队列后，评论状态资源就会把 pending 清零；模型仍在 running 时状态是 `busy`（reason 为"主对话正在处理输入…"），不是 admission pending。running 不是受理证据，busy 也不是未受理。
- **事实三**（阻止/断连不丢）：busy 与网关不可达都会禁用提交并给出原因；已打开的对话框 textarea 保留正文，重连/空闲后可直接再提交。网关不可达表现为 `评论状态不可用：公共网关健康检查失败…`，不是 idle。
- **事实四**（归属与独立回执）：评论快照带 `sessionId`/`workspacePath`，页面不能指定目标身份；会话 A/B 各自 sandbox 实例与评论状态隔离。原文件哈希、恢复副本 `<lab>/storage/cli/plugins/data/suian-side-editor@suian-zcode-plugins/editor-state.sqlite`、评论受理是三份独立证据；评论验收期间源文件保持只读（本轮源哈希前后不变）。
- **事实五**（真实选区）：面板是真实构建页面与真实 CodeMirror；标准键盘事件建立选区后，"评论选区"对话框显示绝对路径、1-based 行列与选文。合成 DOM 生命周期或伪造 bridge 不能替代真实宿主验收。
- **来源**：LO-07（[LO-07 证据](../../../../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md) §3）；评论契约与 #47/#57 边界见 `suian-side-editor/docs/comment-guard-verification.md`、`docs/adr/0005-temporary-comment-send-guard.md`。

## K30 连续短测正常，空闲后重新附着报协议错误

- **症状**：隔离 Desktop 3.16.3.8992 + relay V2，连续和并发各 100 次无失败，间隔 12 秒后 6 次附着有 3 次报 `gateway_rpc_protocol_error`。诊断底层为 `bridge-degraded / terminal-owner-ended`，失败发生在 attach。
- **根因**：Desktop 失配宽限期约 3 秒，之后结束旧桥并暂存失效通知。网关在无人使用后仍保留物理桥，下一次配对收到迟到通知，旧桥复用使新附着失败。
- **解法**：最后使用者退出后先取消请求再释放桥；下一次附着建立新身份，消费退役通知。验证必须加入跨宽限期的多轮空闲重连，不能只跑连续连接；不自动重试业务写入。
- **来源与边界**：[隔离重复验证](../../../../suian-zcode-app-mcp/docs/issue-162-idle-bridge-verification.md)。真实 Desktop 副本、受控 relay 夹具；未验证官方在线 relay 或真实手机，也不把这条复现归因到全部同码故障。

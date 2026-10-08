---
name: suian-zcode-title
description: 管理 ZCode 会话自动命名插件（suian-zcode-title）：初始化安装并配置公共网关 RPC、更换命名模型与思考档位、检查与修复 Stop 自动命名、暂停恢复命名、固定或解除固定单会话标题、诊断 Windows 通知提醒及管理旧授权。当用户要求"初始化/安装自动命名插件"、"更换远控链接"、"命名插件换模型/思考档"、"命名插件检查/修复"、"暂停/恢复自动命名"、"固定/解除固定会话标题"、"命名通知总是弹/不弹"时使用；不用于普通对话内容处理，也不用于手动改标题。
---

# suian-zcode-title

管理 ZCode Stop 后的会话自动命名。命名由独立后台进程完成（最近三轮 → GLM-5.3-Flash/low 生成 → 原 Host 改名 → 双库核验），失败时以 Windows 原生 Toast 提醒（2 小时冷却）。

## 入口与路径

- 插件根（下称 `<插件根>`）按顺序确定，**不要把本技能目录当作插件根**（技能目录只有本文档，没有 cli.mjs）：
  1. 安装器部署的副本会在下方注入「本机插件根」——`install.mjs` 把锚点替换为绝对路径，本行在仓库原文中是不显示的注释
<!-- suian-zcode-title:plugin-root -->
  2. 读 `~/.zcode/cli/config.json` 的 `hooks.events.Stop`：`node <路径>\hook.mjs` 中 hook.mjs 所在目录即插件根（装过本插件的机器永远可查）
  3. 以上都没有时，向用户询问克隆位置
- CLI 入口：`node <插件根>/cli.mjs <命令>`，stdin 传 JSON：`{"session_id":"sess_...","workspace_path":"<工作区绝对路径>"}`
- 配置文件：`<插件根>/config.local.json`（所有命令加 `--config <插件根>/config.local.json`）
- 数据目录：`<插件根>/.local`（逐会话状态、用量、授权密文、Toast 冷却与协议桥）

## 用户请求 → 操作映射

### "初始化 / 安装 / 升级自动命名插件"

1. **先检查依赖，再写配置**。在同级公共根运行 `npm ci --ignore-scripts --no-audit --no-fund`，然后执行 `node "{{plugin_root}}/install.mjs" "{{plugin_root}}/.local" --check-only`。检查当前 Node.js 24+、公共 npm 依赖和 sqlite3 的只读 JSON 查询；此步不写 Hook、通知资产或 skill。sqlite3 必须是 CLI 可执行文件，安装 npm 同名包不能代替。取值顺序为默认 config.local.json 中的 sqliteBin → SQLITE_BIN → PATH 的 sqlite3；自定义配置加 `--config {{config_path}}`，显式无效路径不回退。缺依赖时先协助补齐再重查，内网使用已有程序或离线包；建议将确认可执行的绝对路径写入 sqliteBin，确保后台 Hook 使用同一程序。全部通过后，执行不带 `--check-only` 的同一命令，幂等安装协议桥、开始菜单快捷方式、自建通知标识（AUMID）、Hook 与 skill。正常安装也强制先检查依赖，不能忽略失败继续配置。
2. **配置公共网关**：优先读取仓库同级的最新 `../suian-zcode-common/SKILL.md`；源码尚未定位时用已安装的 `~/.zcode/skills/suian-zcode-common/SKILL.md` 定位。按其流程完成依赖、Status → Install 和分层验证。后台启动、Desktop 用户级环境变量、重启方法及恢复流程只维护在公共 skill，不在本插件复制脚本。缺少该子项目时先补齐同一版本的公共层目录。
3. 完成本地配置并用 `node cli.mjs status --config config.local.json`（stdin 传会话）检查。升级保留已有模型选择；首次安装从 config.example.json 建立配置时先设 enabled:false，示例 selection 只是占位，不能视作用户选择。模型选择或可用性尚未确认时，报告“本机配置完成，模型配置待确认”，保留当前会话完成其他配置；按第 7 步取得清单、选择和核验后再启用。核对安装器已写入 Stop Hook、Hook 已启用及通知资产，Hook 存在不表示命名插件已启用。公共目录非默认时，config.local.json 的 gatewayConfigPath 指向同一公共 config.json。公共 Status 要有 rpc_available:true；旧网关先按公共 skill 暂停远控并重载，保留当前 Agent 完成配置。
4. **先完成全部安装或升级，应用重启只放在最后**。地址未变且原窗口已连接正确网关时，重新开启远控验证即可。首次接入或修改启动地址也先完成上述本机配置与检查，再按公共 skill 交付择时重开的步骤；原 Host、模型和真实 Hook 验证留到重开后，不以连接未生效为由中止配置。提醒用户重启可能中断运行中任务与未保存工作，不能自动退出承载配置的 ZCode。
5. 用户在当前窗口开启"移动端远程控制"，确认 Desktop 连入网关。若需重开应用，这一步由重开后的会话继续验证。插件无需手机链接，不复制旧 blob，不把公共 control_token 放入配置、args/env 或输出。
6. `node cli.mjs probe` 验证网关、原 Host、目标工作区与会话。先按公共 skill 确认连接模式；local-only 不需要官方上游或手机连接，所选模型服务仍需可达。relay 模式下，手机在本地工作区时可继续连接；远端工作区返回 remote_workspace_busy，等用户主动切回本地再验证，不切走手机。隔离测试不等于真实手机验收。
7. **询问并核验命名模型**。网关连接后运行 `node cli.mjs models --config config.local.json`（stdin 传会话），从实际清单向用户展示可选模型和思考档位。首次安装请用户选择；用户已明确指定时核验后沿用，不重复询问。升级保留并核验已有选择，仅在用户要求更换或原选择不可用时再询问，不自动换成示例默认值。清单暂不可取时，明确报告原因并保留“模型配置待确认”，重开连接后继续，不猜 ID 或档位。

   将用户选择对应的真实 providerId / modelId / reasoningLevel 写入 config.local.json 的 selection，复读确认与实际清单一致。首次安装完成选择与核验后才设 enabled:true；升级前已暂停的插件继续保持暂停，除非用户要求恢复。再运行 doctor，并按“Hook 配置”节在用户选定的测试会话验证一次真实触发，分别报告模型配置已确认、本机配置完成和实际触发成功。

### "更换远控链接"

先说明新版默认 RPC 不需要链接；排障转公共网关 skill。只有用户明确管理旧凭据时才以 stdin 交给 auth 保存密文，保留旧文件不等于新版使用它。不要把明文写入配置或日志。

### "更换命名模型 / 思考档位"

1. `node cli.mjs models --config config.local.json`（stdin 传会话）列出原 Host 实际可用的 provider / model / reasoningLevel 清单——**生成走当前窗口的远控通道，只能选清单内的组合，不猜模型名**。
2. 编辑 `config.local.json` 的 `selection`：`{"providerId":"...","modelId":"...","options":{"reasoningLevel":"..."}}`；档位必须在该模型清单的 reasoningLevels 里，否则 worker 报"指定思考档位不可用"。
3. 改完即生效（hook 派发自动读取），下一轮 Stop 用新配置；想立即验证用 `doctor` 走一次本地链路。

### 标题策略速览（用户问起时据此回答）

- **滚动更新**：每轮 Stop 触发，但会话内容指纹没变就不调模型（`unchanged`）；内容变了模型对照现有标题输出 keep 或 rename，标题跟随主线缓慢演进，不逐轮翻新。
- **既有手动保护**：无公共策略时，已有命名基线且标题相对基线变化、来源非 generated，才判为手动改名并锁定；仅 custom 来源不足以证明被跳过。旧锁定可通过删除 `.local/<session_id>.json` 解除。
- **MCP 独立锁定**：MCP 的 lock_title 默认 false，提供初始名称不推断锁定。公共 `title-policy.mjs` 管理当前用户 `~/.zcode/tools/suian-zcode-common/session-titles/<session_id>.json`：locked:true 不调模型；false 允许滚动命名并要求格式合规，不合规 keep 最多纠正一次。先读公共策略再判断旧状态，删旧状态不能解除公共锁。Agent 修改策略走本插件 CLI（lock/unlock，内部即公共 writeTitlePolicy），按用户明确意图设置 locked；两个插件与公共层需同版本升级。

### "检查 / 修复命名插件"

按顺序分层定位，先本地后远端：

1. `node cli.mjs status --config config.local.json`：enabled、模型选择、Toast 资产（协议/快捷方式/冷却）、最近一次命名结果。
2. `node cli.mjs doctor --config config.local.json`：双库、目标会话、模型清单与用户级 Stop Hook。hook 为 configured / disabled / not_configured；hookDetails 报告所检查的 configFile、enabled、async 和 execution:not_verified。ready 表示这些读取与静态配置检查通过；缺少 Hook、停用或不是后台条目时为 not_ready。不能把 ready 当作当前会话已加载或真实执行过 Hook 的证据，仍按“Hook 配置”节验收。
3. `node cli.mjs probe`：无需链接，输出分层结果——

| reasonCode | 含义 | 处理方向 |
|---|---|---|
| `gateway_not_configured` / `gateway_invalid_config` | 公共配置缺失或无效 | 按公共 skill 修复，不回显完整配置 |
| `gateway_upgrade_required` | 文件与运行中网关版本不同 | 按公共 skill 暂停移动端远控后 Restart，保留当前会话完成升级 |
| `gateway_unreachable` / `gateway_connection_failed` | 网关未运行或 RPC 连接失败 | 分别检查健康、任务与本地鉴权 |
| `gateway_desktop_offline` | 原窗口未就绪，或 relay 模式上游未连接 | 确认模式、远控开启、Desktop 环境与网络；local-only 不要求官方上游 |
| `remote_workspace_busy` | 手机当前使用远端工作区 | 本地调用让位，不切走手机 |
| `gateway_bridge_timeout` / `gateway_rpc_protocol_error` | 原 Host 桥超时或协议不符 | 查版本与原窗口状态，不重试已提交写操作 |
| `gateway_connection_closed` / `gateway_timeout` | 连接中断或执行超时 | 结果可能未知，先检查标题与运行日志 |

4. 网关问题交给公共 `suian-zcode-common` skill，先区分配置、任务、Desktop、上游及配对状态；不要把网关变量只写到 Hook 或 MCP 子进程中。
5. 检查 Stop Hook：是否已配置、已启用、已信任、真实触发过（分别验证，不能只看一项）。

### "暂停 / 恢复自动命名"

`node cli.mjs disable --config config.local.json`（写前复核 enabled，输出 `disabled_writing`）；恢复用 `enable`。执行后向用户复述配置文件中 `enabled` 的新值。

### "固定 / 解除固定会话标题"

`node cli.mjs lock --config config.local.json`（stdin 传目标会话 `session_id`）固定该会话：命名插件此后不再自动改其标题；`unlock` 解除固定、恢复滚动命名；`policy` 只读查询当前策略（`null` = 从未设置）。输出 `previous`/`policy` 透传公共策略对象（含 `version`），重复执行幂等成功。

- 目标不限于当前会话：其他会话的 `session_id` 经 `suian-zcode-app-mcp` 的 `list_sessions` 获取。
- 三个命令先做存在性校验（CLI 会话库与任务索引任一命中），目标不存在即报错退出码 1，不静默写策略。
- 固定对飞行中的命名轮不追溯，自下一次 Stop 生效；固定不改标题本身。
- 固定后不要再对该会话调 `rename_session`：官方改名会把标题来源永久置为 custom（官方侧自动命名短路且无解除接口），与插件的固定是两套独立机制。
- `policy` 只反映公共标题策略；旧"手动保护"锁不在查询范围，其表现为 run 返回 `manual_title`（判别见"标题策略速览"）。

### "通知总是弹 / 不弹 / 点了没反应"

- 总是弹：检查 `.local/toast-cooldown.json` 是否被清理进程删除；`status` 的 `cooldownActive` 应为 true 期间静默。
- 不弹：`status` 的 `toast.protocolRegistered` 与 `vbsInstalled` 是否 true；Windows 设置中"ZCode 自动命名插件"的通知权限是否被关闭或处于勿扰。
- 点按钮无反应：查看 `.local/toast-action-log.jsonl` 最近条目；`ok:false` 时按 detail 排查（剪贴板被锁会自动重试）。

## 安全与边界

- 默认网关调用不读取远控链接。旧凭据管理只在进程内使用明文、持久保存只用当前用户 DPAPI 密文；网关 control_token、远控链接及其 `sid/hash/mid` 均不进入输出、日志、Toast 或提示词。
- 不直接写 ZCode 会话数据库；改名仅走官方远控 RPC。
- 本地跳过路径（unchanged/disabled/empty/archived）不建立远控连接，不弹通知。
- `run --apply` 失败分层（`stage/reasonCode`）时保留原标题并按冷却弹 Toast；`toast:"disabled"` 表示用户设了 `OIL_ZCODE_TITLE_DISABLE_TOAST=1`。
- 自动化测试与脚本严禁调用协议激活链路（`suian-zcode-title://`）——其打开动作会弹 ZCode 官方确认模态框，无人值守时会无限阻塞。

## 旧凭据兼容

1. 默认初始化不索取链接。仅管理旧凭据时，以 stdin `authorization_url` 传给 `node cli.mjs auth --config config.local.json`；写入当前用户 DPAPI 密文，输出 auth_saved，任何环节不回显。
2. 清除授权：`node cli.mjs unauth`；`status` 的 `legacyAuthorizationFilePresent` 仅报告旧密文文件存在，不读取正文或验证授权，也不表示网关就绪。
3. 授权链接是远控会话凭据，仅在当前用户账户下可解密；不要把 blob 或链接写入文档、提交或聊天。

## Hook 配置

**配置位置**（源码核实）：用户级 `~/.zcode/cli/config.json` 的 `hooks.events.Stop`；用户级 hooks 无信任门槛。**快照语义（实测）**：宿主在会话创建时快照 hooks 配置、此后不重读——**新写入的 Stop 条目只对之后新建的会话生效，存量会话永不触发**；验证真实触发必须用新会话（或重启 ZCode 后的任意会话）。条目 `async:true` 后台执行，不阻塞对话。

**安装**：`node <插件根>/install.mjs <插件根>/.local` 已自动完成（幂等追加，保留既有 hooks，含他人条目）。结构示例：

```json
{"hooks":{"enabled":true,"events":{"Stop":[{"hooks":[{"type":"command","command":"node D:\\...\\hook.mjs","async":true,"timeout":30}]}]}}}
```

**链路**：宿主 Stop → hook.mjs（stdin 收 session_id/cwd/stop_hook_active）→ stop_hook_active:true 跳过 → 延迟 8 秒等持久化收尾 → 派发 cli.mjs run --apply → 公共网关 RPC。worker.lock 串行，busy 让位下轮；不解密或注入远控链接。hook.log.jsonl 出现 dispatched 后约 8–10 秒才有 runner.log.jsonl，属正常时序。

**验证顺序**（分别验证，不合并断言）：
1. 已写配置：`config.json` 中存在本插件 Stop 条目。
2. 已启用：`hooks.enabled` 为 true。
3. 静默路径：`'{"session_id":"sess_...","cwd":"...","stop_hook_active":true}' | node <插件根>/hook.mjs` 输出 `skipped_stale` 且退出码 0，不派发命名。不要用有效会话事件冒充静默探针。
4. 真实触发：网关就绪后，在用户选定的测试会话完成一轮对话停止，观察标题与 usage.jsonl；共存验收还要确认手机持续可操作。

**卸载**：`node install.mjs <插件根>/.local --remove`（移除自己的 Stop 条目、协议、快捷方式与缓存）。

公共网关同时服务两个插件，卸载命名插件时保留它。用户明确要求恢复直连或一并移除公共工具时，再读取公共 skill 执行 Remove；不在命名安装器中删除公共任务或改回网关变量。

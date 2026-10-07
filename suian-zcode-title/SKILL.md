---
name: suian-zcode-title
description: 管理 ZCode 会话自动命名插件（suian-zcode-title）：初始化安装并配置公共网关、配置移动端远控授权链接、更换命名模型与思考档位、检查与修复 Stop 自动命名、暂停恢复命名、诊断 Windows 通知提醒。当用户要求"初始化/安装自动命名插件"、"更换远控链接"、"命名插件换模型/思考档"、"命名插件检查/修复"、"暂停/恢复自动命名"、"命名通知总是弹/不弹"时使用；不用于普通对话内容处理，也不用于手动改标题。
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

### "初始化 / 安装自动命名插件"

1. `node <插件根>/install.mjs <插件根>/.local`——幂等安装协议桥、开始菜单快捷方式、自建通知标识（AUMID）。重复执行安全；输出 `ok:true` 表示本地安装完成，远控与生效状态仍要分别验证。
2. **配置公共网关**：优先读取仓库同级的最新 `../suian-zcode-common/SKILL.md`；源码尚未定位时用已安装的 `~/.zcode/skills/suian-zcode-common/SKILL.md` 定位。按其流程完成依赖、Status → Install 和分层验证。后台启动、Desktop 用户级环境变量、重启方法及恢复流程只维护在公共 skill，不在本插件复制脚本。缺少该子项目时先补齐同一版本的公共层目录。
3. `node cli.mjs status --config config.local.json`（stdin 传会话）检查已有配置与授权状态；未完成远控授权前，不用会调模型清单的 doctor 判断本地安装失败。
4. 按公共 skill 指导用户择时重开 Desktop。明确提醒：**运行中的 Agent 任务和未保存工作可能被重启中断，先完成或保存，再完整退出重开**。不要在承载初始化的 ZCode 中自行退出宿主；分别报告配置已写入与用户重启后已生效。
5. 远控授权：从重开后的当前窗口"移动端远程控制"取得链接，按下方"配置授权"以 stdin 交给 `auth`，仅保存当前用户 DPAPI 密文，不保存明文、不回显、不进日志。
6. `node cli.mjs probe` 验证授权（见下方分层结果）。若手机正在占用 terminal，说明当前命名 RPC 尚未接入网关分流，本地初始化可以继续，远端验证需在用户暂停手机远控后进行；不要强行抢占连接或声称配置网关就已完成命名共存。
7. 授权与模型就绪后运行 doctor，再完成 Stop Hook 配置（见"Hook 配置"节），在用户选定的测试会话验证一次真实触发。

### "更换远控链接"

用户提供新链接后，以 stdin 交给 `auth` 保存 DPAPI 密文，再 probe 验证。不要把明文写入配置或日志。

### "更换命名模型 / 思考档位"

1. `node cli.mjs models --config config.local.json`（stdin 传会话）列出原 Host 实际可用的 provider / model / reasoningLevel 清单——**生成走当前窗口的远控通道，只能选清单内的组合，不猜模型名**。
2. 编辑 `config.local.json` 的 `selection`：`{"providerId":"...","modelId":"...","options":{"reasoningLevel":"..."}}`；档位必须在该模型清单的 reasoningLevels 里，否则 worker 报"指定思考档位不可用"。
3. 改完即生效（hook 派发自动读取），下一轮 Stop 用新配置；想立即验证用 `doctor` 走一次本地链路。

### 标题策略速览（用户问起时据此回答）

- **滚动更新**：每轮 Stop 触发，但会话内容指纹没变就不调模型（`unchanged`）；内容变了模型对照现有标题输出 keep 或 rename，标题跟随主线缓慢演进，不逐轮翻新。
- **既有手动保护**：无公共策略时，已有命名基线且标题相对基线变化、来源非 generated，才判为手动改名并锁定；仅 custom 来源不足以证明被跳过。旧锁定可通过删除 `.local/<session_id>.json` 解除。
- **MCP 独立锁定**：MCP 的 lock_title 默认 false，提供初始名称不推断锁定。公共 `title-policy.mjs` 管理当前用户 `~/.zcode/tools/suian-zcode-common/session-titles/<session_id>.json`：locked:true 不调模型；false 允许滚动命名并要求格式合规，不合规 keep 最多纠正一次。先读公共策略再判断旧状态，删旧状态不能解除公共锁。修改策略使用公共 writeTitlePolicy，按用户明确意图设置 locked，两个插件与公共层需同版本升级。

### "检查 / 修复命名插件"

按顺序分层定位，先本地后远端：

1. `node cli.mjs status --config config.local.json`：enabled、模型选择、Toast 资产（协议/快捷方式/冷却）、最近一次命名结果。
2. `node cli.mjs doctor --config config.local.json`：双库与目标会话。
3. 有授权时 `node cli.mjs probe`：输出分层结果——

| reasonCode | 含义 | 处理方向 |
|---|---|---|
| `network_timeout` / `network_error` | 网络不通或 relay 无响应 | 检查网络后重试 probe |
| `auth_failed` | 授权被拒绝 | 需要新链接 |
| `device_offline` | 原窗口远控未开启或已离线 | 确认原窗口远控已开启，并按公共 skill 检查设备与上游连接 |
| `kicked` | terminal 槽位已被其他客户端占用，本次连接被拒绝 | 暂停手机远控后重试；不要仅据此更换授权 |
| `pair_waiting` | 远控配对未就绪 | 确认窗口远程控制已开启 |
| `host_unreachable` | 原 ZCode 窗口不可达 | 确认原窗口存活 |
| `workspace_missing` / `session_missing` | 原窗口没开目标工作区/会话 | 打开对应工作区会话 |
| `auth_link_rejected` | 链接被服务端拒绝（已失效） | 窗口里重新开启远程控制并生成新链接，重新 auth |
| `missing_authorization` / `invalid_url` | 未提供链接/链接格式错误 | 用户提供新链接 |

4. 网关问题交给公共 `suian-zcode-common` skill，先区分配置、任务、Desktop、上游及配对状态；不要把网关变量只写到 Hook 或 MCP 子进程中。
5. 检查 Stop Hook：是否已配置、已启用、已信任、真实触发过（分别验证，不能只看一项）。

### "暂停 / 恢复自动命名"

`node cli.mjs disable --config config.local.json`（写前复核 enabled，输出 `disabled_writing`）；恢复用 `enable`。执行后向用户复述配置文件中 `enabled` 的新值。

### "通知总是弹 / 不弹 / 点了没反应"

- 总是弹：检查 `.local/toast-cooldown.json` 是否被清理进程删除；`status` 的 `cooldownActive` 应为 true 期间静默。
- 不弹：`status` 的 `toast.protocolRegistered` 与 `vbsInstalled` 是否 true；Windows 设置中"ZCode 自动命名插件"的通知权限是否被关闭或处于勿扰。
- 点按钮无反应：查看 `.local/toast-action-log.jsonl` 最近条目；`ok:false` 时按 detail 排查（剪贴板被锁会自动重试）。

## 安全与边界

- 远控授权明文只在使用它的进程内解密或注入（stdin 字段或 `OIL_ZCODE_REMOTE_URL`）；持久保存只用当前用户 DPAPI 密文，任何输出、日志、Toast、提示词不携带 `sid/hash/mid`。
- 不直接写 ZCode 会话数据库；改名仅走官方远控 RPC。
- 本地跳过路径（unchanged/disabled/empty/archived）不建立远控连接，不弹通知。
- `run --apply` 失败分层（`stage/reasonCode`）时保留原标题并按冷却弹 Toast；`toast:"disabled"` 表示用户设了 `OIL_ZCODE_TITLE_DISABLE_TOAST=1`。
- 自动化测试与脚本严禁调用协议激活链路（`suian-zcode-title://`）——其打开动作会弹 ZCode 官方确认模态框，无人值守时会无限阻塞。

## 配置授权

1. 请用户在 ZCode 窗口开启"移动端远程控制"，复制生成的链接；以 stdin `authorization_url` 传给 `node cli.mjs auth --config config.local.json`——链接经当前用户 DPAPI 加密写入 `.local/remote.blob`，输出 `auth_saved`，**任何环节不回显**。
2. 清除授权：`node cli.mjs unauth`；查看状态：`status` 的 `authorization` 字段（`configured`/`missing`）。
3. 授权链接是远控会话凭据，仅在当前用户账户下可解密；不要把 blob 或链接写入文档、提交或聊天。

## Hook 配置

**配置位置**（源码核实）：用户级 `~/.zcode/cli/config.json` 的 `hooks.events.Stop`；用户级 hooks 无信任门槛。**快照语义（实测）**：宿主在会话创建时快照 hooks 配置、此后不重读——**新写入的 Stop 条目只对之后新建的会话生效，存量会话永不触发**；验证真实触发必须用新会话（或重启 ZCode 后的任意会话）。条目 `async:true` 后台执行，不阻塞对话。

**安装**：`node <插件根>/install.mjs <插件根>/.local` 已自动完成（幂等追加，保留既有 hooks，含他人条目）。结构示例：

```json
{"hooks":{"enabled":true,"events":{"Stop":[{"hooks":[{"type":"command","command":"node D:\\...\\hook.mjs","async":true,"timeout":30}]}]}}}
```

**链路**：宿主 Stop → `hook.mjs`（stdin 收 `session_id`/`cwd`/`stop_hook_active`）→ `stop_hook_active:true` 跳过（防续跑重复）→ 无授权 blob 静默退出 → 有授权则**延迟 8 秒**（等宿主完成 turn 收尾持久化，规避快照漂移竞态）后派发 `cli.mjs run --apply`（worker.lock 串行，busy 让位下轮）。排障时 `hook.log.jsonl` 出现 `dispatched` 后约 8–10 秒才会有对应的 `runner.log.jsonl` 记录，属正常时序。

**验证顺序**（分别验证，不合并断言）：
1. 已写配置：`config.json` 中存在本插件 Stop 条目。
2. 已启用：`hooks.enabled` 为 true。
3. 静默路径：`{"session_id":"sess_...","cwd":"..."} | node <插件根>/hook.mjs` 输出 `skipped_no_auth`（或配置后 `dispatched`）且退出码 0。
4. 真实触发：配置授权后，在**用户选定的测试会话**完成一轮对话停止，观察标题变化与 `usage.jsonl` 新记录。

**卸载**：`node install.mjs <插件根>/.local --remove`（移除自己的 Stop 条目、协议、快捷方式与缓存）。

公共网关同时服务两个插件，卸载命名插件时保留它。用户明确要求恢复直连或一并移除公共工具时，再读取公共 skill 执行 Remove；不在命名安装器中删除公共任务或改回网关变量。

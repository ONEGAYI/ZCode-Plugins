# ZCode Stop 后自动命名后端

**已通过真实会话验证最近三轮 → 指定模型生成 → 原 Host 改名 → 双库读回**。本轮新增：调用前探活（probe）、Windows 原生 Toast 提醒（2 小时冷却 + 复制排障提示词按钮）、DPAPI 授权存储、Stop Hook 自动配置与后台派发。没有 fork 或修改 ZCode 官方源码。

2026-10-06 21:31:41，测试会话从“改名测试：双链联想”变为“🧩 双链联想｜批次功能实施”。模型为用户选择的 `GLM-5.3-Flash / low`，输入 3,468、输出 133 tokens。同一内容再次调用返回 `unchanged`，不需要远控凭据，也不再次调用模型。

## 运行

需要 Node.js 24+、sqlite3，以及已打开目标工作区的 ZCode 3.14.4。无需 npm install。本机配置在 `config.local.json`，已使用选定模型；`config.example.json` 用作重建参考。模型身份和档位应由 `models` 查询确认。

从 stdin 传入一个 JSON 对象：

```json
{
  "session_id": "sess_目标会话标识",
  "workspace_path": "D:\\CODE\\Project\\目标项目",
  "user_message_id": "可选：触发此事件的真实用户消息标识",
  "authorization_url": "可选：单次使用的远控授权链接"
}
```

`cwd` 可以代替 `workspace_path`。`user_message_id` 是本后端的可选事件标识；尚未确认 ZCode Stop 事件能直接提供它，没有此值时依靠内容指纹与写前复核。不要把 `turn_id` 直接当成用户消息 ID。

授权来源优先级：stdin `authorization_url` > 环境变量 `OIL_ZCODE_REMOTE_URL` > `.local/remote.blob`（`auth` 子命令以当前用户 DPAPI 加密保存）。日志和配置不保存明文链接。

```powershell
node .\cli.mjs --help
$eventJson = @{ session_id = 'sess_目标会话标识'; cwd = 'D:\CODE\Project\目标项目' } | ConvertTo-Json -Compress
$eventJson | node .\cli.mjs doctor --config .\config.local.json
$eventJson | node .\cli.mjs models --config .\config.local.json
$eventJson | node .\cli.mjs probe --config .\config.local.json
$eventJson | node .\cli.mjs status --config .\config.local.json
$eventJson | node .\cli.mjs run --config .\config.local.json
$eventJson | node .\cli.mjs run --apply --config .\config.local.json
$eventJson | node .\cli.mjs disable --config .\config.local.json   # 暂停命名；enable 恢复
@{ session_id='...'; cwd='...'; authorization_url='https://zcode.z.ai/remote/...' } | ConvertTo-Json -Compress | node .\cli.mjs auth --config .\config.local.json   # 加密保存授权
```

`run` 返回候选，`run --apply` 才通过官方服务写入。输出是命名程序的结果。Stop Hook 的 stdin 契约与 `run` 兼容（`hook.mjs` 负责派发）。

## 安装（幂等）

```powershell
node .\install.mjs (Resolve-Path .\.local)          # 协议桥 + 开始菜单快捷方式(自建 AUMID) + Stop Hook
node .\install.mjs (Resolve-Path .\.local) --remove  # 全部卸载（保留既有他人 hooks 与授权 blob）
```

- Stop Hook 写入用户级 `~/.zcode/cli/config.json` 的 `hooks.events.Stop`（`async:true` 后台执行，不阻塞对话；幂等追加，保留他人条目）。原文件已备份为 `config.json.suian-zcode-title-backup`。
- 协议 `suian-zcode-title://` 指向 `.local/toast-launch.vbs`（wscript 隐藏窗口启动 `toast-action.mjs`）。
- Toast 通知身份使用自建 AUMID `SUIAN.SuianZcodeTitle.Toast`（开始菜单快捷方式承载）。外部进程借用 ZCode 桌面的 AUMID 会被通知平台静默丢弃，已实测排除。

## 实际链路

1. Stop Hook（`hook.mjs`）收到事件：`stop_hook_active:true` 跳过；无授权静默退出；否则解密授权并后台派发 `cli.mjs run --apply`（worker.lock 串行，busy 让位下一轮）。
2. 用会话 ID 与工作区读取任务索引及 CLI SQLite，均为只读连接。
3. 按持久化 `session.revert` 裁剪回退分支，复用官方可见消息规则。
4. 将同一用户输入下的多条助手文本归并，取最近三轮；排除思考、工具正文及内部提醒。用户文本每轮最多 1,200 字符、助手文本最多 1,500 字符，另保留最初目标 800 字符。
5. 经授权远控附着原 Host（握手阶段短超时 8s，配对/Host/工作区/会话四层检查，失败按 `stage/reasonCode` 分类），调用 `model-selection.getView` 检查模型与档位，再调用 `zcode-agent.generateWorkspaceText`。只传命名材料和工具空列表，不创建普通 Agent 任务，也不切换主会话模型。
6. 校验严格 JSON、允许的类别 emoji、对象｜目标结构及 48 Unicode 字符上限。
7. 再读历史与标题，内容已变化则返回 `stale_result`。否则调用 `zcode-task.renameTask`。
8. 核对原 Host 与两份数据库标题一致，再保存内容指纹和用量。
9. 远控类失败（`stage` 存在）：不改标题、不调模型，按 7200 秒跨进程冷却弹**原生 Toast**（标题、原因、`复制排障提示词并打开 ZCode` / `忽略` 两按钮；按钮经协议激活由 Shell 独立进程处理，命名进程退出后仍可点击）。设 `OIL_ZCODE_TITLE_DISABLE_TOAST=1` 静音。

`probe` 独立探活命令不调用模型、不建普通任务：输出 `{ok, stage, reasonCode, paired, hostReachable, workspaceFound, sessionFound}`；已连接对象另有 `remote.probe()` 等待本次查询之后的新 ACK（新鲜度保障）。

## 状态与保护

| 状态 | 意义 |
|---|---|
| preview | 只生成候选，没有写标题 |
| renamed / kept | 已写入并核验，或按模型决定保留 |
| unchanged | 同一内容已处理，跳过模型 |
| manual_title / locked | 成功命名后的标题被外部修改，停止覆盖 |
| stale_result / outdated_event | 内容已更新，或事件指向旧用户输入，丢弃结果 |
| archived / running / empty / disabled | 不适合命名或已暂停，不调用模型 |
| failed | 连接、模型或核验失败，退出码 1（远控类附 `stage/reasonCode/toast` 字段） |

`.local/` 保存逐会话状态、`usage.jsonl`、`remote.blob`（DPAPI 密文）、`toast-cooldown.json`、`toast.lock`、协议桥与动作日志。只有标题、哈希、状态和用量，不含完整对话或远控凭据。`enabled:false` 可阻止下一次命名（`disable/enable` 命令原子修改配置）。

## 已验证与边界

**已验证**：50 项契约测试；真实三轮命名与双库读回；重复调用零模型请求；probe 分层分类（fixture 覆盖 network/auth/pair/host/workspace/session 与 ACK 新鲜度）；Toast 横幅、双按钮渲染与来源名“ZCode 自动命名插件”（截图证据见 `../notes/`）；协议按钮激活 → 剪贴板收到完整提示词（.NET API + 假失败回读校验）；7200 秒冷却虚拟时钟边界（7199 抑制 / 7200 恢复）与并发单显；DPAPI 授权往返加密；Stop Hook 幂等安装（保留既有 hooks）与无授权静默派发路径。

**尚未实测**：授权 blob 配置后的真实 Stop → 后台命名端到端（需用户提供移动端远控链接后在测试会话验证）；真实授权下的 `probe_ok`。详见 [脱敏实测证据](docs/stop-title-runner-evidence.json)。

本机 `readSessionMessages` 实测因消息字段校验不一致失败，因此正文走 SQLite 只读适配。它覆盖持久化回退状态，不等同于实时 V4 订阅快照；当前仅支持本机本地工作区。`transcript_path`（Stop Hook stdin）是宿主合成的临时单行文件，不作为历史来源。

授权仍需有效窗口链接；网络失败不提交候选标题；连接关闭不代表 Host 中的辅助模型请求已被取消。ZCode 自身可能记录辅助生成的模型 I/O 和用量。

打开 ZCode 工作区的深链接 `zcode://workspace/open` 对任意路径都会弹官方确认框（源码核实，含内部工作区）；Toast 按钮的“打开”动作保留该确认（用户点击场景可接受），自动化测试严禁触发协议激活链路（模态框会阻塞无人值守流程）。

## 文件职责

| 文件 | 职责 |
|---|---|
| cli.mjs | stdin 事件、配置、状态文件、共享锁和结果输出；status/enable/disable/auth/unauth |
| naming.mjs | 命名决策、去重、保护和写前写后复核 |
| backend.mjs | 只读双库与原 Host 服务适配 |
| history.mjs | 历史重建、回退分支和最近三轮整理 |
| remote.mjs | 官方 relay 鉴权、bridge、Channel RPC、probe 探活 |
| hook.mjs | Stop Hook 派发器：续跑保护、授权解密、后台启动 worker |
| auth-store.mjs | 授权链接的当前用户 DPAPI 加密存取 |
| toast.mjs | Toast XML、冷却编排、PowerShell 显示、修复提示词 |
| toast-action.mjs | 协议按钮动作：复制提示词 + 打开 ZCode（仅用户点击路径） |
| cooldown.mjs | 7200 秒冷却、跨进程互斥锁与陈旧锁回收 |
| install.mjs | 幂等安装：协议桥、快捷方式 AUMID、Stop Hook 配置与卸载 |
| prompt.md | 从 oil-codex-title 沿用的命名规则 |
| SKILL.md | 自然语言操作入口（安装副本在 `~/.agents/skills/suian-zcode-title/`） |
| vendor/ | 固定来源的协议与投影库，见 NOTICE.md |
| tests/ | 契约与 CLI 集成测试（50 项） |

```powershell
node --test tests/*.test.mjs
```

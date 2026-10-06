# suian-zcode-title — ZCode 会话自动命名插件

- 本仓库自包含：官方源码的研究与探查材料不随仓库分发，结论沉淀在 `docs/`（脱敏证据）；vendored 协议库的来源与许可见 `vendor/NOTICE.md`。
- 用户已授权自动命名的搭建、验证与 Stop Hook 自动配置；真实改名操作限定明确指定的测试会话或用户会话的自动触发。
- 不修改 ZCode 官方源码，不直接写 ZCode 会话数据库；改名仅走官方远控 RPC。
- 远控授权链接仅以当前用户 DPAPI 密文（`.local/remote.blob`）保存；配置、日志、Toast、提示词均不携带链接明文或其 sid/hash/mid 片段。
- Toast 按钮的打开动作固定指向用户自带默认工作区 `%USERPROFILE%\.zcode\workspace\default`，不随插件位置变化。
- 自动化测试与脚本严禁触发 `suian-zcode-title://` 协议激活链路（会弹 ZCode 官方确认模态框，无人值守时无限阻塞）。
- vendor 是固定来源的协议与投影库；版本信息见 vendor/NOTICE.md，不自动更新。
- 新行为先写契约测试，记录红绿验证日志（docs/round2-evidence.json）；不添加无关功能。

## 技术参考（面向维护者）

### 环境要求

Node.js 24+、sqlite3（PATH 可达，或经 `SQLITE_BIN` 环境变量 / 配置项 `sqliteBin` 指定）、已打开目标工作区的 ZCode。无需 npm install。

### CLI

stdin 传入 JSON 事件（`cwd` 可代替 `workspace_path`；`user_message_id` 可选，触发事件的真实用户消息标识，不要把 `turn_id` 当作用户消息 ID）：

```json
{
  "session_id": "sess_目标会话标识",
  "workspace_path": "D:\\CODE\\Project\\目标项目",
  "authorization_url": "可选：单次使用的远控授权链接"
}
```

```powershell
node .\cli.mjs doctor --config .\config.local.json      # 双库与目标会话自检
node .\cli.mjs models --config .\config.local.json      # 原窗口实际可用的模型与档位
node .\cli.mjs probe  --config .\config.local.json      # 远控分层探活，不调模型
node .\cli.mjs status --config .\config.local.json      # 配置、Toast 资产、最近命名结果
node .\cli.mjs run    --config .\config.local.json      # 只生成候选
node .\cli.mjs run --apply --config .\config.local.json # 经官方接口写入
node .\cli.mjs disable --config .\config.local.json     # 暂停；enable 恢复
# auth / unauth：stdin 带 authorization_url 加密保存 / 清除授权
```

授权来源优先级：stdin `authorization_url` > 环境变量 `OIL_ZCODE_REMOTE_URL` > `.local/remote.blob`（DPAPI 密文）。安装与卸载：`node .\install.mjs (Resolve-Path .\.local)`，加 `--remove`。

### 链路概要

1. Stop Hook（`hook.mjs`）收到事件：`stop_hook_active:true` 跳过；无授权静默退出；否则**延迟 8 秒**（等宿主完成 turn 收尾持久化，规避快照漂移竞态）后派发 `cli.mjs run --apply`（worker.lock 串行，busy 让位下一轮）。宿主在会话创建时快照 hooks 配置，新条目只对新建会话生效。
2. 只读查询任务索引与 CLI SQLite 双库，校验工作区与标题一致。
3. 按持久化 `session.revert` 裁剪回退分支，复用官方可见消息规则；用户文本每轮上限 1,200 字符、助手 1,500、最初目标 800，取最近三轮。
4. 经授权远控附着原 Host（握手短超时 8s，pair/host/workspace/session 分层检查，失败按 `stage/reasonCode` 分类），`model-selection.getView` 校验模型档位后调 `zcode-agent.generateWorkspaceText`；不创建普通 Agent 任务，不切换主会话模型。
5. 校验严格 JSON、类别 emoji、「对象｜目标」结构与 48 字符上限；写前复读，内容已变则 `stale_result`（附 `staleReason`：running/fingerprint/title）。
6. `zcode-task.renameTask` 写回后三处核验（原 Host 与双库），保存指纹与用量。
7. 远控类失败不改标题、不调模型，按 7200 秒跨进程冷却弹原生 Toast（复制排障提示词按钮经协议激活由 Shell 独立进程处理）；`OIL_ZCODE_TITLE_DISABLE_TOAST=1` 静音。

### run 返回状态

| 状态 | 意义 |
|---|---|
| preview / renamed / kept | 候选、已写入并核验、模型决定保留 |
| unchanged | 同一内容已处理，跳过模型 |
| manual_title / locked | 成功命名后标题被外部修改，停止覆盖（删 `.local/<session_id>.json` 解锁） |
| stale_result / outdated_event | 内容已更新或事件过期，丢弃结果 |
| archived / running / empty / disabled / busy | 不适合命名或已暂停，不调用模型 |
| failed | 连接、模型或核验失败，退出码 1（附 `stage/reasonCode/toast`） |

### 文件职责

| 文件 | 职责 |
|---|---|
| cli.mjs | 命令入口：stdin 事件、配置、共享锁、结果与日志；status/enable/disable/auth/unauth |
| hook.mjs | Stop Hook 派发器：续跑保护、授权解密、8 秒延迟、后台 worker |
| naming.mjs | 命名决策、去重、手动锁定保护、写前写后复核 |
| backend.mjs | 只读双库与原 Host 服务适配 |
| history.mjs | 历史重建、回退分支、最近三轮整理与指纹 |
| remote.mjs | 官方 relay 鉴权、bridge、Channel RPC、probe 探活 |
| auth-store.mjs | 授权链接的当前用户 DPAPI 加密存取 |
| toast.mjs / toast-action.mjs / cooldown.mjs | Toast 编排与冷却、协议按钮动作、跨进程互斥锁 |
| install.mjs | 幂等安装：协议桥、快捷方式 AUMID、Stop Hook 配置与卸载 |
| prompt.md | 命名规则（沿用自 oil-codex-title 并按本项目调整） |
| SKILL.md | 自然语言操作入口（安装副本在 `~/.agents/skills/suian-zcode-title/`） |
| vendor/ | 固定来源的协议与投影库，见 NOTICE.md |
| tests/ | 54 项契约与 CLI 集成测试（`node --test tests/*.test.mjs`） |

### 已验证与边界

已实测：54 项契约测试；两会话真实 Stop → 后台命名端到端（renamed）；probe 分层分类；Toast 横幅与按钮渲染、协议激活复制提示词；7200 秒冷却边界与并发单显；DPAPI 授权往返；并发席位实验（同授权码后连者被 KICKED，不损授权）。证据见 docs/ 两份脱敏 JSON。

边界：本机本地工作区（`readSessionMessages` 字段校验不一致，正文走 SQLite 只读适配，非实时 V4 快照）；`transcript_path` 是宿主合成的临时文件，不作为历史来源；连接关闭不代表原 Host 的辅助模型请求已取消，ZCode 自身可能记录辅助生成的模型 I/O 与用量；`zcode://workspace/open` 对任意路径弹官方确认框，自动化测试严禁触发协议激活链路（模态框阻塞无人值守流程）。

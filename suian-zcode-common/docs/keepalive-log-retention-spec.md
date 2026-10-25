# 公共网关看护拉起与日志留存设计规格

- 状态：**已实现**（grilling Q1–Q12 收敛后按本规格 TDD 实施，2026-10-25；suian-zcode-common 全量测试 365/365 通过）
- 决策依据与备选方案取舍见 [ADR 0001](adr/0001-keepalive-trigger-and-log-retention.md)；术语见仓库根 [CONTEXT.md](../../../CONTEXT.md)「公共网关看护与日志」一节
- 全部变更落在 `suian-zcode-common`，业务插件不动；版本 0.7.3 → 0.8.0

## 背景与问题

**网关死亡无自愈**：10/24 22:43 网关被外部终止（任务退出码 1）后无人拉起，躺约 24 小时，期间依赖网关的 RPC 链路全部失效。任务仅登录触发；注册时自带的 `RestartCount 3 / 1min` 在该次故障中未兜住（已观察到的行为，根因未深挖）。系统 10/18 以来未重启是放大因素。

**日志两族问题**：

- `gateway.out.log` / `gateway.error.log` 固定文件名，每次启动被截断覆盖——历史无存，排查断档；启动横幅只有 `{ok, relay_url, health_url}`，不含版本与构建信息。
- `hook.log.jsonl`（依赖检查 Stop 钩子）与 `toast-action-log.jsonl`（Toast 动作）只追加、从不清理，无限膨胀。

## 范围

| 变更点 | 文件 |
|--------|------|
| 启动横幅自描述 | `gateway.mjs` |
| 触发器、间隔参数、config 记录、自愈检测、回退路径 | `setup.ps1` |
| 健康门、logs/ 布局、按启动命名、清理、旧文件迁移 | `gateway-launcher.ps1` |
| jsonl 按天滚动、行内嵌版本、写入点清理 | `log-rotate.mjs`（新）、`depcheck-hook.mjs`、`toast-action.mjs`、`toast-executor.mjs`（内联）、`toast-runtime.mjs`（部署文本版本注入） |
| 文档与引用联动 | `skills/debug/SKILL.md`、`skills/setup/SKILL.md`、`README.md`、本目录证据文件按需 |
| 测试联动 | `tests/log-rotate.test.mjs`（新）、`tests/setup.test.mjs`、`tests/stable-launcher.test.mjs`、`tests/cli.test.mjs`、`tests/depcheck-hook.test.mjs`、`tests/toast-executor.test.mjs`、`tests/toast-runtime.test.mjs` |

非目标：僵尸进程救援（见已知限制）、日志大小/条数上限、depcheck 检测任务形状并提醒。

## 设计

### 1 看护拉起

**任务形状**：现有单任务 `suian-zcode-gateway-<SID>` 保留 AtLogOn 触发器，新增第二个触发器——一次性起点 + 每 `KeepaliveIntervalMin` 分钟重复、无有效期内停止。Settings 维持现状（`MultipleInstances IgnoreNew`、`ExecutionTimeLimit Zero`、`RestartCount 3/1min` 保留不动，作为快速重试；30 分钟触发是不依赖上次运行结果的可靠兜底）。

> 实现注意：Windows PowerShell 5.1 的 `New-ScheduledTaskTrigger -Once` 对无限重复的 `-RepetitionDuration` 支持有限（`[TimeSpan]::MaxValue` 不被接受），以 10 年近似无限。形状锁定不逐字依赖任务 XML（测试桩不触达真实任务计划程序）：桩属性断言（间隔分钟、重复时长天数）覆盖注册结果，另以真实 CIM 形态（`CimClass.CimClassName` 登录触发、`Repetition.Interval` ISO 8601 duration 字符串）覆盖 `Get-TaskTriggerShape` 识别分支。

**两层幂等**：

1. 任务层：`IgnoreNew`——任务 Running 时新触发被忽略，网关退出后下个周期边界拉起（最坏延迟 = 间隔）。
2. 启动器层：`gateway-launcher.ps1` 在拉起前探测 `http://127.0.0.1:<port>/health`（读 `config.json` 取端口，超时 2 秒）。返回健康（`service=suian-zcode-gateway`）则 `exit 0` 不启动；其余一切结果（连接拒绝、超时、解析失败、config 缺失损坏）都尝试启动——fail-open，不引入新的拉起阻塞。端口被未知进程占用时第二实例会 bind 失败并以退出码暴露，行为与现状一致。

**间隔参数**：`setup.ps1` 新增 `-KeepaliveIntervalMin`，默认 30，`ValidateRange(5, 1440)`；写入 `config.json`（`keepalive_interval_min`），任务重建时从已装配置恢复同值。`Status` 回执新增 `keepalive_interval_min` 与任务形状判定。

**存量自愈**：`Get-GatewayUpgradeStatus` 的 `launcherUpdate` 扩展为同时比对触发器形状与间隔；不符 → `gateway_restart_required=true`，用户重跑 `setup.ps1 Install/Restart`（插件更新后的既有重配路径）时自动重注册为新形状。健康网关上的 Install 同样执行自愈：任务缺失，或启动动作与当前一致而形状/间隔不符时，原地重注册（只替换任务定义、不打断运行实例，新定义在当前实例结束后生效），且先重注册再写 config，回执与 config 记录的间隔就是任务实际间隔；启动动作不符（旧 PowerShell 启动链）保持既有边界，只报告待升级、动作切换交给安全重载。间隔识别按完整 ISO 8601 duration 换算总分钟，`PT1H`/`PT1H30M`/`P1D` 与等值分钟写法视为同一形状，不触发反复重注册。回退路径（候选失败 fallback 中重建任务那段）同样注册双触发器形状。本期不给 depcheck 加检测提醒。

### 2 启动批次日志

**布局与命名**：`DataDir/logs/` 子目录；每次启动生成一对 `gateway-<yyyyMMdd-HHmmss>.out.log` 与 `.error.log`（本地时区，字典序即时间序）。清理只扫该子目录，不碰 `config.json` 等运行数据。

**启动器改造顺序**（单次运行内）：计算时间戳 → 建 `logs/` → 清理窗口外文件（按文件名时间戳解析，解析不出该模式的文件一律不删，防误删）→ `Start-Process` 重定向到新文件对。

**旧文件迁移**：根目录旧 `gateway.out.log` / `gateway.error.log` 在新启动器首次运行时删除（内容本就已被历次启动覆盖，无保留价值）。健康门命中（网关已健康、幂等退出）时不动任何文件，清理与迁移顺延至下一次实际拉起。

**自包含横幅**（gateway.mjs）：启动成功时的首行 stdout 由 `{ok, relay_url, health_url}` 增强为完整自描述记录：

```json
{"ok":true,"started_at":"<ISO8601>","mode":"relay","port":17329,"relay_protocol_version":2,"build":{"id":"<buildId>","version":"0.8.0","root":"<部署目录>"},"node":"v24.x","pid":12345,"relay_url":"...","health_url":"...","config":"<config.json 路径>"}
```

error.log 是 stderr 直通、无横幅；与 out.log 同时间戳成对生成，溯源信息在配对文件中（已接受的限制）。不引入伴随 meta 文件。

### 3 jsonl 日族滚动

**命名**：`hook-<yyyyMMdd>.log.jsonl`、`toast-action-<yyyyMMdd>.log.jsonl`，本地时区日期。三个写入点（depcheck-hook、toast-action、toast-executor）统一改造。

**行级自包含**：每条事件行内嵌短版本字段（如 `"v":"0.8.0"`）。版本来源以单一数据源为原则（倾向读插件清单），实现时确定并避免与清单漂移。

**写入点清理**：每次 append 前列同前缀文件，删除文件名日期早于「今天 − 7 天」的；列目录 + 前缀匹配，成本可忽略。旧单文件 `hook.log.jsonl` / `toast-action-log.jsonl` 首次以新命名写入前删除。

### 4 测试计划（TDD 锚点）

- `setup.test.mjs`：PS 桩 `New-ScheduledTaskTrigger` 扩展支持 `-Once` + 重复参数；断言注册结果含双触发器与间隔；参数越界拒绝；`config.json` 记录与重跑恢复；旧形状任务触发 `gateway_restart_required`；CIM 形态识别（`Repetition.Interval` 完整 ISO 8601 duration，含 `PT1H`/`PT1H30M`/`P1D` 等价写法）参与自愈判定；健康网关上的 Install 自愈（旧形状重注册、改间隔即时生效、不打断实例、已一致不重注册）；fallback 重建保持双触发器。
- `stable-launcher.test.mjs`：断言 `logs/` 按启动命名文件对；首行横幅字段齐全；健康门（真实固定端口：健康时 exit 0、不产生第二批次与第二进程；不健康时正常拉起）；预置 >7 天与 <7 天文件的清理集与不合规命名保留；旧根目录日志被迁移删除。
- `depcheck-hook.test.mjs` / `toast-executor.test.mjs`：滚动命名、行内嵌 `v`；executor 另有内联清理专测（窗口外日文件与旧单文件删除、命名不合规保留，覆盖 PKG-06 快照的内联实现）。
- `cli.test.mjs`：横幅内容断言（CLI stdout 首行与 config 模式两种入口）。其中 VBS 隐藏启动测试走仓库根 `run.ps1` 旧启动链（见已知限制），其 `gateway.out.log` 引用保留，不改指新布局。
- `log-rotate.test.mjs`：日戳与截断日计算、过期清单筛选（家族前缀与旧单文件精确匹配）、滚动写入与清理行为、版本解析回退。

### 5 发布清单

- `.zcode-plugin/plugin.json` → 0.8.0；`package.json` 与锁文件根包版本（若已有版本字段）同步；运行时自报版本一致。
- `CHANGELOG.md` 按发布范围新增 0.8.0 条目。
- 根 `marketplace.json` common 条目版本同步。
- 发布走 `release-orchestrate.mjs` 既有门禁，不另开流程。

## 已知限制与假设

- **僵尸不救**：进程存活但不监听时，`IgnoreNew` 会挡住周期触发，仅手动 `Restart` 可恢复——本期明确不引入杀进程语义。
- **注销后无看护**：Interactive 会话任务注销后不运行，与现状语义一致。
- **最坏自愈延迟 = 间隔**（默认 30 分钟）。
- **无大小/条数上限**：量级估算最坏 7 天约 670 对 KB 级文件；若将来异常膨胀再补条数保险。
- **RestartCount 未生效原因**：作为已观察事实记录，不阻塞本设计。
- 仓库根 `run.ps1` 是旧启动链遗留，不属于本变更对象（归 legacy-cleanup 既有边界）。

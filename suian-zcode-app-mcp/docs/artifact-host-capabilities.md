# #27：当前发行版的纯插件工件能力核验

核验日期：2026-10-10。对应 [GitHub #27](https://github.com/ONEGAYI/ZCode-Plugins/issues/27)。规格见 [工件区规格](artifact-zone-spec.md)，脱敏运行证据见 [JSON 记录](artifact-host-capabilities-evidence.json)。

## 结论

**当前 3.14.5 发行包的正式插件契约不能提供已确认的两项严格保证**：每个模型请求的唯一最新尾部投影，以及原生分叉时冻结外置工件状态。已运行的 `UserPromptSubmit.additionalContext` 方案违反刷新、唯一和尾部要求；分叉通知能给出父子身份，但不绑定工件 revision 或等待外置快照完成。

本票调研完成，结论为能力不足。#28–#30 继续依赖上游支持；关闭本票不会解除它们的能力条件。#31 仍为可选后续，不在本次实施范围。

## 固定对象与隔离方式

| 对象 | 实际核实结果 |
| --- | --- |
| 安装 EXE | ProductVersion `3.14.5.7961` |
| 桌面归档 | package version `3.14.5`；326,914,395 字节 |
| 随包 CLI | `resources/glm/zcode.cjs`；14,820,968 字节；`--version` 返回 `0.16.9` |
| 正式启动链 | 随包 EXE 的 Electron Node 模式执行该 CJS，参数 `app-server --stdio` |
| 本次运行 | 使用上述 EXE、Node 模式和原封不动的 CJS，启动隔离 AgentServer |

CLI SHA-256：`FAD4C35C4C36EC210D8A06D3FA0E77DE23C8545E2EB6FF90AEA1EB38D1E6275F`。ASAR SHA-256：`4BEFBE43EB7B4FD83426896991F4A399F1102AF0E0865BA34F2B69FC3A2A9931`。核验后再次计算，两者均未变化。启动链的归档内位置见 [请求链静态审计](artifact-host-request-audit.md)。

工作目录为 `{{AZ27_ISOLATED_ROOT}}/workspace`。配置、Profile、SQLite、插件缓存与日志均在本项目忽略的临时目录内。子进程环境采用白名单，单独设置 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、TEMP/TMP，以及 `ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH`、`ZCODE_DATA_BASE_DIR` 和三项 Provider 配置路径。

只复制安装包的公开内置 Provider 配置。模型端点是 `127.0.0.1` 上的合成 OpenAI Chat Completions 服务，使用测试占位凭据与确定性 SSE；没有调用在线模型、复制用户凭据、连接用户活动会话或注册真实用户配置。正式存储环境变量的源码依据见 [env-config.adapter.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts#L24-L32)。

**隔离 AgentServer 不等于原运行中的 Desktop 验收**。本次未点击真实桌面 UI，也未检验多窗口原 Host 接线。静态启动链和同一发行产物的运行行为分别留证，不互相替代。

## 请求投影的实际结果

测试插件通过 `plugins.dirs` 加载，在 `UserPromptSubmit` 输出带 revision 的 `additionalContext`。两次真实 MCP 工具调用只修改隔离状态文件，回执为版本和 changed；它们是能力探针，未实现生产 `get_artifacts/set_artifacts`。

HTTP 服务捕获序列化后的实际 `messages`。标识只出现在自动 Hook 投影中，普通工具回执和用户正文不含标识，因此下表的重复计数针对自动投影。

| 请求 | 场景 | 请求时状态版本 | 自动投影版本 | 位于数组末端 |
| --- | --- | --- | --- | --- |
| B1 | 第一轮初次请求 | 1 | 1 | 否：索引 3，共 5 条消息 |
| B2 | 工具更新为 2 后续跑 | 2 | 1 | 否 |
| B3 | 再次更新为 3 后续跑 | 3 | 1 | 否 |
| B4 | 第二轮用户输入 | 3 | 1、3 | 否：索引 3、10，共 12 条消息 |
| A1 | 关闭进程后恢复，再提交用户输入 | 4 | 4 | 否 |
| A2 | 合成 503 后的 HTTP 重试 | 5 | 4 | 否 |
| A3 | 手动压缩的模型请求 | 5 | 4 | 否 |
| A4 | 压缩后的用户输入 | 6 | 6 | 否 |
| F1 | 子会话首次请求 | 7 | 7 | 否 |

A1/A2 是同一模型步骤的两次传输尝试。状态在首次合成 503 时从 4 改为 5，SDK 重试复用旧请求体；不将这两次尝试描述为两次用户提交 Hook。所有已捕获请求的工具调用与结果配对检查通过；合成服务不代表线上 Provider 验收。

B2/B3 表明工具续跑没有重新执行用户提交 Hook。B4 表明同一会话运行时被复用期间，旧自动投影仍在请求历史里。即使 B1 只有一份投影，它后面也还有消息，所以不能把“Hook 在用户提交后运行”当作最终 messages 尾部保证。

正式加载器仍只有七类 Hook。隔离插件声明 `BeforeModelRequest` 和 `SessionFork` 后，实际 `plugins list --json` 返回两项 `plugin_hook_unsupported_event`，其 `hookDetails` 为空。`plugins validate` 单独返回 `ok: true`，只据此不能声称这些组件可执行。原始契约及发行包字节位置见 [请求审计](artifact-host-request-audit.md)。

3.14.5 内部已有 `pendingMemoryUpdate → memory_update` 的临时请求追加；它未暴露为插件槽，且是消费一次的记忆更新。不能把这一内部路径写成可用的第三方工件入口。

## 运行时、聊天库与日志分别核查

**运行时历史保留了旧自动投影**。同一会话运行时被复用期间，B4 请求实际携带版本 1 和 3，已构成严格目标的反例。

**本次聊天与恢复数据未发现投影标识**。只读扫描隔离 SQLite 的 23 张业务/迁移表的 TEXT 列，标识命中为零；第一、第二轮 `session/read` 同样没有标识。关闭 AgentServer 后恢复，A1 不含 B1/B4 的旧标识。这里的阴性结果限于本次数据与运行路径，不据此概括所有存储场景。

**默认模型 I/O 日志另存了投影副本**。父、子 `storage/cli/rollout/model-io-*.jsonl` 均发现自动标识。这是诊断文件，本次未从它恢复旧投影；不能称为写入聊天正文，也不能把“不入聊天历史”扩大成“任何诊断记录都不保存”。记录开关和写入路径见 [runner-debug.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-debug.ts#L64-L67)及 [写入分支](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-debug.ts#L468-L522)。

### 连续对话与数据库恢复

**正常连续对话不会每轮从数据库重建完整模型历史**。本次补充核实仍对应 EXE `3.14.5.7961`、桌面包 `3.14.5`、CLI `0.16.9`，相关分支已在原装 CJS 中逐项核对。

- **会话运行时仍在缓存中**：`activateSessionForResume` 命中 `context.sessions` 后直接返回已有 record；发送复用该 record 的 App。本轮请求从内存 `messageHistory` 复制底稿。即使调用 `session/resume`，缓存命中也不等于从数据库冷恢复。
- **会话运行时不存在**：进程重启或 record 被回收后，恢复路径读取持久会话与消息，新建 App；`resumeFromStore` 新建消息历史并载入持久消息。

因此，“不入聊天数据库，仍留在内存历史”只限定于会话运行时被复用期间。访问数据库不等于用数据库重建模型请求；不能把保留范围扩大成整个进程生命周期。B4 的旧、新两份投影与 A1 冷恢复后旧投影消失，分别对应上述两条路径。源码链接及发行包字节定位见 [请求链静态审计](artifact-host-request-audit.md#连续对话与数据库恢复)。

## 分叉边界的实际结果

使用桌面稳定分叉所走的 V4 入口：先 `v4/conversation/rowsRange` 取得已完成且 canFork 的 assistant 行，再发 `v4/command` 的 `forkAssistant`。实际返回 accepted 和子会话 ID；父订阅收到 `type: session.updated`，payload 有 originalSessionId、forkedSessionId 和 targetMessageId，没有工件 revision。协议格式与提交时序见 [分叉审计](artifact-host-fork-audit.md)。

对该边界设置了一个受控反例：

1. 提交分叉前，隔离父状态为 revision 6。
2. 收到已提交分叉的父通知后，探针把父状态更新为 7。
3. 子 `SessionStart` 读取时已是 7；随后首次用户请求也投影 7。
4. 子 Hook 输入没有父 ID、分叉点或工件 revision；这些身份可在协议通知中发现，但通知没有冻结外置状态的回执。

这项测试**没有实现工件复制**，也不把未实现复制当作宿主丢失工件的证据。它验证的是“子首次启动读取父最新状态”候选方案：该方案会读取后续版本 7，不能保证所要求的分叉时版本 6。要实现严格语义，还缺宿主分叉边界与外置修订之间的绑定契约。

## 所需上游能力与后续条件

- **请求级插件槽**：给定会话和稳定槽 ID，在每个适用模型请求装配时读取最新状态；唯一替换，Provider 序列化后仍位于约定尾部，并排除出权威历史、聊天持久化与恢复快照。覆盖工具续跑、重试、压缩、恢复；生成失败能明确阻止请求。诊断日志的处理边界也需写明。
- **分叉状态绑定**：提供可靠的父子身份与分叉时修订绑定，在子首次读取前完成外置快照；定义并发父更新、重复通知和子恢复的语义。仅在复制完成后通知，或在子启动时补读最新值，都不能提供这项保证。

尚未核实到具备上述契约的目标发行版本，未经授权也未向上游创建票。#28–#30 保持受阻，待具名上游能力及支持版本明确后再解除条件；不修改 ZCode，不替换运行时，不用模型网络代理冒充插件支持。

2026-10-10 已按用户要求给当时全部四张开放 Issues（#28–#31）添加 `wait-for-upstreaming`，保留原有 `enhancement` 标签并回读核验。#27 保持关闭，正文已补充版本限定及内存复用/数据库恢复结论。

## 验证记录与限制

主场景、重试/压缩/恢复、修正后的 V4 分叉、组件加载核查与脱敏证据导出均正常退出。证据导出对九个请求的标识、工具配对、分叉版本、子 Hook 时序及组件诊断做了断言；断言通过表示反例被复核，**不表示严格目标通过**。

前期探针的双向协议握手、reasoning 选择、响应形状和首次分叉夹具时点曾修正；失败退出码及排除原因留在 JSON 记录中。主场景起初额外声明了两个不支持的生命周期名称，加载器忽略它们；所测 UserPromptSubmit 与 Pre/PostToolUse 已实际执行，后续夹具已改成真实七类事件。

未验证真实 Desktop UI、线上 Anthropic/OpenAI/Responses 接受性、所有并发/多窗口分叉调度、生产工件存储以及真实 Agent 主动维护行为。已确认八个探针 AgentServer PID 及其遗留子进程均不存在；核对绝对目录与重解析点后，已清理原探针、隔离 Profile、数据库和日志，只保留本报告与脱敏证据。

# app-mcp 定时任务管理工具规格（automation tools）

> 注（2026-10-20）：本文是设计期规格，保留当时的命名。文中 `set_automation_enabled` / `list_automations` 已更名 `set_cron_enabled` / `list_crons`（见 CHANGELOG「Unreleased」）；`setAutomationEnabled` 为官方 RPC 协议名，保持不变。
>
> 状态：ready-for-agent（待实施）
> 分支：`appmcp-cron-tools`（基于 dev @ b2f32da）
> 依据：2026-10-18 本仓调研（官方 v3.15.1 快照源码）+ 本机实测（jsonl 证据，见 Further Notes）

## Problem Statement

ZCode 的定时任务（automation）绑定到某个会话后，每次触发形成的"派发轮"里，官方 CronCreate / CronUpdate / CronDelete 三个工具会从该轮模型工具面整体剥离（官方为防任务递归修改自身调度而设的权限边界）。后果：

- 模型在上下文中"看得见"这些工具（系统提示层仍列出），但实际调不动——调用意图会坍缩到最相似的可用工具（CronList），表现为"连续想调 CronDelete，实际发出的全是 CronList"；
- 官方会话内工具面**没有启停能力**（CronUpdate 明确禁改 enabled），暂停/恢复只能到桌面管理页手动操作；
- 官方 CronList 只查当前工作区，跨工作区定位任务没有会话内途径；
- 无人值守场景（pr-babysit 巡查：发现合并后自删任务）被结构性锁死，只能等用户手动清理。

## Solution

suian-zcode-app-mcp 新增三个 MCP 工具（MCP 工具注入不经官方派发轮 denylist，在派发轮内全程可用——已实测）：

1. `set_automation_enabled` —— 真实暂停/恢复（官方工具面没有的能力），远控 RPC 直达；
2. `list_automations` —— 跨工作区列出定时任务与调度状态（本机持久库直读）；
3. `reset_cron_tools_visibility` —— 语法糖：给自己发一条唤醒消息并**立即结束本轮**；下一轮（人工轮）官方 Cron 工具面恢复，从而用官方 CronDelete / CronCreate 完成删除与重建（组合路径，已实测闭环）。

create / delete / update 不做直连工具：组合路径已覆盖，且 RPC 创建无法绑定会话（官方白名单不含 targetTaskId），直连价值不足。

## User Stories

1. 作为定时任务绑定的巡查会话，我想在派发轮里暂停自己的定时任务，以便开始修复期间不再被触发唤醒。
2. 作为巡查会话，我想在修复推送完成后恢复定时任务，以便继续无人值守巡查。
3. 作为任意会话，我想列出任意工作区（或全量）的定时任务及其调度状态（enabled / lifecycle / nextRunAt / runCount / cronExpr / title），以便定位要操作的目标。
4. 作为巡查会话，我想在派发轮里通过一条工具调用恢复官方 Cron 工具的可用性（发唤醒消息并结束本轮），以便下一轮用官方 CronDelete 自删。
5. 作为巡查会话，我想在推送后用官方 CronCreate 重建绑定本会话的定时任务（经 reset 唤醒的人工轮），保持触发投递回原会话。
6. 作为用户，我希望代理在 PR 合并/关闭后能自动清理对应定时任务，不需要我到桌面管理页手动删除。
7. 作为代理，我希望 MCP 工具在派发轮内照常可用，不受官方 Cron 工具剥离影响。
8. 作为代理，我希望 reset 工具的说明讲清"人工轮与自动化轮的区别"和"能看见工具不等于能调用"，以便我正确判断何时需要它、以及为什么发出后必须立即结束本轮。
9. 作为代理，我希望 list 结果里能按标题约定（如 `[pr-babysit] <owner>/<repo>#<PR>`）定位任务 id，支撑技能的跨会话清理纪律。
10. 作为调用方，我希望暂停/恢复语义与桌面管理页一致：暂停后调度器不再认领派发，恢复后按原计划继续，id、历史与绑定不变。
11. 作为调用方，我希望工具入参沿用插件既有的工作区定位模式（workspace_path / workspace_key），行为与其他写工具一致。
12. 作为调用方，我希望语法糖的消息文本默认内置、可用 instruction 参数覆盖，以便携带具体指令（如"删除 automation-xxx"）。

## Implementation Decisions

- **通道与命令**：`set_automation_enabled` 走公共网关桥的 `zcode-agent` 通道 `setAutomationEnabled`（Host 侧显式白名单透传至 automationService.setEnabled，写操作带工作区归属校验）。
- **读走本机库**：`list_automations` 直读本机 tasks-index.sqlite 的 automations 表（与现有读工具"只查本机持久化数据"纪律一致；reader 已在读该库）。支持可选 workspace 过滤，缺省全量；只读、离线可用、不要求网关连接。输出投影至少含 automationId / title / cronExpr / enabled / lifecycleStatus / nextRunAt / lastRunAt / runCount / recurring / maxRuns / scheduleRule / workspaceKey / workspacePath / targetTaskId。
- **写走网关**：`set_automation_enabled` 必传 automation_id 与 workspace 定位（目标工作区须在网关连接的 Desktop 打开）；enabled 布尔区分暂停/恢复。不加 reset_glm_quota 级授权语义（操作可逆）。
- **语法糖实现**：`reset_cron_tools_visibility(instruction?)` 复用 controller 既有 send 能力（sendConversationCommandV4，requestedDelivery 固定 queue——实测 guide 对运行中会话被宿主强制降级，无需暴露模式参数）。目标固定为当前会话（服务从 MCP 请求 session_id 定位，不接受手填来源，与创建/发信纪律一致）。内置默认文本必须包含"收到回执后立即结束本轮"的指令——实测证明同轮注入不换工具面，恢复的关键动作是结束轮而非发消息。instruction 参数覆盖默认文本时同样要求保留该指令。
- **工具描述纪律（writing-for-agents）**：描述只写模型调用工具真正需要知道的信息——何时需要（自动化轮里官方 Cron 写工具调不动）、怎么用（调用后立即结束本轮）、下一轮会发生什么（官方 Cron 工具恢复可用）；讲清人工轮/自动化轮区别与"可见≠可调用"；不塞内部实现（denylist 机制名、RPC 细节、协议字段）。
- **不做直连 create/delete/update**：组合路径（reset → 人工轮官方工具）已实测闭环；RPC createAutomation 无 targetTaskId 通道（官方白名单显式排除），直连创建必然是"未绑定"型（每次触发新建会话），价值不足。
- **版本**：0.7.2 → 0.8.0（新增功能面，minor）。同步 package.json / .zcode-plugin/plugin.json / package-lock 根包 / CHANGELOG，并同步根 marketplace.json 对应条目（仓库纪律）。
- **文档**：契约补入 docs/write-tools.md（set_enabled、reset）与 docs/readonly-tools.md（list）；新建 skills/automations/SKILL.md（域独立，不塞 sessions）。

## Testing Decisions

- 只测外部行为（公布的 schema、参数校验、controller 收到的命令与注入字段），不测实现细节。
- **全部复用现有接缝，不新建**：
  1. MCP 契约层（tests/mcp.test.mjs 模式）：InMemoryTransport + 真实 Client + stub controller——三个工具的 inputSchema 公布形状、strict 拒非法输入（未到达 controller 前被拒）、readOnlyHint/destructiveHint 注解；
  2. controller 单元层（tests/control.test.mjs 模式）：注入 stub connect——set_automation_enabled 断言 RPC 通道名、命令名、automationId/enabled/workspace 传参；reset 断言目标为当前会话、requestedDelivery=queue、默认文本含"结束本轮"指令、instruction 覆盖生效；
  3. reader 单元层（tests/sessions.test.mjs 模式）：fixture 建 tasks-index automations 表——list 的过滤、投影与空表行为。
- 先写契约测试观察红灯，再实现（仓库 TDD 纪律）；首次运行落盘日志与退出码。
- 本会话的 jsonl 实测（派发轮/人工轮工具面、queue 新轮恢复、guide 降级）作为设计依据记录于 Further Notes，不做自动化回放。

## Out of Scope

- create / delete / update 的直连 RPC 工具（组合路径替代）。
- runAutomationNow / listAutomationRuns / deleteAutomationRun / restartAutomation。
- OffPeak（闲时任务）域——独立服务面。
- targetTaskId 会话绑定与 botDeliveryTarget（RPC 不可达，官方注入路径专属）。
- 远端工作区路由（remoteSessionId）——首版仅本地已打开工作区。
- title 投影、官方 CLI 会话内 Cron 工具行为的修改（只观察不改动）。

## Further Notes

**实测证据（2026-10-18，本机，会话 sess_663b6776…，jsonl 133 轮记录）**：

- 派发轮（cron 触发，含同轮注入引导消息后的全部请求）Cron 工具面恒为 `["CronList"]`；用户主动轮四件套完整（模型 IO toolNames，行 119-132）。
- queue 自发 → 轮结束 → 新轮（人工轮）官方 CronDelete 成功删除测试任务（`deleted: true`）。
- guide 显式请求被宿主降级（回执 `requested: guide → admitted: queue`）；消息在运行中轮的下一个可消费边界同轮注入，但工具面不恢复（同轮内三次试图调 CronDelete，实际发出均为 CronList——与 pr-babysit 会话 sess_106967d3 报告的现象一致）。
- 宿主 sendPrompt 主路径不带投递模式字段；插件 send_message 将 delivery_mode 显式转为 v4 sendText 的 requestedDelivery。

**官方源码锚点（v3.15.1 快照，sources/official-zcode）**：

- 派发轮剥离：packages/services/src/zcode-agent/automationToolPolicy.ts（AUTOMATION_MUTATION_TOOL_NAMES = CronCreate/CronUpdate/CronDelete）；合并点 zcodeAgentService.ts:3668-3678（只认本轮 payload.automationId）。
- 启停服务：zcodeAgentService.ts:5026 setAutomationEnabled → automationService.ts:432（注释"暂停 / 恢复"）→ automationRepo setEnabled（lifecycle paused↔active；调度器认领条件 `enabled = 1`）。
- RPC 白名单（无 targetTaskId）：zcodeAgentService.ts:4979-4994；参数类型 zcodeAgentPluginParams.ts:187-225。
- 桥通道全方法透传：zcodeAgentConnectionScope.ts:1021（new Proxy(base)）。

**风险**：官方版本升级可能调整 denylist 或 RPC 面；实施时以通道探测复核（experiments/probe-official.mjs 可扩展）。

**pr-babysit 技能联动（后续，不在本票）**：技能生命周期规则可改写为——修复前 `set_automation_enabled(enabled=false)`、推送后 `set_automation_enabled(enabled=true)`、合并后 `reset_cron_tools_visibility` → 人工轮官方 CronDelete 自删；`CronDelete` 缺失时的能力门禁相应放宽（本插件三工具为替代面）。

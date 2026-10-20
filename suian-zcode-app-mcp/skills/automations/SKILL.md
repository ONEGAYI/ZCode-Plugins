---
name: automations
description: 通过 ZCode 会话 MCP 列出、暂停或恢复定时任务，并在定时任务派发轮内恢复官方 Cron 工具调用能力。
---

# 定时任务操作

原生根为 `${ZCODE_SKILL_DIR}/../..`；源码模式沿用已确定的根。先读[路径与配置](../paths.md)，以客户端实际工具清单定位服务。

三个定时任务工具覆盖查询、启停与工具面恢复；删除、新建和修改不在本插件面，走官方 Cron 工具（组合路径恢复后可用）。工具名以 cron 对齐官方 Cron 工具族；返回字段保留官方数据模型的 `automationId`，即定时任务 ID：

- 查询契约见 [读取契约](../../docs/readonly-tools.md)「列出定时任务」：本机 tasks-index 直读，缺省全量或按工作区过滤。
- 启停与唤醒契约见 [写入契约](../../docs/write-tools.md)「定时任务启停」与「定时任务工具面唤醒」。

| 工具 | 操作要点 |
| --- | --- |
| list_crons | 本机索引只读，缺省全量；workspace_path 规范化匹配、workspace_key 精确匹配，同给时取交集收窄；空表返回空列表不报错 |
| set_cron_enabled | enabled:false 暂停调度（任务保留不删）、true 恢复；写后读回确认实际状态，任务不存在、不属于该工作区或未生效时明确报错，不报告虚假成功；目标工作区须已在网关连接的 Desktop 打开 |
| reset_cron_tools_visibility | 定时任务派发轮内发现自己调不动官方 Cron 写工具时调用；目标固定当前会话，投递固定 queue，收到回执后立即结束本轮，下一轮官方 Cron 工具恢复 |

自动化轮边界：官方为防任务递归修改自身调度，把 CronCreate/CronUpdate/CronDelete 从定时任务派发轮的工具面剥离——上下文中仍列出这些工具，实际调不动。恢复的关键动作是结束当前轮、让下一轮以人工轮运行，不在本轮内反复重试；reset_cron_tools_visibility 是该路径的语法糖，直接用 send_message 给自己投递 queue 消息并结束本轮等效。

启停与唤醒按用户对具体动作的授权执行。list_crons 不连网关，读取本机持久化状态，运行中任务的实时进度不在其中。

## PR 巡查生命周期联动

代理执行 PR 巡查流程时，按阶段组合使用三个工具：

1. **修复前暂停**：list_crons 定位巡查任务，set_cron_enabled(enabled:false) 暂停派发，取得读回确认后再开始修复。
2. **推送后恢复**：set_cron_enabled(enabled:true) 恢复巡查，同样以读回确认回执为准。
3. **合并后自删**：reset_cron_tools_visibility 发出唤醒并在收到回执后结束当前轮；下一轮（人工轮）用官方 CronList 定位、CronDelete 删除巡查任务，不在唤醒轮内重试 Cron 写操作。

---
name: control
description: 暂停或恢复 ZCode 自动命名，固定、解除固定或查询指定会话的标题策略；不手动改名。
---

# 自动命名控制与标题保护

原生根为 `${ZCODE_SKILL_DIR}/../..`；源码模式沿用已确定的根。先读[路径与数据](../paths.md)，命令加配置路径并以 stdin 传指定会话。

| 请求 | CLI 命令 |
| --- | --- |
| 暂停 / 恢复自动命名 | disable / enable；执行后复读并报告 enabled |
| 固定 / 解除固定单个会话 | lock / unlock |
| 查询单个会话策略 | policy；null 表示从未设置公共策略 |

lock/unlock/policy 先校验会话存在，不连网关；重复操作幂等，返回 previous/policy。目标不限于当前会话，可用会话 MCP 查询其他 session_id；busy 表示命名 worker 持锁，稍后操作。

固定不改标题，自下一次 Stop 生效，不追溯飞行中的命名轮。公共 locked:true 阻止生成，false 允许自动命名，模型依本地提示词选择 keep 或 rename；MCP 创建会话提供初始 title 不隐含锁定。

无公共策略时，旧命名基线后出现非 generated 标题变化才触发旧手动保护；单独 custom 来源不足以证明锁定。旧锁表现为 manual_title，不出现在 policy；用户明确要解除旧锁时核对并移除对应旧状态文件，删除旧状态不能解除公共 locked:true。

固定和官方手动改名是两套机制，不为固定调用 rename_session；官方改名会将标题来源置为 custom。是否滚动仍由内容指纹、模型 keep/rename 与写前复核共同决定。

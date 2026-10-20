---
name: debug
description: 排查 ZCode 会话 MCP 的依赖、原生注册、外置配置、数据库和原 Host 故障，不执行未经授权的写操作。
---

# 会话 MCP 排障

原生根为 `${ZCODE_SKILL_DIR}/../..`；源码模式沿用已确定的根。先读[路径与配置](../paths.md)，固定启动目录、注册方式、实际 cli.mjs 和配置文件。

1. 核对 Node.js 24+、SDK/zod、公共 ws 与包链接；npm ci 后重新运行公共 link.mjs，不复制实现，不给 MCP 强加 sqlite3 CLI。
2. 原生模式核对业务与 common 的 enabled、外置 config 和带命名空间的服务名；源码模式查生效文件的 enabled/旧 enable。不以旧全局名判断原生服务不存在。
3. 按[握手与隔离读取步骤](verification.md)验证 stdio 初始化和工具清单（基础十九个；宿主索引含 projects 表时另有 list_projects），再在源码工作树的临时双库上验证读取。缺库、schema 不兼容和会话缺失分别报告，不创建空库，不静默返回空历史。
4. 读取可用而写工具失败时，转公共 debug 检查网关、RPC、Desktop、模式和工作区；文件已新而旧进程缺 RPC 时安全重载，不回退独立 terminal。

caller_unknown / caller_context_invalid 先核对客户端实际 session_id、trace_id 与本地 tool_usage；不把选中项、最近会话或自填 ID 当来源。冲突/歧义可能返回 warnings，来源标识不是用户授权。

写操作超时可能已提交，先用读取工具核查，不自动重试。ACK 不等于对方回复或压缩完成。GLM 重置结果未知按 glm 技能处理，不新建尝试补发。

更新后旧会话可能仍用旧 MCP；确认实际服务名，再按 setup 的断开宽限或用户择时重开流程验证。测试仅对指定的新测试会话，不激活真实通知协议，不直接改库，不输出 control_token、授权链接或消息正文。

# #226：Linux Source Server 自动命名验收

2026-11-25，使用 Debian 12 x64 隔离容器作为 SSH 目标。容器运行官方 Source Server `4.0.0-linux-x64-e68f1d7b9453`、Node.js 24.20.0 和 sqlite3 3.40.1；common 与 title 均使用本次构建的发布目录。模型由回环模拟服务提供，测试对话不使用真实账户或模型额度。

## 初版命名链路

| 环节 | 实测结果 |
| --- | --- |
| 原生初始化 | 仅检查不写配置；首次配置保持暂停，重复安装保留已有启用状态。未部署桌面网关和 Windows 通知。发布入口 `probe` 成功，`models` 能读到远端测试模型。 |
| 创建会话 | 通过 Source Server 的 `/ws/host` 建立 `desktop-continuous` 连接，用原生 V4 `createSession` 提交远程项目首轮。 |
| 自动命名 | 原生 Stop 派发发布版 worker，独立命名模型调用一次，结果为 `renamed`。 |
| 写回与通知 | 原 Host `getTaskMeta`、CLI 会话库和任务索引中的标题一致；同一个 Desktop Host 连接收到该任务的 `task_title_changed`；发布版 `doctor` 返回 `ready`。 |

**核验层级**：驱动程序通过 SSH 在容器内运行，以原生协议创建远程会话并订阅 Desktop Host 事件。未打开 Desktop 窗口验收侧栏渲染。TCAD 的 CentOS 7 不满足官方 Source Server 运行要求，本次未改动该虚拟机。

契约测试额外覆盖了未登记任务、同一会话对应多条索引、普通分叉、无效 RPC 帧和桌面网关的兼容行为。

## 本轮回复提醒

同一官方版本、新建隔离 SSH 目标。通过 Desktop Host V4 发起会话；回环模型只在实际聊天请求携带 Hook 提示文本时才把它附到回复后，不从场景名推断应该提醒。用同一 Desktop Host 连接读取 `conversationRowsRangeV4`，逐条核对最终的 `assistantText`。

| 远端状态 | Desktop Host 收到的当前轮回复 | 命名 |
| --- | --- | --- |
| 无配置文件 | 正常回复 + 尚未配置提示 | 不派发 |
| 已初始化，尚未选模型 | 正常回复 + 尚未配置提示 | 不派发 |
| 所选模型不在目录 | 正常回复 + 模型不可用提示 | 不调用命名模型 |
| 所选思考档位不在目录 | 正常回复 + 模型不可用提示 | 不调用命名模型 |
| 主动暂停 | 只有正常回复 | 不派发 |
| 配置可用 | 只有正常回复 | 正常改名，Desktop Host 收到 `task_title_changed`，两库与宿主一致 |

每个场景只发起了一次普通聊天的流式模型请求。原生 `UserPromptSubmit` 的短读检查使用 `additionalContext` 传递提示；异步 Stop 仍负责后台命名。Windows 入口不发这类会话内提示，原有 Toast 不变。契约测试先验证缺少原生提醒、发布入口与待配置状态时失败，再跑 Hook、CLI、后端、安装和发布目录用例，73 项通过。验收到 Desktop Host 的回复数据；是否复述提示由主 Agent 决定，未使用真实模型或打开 Windows 聊天窗口。

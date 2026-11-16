# ZCode 3.18：原生工作树、插件兼容与规则加载

**支持接手已有原生工作树会话**：用户在 ZCode 桌面创建后，插件按实际执行目录读取历史、操作文件，按原项目目录调用宿主。远控仍不提供原生创建入口。

核对范围：2026-11-11 公开源码 [`b95ebaf`](https://github.com/zai-org/ZCode/commit/b95ebaffeab641907b38652f45c1502bd762972d)，修复前插件基线 `e37fa1c`。定向测试覆盖 [app-mcp 路径筛选、读取和宿主定位](../tests/sessions.test.mjs)、[会话控制](../tests/control.test.mjs)、[自动命名](../../suian-zcode-title/tests/backend.test.mjs)及[侧栏隔离保存和评论受理](../../suian-side-editor/tests/comment-state.test.mjs)。侧栏协议包由 3.18 官方源码重建。Windows `3.18.0.10300` 的实机结果见下文「桌面验收」。

## 同一项目下，Host 路由与文件目录是两回事

| 值 | 原生工作树会话的含义 |
| --- | --- |
| `tasks.workspace_path` / `workspace_key` | 仍归原项目，Host 以此选 CLI 进程并路由会话 RPC。 |
| `tasks.root_path` / CLI `session.directory` | 会话实际执行目录，可能是工作树里的子目录；用于文件、终端和 Git 操作。 |
| `tasks.worktree_root` | 工作树根，用于识别和管理工作树，不一定等于执行目录。 |

依据：[Host 预留任务并提交首条输入](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/managed-worktree-tasks/service.ts#L392-L437)、[存储契约](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/docs/git/worktree.md#L437-L475)。同仓库的附加目录映射进新工作树，其他仓库的附加目录仍是原路径；工作树隔离的是 Git 检出，不是文件权限沙箱。

## 修复前的业务断点

| 组件 | 结论与证据 |
| --- | --- |
| **app-mcp：历史与会话控制** | [`read_session`](../sessions.mjs#L260-L278) 把 CLI 执行目录与 Host 归属目录强制判等。两份临时数据库上，普通会话读取通过，工作树会话返回 `workspace_mismatch`。依赖历史推断路由的 [`targetOf`](../control.mjs#L54-L64) 也会被拦截。列表按归属目录读索引，而 [`get_current_session`](../sessions.mjs#L129-L154) 返回 CLI 执行目录；不能把两个返回值互换当 RPC 地址。工件 Hook 按会话/轮次 ID 工作，[不使用执行目录路由](../artifact-hook.mjs#L9-L21)。 |
| **title：自动命名** | [命名后端](../../suian-zcode-title/backend.mjs#L40-L81) 将 CLI 的 `session.directory` 同时用于历史读取和 Host 附着。注入连接的探针确认工作树会话传入的是工作树 cwd；[网关](../../suian-zcode-common/rpc-broker.mjs#L141-L170) 仍按 Host 元数据核对归属目录，两者冲突。Stop [输入兼容字段](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts#L14-L55) 仍在，风险点在 Hook 触发后的路由。 |
| **side-editor：文件与评论** | [文件范围](../../suian-side-editor/server.mjs#L15-L42) 经公共上下文读取任务 `root_path`，方向正确；仍需在桌面验证 stdio 绑定和实际读写。评论工具却把 [`sessionWorkspacePath`](../../suian-side-editor/server.mjs#L114-L120) 当 Host 地址。另一个独立问题是 V4 新增 [`worktreeCreated` 行](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/shared/src/zcode-protocol-v4/rows.ts#L392-L401)：同一夹具的普通行通过，现有固定 decoder 在快照和历史页中都拒绝该标记，评论状态会退回不可确认。 |
| **common：网关与 local-only** | 当前网关校验的是归属目录，这个校验应保留；应由调用方提供正确归属，不能对任意路径放宽。Windows `3.18.0.10300` 已有[随包档案](local-only/14-windows-3.18.0-candidate.md)及候选/副本验证；原生冷启动、原 Host 闭环与在线 relay 仍需分别验证。源码锚点不替换公共层固定的协议产物，也不是包兼容凭证。 |

**普通会话**：[`createTask`](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/session/zcodeTaskService.ts#L207-L235)、[`getTaskSnapshot`](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/session/zcodeTaskService.ts#L485-L496)、[V4 订阅](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/zcode-agent/zcodeAgent.ts#L1001-L1019)仍在，V4 [wire 版本仍为 3](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/shared/src/zcode-protocol-v4/core.ts#L7-L8)。另有两处行为变化，暂未定位到普通会话的确定断点：

- [`sendPrompt` 的文本路径](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L465-L504)开始返回 Host 接受回执，可区分 `duplicate`（不会开新一轮）；失败仍由 Host 抛错。我们的[直接发信路径](../control.mjs#L68-L72)每次用新 ID，仍忽略返回值，不应把 `accepted` 当成回复完成。
- [MCP App 待发送上下文](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/ui/src/plugin-ui/adapters/pluginUiModelContextEvents.ts#L5-L40)改为在窗口内按会话保存，卸载输入框不再等于清除。侧栏应实测切换会话、关闭重开、提交后的草稿与受理回执；单凭源码不能确认既有评论缺口已消失。

## 原生入口适合人工创建，目录自选则用 Git

**原生模式**：本地桌面的 Git 项目，新建聊天勾选工作树，首次发送才创建。默认从当前 HEAD，也可以选起点；以 detached HEAD 检出，不切换主目录。新聊天不复制未提交改动，「分叉到新工作树」才带入父任务的改动。仓库可用 `.worktreeinclude` 指定要拷贝的已忽略文件，但不会自动安装依赖或初始化子模块。项目菜单的 Worktrees 管理已有工作树；删除前检查改动和占用，删除后聊天保留为只读。见[上游功能说明](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/docs/git/worktree.md#L78-L148)、[Git 实现](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/git/managed-worktree/gitWorktreeRepo.ts)与[删除检查](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/managed-worktree-tasks/removal.ts)。

**插件边界**：桌面走内部 `managed-worktrees` 通道，现有网关连接的远控白名单不开放该服务。普通 `createTask` 无工作树参数；Host 也拒绝外部会话命令自行注入 `cwd`、`worktreeCreation` 或 `targetCwd`。插件可在用户创建后识别和接手会话，不应借私有通道、模拟点击或写宿主数据库实现自动创建。见[远控白名单](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts#L21-L86)、[Host 命令防护](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/zcode-agent/zcodeAgentService.ts#L1388-L1398)。

**开关默认关闭**：桌面把选择存在当前新建聊天草稿里，创建新草稿时重置为 `draftWorktree: null`，不会记住上一条聊天的选择。插件可以记录这个产品默认值，但当前 API 读不到某个桌面草稿的勾选状态，也没有可读取的全局默认偏好。若宿主将来开放原生创建能力，再给 `start_session` 加可选布尔参数；省略沿用普通创建，显式启用而能力不可用时应报错。见[草稿重置](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/ui/src/store/zcodeSessionStoreWorkspaceSlice.ts#L588-L604)和[首发分支](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/ui/src/v4/SessionPane.tsx#L4031-L4074)。

**位置设置**：3.18 [明确没有工作树专属设置](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/docs/git/worktree.md#L34-L42)。Windows 通常位于 `%USERPROFILE%\.zcode\worktrees\<四位十六进制目录>\<仓库名>`。应用配置的数据根优先，其次是 `ZCODE_DATA_BASE_DIR`，最后才是用户主目录。「设置 → 通用 → 数据存储路径」改变整个应用数据根，重启后影响新树；迁移仅复制 `.zcode/v2`，不会迁移旧树，旧聊天还可能因目录在新根之外而进入只读。见 [目录布局](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/docs/git/worktree.md#L399-L410)、[数据根优先级](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/paths.ts#L12-L47)、[设置说明](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/docs/desktop/configurable-data-directory.md)和[迁移实现](https://github.com/zai-org/ZCode/blob/b95ebaffeab641907b38652f45c1502bd762972d/packages/services/src/paths.ts#L257-L286)。

如果必须放到指定盘，用 `git worktree add` 自选绝对路径，再把它当普通本地项目在 ZCode 打开。这样可以沿用插件的已打开目录模式，但不会保留原生工作树在原项目下的归属和管理。不要移动既有受管树，或为了改新树位置而迁移整个日常数据目录。

## 桌面验收

在隔离的 Windows `3.18.0.10300` 运行四个插件的构建产物。宿主、网关、Git、会话库、Stop Hook 和侧栏均走实际链路；仅模型端点由本地固定响应代替，未验证在线中继。

- **会话与命名**：桌面创建普通会话和原生工作树会话，两者均能列出和读取历史、收到 `send_message` 的消息，并由 Stop Hook 自动改名。原生会话另验证 `rename_session` 写入并读回，以及 `compact_session` 受理后在桌面显示「上下文已压缩」。现有 `start_session` 仍能创建普通会话并提交首条消息。
- **侧栏保存和评论**：保存只修改工作树里的文件，原项目同名文件未变。重启宿主加载修复产物后，对工作树文件选区添加评论，主对话发送后历史能读到完整评论，侧栏待发送计数由 1 降到 0。
- **本轮发现并修复的旧 RPC 问题**：工作树会话的 `resumeTask` 和 `getTaskSnapshot` 会在刷新任务索引时按检出目录查运行时，实际返回 `ZCode Agent runtime is not running.`。发信与压缩交给 V4 按原项目恢复；侧栏按已校验的 V4 快照判断工作树对话状态。普通会话沿用原路径。
- **归档**：旧 `getTaskSnapshot` 曾在工作树会话上返回 `ZCode Agent runtime is not running.`。修复后，归档仍检查主代理、后台任务、子代理、计划、目标、队列和待处理交互；原生工作树在写入前向原项目 Host 取两份新的 V4 运行快照，普通会话保留旧路径。快照归属或运行态无法确认时不写入，`force` 不跳过取证。

归档在同一隔离宿主以构建后的 app-mcp 和真实 stdio 接口复验。模型流由本地测试端点显式保持与放行，索引状态按会话 ID 精确读回：

| 会话 | 模型仍在生成时 | 空闲时 |
| --- | --- | --- |
| 原生工作树 | `confirmation_required`，原因为 `main_agent_active`，索引仍未归档 | 冷启动后及生成结束后均可归档，索引确认，随后可复原 |
| 普通 | 同样拦截，索引仍未归档 | 生成结束后可归档，索引确认，随后可复原 |

[归档契约测试](../tests/control.test.mjs)另验证了二次检查从空闲转为运行时拦截，以及第二份快照归属不符时即使 `force` 也不写入。

## 3.18.1 增量核查

2026-11-12 对照 [`b95ebaf` → `c590468` 的公开源码差异](https://github.com/zai-org/ZCode/compare/b95ebaffeab641907b38652f45c1502bd762972d...c5904686ea8341826b3affe5d993d06a134fa779)。这是一个直接后继提交。现有插件所用的接口未发现需要跟改的变化：

| 组件 | 与插件有关的结论 |
| --- | --- |
| **app-mcp** | 项目与工作树归属、会话控制和运行态读取的服务实现未变；V4 gateway 的修改只增加诊断计数，消息、历史和快照的协议定义不变。保留原生工作树归档的两次运行态检查，`start_session` 仍创建普通会话。 |
| **title** | Stop Hook 事件、宿主的 `generateWorkspaceText` 路由和标题写回未变。宿主仍可能为同一工作区复用现有会话运行时，[#208 的隔离修复](../../suian-zcode-title/docs/notes/one-shot-generation-audit.md)仍有必要。 |
| **side-editor** | MCP App 桥、评论链路和工作树文件目录来源未变。可见变化是宿主允许把侧栏拖得更宽，以及浏览器设计面板不再自动请求全屏；编辑器不依赖被删除的设计面板事件。 |
| **common** | Desktop 远控管理器、Host 附着白名单和 V4 消息定义未变；手机远控的改动在浏览器前进、后退和刷新恢复。Windows 安装器变更涉及旧进程检查和升级备份，不改变 local-only 按安装包身份选补丁的契约。 |

以上是源码差异核对。已归档的 3.18.1 隔离宿主证据覆盖 [local-only 启动与 MCP 创建、发信、读回](local-only/15-windows-3.18.1-candidate.md)及 [#208 自动命名与超时回收](../../suian-zcode-title/docs/notes/one-shot-generation-audit.md#208隔离辅助生成的活动归属)；未用这些结果代替 3.18.1 的完整桌面回归。

## 3.18.2 增量核查

**本次增量未发现四个插件需要新增兼容修复。**

2026-11-16 以业务提交 `fe803161189a64d0465d7c3ee4786eaf12b613dc` 为基线，对照官方 [`c5904686` → `fec97590`](https://github.com/zai-org/ZCode/compare/c5904686ea8341826b3affe5d993d06a134fa779...fec975905a2abd4c07e35c40d51fa097a2258ec9) 的 46 个变更文件。

原生工作树兼容已在 [#204](https://github.com/ONEGAYI/ZCode-Plugins/pull/204) 修复并经 [#205](https://github.com/ONEGAYI/ZCode-Plugins/pull/205) 正式集成；命名辅助活动隔离和对应 Windows 发行包的 local-only 档案也已包含在业务基线中。

### 新增变化主要在官方凭据与模型账号

- **数据目录迁移补齐凭据密钥登记**。官方复制数据后，由 Host 请求 Main 将系统凭据密钥登记到目标数据根，再继续切换。我们的旧授权库使用独立的当前用户 DPAPI，默认网关不读取官方凭据文件，无需跟随复制密钥。见[迁移接线](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/services/src/setting/settingService.ts#L415-L428)、[密钥登记实现](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/shared/src/credential-security/systemCredentialCipher.ts#L334-L396)与[公共授权存储](../../suian-zcode-common/auth-store.mjs#L6-L29)。
- **Linux 增加凭据密钥后备路径**。这条分支不改变 Windows 插件与补丁的调用方式。见[平台条件](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/desktop/src/main/index.ts#L303-L314)。
- **Start Plan 修复国内未关联账号的模型目录与鉴权**。命名插件继续通过 Host 查询模型目录、发起辅助生成，不增加自己的账号判断。见[官方鉴权分支](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/services/src/model-provider/accountProviderRequestAuthService.ts#L83-L92)与[命名调用方](../../suian-zcode-title/backend.mjs#L103-L145)。

### 插件直接依赖的契约保持

在此次增量中，RPC、远控管理器、会话与项目存储、会话操作、V4 schema、CLI 生命周期 Hook、插件加载器以及 MCP App 桥的相关实现均无差异。会话读取、控制、工件、命名和侧栏继续使用已有接口；无需因研究快照更新而修改业务版本或重建 vendor。已修复的工作树路径契约见[公共上下文](../../suian-zcode-common/project-context.mjs#L30-L44)、[历史读取](../sessions.mjs#L277-L290)、[命名路由](../../suian-zcode-title/backend.mjs#L41-L87)和[编辑器上下文](../../suian-side-editor/server.mjs#L32-L43)。

local-only 复用[对应发行包的既有档案与隔离验证](local-only/16-windows-3.18.2-candidate.md)，包括无登录启动、真实 stdio 会话往返与网关重启恢复。本次只更新源码快照，不重新应用补丁或扩大该记录的验收范围。

### 既有归档说明有一处遗漏

**归档还会暂停绑定的活动定时任务，复原不会自动恢复这些任务。** 官方在首次“未归档 → 已归档”转换时，同事务暂停 `enabled=1` 且 `lifecycle_status=active` 的绑定任务；已认领的轮次不会被撤销，重复归档也不覆盖用户后来重新开启的选择。见[归档转换](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/services/src/session/taskIndexRepo.ts#L1157-L1159)和[自动任务更新](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/services/src/session/automationRepo.ts#L38-L51)。

这是本次增量之前已有的行为。我们的[工具说明](../server.mjs#L216)及[写工具契约](write-tools.md#L170)仍使用“归档只隐藏会话”，需要在后续归档说明修订中补齐此副作用；本轮仅记录影响，没有修改工具实现或发布内容。

### 定向验证结果

使用目标快照的两份原始 `schema.baseline.sql` 建立临时 SQLite，调用当前业务模块，7 项检查通过：普通会话读取、工作树双路径读取、执行目录筛选、隐式发信的 Host 目标、公共上下文双路径、编辑器双路径绑定、当前 V4 decoder 接受 `worktreeCreated` 行。网络连接以记录参数的桩替代，编辑器绑定检查执行现有 `boundContext` 函数体；结果为模块级验证，未启动实际 Desktop。

已有桌面证据继续按各自输入和范围复用；没有重跑全量回归。以下 AGENTS 检查使用同一目标源码，与业务基线独立。

## 多工作区不会自动汇总全部 AGENTS

**启动主对话时，默认只组合用户级 AGENTS 与一个项目级 AGENTS。**

1. 用户级文件是 `~/.zcode/AGENTS.md`。
2. 项目级文件从会话实际执行目录 `cwd` 向上寻找，找到首个 `AGENTS.md` 即停止；搜索边界为最近 Git 根或文件系统根。
3. 其余项目目录进入 `additionalDirectories`，但不参与指令文件发现。主目录 A、附加目录 B 各有规则时，默认注入“全局 + A”，不会自动加入 B。如果执行目录下有更近的 AGENTS，则不会再累加各级祖先的规则。

依据：[项目主目录与附加目录分解](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/services/src/project/index.ts#L317-L341)、[runtime 的独立配置字段](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts#L149-L157)、[规则解析入口](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/adapters/src/context/index.ts#L123-L158)及[首个命中即返回](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/adapters/src/context/index.ts#L236-L275)。

这些正文经上下文构建器组成 `meta_user` 指令公告，再在模型请求前进入消息列表，确实影响模型输入；附加目录的环境说明则是另一项内容。见[指令装配](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/context/sections/request-user-context.ts#L23-L61)与[模型请求前接线](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts#L182-L197)。

### 文件名与读取边界

- **默认只识别 AGENTS.md**。没有 `ZCODE.md`、`CLAUDE.md` 的自动回退，也不默认搜索项目内 `.agents/AGENTS.md` 或 `.zcode/AGENTS.md`；用户级 `~/.zcode/AGENTS.md` 是单独处理的特例。见[默认文件名](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/adapters/src/context/index.ts#L26-L27)。
- **裸 `@文件路径` 不会自动展开**。加载器读取正文并按字节上限截取，不解释引用。Hook 注入或 Agent 主动读取属于其它机制。见[正文读取](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/adapters/src/context/index.ts#L188-L205)。
- **压缩重读仍使用单个执行目录**。未发现普通 Read 工具在进入其它目录时调用这套规则解析器。见[初始化](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/context.ts#L48-L79)与[压缩重读](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/context.ts#L299-L336)。
- **子代理按 profile 继承父级快照**，不重新扫描所有目录。内置 general-purpose 开启 AGENTS 注入，Explore 关闭。见[继承接线](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts#L133-L139)与[内置 profile](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/subagent/profile.ts#L23-L86)。

**建议把跨目录必需的短规则放在主目录 AGENTS.md**，并明确要求 Agent 在处理附加目录前读取其规则文件。这依赖 Agent 执行读取，不依赖裸 `@路径`，也不把“能访问附加目录”当成“规则已自动注入”。

本轮使用目标提交的实际 resolver 函数、Node 内置 TypeScript 去类型及显式 `projectRoot` 做了 5 项断言：全局 + 主目录、最近祖先不累加、默认文件名、`@` 保持字面文本、无其它文件名或隐藏目录回退，全部通过。临时目录已清理；未安装上游依赖，未运行真实模型。此加载范围在本次快照更新前已存在。

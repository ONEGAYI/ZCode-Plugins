# suian-zcode-title — ZCode 会话自动命名插件

- 本插件依赖公共插件 `suian-zcode-common`：公共导入经 `common-access.mjs` 薄适配按安装记录定位 common 发布目录（PKG-01 客户端契约）加载，不依赖 Node 包链接；源码调试用 `--common-root` 指向 common 构建产物。命名规则留在本目录，协议、DPAPI 与通知实现不复制。原生配置留在 dataPath，状态使用缓存外的 dataDir，默认 dataPath/state，不随缓存版本变化；结论沉淀在 docs/（脱敏证据）。
- 用户已授权自动命名的搭建、验证与 Stop Hook 自动配置；真实改名操作限定明确指定的测试会话或用户会话的自动触发。
- 不修改 ZCode 官方源码，不直接写 ZCode 会话数据库；改名仅走官方远控 RPC。
- 旧远控授权链接仅以当前用户 DPAPI 密文（`.local/remote.blob`）保存；默认网关调用不读取它。配置、日志、Toast、提示词均不携带链接明文、sid/hash/mid 片段或网关 control_token。
- Toast 按钮的打开动作固定指向用户自带默认工作区 `%USERPROFILE%\.zcode\workspace\default`，不随插件位置变化。
- 自动化测试与脚本严禁触发 `suian-zcode-title://` 协议激活链路（会弹 ZCode 官方确认模态框，无人值守时无限阻塞）。
- 公共 vendor 是固定来源的协议与投影库；版本信息见 ../suian-zcode-common/vendor/NOTICE.md，不自动更新。
- 新行为先写契约测试，记录红绿验证日志（docs/ 下按功能分卷，现有 round2-evidence.json 与 title-lock-evidence.json）；不添加无关功能。
- 会话 ID 同时接受旧版 `sess_` 与 3.16 的 `session_` 前缀；其余字符仍限制为字母、数字、下划线与连字符。前缀兼容测试不代表真实 3.16 Stop Hook 与自动命名已验收。
- MCP 创建会话的公共命名策略优先：locked:true 不生成；false 不推断手动保护、要求格式合规。不合规 keep 最多纠正一次并记录理由。既有无策略会话保留原规则。

## 技术参考（面向维护者）

### 环境要求

Node.js 24+、sqlite3（配置项 `sqliteBin` → `SQLITE_BIN` 环境变量 → PATH）、已打开目标工作区的 ZCode。插件自身无需 npm install；公共层按其 skill 安装锁定 npm 依赖（esbuild 亦取自公共层锁文件，title 的发布构建 `npm run build:release` 不引入本地 node_modules）。命名安装入口先检查 Node、公共依赖与 sqlite3 只读 JSON 能力，检查失败不安装 Hook 或通知。

### CLI

stdin 传入 JSON 事件（`cwd` 可代替 `workspace_path`；`user_message_id` 可选，触发事件的真实用户消息标识，不要把 `turn_id` 当作用户消息 ID）：

```json
{
  "session_id": "sess_目标会话标识",
  "workspace_path": "D:\\CODE\\Project\\目标项目"
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
node .\cli.mjs lock   --config .\config.local.json      # 固定目标会话标题（命名插件不再自动改名）
node .\cli.mjs unlock --config .\config.local.json      # 解除固定，恢复滚动命名
node .\cli.mjs policy --config .\config.local.json      # 只读查询目标会话标题策略
# auth / unauth：stdin 带 authorization_url 加密保存 / 清除授权
```

默认调用通过公共网关 connectHost，无需远控链接；gatewayConfigPath 可指定公共配置文件。auth/unauth 只保留旧凭据管理，不能据其状态判断网关是否就绪。lock/unlock/policy 不连网关：先做存在性校验（CLI 会话库与任务索引任一命中，查询异常上抛不吞），不存在报错退出码 1；输出 `previous`/`policy` 透传公共策略对象，重复执行幂等。config 的 `titlePolicyDirectory` 可覆盖策略目录（默认公共目录，供测试隔离；误留在日常配置会使 CLI 与命名进程读写不同目录，固定不生效且无告警）。公共能力定位：宿主注入（Hook/MCP）自动推导；独立 CLI 无注入时 `--installed-plugins {{json路径}}`，源码调试 `--common-root {{common构建产物目录}}`（详见 skills/paths.md）。安装：`node .\install.mjs .\.local`；仅检查加 `--check-only`，自定义配置加 `--config {{path}}`。卸载加 `--remove`，不能与仅检查同时使用。

### 链路概要

1. Stop Hook（hook.mjs）收到事件：stop_hook_active:true 跳过；延迟 8 秒等持久化收尾后派发 cli.mjs run --apply，只传会话元数据，不解密或注入链接。worker.lock 串行，busy 让位下一轮。宿主在创建会话时快照 hooks，新条目只对新会话生效。
2. 只读查询任务索引与 CLI SQLite 双库，校验工作区与标题一致。
3. 按持久化 `session.revert` 裁剪回退分支：优先使用 `branchCutAfterMessageID` 拼接保留前缀与切点之后的新消息，兼容旧 `createdMessageID`；切点不存在时只保留已登记前缀，不重新纳入废弃分支。复用官方可见消息规则；用户文本每轮上限 1,200 字符、助手 1,500、最初目标 800，取最近三轮。
4. 经公共网关附着原 Host（握手短超时 8s，失败按 stage/reasonCode 分类），model-selection.getView 校验模型档位后调 zcode-agent.generateWorkspaceText；不创建普通 Agent 任务，不切换主会话模型。旧网关明确要求重载，不回退官方 terminal。
5. 校验严格 JSON、类别 emoji、「对象｜目标」结构与 48 字符上限；写前复读，仅宿主 `generated` 标题变化且候选为 `rename` 时允许继续，是否写入以最新标题比较；`keep`、非 generated 标题变化、运行或内容变化仍返回 `stale_result`（附 `staleReason`：running/fingerprint/title）。
6. `zcode-task.renameTask` 写回后三处核验（原 Host 与双库），保存指纹与用量。
7. 远控类失败或所选命名模型／思考档位不在原 Host 可用目录时不改标题，按 7200 秒跨进程冷却弹原生 Toast；按钮可复制排障提示词或对命名插件免打扰 24 小时，协议激活由独立进程处理。`OIL_ZCODE_TITLE_DISABLE_TOAST=1` 静音。

### run 返回状态

| 状态 | 意义 |
|---|---|
| preview / renamed / kept | 候选、已写入并核验、模型决定保留 |
| unchanged | 同一内容已处理，跳过模型 |
| manual_title / locked | 无公共策略时，成功命名后非 generated 标题变化则保护；宿主 CronCreate 冻结的标题除外（命中会话内成功 CronCreate 的 input.title 时接管重命名，不锁，见 docs/freeze-takeover-evidence.json）；MCP 的公共 locked:true 优先阻止生成，false 明确不锁。公共锁经 cli.mjs lock/unlock 修改，删除旧状态仅解除旧锁 |
| stale_result / outdated_event | 内容已更新或事件过期，丢弃结果 |
| archived / running / empty / disabled / busy | 不适合命名或已暂停，不调用模型 |
| failed | 连接、模型或核验失败，退出码 1（附 `stage/reasonCode/toast`）。本地双库标题不一致为 `index_title_mismatch`、原 Host 与持久化不一致为 `host_title_mismatch`：均不弹 Toast、不改标题，需经官方改名链路对齐两库后自愈；冻结证据（会话内成功 CronCreate 的 input.title）命中时放行并由命名层接管 rename 同步两库 |

### 文件职责

| 文件 | 职责 |
| --- | --- |
| cli.mjs | 命令入口：stdin 事件、配置、共享锁、结果与日志；status/enable/disable/auth/unauth/lock/unlock/policy |
| hook.mjs | Stop Hook 派发器：续跑保护、会话元数据、8 秒延迟、后台 worker（worker 为同目录 cli 入口，源码与发布形态同构） |
| naming.mjs | 命名决策、去重、手动锁定保护、写前写后复核 |
| backend.mjs | 只读双库与原 Host 服务适配 |
| history.mjs | 历史重建、回退分支、最近三轮整理与指纹；投影策略经公共客户端契约加载 |
| common-access.mjs / release-layout.mjs | 公共客户端契约薄适配（定位、兼容声明、锚点优先级）与源码/发布双模式布局解析（发布根由上级 release.json 判定） |
| ../suian-zcode-common/locate.mjs | 薄定位器单一源码；构建时作为业务包唯一允许的 common 输入分发进产物 |
| toast.mjs / toast-action.mjs | 命名失败文案、排障提示词模板（部署时外置到数据目录）与自有协议调试入口；部署链走公共缓存外执行器，系统通知、冷却和剪贴板交给公共层 |
| install.mjs | 安装命令入口（薄）：参数解析与退出码；复用逻辑在 installer.mjs |
| installer.mjs | 安装与通知身份共享实现：sqlite3 检查、共享 Toast 稳定运行时与外置身份登记、提示词模板部署、Hook 与技能副本（命令入口间禁止互相导入，避免 bundle 内联复制主模块判定） |
| build-release.mjs | 发布目录构建：esbuild 四入口进 dist/、资源组装、release.json 与构建输入记录；构建期断言仅薄定位器来自 common |
| .zcode-plugin/plugin.json / hooks/hooks.json | 原生元信息与异步 Stop；发布构建把 Stop 命令改指 dist/hook.mjs，native 初始化不重复全局注册 |
| skills/ | setup / configuration / control / debug，paths.md 统一路径与数据说明 |
| doctor.mjs | 只读双库/模型与实际用户级 Stop Hook 配置检查；明确区分配置就绪和执行待验证 |
| prompt.md | 命名规则（沿用自 oil-codex-title 的 prompts/naming.md，只调整编辑器名称）；发布时从发布根定位 |
| SKILL.md | 源码兼容路由，按请求读取拆分技能；公共配置委托 common 技能 |
| ../suian-zcode-common/vendor/ | 两个插件共用的固定投影库与远控协议库，见公共 NOTICE.md |
| tests/ | 命名、Hook、授权与通知契约、CLI 集成与发布目录契约；`npm test` 经 tests/common-fixture.mjs 预载合成宿主存储根 |

### 已验证与边界

历史实测：54 项契约测试；两会话真实 Stop → 后台命名端到端（renamed）；probe 分层分类；Toast 横幅与按钮渲染、协议激活复制提示词；7200 秒冷却边界与并发单显；DPAPI 授权往返；旧独立 terminal 的并发席位实验（同授权码后连者被 KICKED，不损授权）。证据见 docs/ 两份脱敏 JSON。新版网关 RPC 的隔离验证与真实手机验收分别记录于 MCP 的共存报告。

边界：本机本地工作区（`readSessionMessages` 字段校验不一致，正文走 SQLite 只读适配，非实时 V4 快照）；`transcript_path` 是宿主合成的临时文件，不作为历史来源；连接关闭不代表原 Host 的辅助模型请求已取消，ZCode 自身可能记录辅助生成的模型 I/O 与用量；`zcode://workspace/open` 对任意路径弹官方确认框，自动化测试严禁触发协议激活链路（模态框阻塞无人值守流程）。

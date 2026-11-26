# 工件 demo 开发验证

2026-10-12，在独立工作树完成本地实施与验证。本记录保存实施阶段的测试和隔离验收证据；后续交付状态以 Git 历史及关联 PR 为准。规格见 [artifact-zone-spec.md](artifact-zone-spec.md)。

## 已实施的行为

- 十二个 MCP 工具中，新增当前会话 get_artifacts / set_artifacts。真实 SQLite 保存状态；get 每次重新读取，set 在同一事务内检查 revision、应用增量和校验容量。
- 原生 SessionStart 幂等初始化，UserPromptSubmit 输出一句登记入口与分类统计，Stop 同步提交消息断点快照。详细管理规则放在 get/set 工具描述，普通空 get 不创建工件库。
- 原生分叉按隐藏 forkOrigin 的原始父消息 ID 继承；子版本从 0 独立计数。snapshot_missing 是保留的继承诊断，后续读写仍正常。
- 原生只读页共用 get，显示 revision、统计、条目与诊断，条目使用 textContent。页面只提供刷新和 HTTP(S) 引用，不编辑状态、不启动模型。

统计形状为 `stats: { total, by_kind: { pr, session, file, link } }`。set 的 upserted/removed 是实际变化条数，无变化时为 0；成功不回传 items。业务拒绝使用 revision_conflict、invalid_input、capacity_exceeded；参数形状由 MCP SDK 校验，底层存储错误保留错误信息，不假装空集合。

## 自动化契约

Node.js 24.15.0、MCP SDK 1.32.1，使用独立 SQLite 和公开 MCP/stdio 入口。测试命令是 `npm test`，日志在运行首次落盘并记录退出码。

覆盖空读不建库、四类条目与统计、精确 ref、顺序、无变化、冲突与批次原子性、20/21 条、12000/12001 Unicode 码点（含中文和 emoji）、未知/歧义调用者、损坏和不兼容存储、独立进程并发 CAS、全部进程退出后的恢复，以及宿主双库字节不变。

独立规格审查发现首次拒绝写入会回滚新库结构的问题。已补充首次版本冲突和首次容量超限后仍能读取空状态、合法重试的公开 MCP 测试；两项先失败，再修复为独立提交库结构，业务事务仍原子处理 revision 和增量。该次完整回归 101 项通过、0 失败、退出码 0。

首次实施的规范轴与规格轴独立复核均通过，原 P1 已解决；固定实现提交记录在脱敏证据中。审查通过和代理自检不代替用户验收，也不补作未执行的真实模型评估。

随后按用户要求将自动管理说明缩为一句入口，详细规则移到工具描述。正式 UserPromptSubmit 输出与公开 tools/list 描述的两项契约先失败，修改后聚焦 14 项通过、完整回归 102 项通过、退出码 0。容量仍沿用原固定表示；统计、缺快照诊断和 12000/12001 码点边界均继续通过。此次文案修改未重跑 Desktop，原生接线证据仍归属于首次实施。

Hook 从正式 hooks.json 的同步 command 启动。覆盖 A/B 历史继承、同轮多 Stop、相同内容不同消息映射、旧 Stop 重放不改映射、缺快照后继续写入、迟到快照不覆盖子状态、首次 set 初始化，以及提交摘要不含 ref/label/purpose/items。

UI 契约覆盖版本、客户端身份和 MCP Apps MIME 的组合，包括应用 3.15.1 与握手 CLI 0.16.9 的实测组合。旧版、未知版本或能力不足时，两个工具仍保留，UI 元数据和资源不提供。

最终回归数量和独立审查结果见 [脱敏证据](artifact-demo-evidence.json)。

## 真实 Desktop 接线

宿主为 ZCode 3.15.1.8093，构建标识 f18d6db7，随包 CLI 0.16.9。使用全新 profile、用户配置、插件数据、工作区及 Electron 存储；保留原安装文件，不复制用户账号或会话。模型接口是本地合成 OpenAI SSE，只验证工具、Hook 和页面链路。

| 轨迹 | 观察结果 |
| --- | --- |
| 原生生成 A，再生成 B | 正式 MCP 工具保存四类工件，正式同步 Stop 保存原始完成消息映射 |
| 父最新 B，再从旧 A 的“分叉”按钮创建子会话 | 子 SessionStart 保存 A；首次 get 与侧栏显示 A、revision 0，父仍为 B |
| 后台独立 MCP 增量写入，再点页面刷新 | 页面取得新 revision 和条目，合成模型请求数不增加 |
| 删除插件自有的 B 映射，模拟缺快照，再从 B 原生分叉 | 分支创建成功，子记录 snapshot_missing、空集合和 revision 0 |
| 缺快照子会话继续生成 C | 正式 get/set 成功，子完成正常聊天；侧栏显示 C 和保留的缺失诊断 |
| 清空子引用，刷新 | 零统计和空状态，仍明确未继承 |
| 临时损坏隔离工件库，刷新后恢复原字节 | 页面显示读取失败，清除旧列表，不呈现“空工件成功” |

直接采集原生沙箱截图并核对 DOM；还用有 DPI 感知的窗口截图确认实际侧栏布局。主窗口 CDP 组合截图曾显示陈旧、裁切的 guest 图像，不据此修改正常页面 CSS。四类显示、长引用换行、`<tag>` 按文本显示、emoji、空状态与错误均完成代理视觉自检；用户验收仍待进行。

![原生侧栏读取最新状态](images/artifact-demo/latest.png)

![缺快照后仍可继续管理工件](images/artifact-demo/snapshot-missing.png)

## 宿主限制与版本修正

公开 aac4755 快照把 MCP clientVersion 接到 appVersion；本机 f18d6db7 构建的线协议仍返回 `clientInfo: { name: "zcode", version: "0.16.9" }`。同一 MCP 进程实测收到 `ZCODE_APP_VERSION=3.15.1`，因此门控优先使用 Desktop 的该环境变量，缺失时才读取 ZCode 客户端版本；并要求 `extensions["io.modelcontextprotocol/ui"].mimeTypes` 含所需 MIME。页面桥接版本 `1` 不参与判断。

**首开连接仍有宿主限制**。尚未为目标会话建立 MCP lease 时，宿主在装载页面前返回 `MCP App connection is unavailable`。本轮在旧会话恢复和新分叉中观察到；目标连接就绪后重新加载成功。插件页面自身不发起模型请求，也无法在装载前替宿主签发连接凭证。完整的“任何冷会话首开即用”不在本次已通过的验收范围，不把版本与 MIME 满足说成连接一定就绪。

依据：[UI_PLUGIN.md](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/UI_PLUGIN.md)、[UI 连接凭证入口](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/protocol.ts#L222)、[共享连接池](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/mcp/pool.ts)。

## 开发分支的列表与详情改版

2026-10-12，按用户的新交互要求取消原 20 条和 12000 字符限制，补充分组折叠、方向图标、统一详情与服务记录时间。get_artifacts 省略 ref 返回列表，指定精确 ref 返回详情；页面使用同一接口，会话详情每次查询原 Host。

独立工作树的基线 102 项通过；改版回归 109 项通过、0 失败，退出码 0。容量、时间详情、实时查询、首发前关系和分页各自先观察契约失败，再实施；会话图标的 CSS 名称冲突也通过浏览器可绘制视口检查复现并修正。另覆盖旧时间未知、双向关系写入原子性和分叉不冒充原创建方向。

Chromium 加载 MCP 正式注册返回的 HTML，通过真实 SDK/InMemoryTransport 调用正式 get/set，与真实隔离 SQLite 连接。原 Host RPC 在此检查中使用模拟边界，不读取用户凭据、不创建实际用户会话。浏览器覆盖折叠后数量、刷新保留折叠、图标可见、详情往返、HTTP(S) 打开、时间、每次会话点击重新查询、查询错误、迟到响应、文字安全、320px 深色窄栏、205 条分页和空状态。

![分组工件列表](images/artifact-panel/list.png)

![统一工件详情](images/artifact-panel/detail.png)

日志首次执行时落盘并记录退出码；脱敏结果与日志 SHA256 见 [改版证据](artifact-panel-evidence.json)。规范轴和需求轴的独立复核均通过，固定实现提交为 a6f5745；审查不代替用户验收。旧版 Desktop 的原生接线证据仍归属于上文；新版未安装到实际用户缓存，尚未进行新版 Desktop 与用户验收。

## UserPromptSubmit 受限工件简表

2026-10-12，按用户追加要求，在登记入口、统计和继承诊断后注入工件简表。按更新时间选取最多 20 条，整个 additionalContext 最多 9000 个 Unicode 码点；非空类别最多预留最新 3 条，字符不足时保住各类最新 1 条。裁剪只影响注入，完整存储与 GUI 不减少条目。

基线 109 项通过。正式 UserPromptSubmit 的简表接线、时间/类别选择和字符预算分别先观察测试失败再实施；最终完整回归 118 项通过、0 失败、退出码 0，语法与 diff 空白检查通过。公共 formatter 覆盖 9000/9001 边界、转义展开、Unicode 码点不拆开（含单码点 emoji）、未知时间、时间并列、空集合和输入不变；正式 Hook 通过真实 MCP 与 SQLite 验证 45 条存储只注入 20 条（11 条 PR，另三类各 3 条），下一次提交重新读取且存储不变。

字段使用 JSON 字符串，换行不会伪造表行，管道和反引号转义后仍能还原。必须截短字段时添加 … 并提示先 get 完整列表，不能把截短 ref 当作精确引用。省略数量按真实存储总数报告；同轮旧摘要仍可能保留，不宣称每请求唯一最新投影。

脱敏日志哈希与结果见 [简表验证证据](artifact-summary-evidence.json)。规范轴和规格轴独立复核通过，固定实现提交为 0e9cddae；唯一 P3 文档问题已关闭。复核后仅收窄多码点 emoji 的文字保证，运行时代码与测试断言未变。本轮使用隔离存储和正式 Hook 命令，没有修改用户缓存、读取真实用户工件或启动实际 Desktop；真实模型行为与用户验收仍独立待执行。

## 真实 Agent 主动维护评估

本轮没有可用于隔离测试的真实模型账号，未复制用户凭据。合成 SSE 按固定脚本发起 get/set，不能证明真实 Agent 会主动登记、维护或清理。该评估保持未执行状态。

后续用已确认的测试模型，在独立项目与会话中运行以下任务，不在任务文本里额外要求“登记工件”：

1. 提供现有 PR、关联会话和规格文件，让 Agent 接手续写验收说明。检查是否只登记有后续用途的引用。
2. 让 Agent 用新规格替换旧规格。检查是否增量 upsert/remove，且保留仍需交付的 PR，不删除资源。
3. 用独立 MCP 连接在 Agent 的 get 后修改状态，制造冲突。检查是否重新 get 和判断增量，避免以旧列表覆盖。
4. 完成任务后再提出接续评审。检查完成但仍有用途的工件是否保留、purpose 是否更新。

每次记录模型与思考档位、任务文本、工具轨迹、最终 SQLite 状态、失败原因、请求数与可取得的 token 成本。不得用已执行的技术夹具替代该结果。

## 发布边界

完整版每请求唯一最新投影仍是 [#36](https://github.com/ONEGAYI/ZCode-Plugins/issues/36) 的等待上游事项。实施验证阶段没有修改 ZCode、公共网关实现或实际用户 MCP 设置，也未推送、建 PR 或合并；用户随后授权推送、合并和清理。隔离进程已退出，临时 profile、数据库和采集原始物料已清理；测试首次日志在首次执行时落盘，脱敏证据记录其结果与 SHA256，开发工作树清理后不保留原日志。入库截图仅含合成引用，证据不包含用户目录、账号、会话 ID 或凭据。

## 2026-10-16 工具结果简报与单份完整数据

按当前 ZCode 使用范围调整工具回执：`structuredContent` 保留完整数据，`content` 仅报告关键数量、操作状态或错误原因，最多 160 个 Unicode 码点。业务错误继续返回 `isError:true`；参数校验仍由 SDK 负责。已提交、结果未知、归档待确认及重置取消等状态不表述为操作已完成。工件 Hook 和页面实现均未修改。

先通过公开 MCP/stdio 契约观察简报和结构化错误缺失的失败，再修改返回封装。最终完整回归 190 项通过、0 失败。工具名、输入 schema、注解与 UI 可见性保持原约定。

从本机实际安装的 ZCode 3.15.3.8237 产物提取工具结果格式化函数，在独立 VM 中重放正式 MCP＋隔离 SQLite 返回的长聊天结果：完整正文标记从原封装的两次降为一次；追加的结构化 JSON 与原回执深相等。错误回执仍保留 `isError` 和完整错误数据。

Chromium 加载正式 MCP resource 返回的页面，通过 `window.zcode` 服务桥调用真实 SDK 和隔离 SQLite。复用现有浏览器验收函数，覆盖分组、折叠、详情、链接、会话状态、文件存在/缺失标记与文字安全；另验证 PR 状态回执、文件定位回执、结构化错误展示与恢复，页面错误为零。

上述检查没有替换用户安装缓存，没有启动新的真实 ZCode 会话或发送模型请求；Host 状态、gh 和文件定位使用服务桩。当前产物的离线重放与浏览器桥接验证，不代替实际 Desktop 更新后的端到端验收。日志首次执行即落盘并记录退出码，最终保留脱敏汇总。

## 2026-11-26 ZCode 4.0 的工具结果完整数据写入文本

ZCode 3.19 及以上，模型只能读到工具结果的一行简报。本次把“完整数据是否写入 `content`”改为按宿主应用版本决定：3.19 及以上写入，3.18 及以下保持纯摘要，面板专用的两个工具始终纯摘要。

**静态核查**：宿主把工具结果交给模型的函数，是上游 zai-org/ZCode 仓库 `apps/zcode-cli/packages/core/src/mcp/index.ts` 的 `formatMcpToolResult`。

- v4.0.0 源码同步 [`a4b44451`](https://github.com/zai-org/ZCode/commit/a4b4445141eb7d3b3e99eada9292775383bfc44e)（2026-11-23）：第 558 行的条件是 `blocks.length === 0 && output.structuredContent !== undefined`。源码注释为“content 是服务端给模型的表示；仅在没有可见块时回退结构化结果，避免兼容双写。”
- v4.0.0 之前含该函数的全部 10 个提交，从首次开源提交 [`872ad960`](https://github.com/zai-org/ZCode/commit/872ad960de7ec172591f7e1952f7849229f94521) 到 v3.18.2 源码同步 [`fec97590`](https://github.com/zai-org/ZCode/commit/fec975905a2abd4c07e35c40d51fa097a2258ec9)（2026-11-13）：条件都是 `hasInformativeStructuredContent(output.structuredContent)`，结构化结果有内容就追加。提交标题带版本号的有 v3.14.3、v3.15.1、v3.17.2、v3.18.0、v3.18.1、v3.18.2。

0.7.2 把完整数据只放在 `structuredContent`、`content` 只留简报，依据的是后一种行为。所有工具经同一个出口返回，所以 3.19 及以上模型拿不到任何工具的完整数据；`read_session` 读不到聊天正文属于这一推断，未在真实会话里单独调用。

**3.19.x 产物核对**：3.19.x 没有上游源码同步，改用官方安装包中的产物。从官方分发地址下载 Windows x64 的 [3.19.0](https://cdn-zcode.z.ai/zcode/electron/releases/3.19.0/windows-x64/ZCode-3.19.0-win-x64.exe) 与 [3.19.1](https://cdn-zcode.z.ai/zcode/electron/releases/3.19.1/windows-x64/ZCode-3.19.1-win-x64.exe) 安装包，提取的 `app.asar` 与 [3.19.0 适配记录](local-only/17-windows-3.19.0-candidate.md)、[3.19.1 适配记录](local-only/18-windows-3.19.1-candidate.md) 所记的原包摘要一致；两份 `resources/glm/zcode.cjs` 的 SHA-256 分别为 `6b84e928d9258fe020c6ab8c75fa2c123b0cd658fe43c0ce141a13df677fb0ea`、`4b90ae046753be9f5ba63dee14b8fd2cdb07b5540e9bfe348ba127504b8cf8da`。同一函数在两版中的条件都是 `t.length===0&&e.structuredContent!==void 0&&t.push(...)`（标识符是压缩后的名字），与本机 4.0.0.10870 的产物同构。所以宿主行为的变更发生在 3.19.0。这是对产物的静态比对，没有在 3.19 的 Desktop 会话里实际调用。

**运行时验证**：本机 ZCode 4.0.0.10870 安装目录内的 CLI 产物中，同一函数的条件与 v4.0.0 源码一致。在真实 4.0 会话里调用 `get_current_session` 与 `list_sessions`，模型收到的内容分别只有一行“当前会话：<会话 ID>。”和一行数量简报。该版本下宿主启动的子进程环境里，`ZCODE_APP_VERSION` 实测为 `4.0.0`。

契约测试先红后绿：新增的集成用例在修改前因 `content` 没有完整数据而失败，单元测试文件因新导出尚不存在而无法加载；修改后相关 5 个测试文件 96 项通过。阈值前移到 3.19 同样先红后绿：矩阵用例与集成用例在修改前因 3.19 仍按旧版处理而失败，修改后通过。另补 3.19 两个实际 build 号的样本与“正文恰好出现一次”的断言；把阈值次版本临时改为 20 时，矩阵、集成与恰好一次三个用例失败，恢复后通过。最终内容上子项目全量 246 项全部通过、退出码 0。此前失败的 `tests/plugin-cache.test.mjs` 已删除：它验证的是 title 经 node_modules 包链接启动的场景，title 迁移到客户端契约后该前提失效；同一“分别缓存”场景由 title 的 `tests/release.test.mjs` 按当前契约覆盖。

**待验证**：以上检查没有替换用户安装缓存；真实 Desktop 的端到端验收待执行。

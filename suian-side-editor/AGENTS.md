# suian-side-editor — 独立侧栏文本编辑器

当前版本 0.4.1 支持本机 UTF-8 文本编辑、保存、恢复、会话多目录切换与选区评论；ZCode 3.18 原生工作树的保存和评论已在隔离宿主验证。市场 Release ZIP 自带 MCP SDK、zod 和构建页面，安装核对见 `skills/setup/SKILL.md`，无需 npm、链接或 UI 构建。公共实现经 `common-client.mjs`／`locate.mjs` 定位；原生工作树评论需要 common 0.10.3。原 #47 缺口、#57 完整并发及用户验收仍独立跟踪；发送边界的尽力保护见 `docs/adr/0005-temporary-comment-send-guard.md`。

2026-10-14 最终评论代码源`e77520d`／统一`f6b4257`复用SDK55、实际构建浏览器65及common98限定证据，两项可修P2（已观测证明保留、真实ChannelClient订阅释放）闭合。旧严格schema的Native失败保留，公开V4 A普通/B排队全文JSON与API审批通过仅属接口probe；最终f6新缓存／可见guest尚未执行。当前边界见[评论验证](docs/comment-guard-verification.md)顶部新记录；旧正文、JSON与首次失败不回写。

SE-04 的代码、统一执行等同性、分层 Native 证据与文档两轴复核已完成，本地限定条件通过；浏览器42项／组通过，未改SDK复用33/33。旧Native重复读审批失败保留，见`docs/se04-watch-native-verification.md`；不与评论接口probe或最终guest验收混称。评论原H3完整保证未满足；模式数据库写回与源文件写回仍是两个独立回执。

SE-05 已实现 schema 2 的会话恢复副本与独立回执；最终固定源 `20526764` 和统一 `77caa2a` 的代码两轴、统一完整 SDK 37/37、实际构建浏览器 55 项／组及构建／语法检查已通过。页签、阅读位置与脏正文在使用过程中持久化，重建重新通过受审工具取得文件和资源关联。正常关闭重开、自然回收新 guest、应用正常退出重启均有实际恢复证据，见 `docs/se05-native-verification.md`。本轮 Native 文档最终统一整合及 #45 本地条件见 `docs/development-verification.md`。

初版及三轮代码红绿记录保持原提交时点，分别见 `docs/se05-verification.md`、`docs/se05-review-fix-verification.md`、`docs/se05-round2-verification.md`、`docs/se05-round3-verification.md`。其中历史“待复核／H4 未验”不代表当前实测状态；不改写旧失败与冻结证据。评论 #42／46／47 与安装验收 #48 可按用户接受残余风险的尽力禁用范围继续，完整同步／批次及在途追加由 SE-11 独立验收，尚未完成。

LO-07 已在 local-only 隔离环境以真实原生侧栏面板（实际构建页面与真实 CodeMirror）验收评论链路：真实选区快照、经 composer 入主对话、受理反馈、busy/断连阻止与重连恢复、A/B 会话隔离、原文件与恢复副本独立回执均有实际证据；模型 running 与受理证据分离，模型调用来自受控本机 mock。原 #47 缺口、完整并发 #57 与用户验收仍未完成，旧结论不改写，当前尽力禁用边界不变。见 [LO-07 证据](../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md)。

## 范围与约定

- 编辑当前会话允许的本机目录内已有的 UTF-8 文本；3.16 可在文件树上方切换执行／附加目录，冻结会话范围优先于项目 roots，各目录的页签与恢复副本隔离。远程工作区和新建、重命名、删除文件另列后续特性；首版不包含 PPT 编辑。
- 编辑器使用插件内部界面和文件页签；选区评论进入当前主对话，模型回复留在主对话。不得扩展辅助问答或插件内聊天。
- 当前评论采用已核公开会话状态尽力禁用全部提交入口、tooltip 与草稿保留；状态可能迟到、恢复可能早于 Renderer 清理的过渡风险已获用户接受。若用模型 running 保守代理，明确可能整个回复期间锁定，不能称为 admission pending；未知／断连不当空闲。完整原生并发完成后移除临时禁用。
- 沿用根 AGENTS.md 和 CONTEXT.md。真实可复用的实现归 `../suian-zcode-common/`，本插件保留编辑、页签与评论业务；具体抽取边界在规格中明确，不因可能复用而提前创建通用框架。
- `../sources/` 只读，不修改宿主源码或安装研究快照依赖。公开接口事实、集成验证和用户验收分别记录。
- 状态持久化与原文件保存分开；运行数据归本插件，用户文件正文、会话标识和个人路径不写入入库证据。
- 澄清阶段只记录已确定决定；待决问题明确标记，不将推荐方案记为已接受。
- 实施可执行行为时遵循契约测试先行，测试首次运行保存日志和退出码。纯文档采用内容与格式检查，版本元信息采用已有一致性／自报契约，不创建镜像测试。
- 用户已要求使用规格工作树实施。该工作树作为统一集成分支，各实现者在自己的独立工作树完成单票并提交，由专门合并者集成；不切换用户主工作树。开发基线为 dev，正式分支为 master；本轮不自动授权推送、PR 或正式集成。

## 文档入口

- 领域术语：根 `../CONTEXT.md`。
- 设计澄清：`docs/design-discussion.md`。
- 首版规格与票草稿：`docs/text-editor-spec.md`、`docs/text-editor-tickets.md`。
- 实施证据与宿主预读：`docs/development-verification.md`、`docs/native-ui-binding-research.md`。
- 多目录交互与隔离回归：[验证记录](../suian-zcode-app-mcp/docs/multi-directory-validation.md)；原生多目录组合待验。
- 评论代码／夹具通过及 Native 待验的当前边界：[评论验证](docs/comment-guard-verification.md)。
- local-only 隔离环境的真实面板评论与连接恢复验收：[LO-07 证据](../suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md)。
- 主对话上下文接口与安装包核对：`docs/main-composer-context-research.md`。
- 已接受的架构决定：`docs/adr/`。
- 文档组织与开票：`docs/agents/domain.md`、`docs/agents/issue-tracker.md`。

## 文件职责

| 路径 | 职责 |
| --- | --- |
| AGENTS.md / CLAUDE.md | 本插件规则与 Claude 导入入口 |
| .zcode-plugin/plugin.json / .mcp.json | session 侧栏声明、stdio 注册及宿主工作区的显式环境绑定 |
| skills/setup/SKILL.md | 原生实际 rootPath／dataPath 与公共客户端定位核对；正式安装即用，不 npm、不链接、不启动公共远控网关 |
| package.json / package-lock.json | 独立插件的精确运行依赖、测试和语法检查入口 |
| cli.mjs / server.mjs | stdio 服务、app-only 工具与本地 UI 资源；入口先按定位契约加载公共客户端（`common-client.mjs`）再创建服务，宿主 session meta 与每次目录选择验证，只读公共 project-context，评论仍绑定会话执行目录 |
| common-client.mjs / locate.mjs | 业务薄适配与 PKG-01 薄定位器副本（构建时逐字节校验单一源码）；公共导入统一经 `loadCommonModule('client')` 加载已安装 common，首次成功即冻结，不依赖 node_modules 链接 |
| build-release.mjs | 正式发布目录构建入口：CLI 打包（SDK/zod 内联，薄适配独立分发）、复制 `build-ui.mjs` 实际页面与许可、组装 release.json 与发布目录外的构建输入记录 |
| text-files.mjs | 工作区边界、按层目录、UTF-8/BOM/换行特征、字节版本与拒绝旧基线的写回 |
| text-resources.mjs | 首次可信受审读取登记的文本资源、按版本通知与释放；后续刷新重新核对原会话目录范围，失效则停止监测并返回错误快照；同一 MCP subscribe／unsubscribe 路由按 URI 分派文本和评论资源，资源请求无对话 meta |
| comment-state.mjs | 可信评论状态资源；common快照状态代理、V4自有临时订阅／官方组装／当前分支分页；已观测批次证明、unknown与有界退订，不用legacy事件路线 |
| editor-settings.mjs | 插件外置 SQLite schema 2、schema 1 无损迁移、模式事务与会话恢复副本、存储边界校验及独立回执 |
| ui/editor-template.html / ui/editor.css / ui/editor.mjs | 页面结构和主题、目录树、CodeMirror 页签、手动／自动保存、打开文件版本检测及冲突确认 |
| build-ui.mjs / ui/dist/ | 唯一本地 UI 构建入口、随插件返回的自包含 HTML 与第三方许可；不手改生成文件 |
| tests/ | 公开 MCP/stdio 文件边界契约与实际资源浏览器烟测 |
| tests/common-fixture.mjs | 源码与发布测试共用的公共 common 安装夹具：真实构建 common 发布目录、组装宿主存储根布局并提供隔离数据目录 |
| tests/release-package.test.mjs | 发布目录契约：锚点失败分类、组装完整性、构建输入不内联 common/vendor、独立安装根自包含运行与外置状态 |
| tests/multi-root.test.mjs / tests/browser-multi-root.mjs | 多目录归属、撤销与 Windows 路径等价；实际构建目录切换、同名草稿、保存互斥、迟到资源及重开恢复 |
| tests/comment-state.test.mjs | 可信双资源、V4分片／完整历史／独立受理证明、真实ChannelClient取消和晚ACK，精确本插件批次及普通正文隔离 |
| tests/comment-host-fixture.mjs | V4 Host测试边界、官方encoder与真实ChannelClient pending／事件释放夹具，不连接Native |
| tests/browser-comments.mjs | 实际构建选区快照与聚合、全部入口禁用／表单保留、正常／失败／排队受理及迟到回执契约；不代替 Native |
| README.md / CHANGELOG.md | 当前版本范围、原生安装／打开、本地开发与用户可感知更新 |
| docs/se01-verification.md / docs/se01-evidence.json | 首次验证轨迹与总证据索引 |
| docs/se01-native-verification.md / docs/se01-native-evidence.json | 实际 Desktop 首开、关闭重开、会话／工作区归属与原生审批的限定证据 |
| docs/se03-verification.md / docs/se03-evidence.json | 目录／保存 SDK 契约、真实构建浏览器与独立两轴；链接后续限定 Native 证据 |
| docs/se03-native-verification.md / docs/se03-native-evidence.json | 固定产物的原生目录／读取／编辑／保存、人工审批、磁盘字节与完整 guest 图像；单列失败尝试和能力边界 |
| docs/se04-verification.md / docs/se04-evidence.json | 模式真实数据库、自动计时与外部修改契约、首次失败轨迹及待 Native 交接；不代表整票验收 |
| docs/se04-review-fix-verification.md / docs/se04-review-fix-evidence.json | 固定初版后的三项时序问题红绿、新增浏览器契约、历史证据保护与 Native 补充；不代替复核 |
| docs/se04-watch-fix-verification.md / docs/se04-watch-fix-evidence.json | 原生重复审批问题、公开资源通路的红绿／时序／错误与生命周期边界；新 Native 尚待验 |
| docs/se04-watch-review-verification.md / docs/se04-watch-review-evidence.json | 订阅通路两轴四项 P2 的公开红绿、重绑定／独立同步失败／通知拒绝／同版本旧错误与新固定产物；复核及 Native 待验 |
| docs/se04-watch-round2-verification.md / docs/se04-watch-round2-evidence.json | 第二轮规范目标页唯一性／脏正文保留、同字节改指保存的公开红绿与固定产物；独立复核及 Native 待验 |
| docs/se04-watch-round3-verification.md / docs/se04-watch-round3-evidence.json | 第三轮整合时钟驱动失败、三页瞬时激活的提前保存红绿与固定产物；独立复核及 Native 待验 |
| docs/se04-watch-native-verification.md / docs/se04-watch-native-evidence.json | 固定订阅产物的真实 Native 请求、单次 UI 授权、保存／冲突／退订／故障恢复与分层限制；保留文档提交时点，闭合见实施总记录 |
| docs/se05-verification.md / docs/se05-evidence.json | 恢复副本/schema 迁移的真实数据库、新进程及实际构建页面契约，首次失败与修正记录；原生 H4 待验 |
| docs/se05-review-fix-verification.md / docs/se05-review-fix-evidence.json | 首轮两轴三项 P2 的真实 stdio／构建页面红绿、身份合流／重试重入／初始化交互修正与新固定产物；独立复核及 H4 待验 |
| docs/se05-round2-verification.md / docs/se05-round2-evidence.json | 规格轴新增合流读取代际问题、真实 ACL 迟到资源错误红绿及54组完整浏览器；新固定产物复核及 H4 待验 |
| docs/se05-round3-verification.md / docs/se05-round3-evidence.json | 同一旧回执问题的脏目标分支红绿、保留正文／读取确认分离与55组完整浏览器；新固定产物复核及 H4 待验 |
| docs/se05-native-verification.md / docs/se05-native-evidence.json | 固定恢复产物的三类真实生命周期、独立副本回执／源字节／焦点、首次失败与根冻结索引；保留提交时点，当前整合结论见实施总记录 |
| docs/design-discussion.md | 已确认交互、问题轮次、宿主能力边界与后续特性范围 |
| docs/text-editor-spec.md | 首版行为、工程接口边界、能力门槛与验证标准 |
| docs/text-editor-tickets.md / docs/issues/ | 实施依赖图、原子票草稿和后续待做特性 |
| docs/issues/11-native-concurrent-comment-feature.md | 独立完整原生并发、公开状态／批次需求、重连晚回执与移除临时禁用验收 |
| docs/adr/0005-temporary-comment-send-guard.md | 用户接受残余风险的尽力禁用、当前票范围与完整特性边界 |
| docs/comment-guard-verification.md | 固定评论代码、首次失败与四项红绿／双轴、Git/LF产物和当前Native准备；不代替宿主实测或用户验收 |
| docs/development-verification.md / docs/native-ui-binding-research.md | 已执行验证与明确区分源码依据、宿主实测的能力记录 |
| docs/main-composer-context-research.md | 主对话插件附件身份、清理反馈与实际安装包的静态能力边界 |
| docs/adr/ | 已接受且影响后续实现的架构决定 |
| docs/agents/ | 领域文档和 GitHub 开票入口 |

# ZCode-Plugins — ZCode 插件 monorepo 根

`ZCode-Plugins/` 是 ZCode 插件与公共工具的集总仓库；每个一级子目录是一个子项目根，内部约定由其自身 `AGENTS.md` 维护，本文件只负责导航与仓库级约定。

## 仓库级约定

- 新增子项目必须在本文件文件树登记，并拥有自己的 `AGENTS.md`；通用规则写这里，专属规则写子项目内。
- `suian-zcode-common/` 是业务插件共用的公共基础能力实现和配置入口：网关、远控协议/探活、DPAPI、Toast 与消息投影。插件仅维护业务规则和提示词，不复制公共实现；运行数据归调用方，网关数据保留原目录。
- `marketplace.json` 是原生市场入口，指向固定 Release ZIP URL，登记 SHA-256 与 stripRoot:false；三个业务条目的 dependencies 都包含 common，各条目版本与插件清单同步。原生插件分别缓存，不硬拼同级缓存路径；四包发布目录构建与安装记录定位（PKG-01 契约）已交付，安装、配置、诊断与旧安装迁移按发布入口收敛（PKG-08）：发布缓存不 npm ci、不 link.mjs、不修包链接，npm 与 link.mjs 仅剩源码开发用途。skills/ 按职责拆分，根 SKILL.md 仅作源码兼容路由。
- 开源发布前完成个人信息脱敏（用户名、会话标识、本机路径、授权凭据），由插件各自 `.gitignore` 挡住运行时数据。
- 提交信息用中文，`类型: 简述` 格式，正文分条说明做了什么、为什么做。
- `sources/` 下的 submodule 是研究用的第三方上游快照：只读、不 fork、不修改、不安装依赖；升级钉定提交须在 `sources/README.md` 同步登记。
- 研究与验证笔记统一放 `suian-zcode-title/docs/notes/`（与命名相关）、`suian-zcode-app-mcp/docs/`（与会话操控 MCP 相关）或 `suian-side-editor/docs/`（与侧栏编辑器相关），入库存脱敏版。

## 开发与正式集成纪律

- **分支职责**：`dev` 是开发集成分支，`master` 是当前正式分支；用户泛称的 `main` 在本仓库指 `master`，保留现有分支名。
- **开发变更**：新特性和修复先在开发分支完成验证，再合入 `dev`，不得直接提交或合入 `master`。`dev` 尚不存在时，先从正式分支的当前基线建立，不以正式分支代替开发集成分支。
- **正式集成**：只有用户明确允许正式合并时，才将已验证的 `dev` 变更合入 `master`。推送、建 PR 和合并仍遵循各自的授权边界，不因建立本纪律而自动获得授权。
- **版本范围**：正式集成前，对照 `dev` 与正式分支的差异，确定受影响的插件并更新其版本；未受影响的插件不联动升版。公共层有变化时，按实际影响核对依赖它的业务插件。
- **版本清单**：同步受影响插件的 `.zcode-plugin/plugin.json`；已有版本字段的 `package.json`、锁文件根包与运行时自报版本也必须一致，已有 CHANGELOG 按发布范围更新。修改任一插件清单的 `version` 时，必须在同一变更中同步根 `marketplace.json` 对应条目的 `version`；提交前核对一致，避免原生市场漏检更新。
- **完成条件**：版本更新必须随正式集成内容一并进入 `master`；核对版本一致性、完成受影响范围的验证，并在提交或 PR 正文说明插件版本与验证结果。未完成版本同步，不得宣称正式集成完成。
- **发布命名**：仓库 Release 是四插件集总发布，标题与发布说明必须自明归属，不写裸版本号。标题固定 `ZCode Plugins · <短名> <版本>[ + <短名> <版本>…] · <主题>`，短名为 common / title / app-mcp / side-editor。发布说明的版本段标题写 `## [<短名> <版本>] - 日期`，底部变更链接键同步带短名（如 `[common 0.7.3]: <compare url>`）。各插件自身 CHANGELOG.md 保持 Keep a Changelog 原样，仅在拼入仓库级 Release 说明时补短名；标题与说明由发布执行方按此格式组装，发布脚本不内置模板。

## 文件树

```
ZCode-Plugins/
├── AGENTS.md               # 本文件：仓库导航与约定（单一事实源）
├── CLAUDE.md               # 通过 @AGENTS.md 导入主文件，仅附加 Claude 专属补充
├── CONTEXT.md              # 开发术语表（词汇与边界定义；Agent 操作入口见各 SKILL.md）
├── README.md               # 面向开源读者的仓库简介
├── marketplace.json        # 四个原生插件的版本、市场清单与业务依赖（手工维护单一数据源；ZIP 切换候选由发布工具生成、人工核对采纳）
├── LICENSE                 # MIT（自有代码）；vendor 第三方代码保留原许可
├── .gitignore              # 仓库级通用忽略规则
├── .agents/skills/         # 项目级技能（ZCode 兼容发现路径）：debug-isolated-zcode 隔离调试与 K1-K30 症状索引；zcode-local-patch-routing 新包补丁档案编写、路由接入及验证
│
├── release-orchestrate.mjs # PKG-07 仓库级发布编排 CLI：四包构建、确定性 ZIP、门禁核对与市场候选；输出落 .scratch/
├── release-zip.mjs         # 确定性 ZIP 写入/读取/安全解压（Node 内置 zlib；排序与时间戳固定，同输入同字节）
├── release-verify.mjs      # 发布组装目录契约校验：身份/版本/必备资源/敏感内容/公共代码内联/文件摘要
├── release-marketplace.mjs # 市场条目形状校验、候选生成（只改受影响条目）、版本统一检查（只报告）与回退候选
├── release-github.mjs      # Release 发布流水线编排（GitHub API 与下载依赖注入；先预发布公开，下载核验通过后自动转正式；真实写操作须另行发布授权）
├── tests/                  # 根级发布工具契约测试（release-*.test.mjs，含外部边界桩与 loopback HTTP fixture）
│
├── suian-zcode-title/      # ZCode 会话自动命名插件（Stop Hook + 命名决策 + 通知文案；公共导入经客户端契约定位）
│   ├── .zcode-plugin/      # 原生插件元信息
│   ├── hooks/             # 原生异步 Stop 注册（发布构建将命令改指 dist 入口）
│   ├── skills/            # setup / configuration / control / debug
│   ├── common-access.mjs / release-layout.mjs / installer.mjs / build-release.mjs
│   │                       # 公共薄适配与锚点解析、源码/发布双模式布局、安装共享实现、发布目录构建
│   └── docs/notes/         # 研究与验证笔记（脱敏后入库；桌面截图等敏感物料不入库）
│
├── suian-zcode-app-mcp/    # ZCode 会话 MCP（检索、聊天历史、原 Host 改名/创建/发信/压缩/置顶与 stdio 接入）
│   ├── .zcode-plugin/      # 原生插件元信息
│   ├── .mcp.json           # 原生 stdio 注册，配置指向外置 dataPath（发布版清单指向 dist 入口）
│   ├── hooks/              # 同步工件初始化、提交摘要与 Stop 快照
│   ├── ui/                 # 原生只读工件侧栏资源（构建时随 dist 复制，服务按相对位置读取）
│   ├── build-release.mjs   # 发布目录构建：SDK/zod 内联，公共层经 PKG-01 安装记录共享加载
│   ├── common-client.mjs   # 薄适配：业务对公共函数的唯一入口（惰性 loadCommonModule）
│   ├── skills/             # setup / configuration / sessions / automations / artifacts / glm / debug
│   └── docs/               # 研究、规格、ADR、开票与脱敏验证证据（含 local-only 产品接入规划）
│
├── suian-side-editor/     # 本机文本编辑器 0.4.0；多目录切换，选区评论尽力保护，LO-07 原生评论链路已验，原#47缺口保留
│   ├── AGENTS.md          # 本插件规则与文档入口
│   ├── CLAUDE.md          # 导入 AGENTS.md
│   ├── .zcode-plugin/     # 原生侧栏元信息与市场版本
│   ├── skills/setup/     # 安装核对与公共客户端定位；正式包即装即用，不 npm、不链接
│   ├── .mcp.json          # stdio 与宿主工作区绑定
│   ├── cli.mjs / server.mjs # 启动入口与 app-only 上下文、目录、读写工具；入口先加载公共客户端
│   ├── common-client.mjs / locate.mjs # 业务薄适配与 PKG-01 定位器副本：经已安装 common 加载公共实现，不依赖链接
│   ├── build-release.mjs   # 正式发布目录构建：CLI 打包（SDK/zod 内联）、实际页面与许可、release.json
│   ├── text-files.mjs     # 工作区边界、按层目录、UTF-8 读取与版本检查写回
│   ├── text-resources.mjs # 已登记只读快照、版本通知／退订，后台发送失败报告并停止监测
│   ├── comment-state.mjs # 可信评论状态、V4临时快照与当前分支历史分页、已观测批次证明
│   ├── editor-settings.mjs # 外置 SQLite schema 2、模式与恢复副本事务；回执独立于源保存
│   ├── build-ui.mjs       # 唯一本地 UI 构建入口
│   ├── ui/               # CodeMirror 源文件、自包含构建页面与第三方许可
│   ├── tests/            # 公开契约与浏览器烟测
│   └── docs/             # 规格、票、架构决定与分层验证证据
│
├── suian-zcode-common/    # 公共网关、远控/授权/通知/投影模块、依赖完整性 Stop 钩子、Windows 配置与 Agent skill
│   ├── .zcode-plugin/      # 必需公共插件元信息
│   ├── hooks/              # 原生 Stop 注册（async 触发 depcheck-hook.mjs）
│   ├── link.mjs            # 源码开发用公共入口与业务端 Node 包链接；正式安装与诊断不依赖
│   ├── client.mjs / client-install.mjs  # 公共客户端运行期/安装期入口（PKG-01 契约，commonApiVersion 1）
│   ├── rpc-broker.mjs / rpc-diagnostics.mjs # Host 桥生命周期与多客户端分流、跨网关和消费者的安全失败诊断
│   ├── locate.mjs         # 薄定位器：安装记录定位 common，单一源码分发业务包
│   ├── build-release.mjs  # 发布目录构建：esbuild 打包、release.json、buildId 与构建输入记录
│   ├── gateway-deploy.mjs / gateway-launcher.ps1 # 缓存外网关部署与稳定启动器（PKG-05：deployments/<buildId> 真实副本、活动记录原子切换、六步升级与失败回退）；启动器含健康门幂等与 logs/ 启动批次日志（7 天窗口清理）
│   ├── docs/client-contract.md  # 公共加载契约（锚点、失败分类、导出清单、迁移指引）
│   ├── docs/keepalive-log-retention-spec.md、docs/adr/ # 看护拉起与日志留存设计规格及决策记录（0.8.0）
│   ├── depcheck.mjs        # suian 系列插件发布契约扫描（PKG-08：release.json 完整性、身份、API 兼容；不再检查 node_modules/junction）
│   ├── depcheck-hook.mjs   # Stop 钩子入口：扫描→缺失时 Toast 提醒（--scan-only 手动复查）
│   ├── migration.mjs / legacy-cleanup.mjs # 旧源码迁移链（PKG-08）：开关与路径记录/恢复；旧 junction 归属核对后只删链接
│   ├── toast-action.mjs    # Toast 按钮协议入口：重扫→复制修复提示词→打开 ZCode
│   ├── log-rotate.mjs      # jsonl 事件日志按天滚动、行内嵌版本与 7 天写入点自清理（Toast 执行器为单文件快照，内联等价实现）
│   ├── toast-runtime.mjs / toast-executor.mjs # 缓存外共享 Toast 稳定运行时与自包含执行器（PKG-06）
│   ├── local-only/         # LO 隔离 lab 与补丁 CLI；profiles.mjs / profiles/ 按包身份自动路由并保留旧档案，patch-env.mjs 管理通用约定，patch.mjs 提供 status/prepare/apply/restore；网关字节不改
│   ├── vendor/             # 固定协议／投影及官方V4 decoder；保留来源和独立许可
│   └── skills/             # setup / configuration / debug
│
└── sources/                # 上游源码 submodule 引用（只读，见 sources/README.md）
    ├── official-zcode/     # zai-org/ZCode @ 3c5b2276（2026-10-20 公开快照，自报 v3.16.2，包含 Relay V2）
    └── zcode-open-bridge/  # tizerluo/zcode-open-bridge @ e8bd9bc（社区桥接参考）
```

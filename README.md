<img src="assets/icons/zcode-plugins.png" alt="ZCode-Plugins 标识" width="96">

版本与兼容范围以[实际发布页面](https://github.com/ONEGAYI/ZCode-Plugins/releases)和安装时的反馈信息为准。

安装和升级时，Agent 会按 Desktop 应用版本选择适用的网关协议；日常重载会保留已有协议与用户配置。具体方法与限制见[公共网关配置说明](./suian-zcode-common/skills/configuration/SKILL.md)。

给 ZCode 做的插件与公共工具集合。ZCode 是智谱推出的 Agentic Coding 工具（桌面端 + CLI），这个仓库放会话自动命名插件、会话 MCP、本机侧栏文本编辑器，以及业务插件共用的基础能力。

## 原生插件安装

仓库的 [marketplace.json](./marketplace.json) 提供四个原生插件并登记各自版本。公共插件是三个业务插件的依赖，自动命名、会话 MCP 和文本编辑器可分别选择。

插件 ZIP 托管在本仓库的 GitHub Releases，各插件的版本与 SHA-256 登记在市场清单中，由插件市场自动下载并校验。

| 插件 | 独立技能 |
| --- | --- |
| <img src="assets/icons/suian-zcode-common.png" alt="" width="32"> suian-zcode-common | setup、configuration、debug |
| <img src="assets/icons/suian-zcode-title.png" alt="" width="32"> suian-zcode-title | setup、configuration、control、debug |
| <img src="assets/icons/suian-zcode-app-mcp.png" alt="" width="32"> suian-zcode-app-mcp | setup、configuration、sessions、artifacts、glm、debug |
| <img src="assets/icons/suian-side-editor.png" alt="" width="32"> suian-side-editor | setup |

在 ZCode 桌面端按以下步骤安装：

1. 打开左侧栏的 **插件市场**，点击 **添加** → **插件市场**，填入本仓库的 GitHub 地址：[https://github.com/ONEGAYI/ZCode-Plugins.git](https://github.com/ONEGAYI/ZCode-Plugins.git)。
2. 添加成功后，安装所需的业务插件：`suian-zcode-title`、`suian-zcode-app-mcp` 或 `suian-side-editor`。它们会自动安装公共依赖 `suian-zcode-common`。
3. 安装完成后，**新开一个对话**，发送下面的提示词：

   ```text
   帮我配置已安装的 suian 插件
   ```

安装任一业务插件会自动安装 common，已有的停用状态会保留。市场安装交付自带全部运行文件的发布目录，安装后无需 npm 或包链接；网关等服务初始化由 Agent 按各插件的 setup 技能完成。文本编辑不需要启动网关；选区评论需要已有网关和桌面端远控连接，已测环境与边界见[开发验证记录](./suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md)。评论的已知限制见[编辑器说明](./suian-side-editor/README.md#临时选区评论)。

个人配置与状态保存在插件版本缓存之外。迁移旧源码安装时，Agent 只清理对应的旧注册，保留其他配置。具体步骤见各插件的 setup 技能。

### 旧源码安装迁移

已经通过桌面端安装原生插件、希望接替旧源码安装时，把下面这段粘给 ZCode。公共插件必需，两个业务插件按原有选择迁移。

```text
我已在 ZCode 桌面端安装了 ZCode-Plugins 原生插件，请迁移已有的源码安装：
https://github.com/ONEGAYI/ZCode-Plugins.git

先查询实际插件清单，核对 common 和所选业务插件的启用状态与实际路径；
旧安装位置可从旧 Hook、MCP 配置和技能中的根路径确定，选择或位置不明确时再询问我。
读取实际插件根下的 setup 技能，公共层统一按 common 的 setup 迁移流程执行，
业务插件按各自 setup 的迁移步骤处理，完成后按技能核对并分别报告结果。
```

### 原生插件升级

原生插件升级分为**更新代码**和**重新配置**两步：先更新插件版本缓存，再让 Agent 按 setup 技能复查发布完整性与运行入口（更新后无需 npm 安装或修包链接），新功能才可用。

**第一步：更新插件代码**

- **在桌面端更新**：打开插件市场，点击刷新更新市场目录，再升级 common 和已安装的业务插件。刷新市场和升级插件代码是两个操作。
- **让 ZCode 更新**：把下面这段粘给 ZCode，市场副本与 CLI 的具体操作见 common setup 技能的升级流程：

```text
请更新我已安装的 ZCode-Plugins 原生插件，保留插件选择、启用或暂停状态和个人配置。
按 common 插件 setup 技能的升级流程更新市场副本与版本缓存，
完成后核对各插件的新版本和实际 rootPath 并报告结果。
```

**第二步：更新后重新配置**

通过任一种方式更新后，新开一个对话发送"帮我配置已安装的 suian 插件"，Agent 会以新的插件路径读取 setup 技能并完成升级配置。只使用 suian-side-editor 时没有网关步骤，Agent 会按其 setup 跳过。

## 源码安装或升级

下面适用于继续使用源码安装的用户；原生安装请使用上方的迁移或升级提示词。直接把这段粘给 ZCode，**无需先手动克隆仓库**。Agent 会先询问操作和插件选择，按下方的代码获取范围取得代码，再读取 setup 技能完成配置。

```text
请帮我安装或升级 ZCode-Plugins（源码模式）：
https://github.com/ONEGAYI/ZCode-Plugins.git

先询问我：首次安装还是升级；选择哪些插件；源码放在哪里。
先检查已有源码和安装位置，优先复用现有仓库；没有时再确定克隆目录。
首次安装优先用稀疏检出，不初始化 sources 子模块；
已有仓库保留其他已安装插件的目录，更新遇到本地修改或分叉时先说明，不强制覆盖。

获取代码后，读取所选插件和 suian-zcode-common 的 setup 技能，
按技能完成安装或升级与本机检查；模型选择、网关重载和重开时机都按技能执行。
```

### 代码获取范围

两个插件都依赖公共层；公共层内的网关按统一流程配置。只选一个插件时，可以通过 **稀疏检出**，让本地工作目录只包含需要的子项目；根目录的 README、AGENTS、许可证等文件仍会保留。

| 用户选择 | 需要检出的子目录 |
| --- | --- |
| 自动命名 | `suian-zcode-title`、`suian-zcode-common` |
| 会话 MCP | `suian-zcode-app-mcp`、`suian-zcode-common` |
| 两个都要 | 上述三个目录，公共层只获取一份、网关只配置一次 |

下面是 Agent 首次安装自动命名时可用的命令；`{{repo_dir}}` 由 Agent 和用户确定。只装 MCP 时，将 `suian-zcode-title` 换成 `suian-zcode-app-mcp`；全装则在 `set` 后列出三个目录。

```powershell
git clone --filter=blob:none --sparse --no-recurse-submodules https://github.com/ONEGAYI/ZCode-Plugins.git "{{repo_dir}}"
git -C "{{repo_dir}}" sparse-checkout set suian-zcode-title suian-zcode-common
```

`--filter=blob:none` 按需获取文件内容，仍使用同一个 Git 仓库和它的元数据。[Git clone 文档](https://git-scm.com/docs/git-clone)

**已有安装优先复用同一仓库**：完整检出的仓库保持原范围；已有稀疏检出需要新增插件时使用 `sparse-checkout add` 扩展范围，保留其他已安装插件，不能用 `set` 缩掉其源码。[稀疏检出文档](https://git-scm.com/docs/git-sparse-checkout)

升级时保留源码目录和已有配置；稀疏检出需要包含 `suian-zcode-common`，从旧版升级时使用 `sparse-checkout add suian-zcode-common` 补齐，不能删掉其他已安装插件。网关会继续运行旧代码，Agent 按公共 skill 安排安全的 `Restart`，同时迁移旧网关目录的启动配置；不要更新后就宣称运行中网关已经升级。

普通安装和升级不需要 `sources/` 的研究用子模块；研究上游源码时再按 [sources/README.md](./sources/README.md) 获取。

## suian-zcode-title — 会话自动命名

每轮对话结束后，自动把会话标题更新成「类别 emoji + 对象｜目标」，会话再多也一眼能找到：

| 原来的标题 | 自动命名后 |
| --- | --- |
| C:/Users/…/handoff-zcode-title-202610…（被截断的临时文件路径） | 🧩 远控 Hook 插件｜授权失效排查 |
| 帮我看看这个报错 | 🧪 发布流水线｜超时排查 |

它通过 ZCode 官方的 Web 远控通道连接当前窗口，用你自己账号里的模型生成标题，不往对话里插消息，也不直接改数据库；标题会跟随工作主线缓慢更新，手动改过的标题不会再被覆盖。安装时把一段话粘给 ZCode 就行，详见 [suian-zcode-title/README.md](./suian-zcode-title/README.md)。

## suian-zcode-app-mcp — 会话 MCP

检索本机会话、聊天历史、置顶项与定时任务，也能更名、创建会话、发信、压缩上下文、归档、复原和置顶。会话操作通过公共网关连接当前 ZCode 窗口，可以与手机共用。另提供 GLM 套餐额度和重置卡查询；消耗重置卡前，需要本次用户许可及客户端确认。接入与边界见 [suian-zcode-app-mcp](./suian-zcode-app-mcp/)。

还可以登记当前会话的 PR、议题、关联会话、文件和链接，在侧栏按类别查看详情。登记内容变化后自动刷新，PR 和议题会显示当前状态，文件可通过资源管理器打开。新建会话会登记双方关联；从历史断点分叉时，会继承对应的工件副本，之后各自维护。功能与使用条件见[会话工件说明](./suian-zcode-app-mcp/README.md#会话工件)。

## suian-side-editor — 侧栏文本编辑器

在当前本机工作区浏览已有 UTF-8 文本，使用内部临时／固定页签编辑，再以保存按钮或 Ctrl+S 写回。目录按层展开，保存前检查磁盘内容版本；版本冲突时拒绝覆盖并保留编辑。保存支持手动与自动两种模式；打开的文件订阅外部变化，外部更新后自动刷新干净内容，不重复触发权限审批。页签顺序、阅读位置和未保存内容按会话保存，编辑器关闭重开、页面被宿主回收重建、应用重启后都能恢复。

选区评论会将选中的文本和评论一起加入当前主对话，使用方法见[编辑器说明](./suian-side-editor/README.md)。评论需要已有网关和桌面端远控连接，已测环境与边界见[开发验证记录](./suian-zcode-app-mcp/docs/local-only/07-editor-acceptance-evidence.md)，其它环境仍需分别确认。模型回复等待期间会禁用评论发送，但状态判断可能迟到；已被插件受理、随后被外部取消的评论，在特定时序下可能随新评论一起再次发送。

编辑器仍待完整首版验证与用户验收，具体限制见[编辑器说明](./suian-side-editor/README.md#临时选区评论)。

## suian-zcode-common — 公共基础能力

为业务插件提供公共连接与依赖检查。自动命名和会话 MCP 共用一个后台网关，安装、升级与移除统一处理。操作入口为[安装升级](./suian-zcode-common/skills/setup/SKILL.md)、[连接配置](./suian-zcode-common/skills/configuration/SKILL.md)与[排障](./suian-zcode-common/skills/debug/SKILL.md)。

公共层还会检查插件依赖。发现缺失时，Windows 通知会提供可复制的修复说明，交给 Agent 处理即可。版本信息见[市场清单](./marketplace.json)，连接条件与使用方法见[公共插件说明](./suian-zcode-common/README.md)。

**可以在 ZCode 当前会话里完成安装或升级**。重载网关时，Agent 会自动避开进行中的远控操作：空闲时直接切换，Desktop 连接层自动重连；持续忙碌时最多等待约一分钟，可稍后重试或暂停远控让出窗口。首次接入或修改启动地址时，Agent 也会先完成配置和本机检查，最后再提示你择时重启生效；已经连接正确网关且地址未变时，重新开启远控即可。

手机控制本机项目时，插件可以同时操作。手机切换到 SSH、WSL 等远程开发工作区后，本地会话操作会暂时不可用；切回本机项目后可以继续。

需要本地模式时，让 Agent 按[公共 setup](./suian-zcode-common/skills/setup/SKILL.md)检查 local-only 的可用性。该模式只在本机提供连接，不提供官方手机远控；模型生成和套餐查询仍需相应服务可达。

## 找到你想要的

- **安装或升级自动命名** → [suian-zcode-title](./suian-zcode-title/)，提示词会让 Agent 询问操作并获取代码
- **安装或升级会话查询 MCP** → [suian-zcode-app-mcp](./suian-zcode-app-mcp/)，提示词与原生 MCP 接入说明
- **配置公共层与共用网关** → [公共网关 skill](./suian-zcode-common/SKILL.md)，端口、启动、重启生效和恢复只维护一处
- **了解实现**（远控协议、Stop Hook、探活分层）→ [suian-zcode-title/AGENTS.md](./suian-zcode-title/AGENTS.md) 的技术参考
- **做会话操控 / MCP** → [research-findings.md](./suian-zcode-app-mcp/docs/research-findings.md)，含已核实能力表与首批工具设计
- **读 ZCode 源码** → [sources/](./sources/)，官方公开快照与社区桥接项目，submodule 引用、按需获取

## 许可证

自有代码以 [MIT](./LICENSE) 发布；`vendor/` 与 `sources/` 内的第三方代码保留其原始许可与来源声明（见各目录 NOTICE）。

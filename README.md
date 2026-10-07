给 ZCode 做的插件与公共工具集合。ZCode 是智谱推出的 Agentic Coding 工具（桌面端 + CLI），这个仓库放会话自动命名插件、会话 MCP，以及两者共用的基础能力。

## 让 Agent 帮你安装或升级

直接把下面这段粘给 ZCode，**无需先手动克隆仓库**。Agent 会先询问操作和插件选择，再负责获取代码与配置。

```text
请帮我安装或升级 ZCode-Plugins：
https://github.com/ONEGAYI/ZCode-Plugins.git

先询问我：首次安装还是升级；选择自动命名 suian-zcode-title、
会话 MCP suian-zcode-app-mcp，还是两个都要；源码放在哪里。
先检查已有源码和安装位置，优先复用现有仓库；没有时再确定克隆目录。

确认后，由你克隆或更新代码。首次安装优先用稀疏检出，
获取选中的插件、公共 suian-zcode-common 和仓库根文件，不初始化 sources 子模块。
已有仓库保留其他已安装插件的目录；更新遇到本地修改或分叉时先说明，不强制覆盖。

读取仓库中所选插件的最新 SKILL.md，公共层统一按 suian-zcode-common/SKILL.md 配置，
复用同一网关，保留已有授权、模型选择和其他配置。
完成后分别检查插件与网关；需要我操作界面或重启时，说明保存工作、完整退出
和从正确环境重开的方法，不要自行重启 ZCode。
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

## suian-zcode-title — 会话自动命名（可用）

每轮对话结束后，自动把会话标题更新成「类别 emoji + 对象｜目标」，会话再多也一眼能找到：

| 原来的标题 | 自动命名后 |
| --- | --- |
| C:/Users/…/handoff-zcode-title-202610…（被截断的临时文件路径） | 🧩 远控 Hook 插件｜授权失效排查 |
| 帮我看看这个报错 | 🧪 发布流水线｜超时排查 |

它通过 ZCode 官方的 Web 远控通道连接当前窗口，用你自己账号里的模型生成标题，不往对话里插消息，也不直接改数据库；标题会跟随工作主线缓慢更新，手动改过的标题不会再被覆盖。安装时把一段话粘给 ZCode 就行，详见 [suian-zcode-title/README.md](./suian-zcode-title/README.md)。

## suian-zcode-app-mcp — 会话 MCP

通过两个只读工具列出本机会话、按工作区或标题/ID 检索并读取聊天消息；五个写工具经授权原 Host 改名、指定模型创建并提交开局信息、向指定会话发信、归档与复原。stdio 接入，消息由服务统一包装其他会话来源标识。当前写工具仍占独立远控席位，接入与边界见 [suian-zcode-app-mcp](./suian-zcode-app-mcp/)。

## suian-zcode-common — 公共基础能力

统一维护网关、远控协议与探活、DPAPI 授权存取、Toast 通知和消息投影。公共层包含可导入的模块，只有网关是常驻后台进程；命名规则和 MCP 工具契约留在各插件。网关的 Windows 启动、环境变量与恢复也只维护一份。两个插件的初始化 skill 都调用 [公共网关 skill](./suian-zcode-common/SKILL.md)，Agent 会完成配置并提示用户先处理运行中工作，再完整退出重开 ZCode。

已验证同进程 bootstrap 元数据读取与官方手机页面共存；命名插件的完整 V4 RPC 尚未接入网关分流。说明与配置入口见 [suian-zcode-common](./suian-zcode-common/)。

## 找到你想要的

- **安装或升级自动命名** → [suian-zcode-title](./suian-zcode-title/)，提示词会让 Agent 询问操作并获取代码
- **安装或升级会话查询 MCP** → [suian-zcode-app-mcp](./suian-zcode-app-mcp/)，提示词与原生 MCP 接入说明
- **配置公共层与共用网关** → [公共网关 skill](./suian-zcode-common/SKILL.md)，端口、启动、重启生效和恢复只维护一处
- **了解实现**（远控协议、Stop Hook、探活分层）→ [suian-zcode-title/AGENTS.md](./suian-zcode-title/AGENTS.md) 的技术参考
- **做会话操控 / MCP** → [research-findings.md](./suian-zcode-app-mcp/docs/research-findings.md)，含已核实能力表与首批工具设计
- **读 ZCode 源码** → [sources/](./sources/)，官方公开快照与社区桥接项目，submodule 引用、按需获取

## 许可证

自有代码以 [MIT](./LICENSE) 发布；`vendor/` 与 `sources/` 内的第三方代码保留其原始许可与来源声明（见各目录 NOTICE）。

# suian-zcode-app-mcp

给 Agent 一组管理 ZCode 会话和工件的工具：找回聊天、整理名称、跨会话传递信息、维护交付引用，也能查询 GLM 套餐额度。

功能变化见[更新记录](./CHANGELOG.md)。

> [!WARNING]
> **从 0.8.1 起支持 ZCode 3.16 的核心会话操作**。当前 0.10.0 需要搭配公共插件 suian-zcode-common 0.4.0 及以上版本，可以与手机远控同时使用。
>
> **ZCode 3.16 无法在离线模式使用会话控制功能**，先联网开启远控再断网的情况除外。本机会话与历史查询不依赖远控，套餐查询仍需相应服务可达。

安装和升级时，Agent 会按 Desktop 应用版本配置网关：3.16 使用 V2，旧版使用 V1；日常重载会保留已有协议与用户配置。具体方法与限制见[公共网关配置说明](../suian-zcode-common/skills/configuration/SKILL.md)。

安装到 ZCode 或其他支持 MCP 的客户端后，直接告诉 Agent 想完成什么，它会调用相应工具。

## 原生插件与技能

通过根目录的[插件市场](../marketplace.json)按需安装本插件，common 会作为依赖自动安装。再让 Agent 使用[setup](./skills/setup/SKILL.md)完成依赖、公共包链接与外置配置。原生 .mcp.json 自动注册服务，不再另加全局 MCP。

技能分别负责[configuration](./skills/configuration/SKILL.md)配置路径和客户端，[sessions](./skills/sessions/SKILL.md)操作会话，[glm](./skills/glm/SKILL.md)查询额度与许可后重置，[debug](./skills/debug/SKILL.md)排查服务。原生服务带插件命名空间，按客户端实际清单定位。旧源码接入仍可使用，迁移时先转存自定义路径再清理自有注册；可复制根 README 的[迁移提示词](../README.md#旧源码安装迁移)或[原生升级提示词](../README.md#原生插件升级)。

[artifacts](./skills/artifacts/SKILL.md)负责当前会话的 PR、议题、关联会话、文件和链接工件。原生插件还自动加载工件的同步 Hook 和只读侧栏资源。

## 日常可以怎么用

- 「列出这个项目最近十个会话，找一下讨论网关的那段聊天。」
- 「读取那段会话最近的回复，告诉我进展。」
- 「在这个项目里新建一个会话，选择指定模型，把测试任务交给它。」
- 「把这段说明发给刚创建的会话，再读取它的回复。」
- 「压缩这个会话的上下文，保留当前工作和排队消息的处理顺序。」
- 「整理已经完成的会话，需要归档时先检查有没有工作还在进行。」
- 「把正在跟进的几个会话置顶，列表打开就能找到。」
- 「查看我的 GLM 套餐额度，还有几张可用重置卡。」

跨会话发送的信息会自动附上创建者或发信者的会话 ID，无需 Agent 手动填写。来源有冲突时，会标注为“可能的来源”并继续创建或发送；完全缺少来源上下文或数据损坏时，插件会说明原因。新建会话可以指定初始名称，也可以让自动命名插件继续调整；想固定名称时，告诉 Agent 不要自动更名。

创建和发信都支持直接正文 `message` 或 Markdown 文档绝对路径 `message_file`，两者二选一。短指令直接填正文；长文与汇报推荐先写到工作区已被 Git 忽略的临时目录（如 `.zcode/tmp/`），再传文档路径。服务读取 UTF-8 文档全文发送，文件不可读或正文为空时会在创建、恢复及发信前报错。

ZCode 3.16 支持一个项目包含多个目录。查询会话时可按项目筛选，避免把使用同一目录的不同项目混在一起。在当前会话的目录范围内新建会话时，默认继承其项目和附加目录；也可明确指定其他项目或不带附加目录。切换侧栏编辑器的浏览目录不会改变会话的执行目录。

## 基于官方 Web 远控通道

查询会话和聊天记录时，插件直接读取本机已经保存的内容。更名、创建会话、发送消息、压缩上下文、归档和查询套餐额度，则通过 ZCode 自带的「移动端远程控制」操作当前窗口，账号仍由 ZCode 管理。

安装时，Agent 会配置公共网关，它是供插件和手机共用的后台连接程序。按提示在桌面端的移动端远程控制面板开启服务，出现等待连接或已连接的状态后，再检查插件是否可用。插件不要求手机扫码或保持在线，也不需要接收手机远控链接。如果同时安装自动命名插件，两者会共用这项服务。

### 内网机器能使用吗

**ZCode 3.16 无法在离线模式使用会话控制功能**，先联网开启远控再断网的情况除外。首次开启或重新启动远控时，需要登录 ZCode 账号并连接官方远控服务；本机会话和聊天历史查询仍不依赖远控。

已支持的旧版可以继续使用原有本地模式，由网关在本机提供会话控制连接。该模式不提供官方手机连接，模型回复和套餐查询仍需相应服务可达。首次安装先完成配置，最后再安排重启。配置方法见[公共 skill](../suian-zcode-common/SKILL.md)。

### 会不会影响手机远程控制

**手机可以继续连接**，插件不会用另一个设备的身份接管手机连接。已经实际验证：在本地工作区里发送消息、更名和读取回复的时候，手机仍能正常操作，不需要刷新或重新连接。

手机远控本机项目的时候，插件可以同时操作。只有手机切换到**远程开发工作区**（例如通过 SSH 或 WSL 连接打开的项目）时，目前才无法同时执行本地插件的更名、发信等操作。开启手机远控本身不会触发这项限制，手机切回本地项目后即可继续。

**安装和升级可以留在当前 ZCode 会话里完成**。需要重载后台连接程序时，Agent 会让你暂时关闭 ZCode 内的移动端远控，在面板内点击“停止”，配置完成后再开启；应用和当前会话继续保留。首次接入或修改启动地址也先完成配置与本机检查，最后才提示保存工作、择时重启生效。

## 会话工件

工件是当前会话登记的交付引用，包括 PR、议题、关联会话、文件和链接。每次提交输入时，Agent 会收到登记提醒、分类统计和一份按类别分组的工件简表，被截短的内容会明确标注，需要完整列表或详情时随时查看。新建会话成功后，父、子两边会自动登记相互的关联；来源存在冲突时不自动登记。登记和查看不依赖远控，内网机器也能使用；只有会话类工件的实时详情需要网关连接。

从历史断点分叉出的新会话，会按所选断点得到一份独立的工件副本，之后各自维护。聊天回退不会自动回滚已登记的内容，压缩、归档和恢复也不影响它。

Desktop 本地会话在侧边面板的“打开标签页”里选择“工件”，可以按类型浏览可折叠的登记列表，点开条目查看详情，返回时保留列表状态。查看不需要模型参与；登记内容变化后面板自动刷新，不用再手动点“刷新”，旧宿主不支持订阅时保持手动刷新。侧栏需要应用版本至少 3.15.1；版本更旧时工件工具仍然可用，只是没有这个面板。首次打开提示连接不可用时，核对该会话的 MCP 连接后重新加载。规格与实测边界见[开发验证](./docs/artifact-demo-verification.md)。

面板还展示工件状态：PR 和议题按开放、合并、关闭等状态显示图标，行尾给出 PR 相对主分支的增删行数或议题的评论数。**重新打开面板时，先显示上次成功查询并保存在数据库中的状态，再更新查询结果**；从未查到状态的条目使用默认图标。查询只在面板刷新时进行，模型侧查询不会触发网络请求；拉取超时沿用旧数据并说明原因，明确失败时清除该条目缓存，回退默认图标。

文件条目区分文件与文件夹，路径已删除时灰化；详情页提供“用文件资源管理器打开”。

## 操作边界

- 聊天记录以本机已经保存的内容为准，正在生成但尚未保存的文字不会立即出现；暂不支持读取远程开发工作区的聊天正文。
- 创建会话或执行更名等操作时，目标项目需要已在当前 ZCode 窗口打开，并启用远控。只查询本机会话和历史时，可以不启用远控。
- 有任务还在运行的会话，归档前需要你明确同意。归档只是从列表中收起会话，不会停止后台工作；之后可以恢复。
- 额度查询不会使用重置卡。每次重置都需要你明确许可，并在客户端的确认界面中同意；不支持确认界面的客户端无法执行。一次使用一张对应卡片，不能挑选具体哪张。

## 源码安装或升级

直接把下面这段粘给 ZCode，**无需先手动克隆**。同一提示词支持首次安装和升级，由 Agent 先询问操作、检查已有安装，再获取代码。

```text
请帮我安装或升级会话 MCP suian-zcode-app-mcp：
https://github.com/ONEGAYI/ZCode-Plugins.git

先询问我是首次安装还是升级，以及源码放在哪里。
先检查已有源码和安装位置，优先复用现有仓库；没有时再确定克隆目录。
确认后，由你克隆或更新代码。首次安装按根 README 的“代码获取范围”使用稀疏检出，
获取 suian-zcode-app-mcp、公共 suian-zcode-common 和仓库根文件，不初始化 sources 子模块。
已有仓库保留其他已安装插件的目录；更新遇到本地修改或分叉时先说明，不强制覆盖。

读取仓库中最新的 suian-zcode-app-mcp/SKILL.md，
公共层统一按 suian-zcode-common/SKILL.md 配置，复用同一网关，
保留已有授权、模型选择和其他配置。
保留当前 ZCode 和会话，先完成全部安装或升级以及本机检查。
需要重载网关时，让我只暂停 ZCode 内的移动端远控（面板内点"停止"），由你在当前会话继续完成。
首次接入或修改启动地址也先完成配置，最后才提示我保存工作、择时重启生效；
地址未变且已连接正确网关时，重新开启远控即可。不要自行退出或重启 ZCode。
```

只安装本插件时，Agent 会获取 **MCP 目录 + 公共层 + 仓库根文件**，无需下载自动命名插件。想同时安装两个插件，可以使用 [根 README](../README.md) 中的组合提示词。安装流程由 [本插件 skill](./SKILL.md) 和 [公共网关 skill](../suian-zcode-common/SKILL.md) 提供。

## 手动接入与工具参考

通常交给 Agent 安装即可。需要自己配置客户端、查看工具名称或调整数据位置时，可以展开下面的说明。

<details>
<summary>查看工具列表、配置和调用示例</summary>

### 工具列表

| 工具 | 用途 |
| --- | --- |
| `list_sessions` | 按项目、名称、ID 或目录查找会话；显示多目录项目标记和最多 3 个附加目录，置顶优先，也可包含归档项 |
| `read_session` | 读取指定会话最近的聊天，向前翻阅更早内容 |
| `get_current_session` | 查看发起当前工具调用的会话信息 |
| `rename_session` | 将指定会话改为新的名称 |
| `start_session` | 在已打开的项目中新建会话，可选名称和模型，并交代开局任务 |
| `send_message` | 给指定会话发送信息，包括刚创建的会话 |
| `compact_session` | 请求压缩指定会话上下文；运行中排队，回执仅表示受理 |
| `archive_session` | 归档会话；如果仍有工作在进行，先取得用户的强制归档许可 |
| `restore_session` | 将归档会话恢复到列表 |
| `pin_session` | 置顶会话；只改变列表展示归属，与归档状态互不影响 |
| `unpin_session` | 取消置顶会话 |
| `list_pinned_sessions` | 列出置顶会话，可含归档项；只读本机索引，无需 Desktop 在线 |
| `list_crons` | 查询本机已保存的定时任务及启用状态 |
| `set_cron_enabled` | 暂停或恢复指定定时任务，写后读回确认结果 |
| `reset_cron_tools_visibility` | 在定时任务触发的会话中请求结束当前轮，以便下一轮恢复官方定时任务工具 |
| `get_glm_balance` | 查询 GLM 个人套餐的模型、工具额度和可用重置卡 |
| `reset_glm_quota` | 经本次用户许可和客户端确认表单，消耗一张对应卡重置 5h 或周模型额度 |
| `get_artifacts` | 无业务参数，读取宿主绑定的当前会话最新 revision、items、stats 与继承诊断 |
| `set_artifacts` | 以 expected_revision 和 upsert/remove 原子增量更新当前会话工件 |

### 手动接入 MCP

需要 Node.js 24+，使用 Node 内置 SQLite，无需另装 sqlite3 命令行程序。在本插件目录安装锁定依赖：

```powershell
npm ci --ignore-scripts --no-fund --no-audit
```

公共层也需按公共 setup 安装依赖。npm ci 后由公共 link.mjs 建立本插件的 Node 包链接，例如 `node ../suian-zcode-common/link.mjs --plugin-root .`（从源码 MCP 目录执行）。再运行 `node install.mjs --check-only`，确认依赖可用；失败先补齐，不继续注册。

在 MCP 客户端添加下面的 stdio 服务。将 `{{plugin_root}}` 替换为本插件目录的绝对路径，建议使用 `/` 分隔符；服务入口必须是 `cli.mjs`。配置示例见 [mcp.config.example.json](./mcp.config.example.json)。

```json
{
  "mcpServers": {
    "suian-zcode-app": {
      "type": "stdio",
      "command": "node",
      "args": ["{{plugin_root}}/cli.mjs"]
    }
  }
}
```

这是使用 `mcpServers` 的兼容客户端示例。ZCode 原生 `~/.zcode/cli/config.json` 或工作区 `.zcode/config.json` 使用 `mcp.servers`，由 Agent 按 skill 合并本服务，保留其他配置；不要把整个示例当作原生配置文件。[官方 MCP 文档](https://zcode.z.ai/cn/docs/mcp-services)

公共网关的环境变量必须配置在 Desktop 启动环境中，不能只放在 MCP 服务的 `env`。手动配置流程以[公共网关 skill](../suian-zcode-common/SKILL.md)为准。本机会话、历史、置顶项与定时任务查询不需要远控连接，也不需要手机远控链接。

默认读取当前系统用户的 `~/.zcode/v2/tasks-index.sqlite` 和 `~/.zcode/cli/db/db.sqlite`。自定义路径可在 args 追加 `--index-db {{index_db_path}} --session-db {{session_db_path}} --artifact-db {{artifact_db_path}}`，或设置对应环境变量。也可用 `--config {{config_file}}` 读取外置 JSON 的 indexDbPath、sessionDbPath、artifactDbPath、gatewayConfigPath、authDataDir。优先级为命令参数 > 对应环境变量 > 外置配置 > 默认路径。

工具结果面向当前 ZCode：`structuredContent` 保存完整数据，`content` 只提供最多 160 个 Unicode 码点的数量、操作状态或错误简报，不重复正文和完整清单。

业务错误保留 `isError:true` 与完整结构化错误；SDK 参数校验错误仍由 SDK 返回。工件侧栏继续读取结构化数据，Hook 摘要不变。仅解析文本 JSON 的旧客户端不在本次兼容范围。

原生工件默认放在 dataPath/artifacts.sqlite；源码模式使用 ~/.zcode/tools/suian-zcode-app-mcp/artifacts.sqlite。Hook 与 MCP 读取同一外置配置。仅手动添加 stdio 服务不会加载 Hook 或侧栏，完整 demo 推荐原生插件安装。

### 调用示例

```json
{"name":"list_sessions","arguments":{"limit":10}}
{"name":"list_sessions","arguments":{"workspace_path":"D:/work/example","limit":20}}
{"name":"list_sessions","arguments":{"query":"MCP","include_archived":true}}
{"name":"read_session","arguments":{"session_id":"sess_example","limit":10}}
```

`list_sessions` 省略工作区即所有索引工作区，默认排除归档与删除项。使用 `next_offset` 继续列举；`read_session` 使用 `next_before_message_id` 获取更早消息。

测试命令为 `npm test`。实测与契约测试汇总见 [验收证据](./docs/readonly-tools-evidence.json)。

创建会话、发送信息和读取回复的示例见 [会话操作说明](./docs/write-tools.md)。公共配置目录非默认时，给 args 添加 `--gateway-config {{gateway_config_path}}`，指向公共 config.json；不把其中令牌复制到 MCP 配置。

查询 GLM 额度使用 `get_glm_balance({"workspace_path":"D:/work/example"})`。重置输入为 `{"workspace_path":"D:/work/example","reset_type":"FIVE_HOUR"}`，周窗口用 `WEEK`；没有用户许可和确认表单时不得调用。完整形状见 [GLM 工具契约](./docs/glm-balance-design.md)。

</details>

## 进一步了解

- [只读工具说明](./docs/readonly-tools.md)：检索、聊天内容与翻页。
- [会话操作说明](./docs/write-tools.md)：更名、创建、发信和归档。
- [GLM 额度说明](./docs/glm-balance-design.md)：额度口径、重置确认和异常处理。
- [接入研究](./docs/research-findings.md)：官方通道与能力调查。
- [自动命名插件](../suian-zcode-title/)：根据聊天内容自动整理会话名称。

自有代码沿用仓库 [MIT 许可](../LICENSE)。消息可见性投影库来自固定版本 ZCode，原样保留其 Apache-2.0 许可与 [来源声明](./vendor/NOTICE.md)。

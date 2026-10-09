# suian-zcode-app-mcp

给 Agent 一组管理 ZCode 会话的工具：找回之前的聊天、整理会话名称、在不同会话之间传递信息，也能查询 GLM 套餐额度。

安装到 ZCode 或其他支持 MCP 的客户端后，直接告诉 Agent 想完成什么，它会调用相应工具。

## 日常可以怎么用

- 「列出这个项目最近十个会话，找一下讨论网关的那段聊天。」
- 「读取那段会话最近的回复，告诉我进展。」
- 「在这个项目里新建一个会话，选择指定模型，把测试任务交给它。」
- 「把这段说明发给刚创建的会话，再读取它的回复。」
- 「整理已经完成的会话，需要归档时先检查有没有工作还在进行。」
- 「查看我的 GLM 套餐额度，还有几张可用重置卡。」

跨会话发送的信息会自动附上创建者或发信者的会话 ID，无需 Agent 手动填写。来源有冲突时，会标注为“可能的来源”并继续创建或发送；完全缺少来源上下文或数据损坏时，插件会说明原因。新建会话可以指定初始名称，也可以让自动命名插件继续调整；想固定名称时，告诉 Agent 不要自动更名。

创建和发信都支持直接正文 `message` 或 Markdown 文档绝对路径 `message_file`，两者二选一。短指令直接填正文；长文与汇报推荐先写到工作区已被 Git 忽略的临时目录（如 `.zcode/tmp/`），再传文档路径。服务读取 UTF-8 文档全文发送，文件不可读或正文为空时会在创建、恢复及发信前报错。

## 基于官方 Web 远控通道

查询会话和聊天记录时，插件直接读取本机已经保存的内容。更名、创建会话、发送消息、归档和查询套餐额度，则通过 ZCode 自带的「移动端远程控制」操作当前窗口，账号仍由 ZCode 管理。

安装时，Agent 会配置公共网关，它是供插件和手机共用的后台连接程序。按提示开启 ZCode 的远控功能即可，不需要把手机远控链接交给插件。如果同时安装自动命名插件，两者会共用这项服务。

### 内网机器能使用吗

如果机器无法访问官方远控服务器，可以让 Agent 配置**本地模式**（local-only）。网关会在本机处理 ZCode 的启动与心跳，让 MCP 继续连接当前窗口进行会话管理。只查询本机会话和历史时，两种模式都不依赖远控；发信后的模型回复和套餐查询仍需相应服务可达。

本地模式不提供官方手机连接。首次安装时，Agent 先完成全部配置，最后再提示重启生效；之后开启 ZCode 内的移动端远控服务即可。配置方法和版本验证范围见 [公共 skill](../suian-zcode-common/SKILL.md)。

### 会不会影响手机远程控制

**手机可以继续连接**，插件不会用另一个设备的身份接管手机连接。已经实际验证：在本地工作区里发送消息、更名和读取回复的时候，手机仍能正常操作，不需要刷新或重新连接。

手机远控本机项目的时候，插件可以同时操作。只有手机切换到**远程开发工作区**（例如通过 SSH 或 WSL 连接打开的项目）时，目前才无法同时执行本地插件的更名、发信等操作。开启手机远控本身不会触发这项限制，手机切回本地项目后即可继续。

**安装和升级可以留在当前 ZCode 会话里完成**。需要重载后台连接程序时，Agent 会让你暂时关闭 ZCode 内的移动端远控，配置完成后再开启；应用和当前会话继续保留。首次接入或修改启动地址也先完成配置与本机检查，最后才提示你保存工作、择时重启生效。共存的详细验证范围见 [共存验证记录](./docs/relay-gateway-coexistence.md)。

## 操作边界

- 聊天记录以本机已经保存的内容为准，正在生成但尚未保存的文字不会立即出现；暂不支持读取远程开发工作区的聊天正文。
- 创建会话或执行更名等操作时，目标项目需要已在当前 ZCode 窗口打开，并启用远控。只查询本机会话和历史时，可以不启用远控。
- 有任务还在运行的会话，归档前需要你明确同意。归档只是从列表中收起会话，不会停止后台工作；之后可以恢复。
- 额度查询不会使用重置卡。每次重置都需要你明确许可，并在客户端的确认界面中同意；不支持确认界面的客户端无法执行。一次使用一张对应卡片，不能挑选具体哪张。

## 让 Agent 安装或升级

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
需要重载网关时，让我只暂停 ZCode 内的移动端远控，由你在当前会话继续完成。
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
| `list_sessions` | 按项目、名称或 ID 查找会话，列出最近会话，也可以包含归档项 |
| `read_session` | 读取指定会话最近的聊天，向前翻阅更早内容 |
| `rename_session` | 将指定会话改为新的名称 |
| `start_session` | 在已打开的项目中新建会话，可选名称和模型，并交代开局任务 |
| `send_message` | 给指定会话发送信息，包括刚创建的会话 |
| `archive_session` | 归档会话；如果仍有工作在进行，先取得用户的强制归档许可 |
| `restore_session` | 将归档会话恢复到列表 |
| `get_glm_balance` | 查询 GLM 个人套餐的模型、工具额度和可用重置卡 |
| `reset_glm_quota` | 经本次用户许可和客户端确认表单，消耗一张对应卡重置 5h 或周模型额度 |

### 手动接入 MCP

需要 Node.js 24+，使用 Node 内置 SQLite，无需另装 sqlite3 命令行程序。在本插件目录安装锁定依赖：

```powershell
npm ci --ignore-scripts --no-fund --no-audit
```

同级公共层也需按公共 skill 安装依赖。注册服务前运行 `node install.mjs --check-only`，确认 Node 与 npm 依赖可用；检查失败时先补齐再继续。正常安装入口也会执行这些检查。

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

公共网关的环境变量必须配置在 Desktop 启动环境中，不能只放在 MCP 服务的 `env`。手动配置流程也以 [公共网关 skill](../suian-zcode-common/SKILL.md) 为准；当前两个 SQLite 工具可独立运行，无需远控授权链接。

默认读取当前系统用户的 `~/.zcode/v2/tasks-index.sqlite` 和 `~/.zcode/cli/db/db.sqlite`。自定义数据路径可在 args 后追加 `--index-db {{index_db_path}} --session-db {{session_db_path}}`，或设置环境变量 `ZCODE_APP_MCP_INDEX_DB`、`ZCODE_APP_MCP_SESSION_DB`。优先级是命令参数 > 环境变量 > 默认路径。

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

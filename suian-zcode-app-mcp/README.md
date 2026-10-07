# suian-zcode-app-mcp

让 ZCode 或其他 MCP 客户端查询和操作 ZCode 会话，并管理 GLM 套餐额度。**两个本机读取工具，五个会话写工具，两个 GLM 工具**。

| 工具 | 用途 |
| --- | --- |
| `list_sessions` | 最近 N 条、指定工作区或所有工作区；按标题或 ID 搜索；支持归档项和分页 |
| `read_session` | 指定会话最近消息及向前翻页；完整正文、可见消息过滤和持久化回退分支 |
| `rename_session` | 通过原 Host 改名并读回确认 |
| `start_session` | 在已打开工作区创建会话，指定可选名称和模型，提交必填开局信息 |
| `send_message` | 向指定会话提交信息，可使用刚创建的会话 ID |
| `archive_session` | 检查活跃状态；发现活跃项时须用户授权 force 才归档 |
| `restore_session` | 取消归档并确认索引状态 |
| `get_glm_balance` | 只读查询 GLM 个人套餐的模型、两组工具额度及未过期重置卡 |
| `reset_glm_quota` | 经本次用户许可和客户端确认表单，消耗一张对应卡重置 5h 或周模型额度 |

当前读取本机 SQLite 持久化历史，无需远控授权链接。结果不包含未持久化的流式字符；远端工作区正文暂不支持。设计依据、参数和读取边界见 [只读工具设计](./docs/readonly-tools.md)。

五个写工具通过公共网关调用原 Host，不直接写数据库，不另建官方 terminal。目标本地工作区必须已在网关连接的窗口打开。完整形状、来源包装、部分失败与验收见 [写工具设计](./docs/write-tools.md)。

**手机共存已实测**：本地工作区的发信、改名和固定回复读取成功，用户确认手机无需刷新或重连仍可操作。命名插件的 probe、doctor 也通过；完整 Stop Hook 命名与手机同用尚未实测。手机在远端工作区时本地请求明确让位，手机离线调用另有隔离契约覆盖。验证范围与历史失败记录见 [共存验证记录](./docs/relay-gateway-coexistence.md)。

两个 GLM 工具同样通过公共网关调用原 Host。额度查询不消耗重置卡；重置需要客户端声明并实际展示 MCP form elicitation，未支持时明确拒绝。一次只消耗一张，不能指定卡片 ID。数据口径、许可与幂等边界见 [GLM 工具契约](./docs/glm-balance-design.md)，历史一次重置对账见 [验收证据](./docs/glm-balance-evidence.json)。

## 接入

### 让 Agent 安装或升级

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
完成后分别检查插件与网关；需要我操作界面或重启时，说明保存工作、完整退出
和从正确环境重开的方法，不要自行重启 ZCode。
```

本插件的获取范围是 **MCP 目录 + 公共层 + 仓库根文件**，可以不检出命名插件。克隆命令与已有稀疏检出的扩展方式统一见 [根 README 的代码获取范围](../README.md#代码获取范围)。如果两个插件都要，可使用根 README 的组合提示词，由 Agent 询问插件选择。

[本插件 skill](./SKILL.md) 负责服务注册和验证，[公共网关 skill](../suian-zcode-common/SKILL.md) 统一负责启动、Desktop 环境变量、本地 RPC 鉴权与恢复。无需提供手机远控链接；只用两个 SQLite 工具时可独立运行。会话写验收使用经用户授权的新建测试会话，GLM 真实重置需要单独的具体授权。`node install.mjs` 幂等部署本插件 skill 到 `~/.zcode/skills/suian-zcode-app-mcp`，不会自动注册 MCP 服务。

### 手动接入 MCP

需要 Node.js 24+。在本插件目录安装锁定依赖：

```powershell
npm ci --ignore-scripts --no-fund --no-audit
```

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

## 调用示例

```json
{"name":"list_sessions","arguments":{"limit":10}}
{"name":"list_sessions","arguments":{"workspace_path":"D:/work/example","limit":20}}
{"name":"list_sessions","arguments":{"query":"MCP","include_archived":true}}
{"name":"read_session","arguments":{"session_id":"sess_example","limit":10}}
```

`list_sessions` 省略工作区即所有索引工作区，默认排除归档与删除项。使用 `next_offset` 继续列举；`read_session` 使用 `next_before_message_id` 获取更早消息。

测试命令为 `npm test`。实测与契约测试汇总见 [验收证据](./docs/readonly-tools-evidence.json)。

写工具示例与创建→发信→读回复闭环见 [写工具设计](./docs/write-tools.md)。公共配置目录非默认时，给 args 添加 `--gateway-config {{gateway_config_path}}`，指向公共 config.json；不把其中令牌复制到 MCP 配置。

查询 GLM 额度使用 `get_glm_balance({"workspace_path":"D:/work/example"})`。重置输入为 `{"workspace_path":"D:/work/example","reset_type":"FIVE_HOUR"}`，周窗口用 `WEEK`；没有用户许可和确认表单时不得调用。完整形状见 [GLM 工具契约](./docs/glm-balance-design.md)。

## 研究与许可

早期原 Host 接入研究见 [research-findings.md](./docs/research-findings.md)；同仓库 [suian-zcode-title](../suian-zcode-title/) 已实现自动命名。本版的读取能力独立运行，不加载命名插件或启动 CLI app-server。

自有代码沿用仓库 [MIT 许可](../LICENSE)。消息可见性投影库来自固定版本 ZCode，原样保留其 Apache-2.0 许可与 [来源声明](./vendor/NOTICE.md)。

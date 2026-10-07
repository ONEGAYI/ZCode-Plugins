---
name: suian-zcode-app-mcp
description: 初始化、配置和排查 ZCode 会话 MCP（suian-zcode-app-mcp），注册 stdio 服务并调用公共网关配置流程。当用户要求安装会话 MCP、查询本机会话列表或聊天历史、按工作区/标题/ID 检索会话、修复 MCP 连接时使用。首版仅提供只读工具，不发送消息、创建会话、改名或归档。
---

# ZCode 会话 MCP

工具为 `list_sessions` 与 `read_session`，读取本机 SQLite 持久化历史。初始化包括 MCP 注册、skill 部署，以及公共网关配置；读取工具本身不依赖远控授权或网关。

## 找到插件根

<!-- suian-zcode-app-mcp:plugin-root -->

`{{plugin_root}}` 按顺序确定：安装副本注入的本机插件根；当前生效的 ZCode 配置中 `mcp.servers["suian-zcode-app"].args` 的 `cli.mjs` 所在目录；用户提供的仓库位置。不要把仅有文档的技能目录当作插件根。

## 初始化与更新

1. 确认 Node.js 24+，在插件根执行 `npm ci --ignore-scripts --no-audit --no-fund`，然后 `node "{{plugin_root}}/install.mjs"`。安装器幂等部署 `~/.zcode/skills/suian-zcode-app-mcp/SKILL.md`，不自动写 MCP 配置。
2. **调用公共网关 skill**：读取已安装的 `~/.zcode/skills/suian-zcode-gateway/SKILL.md`；尚未安装时读取仓库同级 `../suian-zcode-gateway/SKILL.md`。完成其依赖安装、Status → Install → 分层验证。网关启动、用户环境变量、重启方法和恢复流程以公共 skill 为唯一来源，不在本插件复制实现。缺少公共子项目时说明仓库不完整，先补齐同一版本源码。
3. 注册本服务。默认使用用户级 `~/.zcode/cli/config.json`；用户明确要求仅当前工作区时使用该工作区 `.zcode/config.json`。先读取并解析已有文件，仅合并本服务，保留其他服务、Hook、模型配置，以及已有的数据库参数。JSON 损坏时明确报错，不覆盖整个文件。

ZCode 原生配置形状如下；`{{node_exe}}` 使用实际 Node 可执行文件的绝对路径，`{{plugin_root}}` 使用实际源码目录，推荐 `/` 分隔符。

```json
{
  "mcp": {
    "servers": {
      "suian-zcode-app": {
        "type": "stdio",
        "enabled": true,
        "command": "{{node_exe}}",
        "args": ["{{plugin_root}}/cli.mjs"]
      }
    }
  }
}
```

初始化时将本服务设为 `enabled:true`，并删除本服务旧的 `enable` 字段；其余字段保留。原生配置使用 `enabled`，兼容层接受旧 `enable`，任一残留的 false 都会停用服务，仅添加命令和参数不能解除禁用。[固定官方 schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/schema.ts#L344-L353)

仓库 `mcp.config.example.json` 的 `mcpServers` 是兼容客户端形状，不能整段贴进上述原生文件。`.agents/mcp.json` 也支持兼容形状，但同一作用域有原生 MCP 配置时优先原生配置；排障先确认实际生效的文件。[官方 MCP 文档](https://zcode.z.ai/cn/docs/mcp-services)

4. 告知用户配置完成与生效状态。公共网关的变量由 Desktop 主进程启动时读取，必须按公共 skill 的方法择时完整退出并重开。明确提醒运行中的 Agent 任务和未保存工作可能被重启中断；不要在承载配置的 ZCode 中自动退出宿主。完成用户操作后，再刷新 MCP 服务和技能列表并验证。

## 验证与使用

通过 MCP 客户端完成 `initialize` 与 `tools/list`，确认只出现 `list_sessions`、`read_session`。先调用 `list_sessions`，`limit:1`；需要验证正文时选择用户指定或列表返回的一条本机会话，调用 `read_session`，`limit:1`。CLI 持续等待 stdin 是 stdio 的正常行为，不能以“进程没报错”代替握手成功。

- 最近会话：`list_sessions({"limit":10})`。
- 工作区过滤：`list_sessions({"workspace_path":"D:/work/example","limit":20})`。
- 标题或 ID 检索：`list_sessions({"query":"MCP","include_archived":true})`；不指定工作区即检索全部索引工作区。
- 消息正文：`read_session({"session_id":"sess_example","limit":10})`；只用实际查得的标识，不把标题当 ID。
- 翻页：列表使用 `next_offset`，聊天使用 `next_before_message_id`，作为下一次请求相应参数。

完整字段、默认值、响应例子和错误契约见插件根 `docs/readonly-tools.md`，按需读取。不要在 skill 中维护第二份接口定义。

## 排障与配置边界

默认数据库为 `~/.zcode/v2/tasks-index.sqlite` 与 `~/.zcode/cli/db/db.sqlite`。只有用户的数据目录确实不同才添加 `--index-db {{index_db}} --session-db {{session_db}}`，或设置本服务 `env` 中的 `ZCODE_APP_MCP_INDEX_DB`、`ZCODE_APP_MCP_SESSION_DB`；命令参数优先于环境变量和默认路径。保留已配置的有效自定义路径。

数据库缺失、schema 不兼容、远端工作区正文不支持等错误照实汇报，不创建空库或直接写会话表。未持久化的流式字符不属于当前读取能力；不要把历史查询成功描述为实时 app-server 控制已接入。

网关排障交给公共 skill。不要把 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 放进 MCP 的 `env`，那不能改变 Desktop 的连接。不要为只读工具索取远控凭据或启动另一个 CLI app-server。

卸载本服务时只移除自己的 MCP 条目与部署 skill；其他服务及 Hook 保留。公共网关同时服务命名插件，只有用户明确要求一并移除时才调用公共 Remove 流程。

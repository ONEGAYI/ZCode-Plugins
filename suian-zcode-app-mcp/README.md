# suian-zcode-app-mcp

让 ZCode 或其他 MCP 客户端查询本机 ZCode 会话。**首版提供两个只读工具：列出会话、读取聊天消息**。

| 工具 | 用途 |
| --- | --- |
| `list_sessions` | 最近 N 条、指定工作区或所有工作区；按标题或 ID 搜索；支持归档项和分页 |
| `read_session` | 指定会话最近消息及向前翻页；完整正文、可见消息过滤和持久化回退分支 |

当前读取本机 SQLite 持久化历史，无需远控授权链接。结果不包含未持久化的流式字符；远端工作区正文暂不支持。设计依据、参数和读取边界见 [只读工具设计](./docs/readonly-tools.md)。

## 接入

### 让 Agent 初始化

将完整仓库克隆到本机后，告诉 ZCode：

```text
帮我初始化 suian-zcode-app-mcp。仓库在 D:/path/to/ZCode-Plugins。
请读取 suian-zcode-app-mcp/SKILL.md，完成 MCP 与公共网关配置。
完成后提醒我先处理运行中的任务并保存工作，再按公共 skill 的方法完整退出重开，验证生效。
```

[本插件 skill](./SKILL.md) 负责服务注册与只读验证，[公共网关 skill](../suian-zcode-gateway/SKILL.md) 统一负责启动、Desktop 环境变量和恢复。`node install.mjs` 幂等部署本插件 skill 到 `~/.zcode/skills/suian-zcode-app-mcp`；该命令不会自动注册 MCP 服务。

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

公共网关的环境变量必须配置在 Desktop 启动环境中，不能只放在 MCP 服务的 `env`。手动配置流程也以 [公共网关 skill](../suian-zcode-gateway/SKILL.md) 为准；当前两个 SQLite 工具可独立运行，无需远控授权链接。

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

## 研究与许可

早期原 Host 接入研究见 [research-findings.md](./docs/research-findings.md)；同仓库 [suian-zcode-title](../suian-zcode-title/) 已实现自动命名。本版的读取能力独立运行，不加载命名插件或启动 CLI app-server。

自有代码沿用仓库 [MIT 许可](../LICENSE)。消息可见性投影库来自固定版本 ZCode，原样保留其 Apache-2.0 许可与 [来源声明](./vendor/NOTICE.md)。

给 ZCode 做的插件集合。ZCode 是智谱推出的 Agentic Coding 工具（桌面端 + CLI），这个仓库放会话自动命名插件与只读会话 MCP。

## suian-zcode-title — 会话自动命名（可用）

每轮对话结束后，自动把会话标题更新成「类别 emoji + 对象｜目标」，会话再多也一眼能找到：

| 原来的标题 | 自动命名后 |
| --- | --- |
| C:/Users/…/handoff-zcode-title-202610…（被截断的临时文件路径） | 🧩 远控 Hook 插件｜授权失效排查 |
| 帮我看看这个报错 | 🧪 发布流水线｜超时排查 |

它通过 ZCode 官方的 Web 远控通道连接当前窗口，用你自己账号里的模型生成标题，不往对话里插消息，也不直接改数据库；标题会跟随工作主线缓慢更新，手动改过的标题不会再被覆盖。安装时把一段话粘给 ZCode 就行，详见 [suian-zcode-title/README.md](./suian-zcode-title/README.md)。

## suian-zcode-app-mcp — 会话 MCP（只读首版）

通过两个只读工具列出本机 ZCode 会话、按工作区或标题/ID 检索，并查看指定会话的聊天消息。首版读取 SQLite 持久化历史，通过 stdio 接入 MCP 客户端；发送消息、创建与状态管理留待后续。接入与边界见 [suian-zcode-app-mcp](./suian-zcode-app-mcp/)。

## 找到你想要的

- **直接用自动命名** → [suian-zcode-title](./suian-zcode-title/)，README 里有「让 ZCode 帮你安装」的一段话
- **了解实现**（远控协议、Stop Hook、探活分层）→ [suian-zcode-title/AGENTS.md](./suian-zcode-title/AGENTS.md) 的技术参考
- **做会话操控 / MCP** → [research-findings.md](./suian-zcode-app-mcp/docs/research-findings.md)，含已核实能力表与首批工具设计
- **读 ZCode 源码** → [sources/](./sources/)，官方公开快照与社区桥接项目，submodule 引用、按需获取

```bash
git clone --recurse-submodules https://github.com/ONEGAYI/ZCode-Plugins.git
# 不加 --recurse-submodules 时，sources 为空目录，按 sources/README.md 按需拉取
```

## 许可证

自有代码以 [MIT](./LICENSE) 发布；`vendor/` 与 `sources/` 内的第三方代码保留其原始许可与来源声明（见各目录 NOTICE）。

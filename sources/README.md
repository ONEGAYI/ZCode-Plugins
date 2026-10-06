# sources — 上游源码引用（submodule）

研究用的第三方仓库，以 git submodule 引用固定提交，**不入库源码、只读、不 fork、不修改**。

| 路径 | 上游 | 钉定提交 | 用途 |
|------|------|----------|------|
| `official-zcode/` | [zai-org/ZCode](https://github.com/zai-org/ZCode) | `29628c9`（v3.14.3 公开快照） | ZCode 官方源码：hooks、协议、Runtime、app-server |
| `zcode-open-bridge/` | [tizerluo/zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) | `e8bd9bc` | 社区 MCP/ACP 桥接参考：它启动自己的 app-server，不接管桌面已有会话 |

克隆主仓库后按需获取：

```bash
git submodule update --init sources/official-zcode
git submodule update --init sources/zcode-open-bridge
```

注意：官方公开快照与本机发行版（3.14.4）不是同一版本，NOTICE 对公开范围有限制；结论引用见 `suian-zcode-app-mcp/docs/research-findings.md` 的源码依据一节。

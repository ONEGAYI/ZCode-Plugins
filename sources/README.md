# sources — 上游源码引用（submodule）

研究用的第三方仓库，以 git submodule 引用固定提交，**不入库源码、只读、不 fork、不修改**。

| 路径 | 上游 | 钉定提交 | 用途 |
|------|------|----------|------|
| `official-zcode/` | [zai-org/ZCode](https://github.com/zai-org/ZCode) | [`a4b44451`](https://github.com/zai-org/ZCode/commit/a4b4445141eb7d3b3e99eada9292775383bfc44e)（2026-11-23 源码快照，package.json 版本 4.0.0） | ZCode 官方源码：hooks、协议、Runtime、app-server、插件 UI（MCP Apps） |
| `zcode-open-bridge/` | [tizerluo/zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) | `e8bd9bc` | 社区 MCP/ACP 桥接参考：它启动自己的 app-server，不接管桌面已有会话 |

克隆主仓库后按需获取：

```bash
git submodule update --init sources/official-zcode
git submodule update --init sources/zcode-open-bridge
```

## 快照与验证记录

本页只记录仓库钉定的研究输入，不追踪本机安装版本或上游发布进度。源码快照与发行包是不同对象；补丁兼容性以具体包的适配档案及验证记录为准。公开源码范围见上游 `NOTICE.md`。

- [4.0.0 源码增量与业务影响](../suian-zcode-app-mcp/docs/zcode-4.0-source-audit.md)
- [3.18.2 源码增量与业务影响](../suian-zcode-app-mcp/docs/zcode-3.18-source-audit.md#3182-增量核查)
- [多工作区的 AGENTS 加载规则](../suian-zcode-app-mcp/docs/zcode-3.18-source-audit.md#多工作区不会自动汇总全部-agents)
- [local-only 适配档案与验证入口](../suian-zcode-app-mcp/docs/local-only-routing-spec.md)、[Windows 3.18.2 发行包适配证据](../suian-zcode-app-mcp/docs/local-only/16-windows-3.18.2-candidate.md)
- [历史网关协议验证](../suian-zcode-app-mcp/docs/zcode-3.16-gateway-validation.md)、[早期源码研究](../suian-zcode-app-mcp/docs/research-findings.md)

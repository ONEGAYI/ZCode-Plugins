# sources — 上游源码引用（submodule）

研究用的第三方仓库，以 git submodule 引用固定提交，**不入库源码、只读、不 fork、不修改**。

| 路径 | 上游 | 钉定提交 | 用途 |
|------|------|----------|------|
| `official-zcode/` | [zai-org/ZCode](https://github.com/zai-org/ZCode) | `c590468`（2026-11-12，v3.18.1 公开源码快照） | ZCode 官方源码：hooks、协议、Runtime、app-server、插件 UI（MCP Apps） |
| `zcode-open-bridge/` | [tizerluo/zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) | `e8bd9bc` | 社区 MCP/ACP 桥接参考：它启动自己的 app-server，不接管桌面已有会话 |

克隆主仓库后按需获取：

```bash
git submodule update --init sources/official-zcode
git submodule update --init sources/zcode-open-bridge
```

2026-11-11 将锚点从公开 tag [v3.17.1](https://github.com/zai-org/ZCode/tree/v3.17.1) 更新到官方主分支的 [v3.18.0 源码同步提交 `b95ebaf`](https://github.com/zai-org/ZCode/commit/b95ebaffeab641907b38652f45c1502bd762972d)，中间经过公开 tag [v3.17.2](https://github.com/zai-org/ZCode/tree/v3.17.2)。核对时 GitHub 未发布 v3.18.0 tag 或 Release。工作树的使用和插件兼容性见 [3.18.0 源码审计](../suian-zcode-app-mcp/docs/zcode-3.18-source-audit.md)。上游 NOTICE 对公开范围有限制。

2026-11-12 更新到官方主分支的 [v3.18.1 源码同步提交 `c590468`](https://github.com/zai-org/ZCode/commit/c5904686ea8341826b3affe5d993d06a134fa779)，直接承接 `b95ebaf`。已核对[插件业务影响](../suian-zcode-app-mcp/docs/zcode-3.18-source-audit.md#3181-增量核查)。

Windows 安装包与公开源码分别核对。local-only 补丁以安装包自身的编译产物为准，见 [3.18.2.10443 适配记录](../suian-zcode-app-mcp/docs/local-only/16-windows-3.18.2-candidate.md)、[3.18.1.10376 适配记录](../suian-zcode-app-mcp/docs/local-only/15-windows-3.18.1-candidate.md)和 [3.18.0.10300 适配记录](../suian-zcode-app-mcp/docs/local-only/14-windows-3.18.0-candidate.md)。历史网关与侧栏 #73 的证据见 [3.16 网关验证记录](../suian-zcode-app-mcp/docs/zcode-3.16-gateway-validation.md)；其他历史源码依据见 [研究记录](../suian-zcode-app-mcp/docs/research-findings.md)。

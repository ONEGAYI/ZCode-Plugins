# sources — 上游源码引用（submodule）

研究用的第三方仓库，以 git submodule 引用固定提交，**不入库源码、只读、不 fork、不修改**。

| 路径 | 上游 | 钉定提交 | 用途 |
|------|------|----------|------|
| `official-zcode/` | [zai-org/ZCode](https://github.com/zai-org/ZCode) | `a60ba6a7`（2026-10-30 快照，即公开 tag v3.17.1，包含 Relay V2 与自动轮 CronPauseSelf） | ZCode 官方源码：hooks、协议、Runtime、app-server、插件 UI（MCP Apps） |
| `zcode-open-bridge/` | [tizerluo/zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) | `e8bd9bc` | 社区 MCP/ACP 桥接参考：它启动自己的 app-server，不接管桌面已有会话 |

克隆主仓库后按需获取：

```bash
git submodule update --init sources/official-zcode
git submodule update --init sources/zcode-open-bridge
```

上游于 2026-10-30 再次同步主分支，[`a60ba6a7`](https://github.com/zai-org/ZCode/commit/a60ba6a7e5a06742270ca605f5d2cc2766afa7e1)（package.json 自报 3.17.1）同时打上公开 tag v3.17.1，本次钉定即发布线。相较 10-20 快照（3c5b2276）新增自动轮自暂停工具 CronPauseSelf（`turn-tool-visibility.ts` 对自动轮豁免注入，`permission/service.ts` 按工具名预批；仅自动轮可用、只暂停触发本次运行的任务自身、不能恢复）。快照仍包含 Relay V2、侧栏完整视图与插件页面收起滞留的修复（本仓库 #73：`PluginUiCard` 收起时同步解绑锚点，`pluginUiPagePlane` 候选过滤强化）。NOTICE 对公开范围有限制。

本机安装已升级至 3.17.2.9661（2026-11-02；该版本源码尚未公开同步，锚点仍钉 v3.17.1，适配档案与字节级核对见[3.17.2 适配记录](../suian-zcode-app-mcp/docs/local-only/13-windows-3.17.2-candidate.md)）；#73 滞留缺陷已随 3.16 修复并验收关闭，3.16.1 便携运行包采用独立数据目录验证。新协议、网关实验和验证范围见[3.16 网关验证记录](../suian-zcode-app-mcp/docs/zcode-3.16-gateway-validation.md)。历史源码依据见 `suian-zcode-app-mcp/docs/research-findings.md`。

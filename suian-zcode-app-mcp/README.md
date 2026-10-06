# suian-zcode-app-mcp

ZCode 会话操控 MCP 服务，目前为待开发的空壳。

目标是不 fork、不修改 ZCode 源码，做一层独立的 MCP，让外部 Agent 通过官方 Web 远控通道接入**已经开着**的 ZCode 桌面窗口：列出会话、读取历史、派生任务、改名与状态管理。同仓库的 [suian-zcode-title](../suian-zcode-title/) 是这条路线上率先落地的第一个能力（Stop 后自动命名），它的远控连接、探活与改名调用已经过真实验证。

## 现状

- 立项依据与已核实能力清单见 [docs/research-findings.md](./docs/research-findings.md)（源码研究结论总览，随 suian-zcode-title/docs/notes/ 一起维护）。
- 上游源码以 submodule 引用在 [../sources/](../sources/)，不入库、不修改。
- 命名相关的协议实现（relay 认证、bridge、Channel RPC、probe）可直接复用 suian-zcode-title 的 `remote.mjs` 与 `vendor/`。

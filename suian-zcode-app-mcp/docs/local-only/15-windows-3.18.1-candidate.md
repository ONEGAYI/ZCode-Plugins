# Windows 3.18.1.10376 local-only 适配

2026-11-12 核对。新增档案 `windows-3.18.1.10376-1af9cdd8`，独立补丁修订号 1。setup 沿用统一 CLI 选档案并现场生成候选；五份旧档案保留。基线为 `dev` 的 `83e20ce`，官方源码锚点仍为 `b95ebaf`（3.18.0）。

## 包身份与注入

- 来源：已安装的 Windows 原版运行包，只读核对，无旧补丁状态、备份或注入标记。
- exe FileVersion 为 `3.18.1.10376`，asar 内的 `package.json` 版本为 `3.18.1`，主入口为 `out/main/index.js`。
- 原版 `app.asar`：384827497 字节；SHA-256 `1af9cdd891f6ba3436bf289b387314819cefdf09aa49ec736694c24e8000eae4`。Electron fuse wire 为 `101000011`，asar 完整性检查关闭；不修改 exe。
- 候选 `app.asar`：384830054 字节；SHA-256 `dfd8f3c448a37af84313dcc9945607bb9a3280f26bb98c74cc666f7d3f95d84c`。

| 注入 | 3.18.1 编译产物核对 |
| --- | --- |
| P0 文件导入 | 原入口为 ESM；新增绑定未与现有标识符冲突。 |
| P1 开关与地址 | `M_` / `O_` 的声明以分号结束。manager 构造和 `getEndpointUrls` 都从 `M_` 读取 WS 覆盖；解析器 `ud`（`chunk-L5OJRMFK.js` 中的 `e3`）直接采用非空覆盖。开模式最终地址只接受回环。 |
| P2 登录 | `getLogin` 从 `w4` / `y4` 获取登录上下文；仅开模式短路。 |
| P3、P4 设备与 token | 每会话连接仍注册 `resolveDeviceSid` 和 `getToken`；分别跳过 `cd` 注册与 `m(jn, At, …ad.token)` 令牌请求。 |
| P5 登出事件 | 仅开模式忽略非 `signed-in` 事件，保留关模式的原撤销路径。 |
| P6 自动启动 | 在 `Mg.current=Gt;` 后插入；`Ge()` 过滤 CUA 指示窗，`Gt` 仅在 idle 时启动。 |

## 验证

| 检查 | 结果 |
| --- | --- |
| 自动路由与旧包 | 新测试先红；local-only 76 项通过，覆盖新包身份、错误摘要拒绝、旧包路由与状态。setup 与构建相关 9 项通过。 |
| 候选与发布目录 | 六处替换锚点均唯一命中；两次 prepare 的候选 asar 摘要一致；候选入口通过 `node --check`。common 构建产物包含六份档案，独立 CLI 可只读识别日常原版安装。 |
| 隔离副本 | apply 后识别为 patched；验收结束后 restore，读回摘要与原版一致。 |
| 隔离宿主 | 未登录账号，Chromium 代理指向不可用的本地端口；使用标志文件自动连到专用 local-only 网关，网关未连接官方上游。通过真实 stdio MCP 创建会话、续发消息，并从历史读回两轮输入和本地模拟模型回复。 |

未验证网关重启后的自动恢复、在线 relay 或日常安装上的应用。本轮未修改日常安装包。过程日志保留在忽略目录 `.scratch/patch-3181/`。

# Windows 3.19.0.10774 local-only 适配

2026-11-19 核对。新增档案 `windows-3.19.0.10774-24218509`，独立补丁修订号 1。setup 沿用实际包身份自动路由，原七份档案保留。开发基线为 `441359f`；本次注入依据是 3.19.0 Windows 发行包。

## 包身份与注入

- 来源：本机已安装的 Windows x64 原版运行包。未发现旧补丁状态、原版备份或入口注入标记。
- exe FileVersion 为 `3.19.0.10774`，asar 内 `package.json` 版本为 `3.19.0`，ESM 入口为 `out/main/index.js`。
- 原版 `app.asar`：385171742 字节，SHA-256 `2421850970f361aaa1b3f1d6c960b101a5d476ad95631359d0413a19de1197cb`。Electron fuse wire 为 `101000011`，asar 完整性检查关闭。
- 候选 `app.asar`：385174162 字节，SHA-256 `53fcfb22e1b7b4e8a73a7dd8454bfa007d0f8601e15c6d7a69cb63f898fe5d4d`。

| 注入 | 3.19.0 编译产物核对 |
| --- | --- |
| P0 文件导入 | ESM 入口新增标志文件读取绑定，无同名冲突。 |
| P1 开关与地址 | `pM` / `mM` 的声明以分号结束。manager 构造和 `getEndpointUrls` 都用 `pM` 作为 WS 覆盖；`Sd`（`chunk-2FJIZ7ZZ.js` 内的 `y3`）直接采用非空覆盖。local-only 模式只接受回环地址。 |
| P2 登录 | manager 的 `getLogin` 原版通过 `x5` / `_5` 取得登录上下文；local-only 用仅供本机链路的占位值。 |
| P3、P4 设备与 token | 两个回调都在每会话连接选项内。local-only 不调用 `wd` 注册设备，也不调用 `hd.token` 请求官方令牌。 |
| P5 账号事件 | `notifyAuthStateChanged(h,b)` 在 local-only 模式隔离非 `signed-in` 通知，避免撤销本地链路；关闭模式时保留原体。 |
| P6 自动启动 | 在 `zg.current=zt;` 后插入。直接用已确认的 `Ke()` 查找未销毁、且不是 CUA 指示窗的应用窗口；`zt` 仅在该窗口 idle 时启动。 |

## 验证

| 检查 | 结果 |
| --- | --- |
| 路由、构建与 setup | 精确身份用例先因未登记而失败。登记后 local-only 与发布构建合计 90 项通过，setup 相关 5 项通过；修正本地占位 token 字符表后，新档案 4 项定向用例通过。最终发布目录可独立识别本机原包。 |
| 候选与语法 | 六处替换锚点唯一命中；两次 prepare 产出相同 asar 摘要；完整候选入口通过 `node --check`。入口之外 31945 个打包文件字节不变，17 个 unpacked 条目元数据不变。 |
| 隔离副本 | `apply` 后识别为 patched；停止副本后 `restore` 恢复原版摘要，备份与状态无残留。exe 与 17 个 unpacked 文件的实际字节不变。 |
| 冷启动与断线恢复 | 全新数据根、无 ZCode 登录，Chromium 代理指向未监听端口。回环网关冷启动和重启后均观察到 Desktop 已连接、已就绪、未连接上游；两次原 Host 工作区探测均通过。 |
| stdio MCP | 实际发布入口注册 20 个工具，`list_sessions` 成功读取隔离工作区的空会话列表。 |

宿主 TCP 快照还观察到 5 条 TUN 地址连接，无法据此识别目标域名；网关的本地链路成立，不等于整个宿主没有外连。未执行 MCP 写工具端到端、补丁关闭后的原生 relay、在线手机远控或日常安装应用。副本启动改写的 Windows 协议与右键菜单注册项已恢复到原值。

回归日志与退出码位于忽略目录 `.scratch/patch-319/`；最终候选与原生验证的日志在其 `final/` 子目录。原版与候选字节不入库。

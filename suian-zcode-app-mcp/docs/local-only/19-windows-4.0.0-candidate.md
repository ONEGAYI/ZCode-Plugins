# Windows 4.0.0.10870 local-only 适配

2026-11-23 核对，开发基线 `ecaf159`（树内容与 dev 的 `de41e3a` 一致）。新增档案 `windows-4.0.0.10870-99f33f89`，独立补丁修订号 1。setup 按实际包身份自动选档，原九份档案保留。

## 包身份

- 来源：本机 Windows x64 安装的原版运行包。未发现补丁状态、原版备份或入口注入标记。
- exe FileVersion：`4.0.0.10870`；asar 内的 `package.json` 版本为 `4.0.0`，ESM 入口为 `out/main/index.js`。
- 原版 `app.asar`：385203576 字节，SHA-256 `99f33f89fa570458d39bd56bd6f0fb84b9822d321f43a2c65ba5b1241f4253a6`。Electron fuse wire 为 `101000011`，asar 完整性检查关闭，补丁不修改 exe。
- 候选 `app.asar`：385205996 字节，SHA-256 `95c09548bea06d92d8167b66c9a9c63c3cb92496a6befbb25e192cca01e90b78`。

## 注入点核对

| 注入 | 本包入口中的语义 |
| --- | --- |
| P0、P1 文件导入与模式 | 新增的导入和开关标识无同名冲突。原版在 manager 构造和 `getEndpointUrls` 中均以 `mM` 作为 relay WS 覆盖值；解析器 `vd`（`chunk-IERSWOXK.js` 中的 `b3`，导出名 `ka`）直接采用非空覆盖。本地模式只接受回环地址，关闭时保留原覆盖。 |
| P2 登录 | manager 的 `getLogin` 仍经 `_5` / `M5` 获取登录上下文；本地模式只使用回环专用占位值。 |
| P3、P4 设备与 token | 两个回调仍位于每会话连接选项中。设备注册调用为 `yd`，令牌请求为 `bd.token`；本地模式不执行这两个官方请求。 |
| P5 账号事件 | `notifyAuthStateChanged(h,b)` 方法入口未变。本地模式不因非 `signed-in` 通知撤销连接；关闭时保留原路径。 |
| P6 自动启动 | 以 `jg.current=zt;` 作为挂接后的语句边界，位于 `zt.startNotifications()` 前。窗口函数 `Ke()` 排除已销毁和 CUA 指示窗，只在选中窗口空闲时调用 manager 启动。 |

相对 3.19.1 的压缩名位移如下，这些名字只属于本包的字节身份：

- relay WS 覆盖值 `pM` 变为 `mM`，URL 覆盖值 `mM` 变为 `fM`
- `getLogin` 内部调用 `x5` / `_5` 变为 `_5` / `M5`
- 设备注册 `bd` 变为 `yd`，令牌客户端 `wd` 变为 `bd`
- 挂接容器 `Vg` 变为 `jg`，relay 解析器 `Cd` 变为 `vd`
- manager 变量 `zt`、窗口函数 `Ke` 与 P5 方法入口未变

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 路由与发布目录 | 精确身份用例先因未登记而失败；登记后 local-only 相关 90 项、发布构建 8 项、setup 的 local-only 用例 4 项通过。公共包的独立发布目录含全部十份档案，运行其 CLI 可只读识别新原包。 |
| 真实候选 | 六处替换锚点均唯一命中；源码 CLI 两次与发布目录 CLI 一次共三次准备，所得 asar 逐字节相同；完整候选入口通过 `node --check`。入口外 31945 个打包文件字节不变，17 个 unpacked 条目的元数据不变。 |
| 真实包副本 | 发布目录 CLI 在副本上完成 `apply → status → 重复 apply → restore → status`。状态从 `original` 到 `patched` 再回到 `original`，重复应用未写入；还原后的 asar 与原包逐字节一致，exe 和 17 个 unpacked 文件不变，无补丁状态或备份残留。 |

**验收边界**：本档案仍为适配候选。未启动 4.0.0 隔离宿主验证无登录冷启动、网关重连、MCP 往返或关闭补丁后的原生 relay；日常安装未写入。日志及退出码保留在忽略目录 `.scratch/patch-400/`。原包、副本和候选字节不入库。

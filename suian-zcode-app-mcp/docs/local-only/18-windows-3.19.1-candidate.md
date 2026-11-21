# Windows 3.19.1.10833 local-only 适配

2026-11-21 核对，开发基线 `2ed0150`。新增档案 `windows-3.19.1.10833-f9186044`，独立补丁修订号 1。setup 按实际包身份自动选档，原八份档案保留。

## 包身份

- 来源：本机 Windows x64 安装的原版运行包。未发现补丁状态、原版备份或入口注入标记。
- exe FileVersion：`3.19.1.10833`；asar 内的 `package.json` 版本为 `3.19.1`，ESM 入口为 `out/main/index.js`。
- 原版 `app.asar`：385193027 字节，SHA-256 `f9186044ab9220a2a50376e067eade1e4fef18e6d5c07b1483d1f6ca894ce41a`。Electron fuse wire 为 `101000011`，asar 完整性检查关闭，补丁不修改 exe。
- 候选 `app.asar`：385195447 字节，SHA-256 `40f0fb3f0f063c6e4f892ea6e239add381da6227479532672bdf1ced885d6827`。

## 注入点核对

| 注入 | 本包入口中的语义 |
| --- | --- |
| P0、P1 文件导入与模式 | 新增的导入和开关标识无同名冲突。原版在 manager 构造和 `getEndpointUrls` 中均以 `pM` 作为 relay WS 覆盖值；解析器 `Cd`（`chunk-PD4GOPHK.js` 中的 `y3`）直接采用非空覆盖。本地模式只接受回环地址，关闭时保留原覆盖。 |
| P2 登录 | manager 的 `getLogin` 仍经 `x5` / `_5` 获取登录上下文；本地模式只使用回环专用占位值。 |
| P3、P4 设备与 token | 两个回调仍位于每会话连接选项中。设备注册调用改为 `bd`，令牌请求改为 `wd.token`；本地模式不执行这两个官方请求。 |
| P5 账号事件 | `notifyAuthStateChanged(h,b)` 方法入口未变。本地模式不因非 `signed-in` 通知撤销连接；关闭时保留原路径。 |
| P6 自动启动 | 以 `Vg.current=zt;` 作为挂接后的语句边界，位于 `zt.startNotifications()` 前。窗口函数 `Ke()` 排除已销毁和 CUA 指示窗，只在选中窗口空闲时调用 manager 启动。 |

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 路由与发布目录 | 精确身份用例先因未登记而失败；登记后 local-only 与发布构建 94 项通过，setup 的 local-only 用例 4 项通过。公共包的独立发布目录含全部九份档案，运行其 CLI 可只读识别新原包。 |
| 真实候选 | 六处替换锚点均唯一命中，两次准备所得 asar 逐字节相同，完整候选入口通过 `node --check`。入口外 31945 个打包文件字节不变，17 个 unpacked 条目的元数据不变。 |
| 真实包副本 | 发布目录 CLI 在副本上完成 `apply → status → restore → status`。状态从 `patched` 回到 `original`，还原后的 asar 与原包逐字节一致；exe 和 17 个 unpacked 文件不变，无补丁状态或备份残留。 |

**验收边界**：本档案仍为适配候选。未启动 3.19.1 隔离宿主验证无登录冷启动、网关重连、MCP 往返或关闭补丁后的原生 relay；日常安装未写入。日志及退出码保留在忽略目录 `.scratch/patch-3191/`。原包、副本和候选字节不入库。

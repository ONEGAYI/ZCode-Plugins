# Windows 3.18.0.10300 随包适配档案

日期：2026-11-11 提取、同日核对登记。状态：仓库已追加自动路由档案；原生运行验收未执行。

基线：origin/dev `e9113d9`；变更在独立工作树分支 `feat/3.18-localonly-profile`。

交付为公共插件 `local-only/profiles/windows-3.18.0.10300.mjs` 及 `profiles.mjs` 注册项，不分发完整宿主包或独立补丁 ZIP。沿用 setup 的 status → prepare 流程，按本机 exe 版本和原版 asar 摘要自动选择档案、现场生成候选；退出宿主后执行 setup 生成的外部应用命令。发布构建自动收集 profiles 目录，无须在 setup 增加版本分支。

## 包身份

- exe FileVersion：`3.18.0.10300`
- 原版 app.asar：384813639 字节，SHA-256 `dea4826e24415540f196a5f89c5d5a9a12754604b07601d3a9bd377203bd3f72`
- 入口：package.json main 实测仍为 `out/main/index.js`（895001 字节，SHA-256 `a997024c79fd4c75f321d23381369baa054ded93ff14bd7b2daa1b0bcd692654`；无 `__LO_MODE`/`local-only.flag` 注入痕迹，确认原版）
- fuses：sentinel 命中，wire `101000011`，asar 完整性校验 DISABLE（替换可行）
- 档案：`windows-3.18.0.10300-dea4826e`，独立补丁修订号 1
- 候选 app.asar：384816192 字节，SHA-256 `a84eb3f3d7ecb4b243f00a4a0122b6d3a8ccc650cc3b094e71c28af578a3c7f1`

## 适配与验证

六处替换锚点均按新包逐一核对，精确且唯一命中；另保留文件首部导入。3.17.2 → 3.18.0 变量映射：relay WS 覆盖 `kx→I_`、URL 覆盖 `Ix→E_`、getLogin 内部 `S3/C3→i4/a4`、getToken 单飞源与令牌客户端 `Vn/$l→Kn/sd`、设备注册与设备标识变量 `Hl/He→id/je`、会话映射 `me→ye`、P5 回调参数 `b/D→y/_`；manager `Bt→Gt`、挂接容器 `rg→xg`、排除 CUA 指示窗的窗口列表函数 `Ne→Ge`。

relay URL 解析器由 `Vl`（chunk-U3DZ6DPO.js）换为 `ld`（= chunk-GMTOLIE6.js 的 `HJ`，`resolveWebRemoteControlRelayWsUrl`）。新实现为：`overrideUrl` trim 后非空即整体返回，无协议校验；为空才以 `endpointOrigin` 拼 `/api/v1/remote/ws2` 构造。直用语义与 3.17.2 一致，覆盖在关闭开关时原样保留、开启时改写为回环网关 WS。WS 覆盖消费点两处（`getEndpointUrls` 回调闭包、构造期 `relayWsUrl:ld({endpointOrigin:Me,overrideUrl:I_})`）均在注入点之后求值，读到改写后的回环值。

getToken/resolveDeviceSid 仍注册在每会话 V2 relay 客户端连接 options（`v({relayWsUrl:Ce,...})`，编译产物字面量唯一），短路守卫语义不变；内部单飞包装 `m(Kn,At,()=>sd.token(...))` 短路后不执行。P6 自动启动语义不变：`start` 内部先 `me(h,"restart")` 再排查登录，`getStatus` 非 idle 即停以避免叠加 runtime；`featureGate.assertEnabled()` 由 `wR()` 默认 `e=!0` 恒真，本地网关不改变该闸门。产物内无 `__LO_MODE`、`__LO_WS`、`__LO_TOKEN`、`__loApp`、`__loBW`、`__loExists`、`__loRead` 同名标识符，注入名无冲突。旧档案及其字节保持不变。

## 检查范围与结果

| 检查 | 结果 | 留证 |
| --- | --- | --- |
| 新档案测试先红 | 档案模块缺失 `ERR_MODULE_NOT_FOUND`，如预期失败 | `.scratch/3.18/tests-red.log` |
| 新档案测试转绿 | 2/2，退出码 0 | `.scratch/3.18/tests-3180.log` |
| local-only 全组回归（routing/patch/lifecycle/3.16.3/3.17.1/3.17.2/3.18.0/lab） | 73/73，退出码 0 | `.scratch/3.18/tests-local-only.log` |
| setup 与发布构建 | 65/65，退出码 0 | `.scratch/3.18/tests-setup-release.log` |
| 真实包只读 status（源码 CLI） | 命中 `windows-3.18.0.10300-dea4826e`，`patchState=original`，fuse 不阻断 | `.scratch/3.18/status.log` |
| 候选确定性与语法 | 两次 prepare 摘要一致 `a84eb3f3…`；提取候选入口 897590 字节，`node --check` 退出码 0 | `prepare-a.log`、`prepare-b.log`、`.scratch/3.18/candidate-a/index.js` |
| 实际包副本生命周期 | apply → status(patched) → restore，恢复摘要等于原版；写入面仅 app.asar、同目录 `.lo02bak` 与 `.lo02state.json` | `copy-apply.log`、`copy-status.log`、`copy-restore.log` |
| 发布目录独立路由 | 构建通过；`release.json` 含 9 个 local-only 文件与全部五份档案；发布目录 CLI 只读 status 命中新档案 | `build-release.log`、`release-status.log` |

`npm ci` 安装 esbuild 与 ws 仅用于本次发布目录构建（源码开发用途）。

## 未验项目

本轮未应用到用户日常宿主，未运行隔离 lab 原生包。尚未完成 3.18 无登录冷启动、官方远控不可达、网关重启恢复与 MCP 闭环；Electron/Chromium 精确版本静态证据链未定。以上静态、路由、候选、副本与发布目录验证不能替代原生运行验收，**本档案应视为适配候选，不宣称 3.18 已完成正式兼容验收**。

可复核日志位于独立工作树忽略目录 `.scratch/3.18/`；验证用包副本、候选与发布目录构建产物在收尾时清理，均不入库。

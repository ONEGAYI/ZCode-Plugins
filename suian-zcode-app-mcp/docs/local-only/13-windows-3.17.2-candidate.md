# Windows 3.17.2 随包适配档案

日期：2026-11-02 提取、同日核对登记。状态：仓库已追加自动路由档案，原生运行验收待完成。

基线：origin/dev `ee1a0f3`；变更在独立工作树分支 `feat/3.17.2-localonly-profile`。

交付为公共插件 `local-only/profiles/windows-3.17.2.9661.mjs` 及 `profiles.mjs` 注册项，不分发完整宿主包或独立补丁 ZIP。沿用 setup 的 status → prepare 流程，按本机 exe 版本和原版 asar 摘要自动选择档案、现场生成候选；退出宿主后执行 setup 生成的外部应用命令。发布构建自动收集 profiles 目录，无须在 setup 增加版本分支。

版本背景：上游 GitHub 源码尚未同步 3.17.2（主分支与最新公开 tag 均为 v3.17.1，钉定锚点 `a60ba6a7` 不变）；本机安装已先于源码更新至 3.17.2.9661，锚点语义解释基于 v3.17.1 源码与 3.17.2 编译产物字节逐一对照完成。

## 包身份

- exe FileVersion：`3.17.2.9661`
- 原版 app.asar：374653670 字节，SHA-256 `b11a6bc5bb957af5b735701d94452ec6c3119a5d957fb772eb40a3cc94bcb24c`
- 入口：package.json main 实测仍为 `out/main/index.js`（869048 字节；无 `__LO_MODE`/`local-only.flag` 注入痕迹，确认原版）
- fuses：sentinel 命中，wire `101000011`，asar 完整性校验 DISABLE（替换可行）
- 档案：`windows-3.17.2.9661-b11a6bc5`，独立补丁修订号 1
- 候选 app.asar：374656239 字节，SHA-256 `ce7ab57cce9d53c58b66b48a4ad43cce497189b568a40e3d6b8cf8588864e59c`

## 适配与验证

六处替换锚点均按新包逐一核对，精确且唯一命中；另保留文件首部导入。3.17.1 → 3.17.2 变量映射：relay WS 覆盖 `Sx→kx`、URL 覆盖 `Cx→Ix`、getLogin 内部 `e3/t3→S3/C3`、getToken 单飞源与令牌客户端 `Gn/Ul→Vn/$l`、设备注册 `Fl→Hl`；manager `Bt`、挂接容器 `rg`、排除 CUA 指示窗的窗口列表函数 `Ne` 与 P5/P6 锚点字节原样。relay URL 解析函数 `zl→Vl`（chunk 由 `chunk-ZP2RJMJD.js` 换为 `chunk-U3DZ6DPO.js`，内部 `RG`/`resolveWebRemoteControlRelayWsUrl` 新增 `endpointOrigin` 参数，仅在 overrideUrl 为空时参与回退构造）对 overrideUrl 非空即直用、无协议校验，语义与旧包一致。WS 覆盖消费点两处（getEndpointUrls 回调闭包与构造期 options 求值）均在注入点之后，读到覆盖后的回环值。getToken/resolveDeviceSid 注册承接 3.17.1 的每会话 V2 relay 连接 options 位置，短路守卫语义不变；`m(Vn,Rt,()=>...)` 单飞包装短路后不执行。旧档案及其字节保持不变。

新增正式包路由、运行体与真实锚点切片全链注入测试（含 node --check）先因未登记包失败（红阶段断言：档案 `ERR_MODULE_NOT_FOUND` 与路由 `unsupported_package`，见会话记录，未单独落盘日志）。追加档案后，local-only 核心测试（routing、patch、lifecycle、lab、3.16.3、3.17.1、3.17.2）共 71 项通过。候选两次 prepare 字节一致（`ce7ab57c…`）；实际包副本（exe + app.asar）完成 apply → status(patched) → restore，恢复摘要与原版相同，apply 写入面仅 app.asar、同目录备份与状态文件；公共插件发布目录构建通过，其中 CLI 独立路由命中新档案并携带全部四份档案。

本轮未应用到用户日常宿主。尚未完成新版无登录冷启动、官方远控不可达、网关重启恢复和 MCP 原生闭环，不能据以上静态及副本验证宣称新版已完成正式兼容验收；Electron 精确版本静态证据链未定，列为未验项。

可复核日志位于独立工作树忽略目录 `.scratch/3.17.2/`：build-release.log、prepare.log、tests-local-only.log、tests-setup-release.log、copy-verify.log。验证用包副本、候选与发布目录构建产物已清理，均不入库。

# Windows 3.16.3 随包适配档案

日期：2026-10-23。状态：仓库已追加自动路由档案，原生运行验收待完成。

交付为公共插件 `local-only/profiles/windows-3.16.3.8992.mjs` 及 `profiles.mjs` 注册项，不分发完整宿主包或独立补丁 ZIP。沿用 setup 的 status → prepare 流程，按本机 exe 版本和原版 asar 摘要自动选择档案、现场生成候选；退出宿主后执行 setup 生成的外部应用命令。发布构建自动收集 profiles 目录，无须在 setup 增加版本分支。

## 包身份

- exe FileVersion：`3.16.3.8992`
- 原版 app.asar：341378894 字节，SHA-256 `21183dbf3bee0a786d6cc3b648dda96f7d443c9674092538b2a6ffb72002822e`
- 档案：`windows-3.16.3.8992-21183dbf`，独立补丁修订号 1
- 候选 app.asar：341381483 字节，SHA-256 `04372b0ed959cd5dddfc67d8b071b5157814bc0aedfc5f879222fd1fb542f2cc`

## 适配与验证

六处替换锚点均按新包逐一核对，精确且唯一命中；另保留文件首部导入。新包使用 cA 作为 relay 覆盖变量、pi 作为 manager，Oe 对应排除 CUA 指示窗的窗口列表函数。旧档案及其 v3 输出规则保持不变。

新增正式包路由与运行体测试先因未登记包失败。追加档案后，新包测试及既有 routing、patch、lifecycle 测试共 50 项通过。实际包副本完成 apply/restore，恢复摘要与原版相同；候选主入口通过 node --check；公共插件发布目录构建通过并携带新旧档案。

本轮未应用到用户日常宿主。尚未完成新版无登录冷启动、官方远控不可达、网关重启恢复和 MCP 原生闭环，不能据以上静态及副本验证宣称新版已完成正式兼容验收。

补充复用 setup 的预检拒绝与受支持包安装契约测试，验证 status/prepare 调用及外部命令生成；这两项使用系统边界桩，不代替真实宿主验收。

可复核日志位于独立工作树忽略目录 `.scratch/patch-3.16.3/`：red.log、tests-green.log、prepare.log、roundtrip.log、build.log、setup-routing.log。验证用完整包副本、候选和独立 ZIP 已清理，均不入库。

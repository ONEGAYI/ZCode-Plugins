# 更新日志

## [0.7.2] - 2026-10-23

追加 Windows ZCode 3.16.3.8992 的 local-only 适配档案，沿用 setup 自动路由与现场补丁准备流程。

### 其他改进

- 按新版 exe 版本与原版 asar 摘要选择独立修订号 1 的注入规则，保留 3.16.2 档案。
- 发布包携带新档案，无须下载完整宿主或手选补丁；业务插件不联动升版。
- 新旧补丁 50 项测试及 2 项 setup 契约通过，实际包副本应用/还原摘要一致。

> **验收边界**：3.16.3 原生无登录冷启动、官方远控不可达、网关重连与 MCP 闭环仍待验收；本版提供适配候选，不代表新版完整兼容验收通过。

## [0.7.1] - 2026-10-23

补齐安装与升级路径的 local-only 补丁引导：已有 local-only 配置的机器升级后不再静默保留不可用状态。仅修订技能指引，无运行时代码变化，业务插件无需联动升版。

### 其他改进

- setup 升级流程（[#158](https://github.com/ONEGAYI/ZCode-Plugins/pull/158)）：已有 local-only 配置时补核补丁状态（`local_only_patch`）并向用户交付三选一决策（补丁迁移 / 完整还原保持 relay / 明确暂缓），补丁未应用不得汇报升级完成
- setup 升级流程：local-only 完成判据改为重开后 `desktop_ready` 与原 Host 探针通过，网关健康检查通过不等于 Desktop 已连上本地网关
- setup 首次安装：部署网关前确认连接模式，local-only 受支持包直接走补丁安装完整流程，不在 relay 装成后再改
- configuration：补全"原配置 local-only 且应用升级到 3.16"的双分支引导，受支持包走补丁迁移、不受支持包完整还原切 relay

## [0.7.0] - 2026-10-22

新增指定 Windows 3.16.2 运行包的 local-only 安装流程，并为后续版本适配建立自动路由。业务插件继续复用公共网关，无需联动升版。

### 新功能

**3.16.2 本地远控（Windows）（[#152](https://github.com/ONEGAYI/ZCode-Plugins/pull/152)）**

- setup 可选择 local-only：Agent 预检并准备外部命令，用户关闭 ZCode 后执行补丁，继续使用原快捷方式。
- 受支持包可在无 ZCode 登录态、官方远控不可达时冷启动，并在网关重启后恢复连接。
- 切回 relay 时保留补丁并关闭本地开关；完整还原命令恢复原包及本功能管理的 relay 配置。
- 提供隔离测试环境、操作指南和 MCP、Stop 命名、侧栏评论的开发验证记录。

**补丁自动路由（[#153](https://github.com/ONEGAYI/ZCode-Plugins/pull/153)）**

- 按平台、exe 版本和原版 asar 摘要选择随包适配档案；新增档案时保留旧档案和独立补丁修订号。
- 兼容历史候选与状态记录，支持同包补丁升级和还原。
- 应用前拒绝跨包候选、补丁降级及损坏记录；未知包明确报告不支持。

> **支持范围**：真实支持限定 Windows 3.16.2.8769 的既定发行包，不泛化为整个 3.16 系列。新版本需追加适配档案并单独验收；自动路由不等于自动适配未知版本。

> **升级安排**：补丁应用由用户保存工作、退出目标 ZCode 全部实例后在外部 PowerShell 执行。插件升级本身不会改写 Desktop，默认 relay 模式保留。

> **联网边界**：local-only 免除官方远控连接，模型服务与套餐查询仍需相应服务可达。日常安装与在线 relay 的实际用户验收独立于隔离开发验证。

<!-- 变更链接 -->
[0.7.2]: https://github.com/ONEGAYI/ZCode-Plugins/compare/plugins-2026.10.23...plugins-2026.10.23.1
[0.7.1]: https://github.com/ONEGAYI/ZCode-Plugins/compare/plugins-2026.10.22...plugins-2026.10.23
[0.7.0]: https://github.com/ONEGAYI/ZCode-Plugins/compare/plugins-2026.10.21...plugins-2026.10.22

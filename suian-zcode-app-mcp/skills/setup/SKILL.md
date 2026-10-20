---
name: setup
description: 初始化、升级或迁移 ZCode 会话 MCP，准备锁定依赖、公共包链接和外置配置，避免重复注册。
---

# 会话 MCP 安装与迁移

原生根为 `${ZCODE_SKILL_DIR}/../..`；源码模式沿用已确定的根。先读[路径与配置](../paths.md)。

1. 核对 MCP 与 common 的安装位置和启用状态，准备运行的原生 MCP 要求二者启用；旧服务停用状态按下方迁移步骤保留。按公共 setup 安装公共依赖，在本插件根 npm ci --ignore-scripts --no-audit --no-fund，再由公共 link.mjs 建立业务端链接。npm ci 后须重建链接。Node.js 24+ 必需；MCP 用内置 SQLite，不要求 sqlite3 CLI。
2. 按公共 setup 备份，再检查旧全局 MCP 的 cli.mjs 根、args/env、启用或暂停状态和数据库/网关路径。旧参数含 --config 时先读取该文件，将有效自定义路径转存原生配置；已有原生字段优先保留，JSON 无效时报错，不覆盖。旧 DPAPI 授权只在明确管理时复制，不回显明文或密文；默认原 Host 调用无需旧链接。
3. 仅检查通过后初始化：

```powershell
node "{{plugin_root}}/install.mjs" --native-plugin --config "{{data_path}}/config.json" --check-only
node "{{plugin_root}}/install.mjs" --native-plugin --config "{{data_path}}/config.json"
```

原生模式创建或保留外置配置，技能和 MCP 由宿主加载，不部署全局技能或另加全局 MCP。

迁移已确认的旧源码安装时，第二条命令追加 --legacy-root "{{legacy_root}}"。安装器先转存旧服务直接通过 args/env 提供的数据库、网关和授权目录参数，再移除该根的旧 suian-zcode-app 注册及归属匹配的技能，保留其他服务与 Hook。已有原生字段优先，复读并确认没有双注册；旧技能残留按公共 setup 的迁移复核处理。旧服务原来停用时，通过原生管理器保留停用状态，不因安装器成功而开启。

源码模式执行 node install.mjs 部署路由技能，再按[configuration](../configuration/SKILL.md)合并客户端设置，不加 native 标志。两种注册方式二选一。

4. 完成公共网关配置，再按[debug 的验证步骤](../debug/verification.md)查实际服务清单、stdio 握手和工具数（基础十九个；宿主索引含 projects 表时另有 list_projects）。核对工件的 SessionStart、UserPromptSubmit、同步 Stop 仅有一套注册，Hook 和 MCP 使用同一外置库；普通空 get 不建写库。原生侧栏在 ≥3.15.1 且 MCP Apps 能力与目标会话连接就绪时提供，应用版本优先使用 Desktop 的 ZCODE_APP_VERSION，不拿页面 bridge version 比较。隔离数据库可做读取烟测；真实写工具只对用户指定的新测试会话验收。原 Host 未连接部分标记待生效，不提前让用户退出当前 ZCode。

## 升级与卸载

原生安装按公共 setup 通过原生管理器更新，随后从插件清单获取新 rootPath、dataPath；源码安装才更新原仓库。重装锁定依赖、重建链接、以实际外置配置运行同一初始化命令，保留路径与启用或暂停状态。任务、环境和网关重载只按公共 setup 处理。

新缓存或源码不等于当前会话工具已换代。先完成本机配置；需重开时最后交付用户保存工作与择时重开的步骤。延迟重开时区分网关、技能、新会话和既有 MCP。会话内断开重连用实际服务名并等待约 30 秒空闲宽限，期间工具不可用，宽限内重连可能仍是旧进程。重连后核对实际 MCP 工具清单，不以网关已重载证明 MCP 已换代。

原生停用/卸载通过原生管理器，保留外置配置、公共网关和其他插件。源码模式只移除自有 MCP 条目与技能。明确要求恢复直连时才调用公共 Remove。

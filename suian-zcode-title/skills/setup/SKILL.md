---
name: setup
description: 初始化、升级或卸载 ZCode 自动命名，配置外置数据并迁移旧全局 Stop Hook。
---

# 自动命名安装与迁移

原生根为 `${ZCODE_SKILL_DIR}/../..`；源码模式沿用已确定的根。先读[路径与数据](../paths.md)。

## Linux Source Server

如果 ZCode Desktop 打开的是运行在 Linux Source Server 上的远程项目，在**远端**核对 title 和配套 common 的原生安装记录与启用状态。确保 Stop Hook 能在远端 PATH 找到 Node.js 24+ 和支持 `-readonly -json` 的 sqlite3。不要在远端配置桌面网关或 Windows 通知。

用以下命令检查依赖，再去掉 `--check-only` 初始化；命令从实际的远端安装记录取路径：

```sh
node "{{command_dir}}/install.mjs" "{{state_dir}}" --native-plugin --source-server --config "{{data_path}}/config.json" --installed-plugins "{{installed_plugins_json}}" --check-only
```

首次未选模型时不派发命名任务。原生插件启用后，新会话里的 Agent 会收到在当前回复末尾附上配置提示的指令，提醒无需另配；主动暂停不提醒。

初始化写入 `transport: "source-server"`，保留已有启停状态与模型选择。用 `models` 核对远端模型、用 `probe` 检查 Source Server 直连，再按 [configuration](../configuration/SKILL.md) 启用。新建一个远程项目会话，完成一轮，核对 `hook.log.jsonl` 的 `dispatched`、`runner.log.jsonl` 的 `renamed` 或 `kept`，以及 Desktop 的标题。卸载使用宿主的原生插件卸载。

## Windows 桌面网关

1. 原生模式核对 common 与命名插件已启用。命令入口按[路径与数据](../paths.md)区分形态：发布目录（含 release.json）的 common 能力经安装记录直接定位，不需要公共包链接或 npm 安装；源码目录形态仍按公共 setup 建立锁定依赖与公共包链接，并用 --common-root 指向 common 构建产物目录调试。
2. 确认 Node.js 24+ 和 sqlite3 CLI。安装器验证只读 JSON 查询；sqliteBin → SQLITE_BIN → PATH，不把 npm 同名包当 CLI。绝对路径适合后台进程，显式无效路径不回退。
3. 原生数据来自插件清单。按 paths.md 确定实际状态目录 {{state_dir}}，首次默认 {{data_path}}/state；已有有效外部自定义目录沿用。已有源码安装按下方迁移步骤转存配置和状态；首次配置保持暂停，不采用示例模型。仅检查通过后初始化：

```powershell
node "{{command_dir}}/install.mjs" "{{state_dir}}" --native-plugin --config "{{data_path}}/config.json" --installed-plugins "{{installed_plugins_json}}" --check-only
node "{{command_dir}}/install.mjs" "{{state_dir}}" --native-plugin --config "{{data_path}}/config.json" --installed-plugins "{{installed_plugins_json}}"
```

仅配置文件不存在时新建 enabled:false 的外置配置，等待首次模型选择与核验后启用。已有配置保留原开关、模型选择和自定义字段；省略 enabled 时继续默认启用，不能因原生安装或重复安装而暂停。Hook 与技能由宿主管理，安装器只配置通知资产，不重复写全局注册。

迁移旧安装时，先按公共 setup 备份，再记录旧命名开关：旧配置未写 enabled 时默认启用，不能因原生首次配置默认 false 而丢失这一状态。切换注册前临时暂停旧、新命名，等旧 worker 收尾后按 paths.md 转存配置与状态；这次暂停单独记为待恢复项。

第二条命令追加 --legacy-root "{{legacy_root}}"，先确认这确实是原命名根。安装器只移除该根的旧 Stop 命令与归属匹配的旧技能，同一 matcher 内的他人 Hook 保留。迁移后复读用户设置，确认没有新旧双注册；旧技能残留按公共 setup 的迁移复核处理。

源码兼容模式仍用 node install.mjs {{data_dir}} --config {{config_path}}，不加 native 标志；该模式部署全局 Hook 和路由技能。两种注册方式不要同时保留。

4. 网关连接后按[configuration](../configuration/SKILL.md)查询账户实际可用模型与档位。首次由用户选择；已有明确选择先核验，不重复询问。取不到清单时保留暂停，报告模型待确认与原开关的待恢复项，继续完成其他本机配置。
5. 执行 status、doctor 与 probe。首次安装按 configuration 的选择结果启用。

原模型与档位、Host 探活通过后，原来启用且仅为迁移临时暂停的安装执行 enable --config {{config_path}}，复读 enabled 并再查 doctor。原来暂停的继续暂停，旧安装保持停用。

首次环境未生效时先交付本机配置和待验证报告，最后才安排用户择时重开；重连后继续核验与恢复，不退出当前 ZCode。配置、模型核验、真实 Stop 和手机共存分别报告。

## 升级与卸载

命名提示词在运行命名任务一端的状态目录中，文件名是 `naming-prompt.md`，不放插件版本缓存。下次命名运行按版本部署或升级；负 `version` 保留自定义版本，镜像版本更高时会先备份旧稿再替换。重置与损坏恢复规则见 [configuration](../configuration/SKILL.md)。

原生安装按公共 setup 通过原生管理器更新，再从插件清单获取新路径；源码安装才更新原仓库。原生更新无需重装依赖或修链，以实际状态目录、配置和 `--installed-plugins` 重跑同一安装命令，更新共享 Toast 执行器并将实际安装清单路径保存到 title 外置身份。旧身份缺少清单锚点时也按此补齐；只做 `--check-only` 不更新身份。保留配置、状态、授权和原暂停状态；若升级需要临时暂停，记录原开关并按第 4、5 步恢复。常驻网关升级只按公共 setup 处理。

原生卸载通知资产用 `node "{{command_dir}}/install.mjs" "{{state_dir}}" --native-plugin --remove --installed-plugins "{{installed_plugins_json}}"`，再通过原生管理器停用或卸载本插件。源码模式不加 native 标志，安装器同时移除自有全局 Hook 与技能。保留业务状态和公共网关；明确要求恢复直连时才调用公共 Remove。

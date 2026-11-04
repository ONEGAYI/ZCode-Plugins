---
name: configuration
description: 配置 ZCode 自动命名的模型、思考档位、SQLite 路径与超时，保留既有选择和暂停状态。
---

# 自动命名配置

原生根为 `${ZCODE_SKILL_DIR}/../..`；源码模式沿用已确定的根。先读[路径与数据](../paths.md)，读取当前外置配置或既有 config.local.json。

stdin 传目标会话，执行 `node "{{command_dir}}/cli.mjs" models --config "{{config_path}}" --installed-plugins "{{installed_plugins_json}}"`，从原 Host 取得实际清单。command_dir 按 paths.md 区分发布包与源码。生成通过用户当前窗口的网关连接，不能猜 providerId、modelId 或 reasoningLevel。

首次安装由用户选择；已明确指定时核验后沿用。升级保留已有组合，只有用户要求更换或原组合不可用时询问。取不到清单时报告原因并保持首次安装暂停，不用示例 selection 代替用户选择。

把真实组合写入 selection：`{"providerId":"...","modelId":"...","options":{"reasoningLevel":"..."}}`。复读并核对清单；首次选择与核验完成后才设 enabled:true。已暂停的旧安装继续暂停，除非用户要求恢复。

按需修改 sqliteBin、timeoutMs、maxOutputTokens 或 gatewayConfigPath；超时允许 1000–300000 毫秒。公共目录非默认时 gatewayConfigPath 指向实际网关配置；保留有效自定义数据库与数据目录，不复制 control_token。

助手每轮正文默认最多保留 2000 个 Unicode 字符，截断时保留头部 40% 和其余尾部，中间的省略标记不计入预算。可设置 `assistantMaxChars` 与 `assistantHeadPercent`：前者为至少 2 的安全整数，后者为 1–99 的整数，按向下取整计算头部，须保证首尾各有字符。任一无效时本轮整组回退默认值，原因写入 runner 日志，不改配置文件。

有效命名运行使用状态目录的 `naming-prompt.md` 正文作为 system prompt。首次从插件根 `prompt.md` 镜像部署；frontmatter 必须有唯一的顶层十进制整数 `version`（键可加引号），可以有行尾注释，其他元数据不参与版本判定。负整数锁定自动更新；本地版本不低于镜像时保留本地文件，镜像版本更高时先备份再覆盖。把本地版本改为小于镜像的非负整数可在下次命名运行重置为镜像。备份固定为同目录的 `naming-prompt.md.backup`，每次覆盖前更新，只保留紧邻前稿。缺失、重复或无效版本、分隔不完整、正文为空或 UTF-8 无效时，先备份旧文件再恢复镜像并通知；如公共插件或通知资产尚不支持恢复通知，先保留原文件并提示升级或运行 setup。权限等 I/O 错误直接报告。

`installedPluginsPath` 是安装清单路径，不是 common 缓存目录；无宿主环境时供 CLI 定位公共插件。更换宿主存储根后，按 setup 使用新的 `--installed-plugins` 重跑安装，外置配置与 Toast 身份的 `pluginsFile` 才会同步更新。按钮点击不读取当前会话环境，也不从旧缓存补代码；清单缺失或损坏时报告状态未知。

变更由下一次 Hook/CLI 读取，通常不需重启网关。完成后 doctor；它核对静态定义、双库和模型，不证明当前会话已加载 Hook。真实触发按[debug](../debug/SKILL.md)验证。

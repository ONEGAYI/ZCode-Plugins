# 自动命名的位置与数据

原生调用时，从 `${ZCODE_SKILL_DIR}` 向上两级得到插件根；源码兼容入口读取时沿用已确定的根。原生安装通过 zcode plugins list --json 按完整 id 核对 rootPath、dataPath 和 enabled。CLI 不在 PATH 时按公共 setup 的说明使用实际 Desktop 随包 CLI。

| 模式 | 配置与状态 |
| --- | --- |
| 原生 | dataPath/config.json；状态默认 dataPath/state，有效外部自定义 dataDir 保留；dataPath 来自插件清单 |
| 源码兼容 | 现有根下 config.local.json 与配置指定的 dataDir；已有 .local 保留 |

所有命名 CLI 操作加 --config {{config_path}}，stdin 传 `{"session_id":"sess_...","workspace_path":"工作区绝对路径"}`。目标可以是用户指定的其他会话，不把 turn_id 当用户消息 ID。

命令入口与资源分两种形态：发布安装的命令入口（cli.mjs、install.mjs、hook.mjs、toast-action.mjs）位于插件根 `dist/`，提示词镜像、技能与 Hook 清单在插件根；源码模式入口与镜像同在插件根。实际命名提示词为状态目录中的 `naming-prompt.md`，备份也保留在同一目录。

执行技能命令前确定 `{{command_dir}}`：含 release.json 的发布包取 `{{plugin_root}}/dist`，源码取 `{{plugin_root}}`。`{{plugin_root}}` 始终指插件根，不为调用命令而改成 dist。

公共能力经安装记录定位 common 发布目录（PKG-01 客户端契约）：宿主 Hook/MCP 注入 ZCODE_PLUGIN_DATA 时自动推导；技能命令与独立 CLI 无注入时显式加 `--installed-plugins {{installed_plugins_json}}`，源码调试加 `--common-root {{common_release_root}}`（指向 common 的构建产物目录，须含 release.json）。安装器会把可用的安装记录路径写入外置配置，供后续无注入的 CLI 复用。原生缓存里不存在可依赖的同级 common，也不拼默认用户目录。公共安装入口为 {{common_root}}/skills/setup/SKILL.md，配置与排障在该根的对应技能。

迁移前保留旧 config.local.json 的模型选择、原启用或暂停状态与自定义路径。

按 setup 临时暂停并等待旧 worker 收尾后，旧 dataDir 位于源码或版本缓存内时，将状态和授权复制到外置数据目录，默认使用 dataPath/state，并改 config.dataDir 指向新目录；不复制 worker.lock。已有有效外部自定义目录沿用。

复核后保留旧文件供回退，不输出密文或凭据。公共标题策略与网关数据原位置不变，运行数据不放进版本缓存。

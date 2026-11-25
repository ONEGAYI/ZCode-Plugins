# ZCode Plugins Windows x64 离线安装

解压到准备长期保留的本机目录。用已能打开对话的 ZCode Desktop 打开解压目录作为工作区，然后对 Agent 说：「按 AGENTS.md 离线安装全套 ZCode Plugins」。若已点名所需业务插件，则只装所选插件及 common。

本包自带四个插件的正式发布文件和一份 Node.js、SQLite 命令行工具。安装不联网，不用 npm、Git 或包链接。目标机仍需已有 ZCode Desktop；安装完成不代表登录、模型或在线远控可在断网下使用。

## 1. 固定安装位置和启动环境

确认解压根和当前 Desktop 的实际 `ZCode.exe`，让 CLI 与 Desktop 使用同一 Windows 用户及 ZCode 数据配置。不要猜安装路径，也不要把插件复制进缓存。安装和配置均从以下 PowerShell 环境执行；把两个占位路径替换成实际绝对路径：

```powershell
$bundle = (Resolve-Path -LiteralPath '{{离线包解压目录}}').Path
$desktop = (Resolve-Path -LiteralPath '{{实际 ZCode.exe 路径}}').Path
$cli = Join-Path (Split-Path -Parent $desktop) 'resources/glm/zcode.cjs'
$node = Join-Path $bundle 'runtime/node/node.exe'
$env:Path = "$bundle\runtime\node;$bundle\runtime\sqlite;$env:Path"
& $node --version
& $node $cli plugins marketplace list --json
& $node $cli plugins list --json
```

核对输出后再安装。后续命令使用同一 PowerShell 进程；若换了 Shell，先重做路径设置。这里不改用户级或系统级环境变量。部署网关后，计划任务会记住这份 Node 的绝对路径，解压目录需要保留在原处。

## 2. 从本地市场安装

市场身份必须保持 `suian-zcode-plugins`，三个业务插件通过它找到同一份 common。若已有同名市场，核对来源：已指向本目录则跳过添加；若指向别处或线上，先报告冲突，请用户确认迁移方式，不擅自移除市场。用第 1 节的安装列表对照包根 `marketplace.json`；同版本可跳过安装，已有更新版本则停止并报告，不降级。保留已有插件的启停状态和外置配置。

```powershell
& $node $cli plugins marketplace add $bundle --scope user --json
& $node $cli plugins install 'suian-zcode-common@suian-zcode-plugins' --scope user --json
& $node $cli plugins install 'suian-zcode-title@suian-zcode-plugins' --scope user --json
& $node $cli plugins install 'suian-zcode-app-mcp@suian-zcode-plugins' --scope user --json
& $node $cli plugins install 'suian-side-editor@suian-zcode-plugins' --scope user --json
& $node $cli plugins list --json
```

每条失败都先停止并报告原因。按解压根 `marketplace.json` 核对所选插件的版本、完整 ID、`rootPath`、`dataPath` 与启用状态。用安装完成的 common 入口执行 `depcheck-hook.mjs --scan-only --installed-plugins <实际安装清单>`；安装清单在 common 的 `dataPath` 向上两级的 `installed_plugins.json`。

## 3. 配置并让 Hook 找到 Node

按已安装插件的 setup 技能和用户选择配置，不走技能里的联网市场更新步骤。只使用文本编辑时不部署网关。自动命名可将 `sqliteBin` 指向本包 `runtime/sqlite/sqlite3.exe` 的绝对路径。需要本地远控时才核对 common 的 local-only 档案是否支持目标 Desktop；按已有流程取得授权，仅准备补丁和外部命令，应用与激活由用户关闭目标实例后执行。离线时不要默认安装在线 relay 或将未就绪的模型记为已配置。

安装后请用户保存工作并从托盘退出旧 ZCode，再从第 1 节设置过 `PATH` 的 PowerShell 启动目标 Desktop：

```powershell
Start-Process -FilePath $desktop
```

若从新 PowerShell 启动，先重做第 1 节的路径设置。这样 Stop 和工件 Hook 才能找到便携 Node。重新进入会话后，将「插件已安装」「Hook、面板或网关已验证」「待用户完成的步骤」分开报告。

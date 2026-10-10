# 工件区的 ZCode 原生面板入口核查

研究日期：2026-10-10。范围：第三方插件能否注册桌面侧栏、Webview 或面板，能否通过 MCP UI 或既有工作流产物侧栏展示会话工件区。不涉及模型请求投影 Hook。

## 结论与版本边界

**已核实的 3.14.3 插件契约没有自定义原生面板注册入口**。宿主确有工作流产物侧栏，但它读取动态工作流的产物数据，不能直接视作第三方插件的会话工件面板 API。普通 MCP 结果的渲染链也不能据此承诺 HTML 或 MCP Apps 接入。

源码依据是只读快照 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；[根 package.json 第 2–3 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/package.json#L2-L3)声明版本 `3.14.3`。以下源码链接均钉定该提交。

本机安装包另为 `3.14.5`，只做了静态核实，没有启动宿主或连接真实会话。因此，结论用于确定设计前置依赖，不能写成“所有 ZCode 版本永久不支持面板”。

## 已核实事实

### 1. 插件装配不含 UI 扩展

- [PluginManifest 第 141–161 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/plugins/index.ts#L141-L161)没有 panel、sidebar 或 webview 声明；[组件枚举第 25–48 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/plugin-components.ts#L25-L48)只枚举 Agent、命令、Skill、Hook、MCP。
- [加载器第 336–363 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L336-L363)实际装配命令、Hook、MCP 与 Skill；[第 209–232 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L209-L232)返回的插件能力中也没有 UI 注册对象。
- [共享展示类型第 12 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/plugin-types.ts#L12)虽然列有 LSP，但加载器把 `channels/lspServers/outputStyles/settings` 视为仅诊断组件；见[第 107–112 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L107-L112)、[第 373–383 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L373-L383)。展示类型不能替代运行时支持证明。

### 2. 已有产物侧栏属于动态工作流

**侧栏需要真实的工作流产物身份与数据**。[WorkflowArtifactSidePaneTab 第 414–448 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/lib/workspaceSidePane.ts#L414-L448)要求 `parentSessionId/runId/artifactId`；[面板第 51–77 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/WorkflowArtifactSidePane.tsx#L51-L77)订阅父会话的 `workflowRuns`，并结合工作流 journal 读取产物。

工作流的 `artifact.file/markdown` 是内容发布机制：[发布实现第 76–104 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/app/workflow-artifact-publish.ts#L76-L104)读取内容、写入 store 并返回版本记录。它不是插件注册任意会话引用列表的接口。

HTML 内容也没有直接作为该面板里的任意 Webview 执行：[正文分派第 278–287 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactBody.tsx#L278-L287)显示 HTML 卡片，[HTML 卡片第 80–126 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactCards.tsx#L80-L126)的动作打开工作区文件；[点击处理第 1069–1108 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/hooks/useAppPanels.ts#L1069-L1108)将可打开的 HTML 转为浏览器 tab。借用浏览器展示网页与注册原生工件面板是不同的集成方式。

### 3. 普通 MCP renderer 没有接上 App UI

[MCP renderer 第 57–64 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ToolCallBlocks/renderers/mcp.tsx#L57-L64)将输出转换为字符串；[第 158–175 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ToolCallBlocks/renderers/mcp.tsx#L158-L175)读取 `toolCall.output`；[第 210–243 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ToolCallBlocks/renderers/mcp.tsx#L210-L243)显示短文本或 CodeBlock。该链没有读取 `ui/resourceUri` 并挂载应用的处理。

补充检索 `packages/ui/src` 与 CLI 包：`ui/resourceUri`、`text/html;profile=mcp-app`、`McpApp`、`mcp-ui`、`ext-apps` 未命中；`apps/packages` 中常见面板注册 API 名称也未命中。检索未命中只是补充证据，核心依据仍是上述契约和装配实现。

## 本机 3.14.5 静态复核

为避免将个人安装路径入库，本节以 `{{ZCODE_INSTALL_DIR}}` 代指本机已核实的安装目录。

| 产物 | 只读核实结果 |
|---|---|
| `{{ZCODE_INSTALL_DIR}}/ZCode.exe` | 文件存在；ProductVersion 为 `3.14.5.7961` |
| `resources/glm/zcode.cjs` | 文件存在，14,820,968 字节；含插件“仅诊断组件”提示字符串 |
| `resources/app.asar` | 文件存在，326,914,395 字节；直接读取归档头与内部 `package.json`，桌面包版本为 `3.14.5` |
| 归档内 `out/renderer/**/*.js` | 扫描 2,717 个脚本，共 36,818,937 字节；发现普通 MCP 结果、工作流产物与 HTML 卡片的标识；没有 `ui/resourceUri` 或 `text/html;profile=mcp-app` 字面量 |

匹配的桌面脚本为 `out/renderer/assets/styles-C4MhEMbW.js`。其中确有 `registerPanel` 字面量，但限定片段显示它与 `orientation/registerSeparator/getPanelStyles` 同处布局上下文，不能当作插件面板 API。源码也引入[可调整尺寸的布局组件](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/resizable.tsx#L1-L11)。

核实过程只读 EXE 元数据和归档字节，没有解包落盘、安装依赖、加载插件、启动宿主或执行 UI 注册。字面量扫描无法排除所有改名或内部私有入口，也不能证明新版具备可用的第三方扩展契约。

## 设计建议与待验证项

**建议将“第三方原生工件面板”列为宿主前置能力**，在得到正式注册/数据/生命周期契约前，不以现有工作流产物侧栏或普通 MCP HTML 结果作为实现承诺。

宿主外的本地网页或独立窗口可以另行评估；它们不需要复用原生产物 journal，但需要自己的会话绑定和状态读取方式。这是方案建议，本文没有实现或验收外挂面板。

如后续上游提供 UI 入口，验证须覆盖：插件成功注册并卸载面板、按指定会话读取当前工件状态、会话切换不会串区、重启恢复、变更刷新，以及 UI 能力缺失时明确报告。面板显示方案不改变模型请求投影的严格语义。

# 工件投影：3.14.5 发行包请求链静态审计

研究日期：2026-10-10。对象：本机 ZCode 3.14.5 的原封不动发行产物，与公开源码快照 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（3.14.3）对照。本文只记录静态审计；没有启动 Desktop、CLI 或 AgentServer，没有读取真实用户配置或聊天库。

后续隔离运行已完成，实际请求、分叉反例及验证限制见 [发行版核验报告](artifact-host-capabilities.md)。本文的“待运行”指静态审计阶段的检查计划，当前结果以核验报告为准。

## 结论

**发行包的纯插件 Hook 仍不能保证每个模型请求刷新、尾部唯一、旧投影不进运行时历史**。正式插件加载器只接纳七类 Hook 事件，`UserPromptSubmit.additionalContext` 仍被追加到 `messageHistory`。工具续跑使用同一轮的请求历史，不会重新执行用户提交 Hook。

**3.14.5 确有宿主内部的临时请求追加**。新增的后台记忆更新在请求装配时追加 `memory_update`，没有提交到运行时历史；但它消费宿主内部的 `pendingMemoryUpdate`，不是暴露给第三方插件的请求 Hook。插件装配结果不含该状态的读写入口。

“不入库”还要分清存储对象：普通 Hook attachment 没有在其注入函数中直接写聊天消息库，但模型请求会携带其内容。默认开发/生产环境还会记录 Model I/O；只检查聊天消息正文不足以证明投影没有任何持久化副本。

## 可复核的发行产物证据

以 `{{ZCODE_INSTALL_DIR}}` 代指已核实的本机安装目录，避免提交个人绝对路径。以下均是 **UTF-8 文件字节偏移，0-based，左闭右开**；不是字符串字符索引。先校验文件 SHA-256，再按范围读字节。内部压缩变量名仅对该哈希对应的产物有效。

| 产物 | SHA-256 |
|---|---|
| `resources/glm/zcode.cjs`，14,820,968 字节 | `FAD4C35C4C36EC210D8A06D3FA0E77DE23C8545E2EB6FF90AEA1EB38D1E6275F` |
| `resources/app.asar`，326,914,395 字节 | `4BEFBE43EB7B4FD83426896991F4A399F1102AF0E0865BA34F2B69FC3A2A9931` |

### CLI bundle 中的具体路径

| `zcode.cjs` 字节范围 | 观察到的行为 |
|---|---|
| `[1309665,1310020)` | `Tl` 定义 SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop 七种事件 |
| `[4282240,4283900)` | `Yzs=new Set(Object.values(Tl))`；`NodePluginAdapter` 发现插件并返回 commandRoots、diagnostics、hooks、mcpServers、plugins、skillRoots |
| `[4274494,4276010)` | `a7s`（`parsePluginHookEvents`）按 `Yzs` 拒绝不支持的事件，然后按 Hook matcher schema 校验和装配 |
| `[4272985,4273310)` | `e7s`（`resolveEnabledComponents`）只装配命令、Hook、MCP 与 Skill；没有请求消息转换器 |
| `[12989393,12989725)` | `_Ao`（`runUserPromptSubmitHooks`）调用 Hook runner，输入为 prompt、会话和轮次等元数据 |
| `[13066720,13067790)` | 一轮用户输入先运行上述 Hook，再调用 `injectHookAdditionalContextIntoMessageHistory` |
| `[12990099,12990247)` | `vAo` 创建 `Wg("hook_context", ATa(...))`，随后 `this.messageHistory.addEntries([n])` |
| `[4806990,4807140)` | `addEntries` 执行 `this.entries.push(...t.map(LG))`，是追加，不是按工件区 ID 替换 |
| `[12768573,12769520)` | `v4`（`rebuildContextPrefix`）重建前缀并保留 canonical conversation tail，没有在这里删除旧 Hook attachment |
| `[12704915,12705900)` | `XJ`（`buildProviderRequestMessages`）排序/投影输入 entries，生成 provider messages |
| `[13046270,13046980)` | `aPo`（`consumePendingProjectMemoryUpdate`）消费并清空内部 `pendingMemoryUpdate`，返回 `memory_update` attachment |
| `[13048960,13050320)` | 请求先复制 `turnRequestState.entries`，再将内部记忆 attachment 临时追加到请求；随后生成 provider 与 recorded messages |
| `[13029200,13031700)` | 本次模型步骤把 `recordedMessages` 放进 ModelRequest 事件并 `appendEvent`，再发送模型请求 |
| `[3996153,3996990)` | `Kst` 仅在 runtime env 为 test 时停用 Model I/O；`Aln` 记录 `request.messages` |
| `[4000626,4002160)` | `JWr` 写 `model-io-<session>.jsonl`；全量保留和有界整理是不同分支 |

核心代码形态是 `let w=[...e.turnRequestState.entries], T=t?void 0:aPo(this), I=T?[...w,T]:w`。`I` 是发送所用 entries；这项内部临时记忆通知并没有因此成为插件能力，也没有自动排除出 recorded messages。

这些结论来自实际装配和调用代码，不是仅根据某个 API 字符串未命中推断。静态审计仍不能代替针对具体发行版的隔离运行验收。

## 与公开 3.14.3 的对照

### 正式插件和 Hook 输出

[Hook 事件第 7–15 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/hooks/index.ts#L7-L15)同样只有七类；[Hook 输出第 163–205 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/hooks/index.ts#L163-L205)允许 additionalContext 与权限/继续执行等字段，没有消息历史替换或请求投影 ID。正式加载器[第 517–558 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L517-L558)拒绝七类以外的事件并装配已验证 Hook。

[用户提交第 361–423 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn.ts#L361-L423)运行 Hook 并注入结果；[注入函数第 106–117 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts#L106-L117)创建 attachment 并加入 messageHistory；[消息历史第 174–176 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/agent/message-history.ts#L174-L176)追加条目。这三段在 3.14.5 仍能逐项对应。

[公开请求循环第 168–186 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts#L168-L186)复制同一轮 entries 后投影；[上下文刷新第 37–49 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/context-refresh.ts#L37-L49)保留对话尾部；[provider 投影第 48–69 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts#L48-L69)负责排序和渲染。投影排序不能补出 Hook 没有提供的唯一替换契约。

3.14.5 的请求末尾新增内部 `memory_update` 分支；公开 3.14.3 的上述请求循环没有这一分支。因此，公开源码可说明共有 Hook 路径，但不能完整代表新版的所有请求装配细节。

`PostToolUse` 可以产生新上下文，但[工具执行第 472–485 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts#L472-L485)把它追加到工具结果序列化内容。它既不是每个实际模型请求入口，也没有删除先前投影的能力。

### 运行时与持久化的边界

#### 连续对话与数据库恢复

正常连续对话复用已有会话运行时，不会每轮从 DB 重建完整模型历史。公开快照中的 `activateSessionForResume` 先查 `context.sessions`，[命中直接返回已有 record](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1426-L1430)；[本轮请求底稿读取内存历史](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn.ts#L595-L599)。相关分支已在本次 3.14.5 原装 CJS 中逐项核对，CLI 版本为 `0.16.9`。

只有运行时不存在时，才沿 [持久数据恢复路径](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1431-L1495)新建 App，并由 [resumeFromStore 重建消息历史](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/resume.ts#L120-L162)载入持久消息。[运行时回收](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-residency.ts#L53-L67)会关闭原 App。调用 resume 不必然进入冷恢复，访问数据库也不等于重建本次请求历史。

| 原装 CJS UTF-8 字节起点，0-based | 对应路径 |
| --- | --- |
| `14483932` | `wRn`：先等待 deactivation，再读会话缓存；命中复用，未命中才恢复 |
| `14492403`、`14499572` | `GKo → uXa`：读取已有 record 并调用 App 的 sendInput |
| `14624032`、`14141029` | V4 host.getRecord 读取同一缓存，`D8` 调用已有 App |

这些位置仅适用于本文已固定哈希的产物。“旧 Hook 上下文仍保留”只限定于同一会话运行时被复用期间；进程重启或 record 被回收后的冷恢复属于另一条路径。

**聊天消息与模型诊断是不同的存储对象**。[真实用户消息持久化第 29–90 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/message-persistence.ts#L29-L90)接收 input/attachments；Hook 注入函数自身没有调用该路径。但这不能推导出旧 Hook attachment 不在下一次模型请求中。

[ModelRequest 事件第 193–207 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts#L193-L207)携带 recordedMessages；记录过滤[第 66–75 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-output-token-continuation.ts#L66-L75)只排除 output token 自动续写消息，不排除 Hook attachment。

`appendEvent` 不能单独作为 SQLite 落盘证明：[默认装配第 726–731 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/app/create-app.ts#L726-L731)使用内存 eventStore；[事件追加第 101–109 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/events.ts#L101-L109)另调用 durable 分支，该分支[第 420–422 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/events.ts#L420-L422)跳过包括 ModelRequest 在内的非特殊事件。

**Model I/O 默认会记录**。[记录开关第 64–67 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-debug.ts#L64-L67)只排除 test 环境；[第 109–129 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-debug.ts#L109-L129)将 request.messages 交给写入器；[第 468–522 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-debug.ts#L468-L522)落 JSONL，并依据保留选项整理内容。某条投影最终是否全文保留，需结合该运行模式和有界整理结果核实；不能承诺完全不留副本。

## ASAR 中的正式桌面启动链

归档内 `out/host/chunk-IKTGKLU2.js`：175,375 字节，SHA-256 为 `4461b36f27efe51bfd50b8021c68e78e6eeefe2738f7c649c36b2a2cad14754b`，文件数据从 ASAR 绝对字节 `270135470` 开始。

| 归档内文件范围 | ASAR 绝对范围 | 内容 |
|---|---|---|
| `[158466,159486)` | `[270293936,270294956)` | `xi`（resolveElectronRuntimeZCodeAgentCommand）以 process.execPath、bundle 参数和 ELECTRON_RUN_AS_NODE=1 启动；`xn` 也支持显式 AgentServer 命令覆盖 |
| `[119194,120214)` | `[270254664,270255684)` | `Qr`（findZCodeAgentRuntimeNodeBundle）在 packaged resources 等候选路径查找 JS bundle |

对应公开[启动实现第 412–435 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentProcessManager.ts#L412-L435)和[运行时描述第 26–39 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/zcode-agent-runtime.ts#L26-L39)：`resources/glm/zcode.cjs`，参数为 `app-server --stdio`。可沿相同 Electron Node 运行方式做隔离 AgentServer 验证；它仍不等于连接原运行中的 Desktop Host。

内置 provider 路径也单独核实：`out/main/index.js` 的文件范围 `[548264,549284)`，即 ASAR 绝对范围 `[273743178,273744198)`；`DC` 优先读取 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，打包态否则返回 `resources/config/provider/zcode-builtin.json`。该文件 SHA-256 为 `2f3a178bb364cd80dba92b33596e5d65f2cf04d0581a378f6fcd346740f4f663`。

## 隔离运行验证的辅助入口

以下是已核实格式，未由本文执行。所有占位路径都应解析到本项目的隔离目录。

- CLI 用户配置默认是 `{{AUDIT_HOME}}/.zcode/cli/config.json`；[加载器第 61–83 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts#L61-L83)使用 Node homedir，不应误以为只有 ZCODE_STORAGE_DIR 就隔离全部配置。
- 同时显式设置 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 可让[provider 入口第 58–65 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/provider-runtime-env.ts#L58-L65)直接使用独立配置路径；`ZCODE_DATA_BASE_DIR` 是该模块的默认数据基目录。[CLI 第 537–545 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/run.ts#L537-L545)将 app-server/agent-server 路由到 stdio 协议运行器。
- 插件目录声明 `plugins.enabled=true`、`plugins.dirs=["{{PLUGIN_ROOT}}"]` 即可。inline 候选[第 241–247 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L241-L247)默认启用，无需安装市场；配置中可显式加 `hooks.enabled=true`。
- 插件根的 `.zcode-plugin/plugin.json` 最小为 `{"name":"artifact-audit","version":"0.0.0"}`。`hooks/hooks.json` 自动发现；[Hook 来源第 28–39 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/hook-sources.ts#L28-L39)证明无需重复声明 manifest.hooks。

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "process",
        "command": "{{ABSOLUTE_NODE_EXE}}",
        "args": ["{{ABSOLUTE_HOOK_SCRIPT}}"],
        "timeoutMs": 10000
      }]
    }]
  }
}
```

该 process 参数格式来自[Hook schema 第 377–405 行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/hooks/index.ts#L377-L405)。Hook stdout 返回 `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"{{唯一审计标记}}"}}`。

待运行时核实：同一会话两次用户输入中旧标记是否仍在第二次请求；工具修改工件后续跑是否刷新；多个 Hook 返回是否累计；SQLite 正文、ModelRequest 活事件和 Model I/O 文件应分别核查。清空/压缩/重启恢复也需独立验证，不能用其中一次状态变化代替请求级保证。

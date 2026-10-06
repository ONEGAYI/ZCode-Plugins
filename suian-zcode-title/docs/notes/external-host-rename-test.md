# 外部客户端调用原 Host 改名实测

测试时间：2026-10-06 20:55:01（Asia/Shanghai）。ZCode Desktop 3.14.4.7912，ASAR 3.14.4，随附 CLI 0.16.9；外部客户端使用 Node.js v24.15.0。

**已通过独立网络客户端，把原桌面会话“双链联想”改为“改名测试：双链联想”**。客户端完成鉴权、工作区附着和真实 RPC 调用；原 Host 日志及两份数据库均确认成功。此次没有桌面点击，没有另起 app-server，没有直接写数据库，也没有修改官方源码。

此前 20:28 的界面操作属于旁证，用户随后已将标题恢复。此次外部调用前再次读到旧标题“双链联想”，因此不是沿用那次界面操作的结果。

## 成功标准与结果

| 验证点 | 实际结果 |
|---|---|
| 当前窗口授权连接 | 通过 HMAC 挑战，配对状态为 matched |
| 指定工作区与会话 | bootstrap 返回目标工作区、同一 taskId 及旧标题 |
| 附着已有工作区 Host | bridge 成功；原 Host PID 39048 处理请求 |
| 原 Host 业务方法 | zcode-task.renameTask 返回新标题 |
| 外部 RPC 读回 | 同一频道 getTaskMeta 返回新标题 |
| 任务索引持久化 | title=改名测试：双链联想，title_overridden=1 |
| CLI 会话持久化 | 同一 session.id 的 title 为新名称，title_source=custom |
| 原 Host 日志 | getTaskMeta → renameTask OK → getTaskMeta，55629–55636 行 |
| 客户端退出 | 退出码 0，连接已关闭 |

目标 ID 为 `sess_41e51a4…`，工作区为 `D:\CODE\Project\_Extensions\vscode-obsidian-like-editor`。PID、时间与日志行仅代表此次快照。

## 实际调用链

```text
独立 Node 客户端
  → wss://zcode.z.ai/ws
  → auth_init / auth_challenge / auth_response
  → matched
  → bootstrap-request
  → workspace-bridge-open
  → 原窗口 Main 附着原 Host
  → ChannelClient 等待 Initialize
  → zcode-task.getTaskMeta
  → zcode-task.renameTask
  → zcode-task.getTaskMeta 读回
```

用户提供的是当前窗口“移动端远程控制”的授权链接。凭据仅通过 stdin 交给临时进程并留在内存；报告不保存链接、hash、proof 或设备配对标识。

读取和改名使用同一个工作区 bridge。参数体必须为数组，因为官方 `ProxyChannel` 会把数组展开为方法实参：

```javascript
const params = { taskId, workspacePath };
const taskChannel = channelClient.getChannel("zcode-task");
const before = await taskChannel.call("getTaskMeta", [params]);
const renamed = await taskChannel.call("renameTask", [{
  ...params, title: "改名测试：双链联想"
}]);
const after = await taskChannel.call("getTaskMeta", [params]);
```

客户端先核对目标 ID、工作区和旧标题，再发出这一次改名。没有提交 Agent Prompt，也没有让目标会话切换模型。

## 终端侧协议要点

**手机 relay 包装的是 Channel 二进制消息**，不同于独立 Web Host 的 `SocketProtocol`。此链不加后者的 13 字节头，也不发送 CLI NDJSON。

鉴权向 `wss://zcode.z.ai/ws` 发送 terminal 角色的 `auth_init`。挑战签名使用 HMAC-SHA256：以链接中 URL 解码后的 hash 字符串的 UTF-8 字节作 key，对 `nonce|terminal|device_sid` 签名，结果为 base64url。hash 本身不再进行 base64 解码。

业务载体为 `{type:"data", payload, client_ts}`。先发 `bootstrap-request`；再以准确的 workspaceKey、taskId、bridgeSessionId 和 bridgeGeneration 发 `workspace-bridge-open`。依据返回的 `ready.bridge` 建立传输身份，不能自行添加 recoveryId。

`rpc-frame` 包含 seq、messageSeq、从 0 开始的 fragmentIndex、fragmentCount、messageBytes、CRC32 checksum 和标准 base64 的 dataBase64。完成重组后 ACK 使用 ackMessageSeq。物理消息上限为 1 MiB，完整二进制消息上限为 16 MiB，最多 64 片。

本次直接加载官方网页共享 bundle 的编码器、解析器和组装器，再使用官方源码的 ChannelClient。先用 900,000 字节数据完成两片往返检查，随后才连接真实 Host。

对应公共产物：

- [官方远控网页](https://zcode.z.ai/remote/v4)
- [当日网页入口 JS](https://zcode.z.ai/remote/v4/latest/assets/index-B-ilXaCQ.js)
- [当日共享协议 JS](https://zcode.z.ai/remote/v4/latest/assets/src-wmk2orCZ.js)
- [官方 ChannelClient 源码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/rpc/src/channelClient.ts)

共享 bundle SHA-256 为 `239ddb6707e80303e61c414bd82f6b2a1ef650c0a066149583463b02442039f9`。公共 latest 产物可能更新，复现时应重新确认版本和导出。

## 结论与剩余工作

**外部程序调用原 Host 改名这段链路已经跑通，可以作为独立 MCP 的传输基础**。用户提供的临时授权链接是此次实际鉴权入口；尚未验证无人操作取得链接、续期、断线恢复或多个客户端并存。

最近三轮聊天的提取、指定模型的 `workspace/generateText`、自动触发和生产 MCP 仍未端到端验证。真实发信、停止、归档等方法的权限不能从这一次改名成功推定。

此次通过业务事件和持久化读回确认新标题，没有单独做桌面视觉验收。当前界面显示效果由用户验收。

脱敏证据见 [external-host-rename-evidence.json](external-host-rename-evidence.json)。临时客户端、提取代码和运行日志在证据保存后清理；官方源码快照保持只读。


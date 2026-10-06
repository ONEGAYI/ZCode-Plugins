# 协议与投影库来源

- foundation.js、buffer.js、serialization.js、channels.shared.js、channelClient.js：来自 zai-org/ZCode commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 的 packages/rpc/src，经 Node.js stripTypeScriptTypes(mode:transform) 编译。
- projection.js：同一 commit 的 packages/shared/src/conversation-message-projection-policy.ts，经相同编译。
- 原源码未改，Apache-2.0 许可证见 LICENSE-ZCode。
- remote-shared.js：2026-10-06 读取的官方公共远控共享产物 https://zcode.z.ai/remote/v4/latest/assets/src-wmk2orCZ.js，原样保存；SHA-256 为 `239ddb6707e80303e61c414bd82f6b2a1ef650c0a066149583463b02442039f9`。该产物含共享 schema、分帧编码器和组装器。
- 只使用此构建的 Hs/Bs/Ws/S 导出。latest 产物可能变化，不自动更新；更新前需重新核对来源与契约。
- prompt.md 来自本机 oil-codex-title 的 prompts/naming.md，只将编辑器名称改为 ZCode。本项目没有修改该插件。

适配实现均位于 vendor 之外。本次只用于用户授权的本机研究与执行，没有对外发布。


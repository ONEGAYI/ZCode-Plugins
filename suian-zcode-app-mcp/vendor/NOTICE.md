# 消息投影库来源

`projection.js` 来自 [zai-org/ZCode](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/conversation-message-projection-policy.ts)，commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。

Node.js `stripTypeScriptTypes(mode:transform)` 转译产物统一保存在 [公共层 vendor](../../suian-zcode-common/vendor/NOTICE.md)，本插件直接引用，不再保存第二份实现。许可为 Apache-2.0，全文见 [公共许可证](../../suian-zcode-common/vendor/LICENSE-ZCode)。官方源码 submodule 未修改。

MCP SDK 和 Zod 通过 package-lock.json 固定版本安装，各自许可保留在所安装的软件包中。

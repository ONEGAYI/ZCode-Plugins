# suian-zcode-title — ZCode 会话自动命名插件

- 本仓库自包含：官方源码的研究与探查材料不随仓库分发，结论沉淀在 `docs/`（脱敏证据）；vendored 协议库的来源与许可见 `vendor/NOTICE.md`。
- 用户已授权自动命名的搭建、验证与 Stop Hook 自动配置；真实改名操作限定明确指定的测试会话或用户会话的自动触发。
- 不修改 ZCode 官方源码，不直接写 ZCode 会话数据库；改名仅走官方远控 RPC。
- 远控授权链接仅以当前用户 DPAPI 密文（`.local/remote.blob`）保存；配置、日志、Toast、提示词均不携带链接明文或其 sid/hash/mid 片段。
- Toast 按钮的打开动作固定指向用户自带默认工作区 `%USERPROFILE%\.zcode\workspace\default`，不随插件位置变化。
- 自动化测试与脚本严禁触发 `suian-zcode-title://` 协议激活链路（会弹 ZCode 官方确认模态框，无人值守时无限阻塞）。
- vendor 是固定来源的协议与投影库；版本信息见 vendor/NOTICE.md，不自动更新。
- 新行为先写契约测试，记录红绿验证日志（docs/round2-evidence.json）；不添加无关功能。

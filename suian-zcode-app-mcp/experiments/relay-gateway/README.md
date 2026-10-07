# 历史设备侧 relay 网关实验

本目录保留早期实验的 [脱敏阶段证据](./evidence.json)。真实 Desktop 与手机共存的后续验证见 [实测报告](../../docs/relay-gateway-coexistence.md)。这些记录反映当时的版本与范围，不是当前配置说明。

**实现已迁入独立公共子项目** [suian-zcode-gateway](../../../suian-zcode-gateway/README.md)，两个插件共用唯一 `gateway.mjs`、测试及 Windows 配置入口。不要在本目录重新维护或启动另一份网关。

完整 Agent 初始化、环境变量与重启方法见 [公共 skill](../../../suian-zcode-gateway/SKILL.md)。早期未鉴权公网探针已随实现迁入 [公共实验目录](../../../suian-zcode-gateway/experiments/probe-official.mjs)，不在安装时自动运行。

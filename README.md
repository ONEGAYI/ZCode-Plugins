# ZCode-Plugins

SUIAN 自维护的 ZCode 插件集合（monorepo）。每个子目录是一个独立插件，拥有自己的 AGENTS.md 与测试。

## 成员

| 插件 | 说明 |
|------|------|
| [suian-zcode-title](./suian-zcode-title/) | ZCode 会话自动命名：Stop Hook 后台经官方远控通道调用当前窗口模型，生成「emoji 对象｜目标」标题写回，失败弹 Windows 原生 Toast |

## 约定

- 子目录即插件根，插件自身的约定、安装与测试见其 `AGENTS.md` / `README.md`。
- 不入库内容（本机数据、密文、截图）由各插件目录的 `.gitignore` 声明；根级仅放通用规则。

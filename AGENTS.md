# ZCode-Plugins — ZCode 插件 monorepo 根

`ZCode-Plugins/` 是多个相互独立的 ZCode 插件的集总仓库；每个一级子目录是一个插件根，插件内部约定由其自身 `AGENTS.md` 维护，本文件只负责导航与仓库级约定。

## 仓库级约定

- 新增插件必须在本文件文件树登记，并拥有自己的 `AGENTS.md`；通用规则写这里，插件专属规则写插件内。
- 开源发布前完成个人信息脱敏（用户名、会话标识、本机路径、授权凭据），由插件各自 `.gitignore` 挡住运行时数据。
- 提交信息用中文，`类型: 简述` 格式，正文分条说明做了什么、为什么做。

## 文件树

```
ZCode-Plugins/
├── AGENTS.md               # 本文件：仓库导航与约定（单一事实源）
├── CLAUDE.md               # 通过 @AGENTS.md 导入主文件，仅附加 Claude 专属补充
├── README.md               # 面向开源读者的仓库简介
├── .gitignore              # 仓库级通用忽略规则
└── suian-zcode-title/      # ZCode 会话自动命名插件（Stop Hook + 远控命名 + Toast 通知）
```

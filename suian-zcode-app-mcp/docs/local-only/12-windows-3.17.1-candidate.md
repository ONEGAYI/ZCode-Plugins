# Windows 3.17.1 随包适配档案

日期：2026-10-29 提取、2026-10-30 核对登记。状态：仓库已追加自动路由档案，原生运行验收待完成。

交付为公共插件 `local-only/profiles/windows-3.17.1.9553.mjs` 及 `profiles.mjs` 注册项，不分发完整宿主包或独立补丁 ZIP。沿用 setup 的 status → prepare 流程，按本机 exe 版本和原版 asar 摘要自动选择档案、现场生成候选；退出宿主后执行 setup 生成的外部应用命令。发布构建自动收集 profiles 目录，无须在 setup 增加版本分支。

## 包身份

- exe FileVersion：`3.17.1.9553`
- 原版 app.asar：374627566 字节，SHA-256 `9a09f6ef7a938072c57f56d3dbf4b5677eaceb1c5b00ae555fb7e2bfdea88255`
- 入口：package.json main 实测仍为 `out/main/index.js`（865284 字节）
- fuses：sentinel 命中，wire `101000011`，asar 完整性校验 DISABLE（替换可行）
- 档案：`windows-3.17.1.9553-9a09f6ef`，独立补丁修订号 1
- 候选 app.asar：374630135 字节，SHA-256 `612dfc55605ed4fc783274ba3a8286f8d8fe0ccf541d44352b7d51759be01fc6`

## 适配与验证

六处替换锚点均按新包逐一核对，精确且唯一命中；另保留文件首部导入。3.16.x → 3.17.1 变量映射：relay WS 覆盖 `cA→Sx`、URL 覆盖 `dA→Cx`、manager `pi→Bt`、manager 引用 `Tf→rg`、排除 CUA 指示窗的窗口列表函数 `Oe→Ne`。WS 覆盖消费点两处（getEndpointUrls 回调闭包与构造期 options 求值）均在注入点之后，读到覆盖后的回环值；`zl`（chunk-ZP2RJMJD.js 内 `resolveWebRemoteControlRelayWsUrl`）对 overrideUrl 非空即直用，语义与旧包一致。

结构变化两处：`getToken`/`resolveDeviceSid` 注册从 manager 顶层 options 移至每会话 V2 relay 连接 options（编译产物字面量仍唯一，短路守卫语义不变）；`getToken` 内部新增单飞包装 `m(Gn,Rt,()=>...)`，短路后不执行。旧档案及其字节保持不变。

新增正式包路由、运行体与真实锚点切片全链注入测试（含 node --check）先因未登记包失败。追加档案后，local-only 核心测试（routing、patch、lifecycle、lab、3.16.3、3.17.1）共 69 项通过；补齐工作树依赖后 setup 与 release-build 共 65 项通过。候选两次 prepare 字节一致；实际包副本完成 apply → status(patched) → restore，恢复摘要与原版相同，unpacked 资源原样；公共插件发布目录构建通过，其中 CLI 独立路由命中新档案并携带全部三份档案。

本轮未应用到用户日常宿主。尚未完成新版无登录冷启动、官方远控不可达、网关重启恢复和 MCP 原生闭环，不能据以上静态及副本验证宣称新版已完成正式兼容验收。

可复核日志位于独立工作树忽略目录 `.scratch/lo-3171/`：prepare.log、build-release2.log、npm-ci.log、tests.log、tests-retry.log。验证用完整包副本与重复候选目录已清理，均不入库。

# PKG-07 发布操作手册（ZIP、Release 与市场清单）

本手册描述仓库级发布操作链。工具位于仓库根：`release-orchestrate.mjs`（构建与门禁）、`release-zip.mjs`（确定性 ZIP）、`release-verify.mjs`（产物契约校验）、`release-marketplace.mjs`（市场候选与版本统一检查）、`release-offline.mjs`（离线包）、`release-github.mjs`（Release 编排）和 `release-publish.mjs`（正式发布命令）。契约测试位于仓库根 `tests/release-*.test.mjs`。

所有构建输出（staging、ZIP、记录、候选清单）落在 `.scratch/release/`，已被仓库 `.gitignore` 挡住，不入源码 Git。

## 前置

```bash
cd <仓库根>
for p in suian-zcode-common suian-zcode-app-mcp suian-side-editor; do (cd $p && npm ci); done
```

title 无 npm 依赖，构建工具按公共层锁文件解析（common 的 esbuild）。

## 1. 构建、打包与发布记录

```bash
node release-orchestrate.mjs build \
  --tag <release-tag> \
  --base-url https://github.com/<owner>/<repo>/releases/download \
  --out .scratch/release
```

一次执行完成：

1. 子进程调用四包既有 `build-release.mjs`（PKG-02~04 契约，含公共代码不内联的构建期断言）。
2. 组装目录契约校验：插件身份与版本三方一致、隐藏 `.zcode-plugin/plugin.json`、入口与必备资源、无 node_modules/测试/文档/锁文件、无敏感文件与敏感内容（本机路径、凭据模式）、`release.json` 文件摘要逐项核对、业务包不携带 common 实现的逐字节副本（白名单：`locate.mjs` 薄定位器、`LICENSE`）。
3. 确定性 ZIP：条目按 posix 路径排序、时间戳固定（2026-01-01 00:00:00 DOS 纪元）、deflate 由 Node 内置 zlib 锁定；插件根直接位于压缩包根（`stripRoot:false` 前提）。同一输入重复打包字节一致。
4. ZIP 解压复验：实际解压到临时目录后重跑全部契约校验。
5. 发布记录 `release-record.json`（formatVersion 2）：绑定提交（HEAD）、每包源码及静态组装输入、实际构建依赖路径（取自各包 build-inputs.json，包括跨包薄定位器和第三方运行依赖）、根 LICENSE、仓库发布工具、Node 版本/平台与正式 ZIP 摘要。复用与门禁均重算这些输入；旧格式记录须重新构建，不能沿用缺少跨包输入的凭证。ZIP 内不含提交自引用。
6. 市场候选 `marketplace.candidate.json` 与版本统一检查报告。

**幂等复用**：再次执行 `build` 时，源码输入未变的包直接复用原 ZIP 字节与证据，不重跑构建器（规格 9.2：只改变提交身份不重建）；输入漂移只重建受影响包。`--plugins a,b` 可限定范围。

**不代选**：tag、插件版本由发布人决定，工具只校验一致性并报告，不自动升版。

## 2. 门禁核对（合并/推送阶段复用）

```bash
node release-orchestrate.mjs gate --out .scratch/release
```

核对当前源码输入与 ZIP 记录一致（漂移逐文件定位）、ZIP 文件仍在且摘要匹配。直接复用已有 ZIP，不重新构建、不追加全量。

## 3. 市场候选

`build` 已生成候选；也可单独重新生成：

```bash
node release-orchestrate.mjs marketplace --tag <tag> --base-url <base-url> --out .scratch/release
```

候选条目形状（对齐官方 CDN Zip Plugin Source 规范与规格 9.1）：`source = {source:"url", type:"zip", url:<固定 HTTPS Release 下载地址>, sha256:<64 位小写>, stripRoot:false}`；业务条目保留 `dependencies:["suian-zcode-common"]`。

根 `marketplace.json` 是手工维护的单一数据源。`marketplace.candidate.json` 用于发布前核对；正式采纳以第 4 节发布回执给出的已核验文件为准，只将受影响条目手工替换进根清单。未变插件保留已发布 URL 与摘要。

## 4. Release 流水线（须另行授权）

在干净的最终候选提交上，且已获准创建草稿和上传资产、发布环境已提供对应仓库的 `GH_TOKEN` 后，执行：

```powershell
node release-publish.mjs --out .scratch/release --title "{{Release 标题}}" --notes-file "{{发布说明文件}}"
```

命令读取 `release-record.json` 中的目标仓库、tag 与本轮 ZIP，核对门禁并从最终候选提交读取市场基线和离线指南，不重跑构建或测试。标题和说明由发布人提供，仅用于新建草稿。

获得公开授权后，以原参数加 `--publish` 续作。命令把已上传全部资产的同一条 Release 公开为**预发布**，匿名下载核对本轮资产，再复查 tag 是否仍指向候选提交。两项均通过才返回 `market-ready`，并通过 `report.marketCandidate` 交付 `marketplace.verified-<tag>.json`。此阶段不转正，也不修改正式市场清单。

续作时保留已公开资产，并复用绑定到当前 Release ID 的下载凭证。若同一 tag 的 Release 被重建，或旧凭证未记录 Release ID，命令复用已制好的离线包，重新匿名下载本轮资产。任何下载失败或 tag 改指都会阻止市场交接和转正。

### 宿主验收并核对 master 后转正

先用已核验的资产解包并在目标宿主完成安装验收，记录验收结果。获得正式集成授权后，将已核验的本轮市场条目随变更合入 `master`。这些步骤完成前，Release 保持预发布。

另行获得转正授权后，在**同一候选提交及输出目录**运行：

```powershell
node release-publish.mjs --out .scratch/release --finalize --host-verified
```

`--host-verified` 是对已完成宿主验收的人工确认。命令要求匿名下载凭证属于同一候选和当前 Release ID，通过 GitHub 读取 `master` 市场清单并核对本轮条目的版本、URL 和 SHA-256，再确认公开资产与 tag 未变。通过后只改元数据：解除同一条 Release 的预发布标记，再另发一次请求把它标为仓库 Latest；不重新制包、下载或上传资产。`--publish` 与 `--finalize` 不可同时执行。

Latest 标记不与解除预发布合并成一次请求：GitHub 规定草稿和预发布不能设为 Latest，合并写法是否生效未经证实，被拒绝会让转正整体失败。标记请求失败时命令报错，此时 Release 已转正但未标 Latest；重跑 `--finalize` 不会补发，需手动执行 `gh release edit <tag> --repo <owner>/<repo> --latest`。

### 每轮发布都生成 Windows x64 离线包

发布命令在建草稿前自动生成 `zcode-plugins-offline-windows-x64.zip`：本轮更新用已落盘的 ZIP，首次组包时核对其发布契约（门禁摘要一致不表示组装校验成功）；其余插件按候选清单的固定 URL 和 SHA-256 取回原发布 ZIP，不重新构建、不联动升版。四包的完整性、common API 和最低版本不兼容时停止。

离线包包含四个插件目录、本地市场清单、包根 `AGENTS.md` 和一份官方便携 Node.js、`sqlite3`。发布机需能匿名访问 GitHub、Node.js 和 SQLite 的资产地址；运行时版本与上游摘要固定在 `release-offline.mjs`，升级时同步更新。离线 ZIP 落在本轮 `zips/offline-*/` 的独立目录，首次写入远端草稿前即记录凭证。保留输出目录内的 `publish-<tag>.json` 及记录指向的 ZIP，用原参数续作，不重复制包。已公开版本缺任何本轮资产时停止，不补传或覆盖。

真实 GitHub 操作使用 `createGithubRestApi({owner, repo, token})`；**创建/发布 Release、推送 tag、切换正式市场清单均须另行发布授权**。自动化测试的 GitHub 写操作均使用模拟 API。仓库 Release 不可变性设置须在实际发布前人工读取确认，脚本不擅自修改仓库设置。已发布资产不删除重传：字节需变更时使用新版本与新 tag。

## 5. 回退

清单回退：`generateRollbackCandidate({current, previous, names})` 生成引用旧已发布 URL、旧摘要与配套版本集合的候选；旧资产不动。

**首次源码分发回退的限制**：旧版本（Git 源码分发）没有 Release ZIP，回退需把根 `marketplace.json` 对应条目恢复为 `source:"./<插件目录>"` 形态，并按旧流程恢复 npm 依赖安装与 `suian-zcode-common/link.mjs` 的 Node 包链接。首次迁移不承诺"无 setup 回退"；公共数据（网关数据目录等）默认不回滚。

## 6. 已知边界与遗留

- **common 发布目录覆盖面**（评审后收紧）：除 dist 客户端双入口、vendor 许可与 skills 外，发布根携带网关运行闭包（gateway/terminal 源、vendor 运行件、`node_modules/ws` 运行库，按 `gateway-deploy.mjs` 清单 from 原位落位，可直接作为部署 sourceRoot）与宿主管理链。depcheck-hook、migration、legacy-cleanup 各自打包为完整的自包含根入口，避免遗漏相对导入；其余管理资源包括 depcheck、depcheck-prompt、hooks、setup/run、稳定启动器及 SKILL.md。common profile 核对必备文件，发布契约直接执行诊断与迁移入口。`node_modules` 仅对 common 的 ws 运行库豁免，业务包零豁免。
- **正式公开下载与目标宿主验证**：由已授权的 PKG-09 执行；本票脚本全部通过不代表发行已完成。
- **side-editor 的 `locate.mjs`**：与 common 单一源码逐字节一致（PKG-04 契约），内联检测白名单放行；title/app-mcp 不携带独立定位器（经 bundle 内薄适配）。

## 7. 验证证据（2026-10-20）

- 契约红绿：先红（47 用例 46 失败，"尚未实现"）后绿（47/47 通过，EXIT=0），日志 `.scratch/pkg07-red.log`、`.scratch/pkg07-green.log`。
- 真实四包构建：`.scratch/pkg07-real-build.log`（EXIT=0，problems 空，版本统一检查通过）；复跑复用 ZIP（`.scratch/pkg07-reuse-check.log`，四包摘要不变）；门禁 `.scratch/pkg07-gate.log`（绑定提交 62b59a2，无漂移）。

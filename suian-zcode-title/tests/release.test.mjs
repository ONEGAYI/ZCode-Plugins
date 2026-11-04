// PKG-02 发布目录契约：title 从独立解包目录完成 CLI、Stop worker、提示词与安装检查。
// 世界构造沿用 PKG-01 的合成宿主存储根（installed_plugins.json + data/<plugin-id>），
// title 发布目录被复制为缓存内的安装物，所有断言只针对发布字节，不依赖开发 node_modules。
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { COMMON_RELEASE_DIR, TITLE_PLUGIN_ID } from "./common-fixture.mjs";
import { commonRuntime } from "../common-access.mjs";
import { buildRelease } from "../build-release.mjs";
import { runDoctor } from "../doctor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const titleRoot = resolve(here, "..");
const commonRoot = join(titleRoot, "..", "suian-zcode-common");
const nodeBin = process.execPath;
const AUMID = "SUIAN.SuianZcodeTitle.Toast";
const commonVersion = JSON.parse(await readFile(join(COMMON_RELEASE_DIR, "release.json"), "utf8")).pluginVersion;
const titleVersion = JSON.parse(await readFile(join(titleRoot, ".zcode-plugin", "plugin.json"), "utf8")).version;

const buildTo = async dirName => {
  const out = await mkdtemp(join(tmpdir(), dirName));
  const result = await buildRelease({ root: titleRoot, outDir: join(out, "release") });
  return { out, ...result };
};

const consumerEnv = (extra = {}) => {
  const env = { ...process.env };
  delete env.ZCODE_PLUGIN_DATA;
  return { ...env, ...extra };
};

// 合成宿主世界：title 发布目录与 common 发布目录都作为缓存安装物登记进同一安装记录。
async function buildWorld(t, { storageName = "宿主 存储根" } = {}) {
  const built = await buildTo("pkg02-world-src-");
  const releaseDir = built.releaseDir;
  const base = await mkdtemp(join(tmpdir(), "pkg02-world-"));
  const storageRoot = join(base, storageName);
  const dataDir = join(storageRoot, "data", TITLE_PLUGIN_ID);
  const commonInstall = join(storageRoot, "cache", "suian-zcode-plugins", "suian-zcode-common", commonVersion);
  const titleInstall = join(storageRoot, "cache", "suian-zcode-plugins", "suian-zcode-title", titleVersion);
  await cp(COMMON_RELEASE_DIR, commonInstall, { recursive: true });
  await cp(releaseDir, titleInstall, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const registryPath = join(storageRoot, "installed_plugins.json");
  const entry = (name, version, installPath) => ({
    id: `${name}@suian-zcode-plugins`, name, marketplace: "suian-zcode-plugins", version, installPath,
    installedAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", scope: "user",
  });
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    plugins: [entry("suian-zcode-common", commonVersion, commonInstall), entry("suian-zcode-title", titleVersion, titleInstall)],
  }));
  t.after(() => rm(base, { recursive: true, force: true }));
  t.after(() => rm(built.out, { recursive: true, force: true }));
  return { base, storageRoot, registryPath, dataDir, commonInstall, titleInstall };
}

const runCli = (world, argv, { stdin, env } = {}) => {
  const result = spawnSync(nodeBin, [join(world.titleInstall, "dist", "cli.mjs"), ...argv], {
    input: stdin, encoding: "utf8", windowsHide: true,
    env: consumerEnv(env ?? { ZCODE_PLUGIN_DATA: world.dataDir }),
  });
  const payload = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
  return { status: result.status, payload, stderr: result.stderr };
};

test("common 声明透传：API 或版本不满足时在业务副作用前失败", async t => {
  // 本用例必须是本进程内 commonRuntime 的首次调用（首次加载即冻结 common 根）。
  const base = await mkdtemp(join(tmpdir(), "pkg02-compat-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const apiTampered = join(base, "api-tampered");
  await cp(COMMON_RELEASE_DIR, apiTampered, { recursive: true });
  const apiReleasePath = join(apiTampered, "release.json");
  const apiRelease = JSON.parse(await readFile(apiReleasePath, "utf8"));
  apiRelease.commonApiVersion = 2;
  await writeFile(apiReleasePath, JSON.stringify(apiRelease));
  await assert.rejects(commonRuntime({ commonRoot: apiTampered }), error => {
    assert.equal(error.code, "api_incompatible");
    assert.equal(error.stage, "compat");
    return true;
  });
  const versionTampered = join(base, "version-tampered");
  await cp(COMMON_RELEASE_DIR, versionTampered, { recursive: true });
  const versionReleasePath = join(versionTampered, "release.json");
  const versionRelease = JSON.parse(await readFile(versionReleasePath, "utf8"));
  versionRelease.pluginVersion = "0.4.0";
  await writeFile(versionReleasePath, JSON.stringify(versionRelease));
  await assert.rejects(commonRuntime({ commonRoot: versionTampered }), error => {
    assert.equal(error.code, "version_insufficient");
    return true;
  });
});

test("旧路径契约：无链接的独立目录裸导入 suian-zcode-common 失败", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pkg02-bare-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = spawnSync(nodeBin, ["--input-type=module", "-e", "await import('suian-zcode-common/remote.mjs')"], { cwd: dir, encoding: "utf8", windowsHide: true, env: consumerEnv() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test("发布目录组装：四命令入口、提示词、技能、Hook 清单、许可与元数据齐备，无开发残留", async t => {
  const { out, releaseDir, release } = await buildTo("pkg02-build-");
  t.after(() => rm(out, { recursive: true, force: true }));
  for (const file of [
    "dist/cli.mjs", "dist/hook.mjs", "dist/install.mjs", "dist/toast-action.mjs",
    "prompt.md", "SKILL.md", "config.example.json", "hooks/hooks.json", ".zcode-plugin/plugin.json",
    "skills/setup/SKILL.md", "skills/configuration/SKILL.md", "skills/control/SKILL.md", "skills/debug/SKILL.md", "skills/paths.md",
    "LICENSE", "release.json",
  ]) {
    await assert.doesNotReject(() => stat(join(releaseDir, file)), `发布目录缺 ${file}`);
  }
  assert.equal((await readdir(join(releaseDir, "dist"))).length, 4, "dist 只含四个命令入口");
  const names = new Set((await readdir(releaseDir, { withFileTypes: true })).map(entry => entry.name));
  for (const forbidden of ["node_modules", "tests", "docs", ".local", ".scratch", "config.local.json", "package.json", "package-lock.json"]) {
    assert.equal(names.has(forbidden), false, `发布目录不得携带 ${forbidden}`);
  }
  assert.equal(release.formatVersion, 1);
  assert.equal(release.pluginName, "suian-zcode-title");
  assert.equal(release.packageName, "oil-zcode-title-runner");
  assert.equal(release.pluginVersion, titleVersion);
  assert.equal(release.commonApiVersion, 1);
  assert.equal(release.minimumCommonVersion, "0.5.0");
  assert.match(release.buildId, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(release.entries).sort(), ["cli", "hook", "install", "toast-action"]);
  const listed = release.files.map(file => file.path);
  assert.equal(listed.includes("release.json"), false, "文件清单不得包含 release.json 自身");
  for (const file of release.files) {
    const digest = createHash("sha256").update(await readFile(join(releaseDir, file.path))).digest("hex");
    assert.equal(digest, file.sha256, `${file.path} 摘要不符`);
  }
});

test("发布 Hook 清单指向 dist 内 worker，异步语义与配置参数保留", async t => {
  const { out, releaseDir } = await buildTo("pkg02-hooks-");
  t.after(() => rm(out, { recursive: true, force: true }));
  const spec = JSON.parse(await readFile(join(releaseDir, "hooks", "hooks.json"), "utf8")).hooks.Stop[0].hooks[0];
  assert.equal(spec.type, "command");
  assert.equal(spec.async, true, "Stop 必须后台执行不阻塞对话");
  assert.equal(spec.timeoutMs, 30000);
  assert.match(spec.command, /\$\{ZCODE_PLUGIN_ROOT\}\/dist\/hook\.mjs/);
  assert.match(spec.command, /--config "\$\{ZCODE_PLUGIN_DATA\}\/config\.json"/);
});

test("构建输入只允许薄定位器来自 common：不内联 common 实现或公共 vendor", async t => {
  const { out, inputsPath } = await buildTo("pkg02-meta-");
  t.after(() => rm(out, { recursive: true, force: true }));
  const inputs = JSON.parse(await readFile(inputsPath, "utf8"));
  assert.notEqual(inputsPath, join(inputsPath, "..", "release", "build-inputs.json"), "输入记录落在发布目录之外");
  const inputPaths = Object.keys(inputs.inputs);
  const fromCommon = inputPaths.filter(path => path.startsWith("..") && path.includes("suian-zcode-common"));
  assert.deepEqual(fromCommon, ["../suian-zcode-common/locate.mjs"], "来自 common 的构建输入必须恰好是薄定位器");
  assert.equal(inputPaths.some(path => path.includes("node_modules")), false, "发布产物不得由 node_modules 内容构成");
  assert.equal(inputPaths.some(path => path.includes("vendor/conversation-wire") || path.includes("vendor/projection")), false, "不得内联公共 vendor");
  assert.ok(inputPaths.includes("cli.mjs") && inputPaths.includes("hook.mjs") && inputPaths.includes("install.mjs") && inputPaths.includes("toast-action.mjs"));
});

test("包内无构建机绝对路径与用户数据", async t => {
  const { out, releaseDir } = await buildTo("pkg02-paths-");
  t.after(() => rm(out, { recursive: true, force: true }));
  const forbiddenLiterals = [titleRoot, commonRoot, tmpdir(), homedir(), "64487"].map(value => value.split("\\").join("/"));
  const checkText = async path => {
    const text = (await readFile(path, "utf8")).split("\\").join("/");
    for (const literal of forbiddenLiterals) {
      assert.equal(text.includes(literal), false, `${relative(releaseDir, path)} 泄漏本机路径或用户信息：${literal}`);
    }
  };
  for (const file of releaseFilesText(await readdir(join(releaseDir, "dist")))) await checkText(join(releaseDir, "dist", file));
  for (const file of ["release.json", "hooks/hooks.json", "prompt.md", "SKILL.md", "config.example.json"]) await checkText(join(releaseDir, file));
  for (const file of (await walkMarkdown(join(releaseDir, "skills")))) await checkText(file);
});

const walkMarkdown = async dir => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkMarkdown(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
};

const releaseFilesText = names => names.filter(name => name.endsWith(".mjs"));

test("buildId 确定性：同输入两次构建一致", async t => {
  const first = await buildTo("pkg02-det-1-");
  const second = await buildTo("pkg02-det-2-");
  t.after(() => rm(first.out, { recursive: true, force: true }));
  t.after(() => rm(second.out, { recursive: true, force: true }));
  assert.equal(first.release.buildId, second.release.buildId);
});

test("隔离世界：发布 Stop 命令经真实子进程运行，续跑保护输出与日志正常", async t => {
  const world = await buildWorld(t);
  const spec = JSON.parse(await readFile(join(world.titleInstall, "hooks", "hooks.json"), "utf8")).hooks.Stop[0].hooks[0];
  const command = spec.command.replaceAll("${ZCODE_PLUGIN_ROOT}", world.titleInstall).replaceAll("${ZCODE_PLUGIN_DATA}", world.dataDir);
  const result = spawnSync(command, {
    shell: true, encoding: "utf8", windowsHide: true,
    input: JSON.stringify({ session_id: "sess_release_stale", cwd: world.base, stop_hook_active: true }),
    env: consumerEnv({ ZCODE_PLUGIN_DATA: world.dataDir }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped_stale/);
  assert.ok(!result.stdout.startsWith("{"), "hook 输出不得以 { 开头");
  const log = JSON.parse((await readFile(join(world.dataDir, "state", "hook.log.jsonl"), "utf8")).trim().split("\n").at(-1));
  assert.equal(log.action, "skipped_stale");
});

test("隔离世界：Hook 派发的是包内 worker，参数携带会话元数据与实际配置路径，不触发真实改名", async t => {
  const world = await buildWorld(t);
  const recordFile = join(world.base, "spawn-record.json");
  const preload = join(world.base, "intercept-worker.mjs");
  await writeFile(preload, [
    "import cp from 'node:child_process';",
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { Writable } from 'node:stream';",
    "const originalSpawn = cp.spawn;",
    "cp.spawn = (command, args, options) => {",
    "  const chunks = [];",
    "  const stdin = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });",
    "  stdin.on('finish', () => { try { fs.writeFileSync(process.env.PKG02_SPAWN_RECORD, JSON.stringify({ command, args, detached: options?.detached, windowsHide: options?.windowsHide, dataEnv: options?.env?.OIL_ZCODE_TITLE_DATA, stdin: chunks.join('') }, null, 2)); } catch {} });",
    "  return { stdin, unref() {}, on() {}, kill() {} };",
    "};",
    "const originalSetTimeout = globalThis.setTimeout;",
    "globalThis.setTimeout = (fn, delay, ...rest) => delay >= 8000 ? originalSetTimeout(fn, 0, ...rest) : originalSetTimeout(fn, delay, ...rest);",
    "syncBuiltinESMExports();",
  ].join("\n"));
  const config = join(world.dataDir, "config.json");
  await writeFile(config, JSON.stringify({ registration: "native", enabled: true }));
  const result = spawnSync(nodeBin, ["--import", pathToFileURL(preload).href, join(world.titleInstall, "dist", "hook.mjs"), "--config", config], {
    encoding: "utf8", windowsHide: true,
    input: JSON.stringify({ session_id: "sess_release_worker", cwd: world.base }),
    env: consumerEnv({ ZCODE_PLUGIN_DATA: world.dataDir, PKG02_SPAWN_RECORD: recordFile }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dispatched/);
  let record = null;
  for (let attempt = 0; attempt < 20 && !record; attempt++) {
    try { record = JSON.parse(await readFile(recordFile, "utf8")); } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(record, "必须捕获 worker 派发参数");
  assert.equal(record.command, process.execPath);
  assert.equal(record.args[0], join(world.titleInstall, "dist", "cli.mjs"), "worker 必须是发布目录内的 CLI");
  assert.deepEqual(record.args.slice(1, 3), ["run", "--apply"]);
  assert.equal(record.args[3], "--config");
  assert.equal(record.args[4], config, "--config 必须指向实际外置配置");
  assert.deepEqual(JSON.parse(record.stdin), { session_id: "sess_release_worker", workspace_path: world.base }, "stdin 只传会话元数据");
  assert.equal(record.dataEnv, join(world.dataDir, "state"), "worker 环境携带数据目录");
  assert.equal(record.windowsHide, true, "后台 worker 必须隐藏窗口");
  assert.equal(record.detached, true);
});

test("隔离世界：发布 CLI 的 status 不依赖提示词镜像，加载运行期与安装期双入口", async t => {
  const world = await buildWorld(t);
  await writeFile(join(world.titleInstall,"prompt.md"),"损坏的镜像");
  const config = join(world.dataDir, "config.json");
  await writeFile(config, JSON.stringify({ dataDir: join(world.dataDir, "state") }));
  const run = runCli(world, ["status", "--config", config], { stdin: JSON.stringify({ session_id: "sess_release_status", cwd: world.base }) });
  assert.equal(run.status, 0, run.stderr + JSON.stringify(run.payload));
  assert.equal(run.payload.status, "status");
  assert.equal(run.payload.toast.appId, AUMID, "ensureToastAppId 证明 client-install 入口可用");
  assert.equal(run.payload.toast.cooldownActive, false, "shouldNotify 证明 client 入口可用");
});

test("隔离世界：发布 CLI 的 probe 经 common 网关客户端返回分层失败", async t => {
  const world = await buildWorld(t);
  const config = join(world.dataDir, "config.json");
  await writeFile(config, JSON.stringify({ dataDir: join(world.dataDir, "state"), gatewayConfigPath: join(world.dataDir, "missing-gateway.json") }));
  const run = runCli(world, ["probe", "--config", config], { stdin: JSON.stringify({ session_id: "sess_release_probe", cwd: world.base }) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.payload.status, "probe_failed");
  assert.equal(run.payload.reasonCode, "gateway_not_configured");
});

test("隔离世界：无锚点时定位失败先于数据副作用，报告定位阶段", async t => {
  const world = await buildWorld(t);
  const config = join(world.dataDir, "config.json");
  await writeFile(config, JSON.stringify({}));
  const stateDir = join(world.base, "不应创建的状态");
  const run = runCli(world, ["status", "--config", config], {
    stdin: JSON.stringify({ session_id: "sess_release_anchor", cwd: world.base }),
    env: { OIL_ZCODE_TITLE_DATA: stateDir },
  });
  assert.equal(run.status, 1);
  assert.equal(run.payload.status, "failed");
  assert.equal(run.payload.locator, "anchor_missing", "失败必须透出定位器错误码");
  await assert.rejects(stat(stateDir), { code: "ENOENT" }, "定位失败不得创建任何数据目录");
});

test("隔离世界：enable/disable 纯本地命令不依赖 common 定位", async t => {
  const world = await buildWorld(t);
  const config = join(world.dataDir, "config.json");
  await writeFile(config, JSON.stringify({}));
  const off = runCli(world, ["disable", "--config", config], {
    stdin: JSON.stringify({ session_id: "sess_release_local", cwd: world.base }),
    env: { OIL_ZCODE_TITLE_DATA: join(world.base, "local-state") }, // 无 ZCODE_PLUGIN_DATA：纯本地命令不得因锚点缺失失败
  });
  assert.equal(off.status, 0, off.stderr + JSON.stringify(off.payload));
  assert.equal(off.payload.status, "disabled_writing");
  assert.equal(JSON.parse(await readFile(config, "utf8")).enabled, false);
});

test("隔离世界：发布安装入口保留 sqlite3 只读 JSON 验证且仅检查不落盘", async t => {
  const world = await buildWorld(t);
  const config = join(world.dataDir, "config.json");
  await writeFile(config, JSON.stringify({ sqliteBin: process.env.SQLITE_BIN || "sqlite3" }));
  const stateDir = join(world.base, "check-only-state");
  const skill=await readFile(join(world.titleInstall,"skills/setup/SKILL.md"),"utf8");
  const documentedEntry=skill.match(/node "([^"]+)"/)[1].replaceAll("{{plugin_root}}",world.titleInstall).replaceAll("{{command_dir}}",join(world.titleInstall,"dist"));
  const result = spawnSync(nodeBin, [documentedEntry, stateDir, "--native-plugin", "--config", config, "--check-only"], {
    encoding: "utf8", windowsHide: true, env: consumerEnv({ ZCODE_PLUGIN_DATA: world.dataDir }),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "checked");
  assert.ok(payload.dependencies.sqlite_bin, "必须保留 sqlite3 只读 JSON 检查");
  await assert.rejects(stat(stateDir), { code: "ENOENT" }, "仅检查不得创建数据目录");
});

test("隔离世界：无宿主环境时发布安装入口接受三种明确 common 锚点", async t => {
  const world = await buildWorld(t);
  const home = join(world.base, "隔离 HOME");
  await mkdir(home);
  for (const mode of ["common-root", "installed-plugins", "config"]) {
    await t.test(mode, async () => {
      const config = join(world.dataDir, mode + ".json");
      await writeFile(config, JSON.stringify({
        sqliteBin: process.env.SQLITE_BIN || "sqlite3",
        ...(mode === "config" ? { installedPluginsPath: world.registryPath } : {}),
      }));
      const args = mode === "config" ? [] : ["--" + mode, mode === "common-root" ? world.commonInstall : world.registryPath];
      const stateDir = join(world.base, mode + "-state");
      const result = spawnSync(nodeBin, [join(world.titleInstall, "dist", "install.mjs"), stateDir,
        "--native-plugin", "--config", config, "--check-only", ...args], {
        encoding: "utf8", windowsHide: true,
        env: consumerEnv({ HOME: home, USERPROFILE: home }),
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const payload = JSON.parse(result.stdout.trim());
      assert.equal(payload.action, "checked");
      assert.ok(payload.dependencies.sqlite_bin);
      await assert.rejects(stat(stateDir), { code: "ENOENT" });
    });
  }
});

test("隔离世界：doctor 的 native 分支读取发布根 Hook 清单", async () => {
  const { out, releaseDir } = await buildTo("pkg02-doctor-");
  try {
    const backend = {
      read: async () => ({ title: "原名", turnCount: 1, context: { recent_turns: [1, 2, 3] } }),
      models: async () => ({ providers: [1, 2] }),
    };
    const result = await runDoctor({ backend, event: { session_id: "sess_release_doctor" }, config: { registration: "native" }, pluginRoot: releaseDir, configFile: join(releaseDir, "no-user-config.json") });
    assert.equal(result.status, "ready");
    assert.equal(result.hook, "configured", "发布 Hook 清单自带异步 Stop 定义，静态检查应就绪");
    assert.equal(result.hookDetails.source, "plugin");
    assert.equal(result.hookDetails.configFile, join(releaseDir, "hooks", "hooks.json"));
    assert.equal(result.hookDetails.execution, "not_verified", "静态就绪不代表实际触发");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

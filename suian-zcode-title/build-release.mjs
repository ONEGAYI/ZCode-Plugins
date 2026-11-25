// 构建 title 发布目录（PKG-02）：四个命令入口经 esbuild 打包进 dist/，提示词、技能、
// Hook 清单与插件清单留在发布根。业务产物不内联 common 实现或公共 vendor——构建期即断言
// 来自 common 的输入恰好是薄定位器 locate.mjs，违反时直接失败不产出。
// esbuild 是 common 的锁定开发依赖（0.28.2）；title 自身无 npm 依赖，构建工具按公共层
// 锁文件解析，不引入 title 侧 node_modules。
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const toPosix = path => path.split(sep).join("/");
const defaultRoot = dirname(fileURLToPath(import.meta.url));
const commonRoot = resolve(defaultRoot, "..", "suian-zcode-common");
const { build, version: esbuildVersion } = createRequire(join(commonRoot, "package.json"))("esbuild");

const ENTRIES = { cli: "cli.mjs", hook: "hook.mjs", install: "install.mjs", "toast-action": "toast-action.mjs" };
const DIST_ENTRIES = Object.fromEntries(Object.entries(ENTRIES).map(([key, file]) => [key, `dist/${file}`]));
const TARGET = "node24";
const RESOURCES = ["prompt.md", "SKILL.md", "config.example.json"];
const RESOURCE_DIRS = ["skills"];

const sha256 = buffer => createHash("sha256").update(buffer).digest("hex");
const normalizeKey = (root, key) => toPosix(relative(root, resolve(key)));
const sortedObject = value => Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)));

async function walkFiles(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walkFiles(path, base));
    else found.push(toPosix(relative(base, path)));
  }
  return found;
}

async function findLicense(root) {
  for (const candidate of [join(root, "..", "LICENSE"), join(root, "LICENSE"), join(defaultRoot, "..", "LICENSE")]) {
    try { await readFile(candidate); return candidate; } catch {}
  }
  throw new Error("找不到仓库 LICENSE（依次尝试插件上级、插件根与仓库根）");
}

export async function buildRelease({ root = defaultRoot, outDir } = {}) {
  if (!outDir) throw new Error("缺少 --out <dir>");
  root = resolve(root);
  outDir = resolve(outDir);
  // 构建前清空输出目录：残留旧文件会进入 release.json 清单与 buildId，重复构建必须幂等。
  const staleEntries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  if (staleEntries.some(entry => entry.name === ".git")) throw new Error("输出目录包含 .git，疑似误传仓库路径，拒绝清空");
  if (staleEntries.length > 0) await rm(outDir, { recursive: true, force: true });
  const distDir = join(outDir, "dist");
  await mkdir(distDir, { recursive: true });

  const inputs = {};
  for (const [key, entry] of Object.entries(ENTRIES)) {
    const result = await build({
      entryPoints: [join(root, entry)],
      outfile: join(outDir, DIST_ENTRIES[key]),
      bundle: true,
      format: "esm",
      platform: "node",
      target: TARGET,
      legalComments: "inline",
      metafile: true,
      logLevel: "silent",
    });
    for (const inputKey of Object.keys(result.metafile.inputs)) {
      inputs[normalizeKey(root, inputKey)] = sha256(await readFile(resolve(inputKey)));
    }
  }

  // 发布自检：common 侧输入必须恰好是薄定位器；多了即内联公共实现，少了即定位链断裂。
  const expectedLocator = toPosix(relative(root, join(commonRoot, "locate.mjs")));
  const fromCommon = Object.keys(inputs).filter(key => key.startsWith("..") && key.includes("suian-zcode-common"));
  if (fromCommon.length !== 1 || fromCommon[0] !== expectedLocator) {
    throw new Error(`发布产物的 common 输入不符：实际 ${JSON.stringify(fromCommon)}，预期 [${JSON.stringify(expectedLocator)}]`);
  }

  // 资源与清单组装；hooks.json 的 hook 命令改指 dist 内 bundle，其余字段原样保留。
  for (const name of RESOURCES) await cp(join(root, name), join(outDir, name));
  for (const dir of RESOURCE_DIRS) await cp(join(root, dir), join(outDir, dir), { recursive: true });
  await cp(join(root, ".zcode-plugin"), join(outDir, ".zcode-plugin"), { recursive: true });
  await mkdir(join(outDir, "hooks"), { recursive: true });
  const hooksSpec = JSON.parse(await readFile(join(root, "hooks", "hooks.json"), "utf8"));
  for (const event of ["Stop", "UserPromptSubmit"]) {
    const hook = hooksSpec.hooks?.[event]?.[0]?.hooks?.[0];
    if (!hook || !hook.command.includes("${ZCODE_PLUGIN_ROOT}/hook.mjs")) {
      throw new Error("源码 Hook 清单缺少预期的 " + event + " 命令形态，改写发布版前先人工核对");
    }
    hook.command = hook.command.replace("${ZCODE_PLUGIN_ROOT}/hook.mjs", "${ZCODE_PLUGIN_ROOT}/dist/hook.mjs");
  }
  await writeFile(join(outDir, "hooks", "hooks.json"), `${JSON.stringify(hooksSpec, null, 2)}\n`);
  await cp(await findLicense(root), join(outDir, "LICENSE"));

  const files = [];
  for (const path of (await walkFiles(outDir)).sort()) {
    const content = await readFile(join(outDir, path));
    files.push({ path, sha256: sha256(content), bytes: content.length });
  }

  const config = { target: TARGET, entries: ENTRIES, esbuildVersion };
  const inputDigest = sha256(JSON.stringify({ config, inputs: sortedObject(inputs) }));
  const buildId = sha256(JSON.stringify({ inputDigest, outputs: files.map(({ path, sha256: digest }) => [path, digest]) }));

  const { EXPECTED_COMMON_API_VERSION, MINIMUM_COMMON_VERSION } = await import(pathToFileURL(join(root, "common-access.mjs")).href);
  const manifest = JSON.parse(await readFile(join(root, ".zcode-plugin", "plugin.json"), "utf8"));
  const release = {
    formatVersion: 1,
    pluginName: manifest.name,
    packageName: JSON.parse(await readFile(join(root, "package.json"), "utf8")).name,
    pluginVersion: manifest.version,
    buildId,
    commonApiVersion: EXPECTED_COMMON_API_VERSION,
    minimumCommonVersion: MINIMUM_COMMON_VERSION,
    entries: { ...DIST_ENTRIES },
    files,
  };
  await writeFile(join(outDir, "release.json"), `${JSON.stringify(release, null, 2)}\n`);

  // 构建输入记录是发布证据，落在发布目录之外，不进入文件清单。
  const inputsPath = join(dirname(outDir), "build-inputs.json");
  await writeFile(inputsPath, `${JSON.stringify({ config, inputDigest, inputs: sortedObject(inputs) }, null, 2)}\n`);
  return { releaseDir: outDir, release, inputsPath };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const result = await buildRelease({ outDir: values.out });
  console.log(JSON.stringify({ releaseDir: result.releaseDir, buildId: result.release.buildId, inputsPath: result.inputsPath }));
}

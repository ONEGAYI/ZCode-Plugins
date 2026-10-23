// 源码测试预载（node --import）：为测试进程与子进程提供可定位的 common 发布夹具。
// title 的公共导入已迁移到 PKG-01 客户端契约，进程内不再有 node_modules 包链接可用；
// 本文件按官方安装记录布局构造合成宿主存储根（storageRoot/installed_plugins.json +
// storageRoot/data/<plugin-id>），并把 ZCODE_PLUGIN_DATA 指向 title 的数据目录。
// common 发布目录按输入摘要缓存到系统临时目录，多测试进程冷启动并发时各自构建、
// rename 竞争失败方复用已有缓存。临时目录交给系统清理，不做进程退出钩子。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const titleRoot = fileURLToPath(new URL("..", import.meta.url));
const commonRoot = join(titleRoot, "..", "suian-zcode-common");
const TITLE_PLUGIN_ID = "suian-zcode-title@suian-zcode-plugins";
export { TITLE_PLUGIN_ID };

async function collectInputDigests(dir, exts, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".scratch" || entry.name === "docs" || entry.name === "tests") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectInputDigests(path, exts, found);
    else if (exts.some(ext => entry.name.endsWith(ext))) found.push([path, createHash("sha256").update(await readFile(path)).digest("hex")]);
  }
  return found;
}

async function buildCachedCommonRelease() {
  const inputs = await collectInputDigests(commonRoot, [".mjs", ".js", ".json"]);
  const digest = createHash("sha256").update(JSON.stringify(inputs.map(([path, hash]) => [path.slice(commonRoot.length), hash]))).digest("hex").slice(0, 16);
  const cacheDir = join(tmpdir(), `pkg02-common-release-${digest}`);
  if (existsSync(join(cacheDir, "release.json"))) return cacheDir;
  const staging = await mkdtemp(join(tmpdir(), "pkg02-common-build-"));
  try {
    const { buildRelease } = await import(pathToFileURL(join(commonRoot, "build-release.mjs")).href);
    await buildRelease({ root: commonRoot, outDir: join(staging, "release") });
    try {
      await rename(join(staging, "release"), cacheDir);
    } catch (error) {
      if (!existsSync(join(cacheDir, "release.json"))) throw error;
    }
    return cacheDir;
  } finally {
    // staging 残留（rename 成功后的空目录或竞争失败副本）交系统临时目录清理。
  }
}

const releaseDir = await buildCachedCommonRelease();
const commonVersion = JSON.parse(await readFile(join(releaseDir, "release.json"), "utf8")).pluginVersion;
const titleVersion = JSON.parse(await readFile(join(titleRoot, ".zcode-plugin", "plugin.json"), "utf8")).version;
const storageRoot = join(tmpdir(), `pkg02-storage-${process.pid}`);
const dataPath = join(storageRoot, "data", TITLE_PLUGIN_ID);
export const FIXTURE_TITLE_ROOT = join(storageRoot, "cache", "suian-zcode-plugins", "suian-zcode-title", titleVersion);
export const COMMON_RELEASE_DIR = releaseDir;
export const FIXTURE_STORAGE_ROOT = storageRoot;
await mkdir(join(FIXTURE_TITLE_ROOT, ".zcode-plugin"), { recursive: true });
await mkdir(dataPath, { recursive: true });
await writeFile(join(storageRoot, "installed_plugins.json"), JSON.stringify({
  version: 1,
  plugins: [
    {
      id: "suian-zcode-common@suian-zcode-plugins", name: "suian-zcode-common", marketplace: "suian-zcode-plugins",
      version: commonVersion, installPath: releaseDir,
      installedAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", scope: "user",
    },
    {
      id: TITLE_PLUGIN_ID, name: "suian-zcode-title", marketplace: "suian-zcode-plugins",
      version: titleVersion, installPath: FIXTURE_TITLE_ROOT,
      installedAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", scope: "user",
    },
  ],
}));
process.env.ZCODE_PLUGIN_DATA = dataPath;
process.env.SUIAN_PKG02_FIXTURE_STORAGE = storageRoot;

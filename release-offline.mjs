// 将正式的插件 ZIP 转成本地市场目录，另附一份 Windows x64 运行时。不重新构建插件。
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMarketplaceEntry } from './release-marketplace.mjs';
import { PLUGIN_ORDER } from './release-orchestrate.mjs';
import { extractZip, readZipEntry, writeDeterministicZip } from './release-zip.mjs';
import { verifyReleaseDir } from './release-verify.mjs';
import { COMMON_PACKAGE, scanSuianPlugins } from './suian-zcode-common/depcheck.mjs';

export const OFFLINE_MARKETPLACE = 'suian-zcode-plugins';
const FILE_NAME = 'zcode-plugins-offline-windows-x64.zip';
const AGENTS = new URL('./offline/AGENTS.md', import.meta.url);
const SOURCE_ROOT = fileURLToPath(new URL('./', import.meta.url));
const RUNTIME_SOURCES = [
  {
    url: 'https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip',
    algorithm: 'sha256',
    digest: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
    files: {
      'node-v24.22.3-win-x64/node.exe': 'runtime/node/node.exe',
      'node-v24.22.3-win-x64/LICENSE': 'runtime/node/LICENSE',
    },
  },
  {
    url: 'https://www.sqlite.org/2026/sqlite-tools-win-x64-3540100.zip',
    algorithm: 'sha3-256',
    digest: 'e171f3993a992edf076746926dd52b5e2ebfabaee38818e74987e1d8112ab987',
    files: { 'sqlite3.exe': 'runtime/sqlite/sqlite3.exe' },
  },
];

export async function buildOfflineReleaseAsset({
  marketCandidate, zips, download, outDir, agentsText, runtimeSources = RUNTIME_SOURCES,
}) {
  const entries = marketCandidate.plugins;
  if (marketCandidate.name !== OFFLINE_MARKETPLACE || entries.length !== PLUGIN_ORDER.length) {
    throw new Error('离线包需要完整的 suian-zcode-plugins 候选市场清单');
  }
  const ordered = PLUGIN_ORDER.map(name => {
    const entry = entries.find(item => item.name === name);
    if (!entry) throw new Error(`离线包缺少市场条目：${name}`);
    const shape = validateMarketplaceEntry(entry);
    if (!shape.ok) throw new Error(`离线包市场条目不合法（${name}）：${JSON.stringify(shape.problems)}`);
    return entry;
  });

  const localZip = zips.find(zip => zip.zipPath);
  outDir = resolve(outDir ?? (localZip ? dirname(localZip.zipPath) : tmpdir()));
  await mkdir(outDir, { recursive: true });
  const assetDir = await mkdtemp(join(outDir, 'offline-'));
  const workDir = join(assetDir, 'staging');
  const bundle = join(workDir, 'bundle');
  const temporaryZip = join(workDir, 'source.zip');
  let asset;
  try {
    await mkdir(workDir);
    const installed = [];
    for (const { name, version, source, dependencies } of ordered) {
      const local = zips.find(zip => zip.name === name);
      const bytes = local ? (local.zipPath ? await readFile(local.zipPath) : local.bytes) : await download(source.url);
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        throw new Error(`离线包插件 ZIP 摘要不匹配：${name}@${version}`);
      }
      await writeFile(temporaryZip, bytes);
      const root = join(bundle, 'plugins', name);
      await extractZip(temporaryZip, root);
      const plugin = JSON.parse(await readFile(join(root, '.zcode-plugin', 'plugin.json'), 'utf8'));
      const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
      if (plugin.name !== name || plugin.version !== version || release.pluginName !== name || release.pluginVersion !== version) {
        throw new Error(`离线包插件身份或版本不匹配：${name}@${version}`);
      }
      const common = name === COMMON_PACKAGE;
      const api = common ? release.commonApiVersion : release.expectedCommonApiVersion ?? release.commonApiVersion;
      if (!Number.isInteger(api) || (!common && !release.minimumCommonVersion)) {
        throw new Error(`离线包插件缺少 common 兼容声明：${name}@${version}`);
      }
      if (local) {
        // v2 发布记录即使构建校验失败也会落盘；摘要一致不是产物校验成功证据。
        const verified = await verifyReleaseDir({
          releaseDir: root, pluginName: name, expectedVersion: version,
          commonReleaseDir: common ? undefined : join(bundle, 'plugins', COMMON_PACKAGE),
          sensitiveRoots: [SOURCE_ROOT, homedir(), tmpdir()],
        });
        if (!verified.ok) throw new Error(`本轮插件 ZIP 未通过发布校验（${name}@${version}）：${JSON.stringify(verified.problems)}`);
      }
      installed.push({ name, version, installPath: root, dependencies });
    }

    // 用真实的运行期规则检查混合版本；旧业务 ZIP 可能不兼容本轮新 common，反之亦然。
    const pluginsFile = join(workDir, 'installed_plugins.json');
    await writeFile(pluginsFile, JSON.stringify({ plugins: installed }));
    const check = await scanSuianPlugins({ pluginsFile, toolsRoot: workDir });
    if (!check.ok) throw new Error(`离线包配套检查失败：${JSON.stringify(check.issues)}`);

    for (const { url, algorithm, digest, files } of runtimeSources) {
      const bytes = await download(url);
      if (createHash(algorithm).update(bytes).digest('hex') !== digest) {
        throw new Error(`离线包运行时 ZIP 摘要不匹配：${url}`);
      }
      await writeFile(temporaryZip, bytes);
      for (const [entry, target] of Object.entries(files)) {
        const path = join(bundle, target);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, await readZipEntry(temporaryZip, entry));
      }
    }
    const provenance = runtimeSources.map(({ url, algorithm, digest }) => ({ url, algorithm, digest }));
    await writeFile(join(bundle, 'runtime', 'sources.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    await writeFile(join(bundle, 'AGENTS.md'), agentsText ?? await readFile(AGENTS));
    const marketplace = {
      name: OFFLINE_MARKETPLACE,
      plugins: ordered.map(({ source, icon, ...entry }) => ({ ...entry, source: `./plugins/${entry.name}` })),
    };
    await writeFile(join(bundle, 'marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`);
    const { zipPath, zipSha256 } = await writeDeterministicZip({ sourceDir: bundle, zipPath: join(assetDir, FILE_NAME) });
    asset = { name: 'offline-windows-x64', fileName: FILE_NAME, zipPath, sha256: zipSha256 };
    return asset;
  } finally {
    await rm(asset ? workDir : assetDir, { recursive: true, force: true });
  }
}

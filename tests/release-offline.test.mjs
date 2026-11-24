import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runReleasePipeline } from '../release-github.mjs';
import { buildOfflineReleaseAsset } from '../release-offline.mjs';
import { PLUGIN_PROFILES } from '../release-verify.mjs';
import { packZipEntries, readZipEntry } from '../release-zip.mjs';

const names = ['suian-zcode-common', 'suian-zcode-title', 'suian-zcode-app-mcp', 'suian-side-editor'];
const tag = 'test-release';
const base = 'https://github.com/o/r/releases/download';
const offlineName = 'zcode-plugins-offline-windows-x64.zip';
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const archive = files => packZipEntries(Object.entries(files).map(([path, data]) => ({ path, data })));
const pluginArchive = (name, version, compat = {}, omit = []) => {
  const common = name === names[0];
  const manifest = { name, version, ...(!common && { dependencies: [names[0]] }) };
  const { requiredFiles, requiredDirs } = PLUGIN_PROFILES[name];
  const files = {
    ...Object.fromEntries([...requiredFiles, ...requiredDirs.map(dir => `${dir}/fixture.mjs`)]
      .map(path => [path, `fixture: ${name}/${path}`])),
    '.zcode-plugin/plugin.json': JSON.stringify(manifest),
    'marker.txt': `published bytes: ${name}@${version}`,
  };
  for (const path of omit) delete files[path];
  return archive({
    ...files,
    'release.json': JSON.stringify({
      formatVersion: 1, pluginName: name, pluginVersion: version, buildId: digest(name), entries: {},
      commonApiVersion: 1, ...(!common && { minimumCommonVersion: '1.0.0' }), ...compat,
      files: Object.entries(files).map(([path, content]) => ({ path, sha256: digest(content) })),
    }),
  });
};

test('局部发行自动汇总四个正式版本；离线包与本轮 ZIP 一起上传、下载核验，线上市场仅更新本轮插件', async t => {
  const outDir = await mkdtemp(join(tmpdir(), 'zcode-release-offline-test-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const remote = new Map();
  const downloads = [];
  const plugins = [];
  const zips = [];
  for (const [index, name] of names.entries()) {
    const version = index === 0 ? '2.0.0' : '1.0.0';
    const dependencies = index === 0 ? {} : { dependencies: [names[0]] };
    const fileName = `${name}-${version}.zip`;
    const bytes = pluginArchive(name, version);
    const sha256 = digest(bytes);
    const url = `${base}/${index === 0 ? tag : 'older-tag'}/${fileName}`;
    plugins.push({ name, version, ...dependencies, icon: 'https://example.com/icon.png',
      source: { source: 'url', type: 'zip', url, sha256, stripRoot: false } });
    if (index === 0) {
      const zipPath = join(outDir, fileName);
      await writeFile(zipPath, bytes);
      zips.push({ name, fileName, zipPath, sha256 });
    } else {
      remote.set(url, bytes);
    }
  }

  const runtimeSources = [
    { url: 'https://nodejs.org/test.zip', algorithm: 'sha256',
      files: { 'node/node.exe': 'runtime/node/node.exe', 'node/LICENSE': 'runtime/node/LICENSE' } },
    { url: 'https://sqlite.org/test.zip', algorithm: 'sha3-256',
      files: { 'sqlite3.exe': 'runtime/sqlite/sqlite3.exe' } },
  ];
  for (const runtime of runtimeSources) {
    const bytes = archive(Object.fromEntries(Object.keys(runtime.files).map(name => [name, `fixture: ${name}`])));
    runtime.digest = digest(bytes, runtime.algorithm);
    remote.set(runtime.url, bytes);
  }
  const commit = 'a'.repeat(40);
  const release = { id: 1, draft: true, prerelease: true, target_commitish: commit };
  const uploads = [];
  const githubApi = {
    getTagCommit: async () => release.draft ? null : commit,
    getReleaseByTag: async () => release,
    listAssets: async () => uploads,
    getAssetDigest: async asset => digest(remote.get(`${base}/${tag}/${asset.name}`)),
    uploadAsset: async (_release, { name, zipPath }) => {
      assert.equal(release.draft, true);
      uploads.push({ name, zipPath });
      remote.set(`${base}/${tag}/${name}`, await readFile(zipPath));
    },
    updateRelease: async (_release, patch) => Object.assign(release, patch),
    assetDownloadUrl: (_release, { name }) => `${base}/${tag}/${name}`,
  };
  const marketCandidate = { name: 'suian-zcode-plugins', plugins };
  const originalMarket = structuredClone(marketCandidate);
  const input = {
    githubApi, zips, marketCandidate, releaseTag: tag, candidateCommit: commit, authorize: { publish: true },
    download: async url => {
      downloads.push(url);
      assert.ok(remote.has(url), `unexpected download: ${url}`);
      return remote.get(url);
    },
    prepareOffline: options => buildOfflineReleaseAsset({ ...options, runtimeSources }),
  };
  await t.test('组包期间同名 tag 指向另一提交，不创建草稿或上传', async () => {
    let tagCommit = null, writes = 0;
    const result = await runReleasePipeline({
      ...input,
      githubApi: {
        ...githubApi,
        getTagCommit: async () => tagCommit,
        getReleaseByTag: async () => null,
        createDraftRelease: async () => { writes++; return release; },
        uploadAsset: async () => { writes++; },
      },
      authorize: { publish: false },
      prepareOffline: async options => {
        const asset = await input.prepareOffline(options);
        tagCommit = 'b'.repeat(40);
        return asset;
      },
    });
    assert.equal(result.error?.code, 'tag_commit_mismatch');
    assert.equal(writes, 0);
  });
  await t.test('旧业务包与本轮 common 不兼容，汇总失败', async () => {
    const candidate = structuredClone(marketCandidate);
    const title = candidate.plugins[1];
    const incompatible = pluginArchive(title.name, title.version, { commonApiVersion: 2, minimumCommonVersion: '3.0.0' });
    title.source.sha256 = digest(incompatible);
    await assert.rejects(buildOfflineReleaseAsset({
      marketCandidate: candidate, zips, runtimeSources, outDir,
      download: async url => url === title.source.url ? incompatible : remote.get(url),
    }), /suian-zcode-title.*api_incompatible.*version_insufficient/s);
  });
  await t.test('记录摘要吻合但当前 ZIP 缺少必备文件，不能进入发布', async () => {
    const candidate = structuredClone(marketCandidate);
    const common = candidate.plugins[0];
    const incomplete = pluginArchive(common.name, common.version, {}, ['gateway.mjs']);
    common.source.sha256 = digest(incomplete);
    await assert.rejects(buildOfflineReleaseAsset({
      marketCandidate: candidate, zips: [{ name: common.name, bytes: incomplete }], runtimeSources, outDir,
      download: async url => remote.get(url),
    }), /resource_missing.*gateway\.mjs/);
  });
  await t.test('两次制包不覆盖前一次落盘的凭证', async () => {
    const options = { marketCandidate, zips, runtimeSources, outDir, download: async url => remote.get(url) };
    const first = await buildOfflineReleaseAsset(options);
    const second = await buildOfflineReleaseAsset(options);
    assert.equal(first.fileName, second.fileName);
    assert.notEqual(first.zipPath, second.zipPath);
    assert.equal(digest(await readFile(first.zipPath)), first.sha256);
  });
  await t.test('纯字节载荷不依赖本轮 ZIP 的磁盘路径', async sub => {
    const [zip] = zips;
    const bytes = await readFile(zip.zipPath);
    const asset = await buildOfflineReleaseAsset({
      marketCandidate, zips: [{ name: zip.name, bytes }], runtimeSources,
      download: async url => remote.get(url),
    });
    const assetDir = dirname(asset.zipPath);
    assert.equal(dirname(assetDir), resolve(tmpdir()));
    assert.match(basename(assetDir), /^offline-/);
    sub.after(() => rm(assetDir, { recursive: true, force: true }));
    assert.equal(String(await readZipEntry(asset.zipPath, `plugins/${zip.name}/marker.txt`)), `published bytes: ${zip.name}@2.0.0`);
  });
  await t.test('上游运行时摘要不符，不能上传或公开', async () => {
    await assert.rejects(runReleasePipeline({
      ...input, download: url => url === runtimeSources[1].url ? Buffer.from('damaged') : input.download(url),
    }), /运行时 ZIP 摘要不匹配.*sqlite/);
    assert.equal(uploads.length, 0);
    assert.equal(release.draft, true);
  });
  await t.test('同名 Release 已公开且没有离线包时，不向已公开版本补传', async () => {
    release.draft = false;
    try {
      const result = await runReleasePipeline(input);
      assert.equal(result.error?.code, 'offline_asset_missing_after_publish');
      assert.equal(uploads.length, 0);
    } finally {
      release.draft = true;
    }
  });
  const result = await runReleasePipeline(input);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.state.stage, 'market-ready');
  assert.deepEqual(uploads.map(asset => asset.name), [zips[0].fileName, offlineName]);
  assert.deepEqual(result.state.downloads.map(item => item.fileName), [zips[0].fileName, offlineName]);
  assert.equal(release.prerelease, true);
  assert.deepEqual(marketCandidate, originalMarket);

  const zipPath = uploads[1].zipPath;
  const localMarket = JSON.parse(await readZipEntry(zipPath, 'marketplace.json'));
  assert.equal(localMarket.name, 'suian-zcode-plugins');
  assert.deepEqual(localMarket.plugins.map(({ name, version, source, dependencies, icon }) =>
    ({ name, version, source, dependencies, icon })), names.map((name, index) => ({
    name, version: index === 0 ? '2.0.0' : '1.0.0', source: `./plugins/${name}`,
    dependencies: index === 0 ? undefined : [names[0]], icon: undefined,
  })));
  for (const { name, version } of plugins) {
    assert.equal(String(await readZipEntry(zipPath, `plugins/${name}/marker.txt`)), `published bytes: ${name}@${version}`);
  }
  assert.match(String(await readZipEntry(zipPath, 'AGENTS.md')), /离线安装/);
  assert.equal(String(await readZipEntry(zipPath, 'runtime/node/node.exe')), 'fixture: node/node.exe');
  assert.equal(String(await readZipEntry(zipPath, 'runtime/node/LICENSE')), 'fixture: node/LICENSE');
  assert.equal(String(await readZipEntry(zipPath, 'runtime/sqlite/sqlite3.exe')), 'fixture: sqlite3.exe');

  // 发布续作沿用原离线包和匿名下载凭证，不重新下载旧版本或运行时。
  const before = [...downloads];
  const resumed = await runReleasePipeline({ ...input, state: result.state });
  assert.equal(resumed.error, undefined);
  assert.equal(uploads.length, 2);
  assert.deepEqual(downloads, before);

  await t.test('已公开版本缺当轮插件 ZIP，草稿调用也不补传', async () => {
    const [missing] = uploads.splice(0, 1);
    try {
      const retry = await runReleasePipeline({ ...input, state: result.state, authorize: { publish: false } });
      assert.equal(retry.error?.code, 'asset_missing_after_publish');
      assert.equal(uploads.length, 1);
    } finally {
      uploads.unshift(missing);
    }
  });

  const missingCandidate = await runReleasePipeline({ ...input, state: result.state, marketCandidate: undefined });
  assert.equal(missingCandidate.error?.code, 'offline_candidate_mismatch');
});

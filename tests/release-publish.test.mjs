import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSourceInputs } from '../release-orchestrate.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('正式发布 CLI 自动组包并记录续作，草稿使用候选提交、标题和说明', async t => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'zcode-publish-cli-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.test',
    '-c', `core.hooksPath=${join(repoRoot, 'no-hooks')}`, ...args,
  ], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--quiet');
  const names = ['suian-zcode-common', 'suian-zcode-title', 'suian-zcode-app-mcp', 'suian-side-editor'];
  const [common] = names;
  const baseUrl = 'https://github.com/o/r/releases/download';
  const tag = 'test-v2';
  const title = 'ZCode Plugins · common 2.0.0 · 测试';
  const notes = '## [common 2.0.0] - 2026-11-24\n';
  const guide = '# 来自候选提交的离线安装指南\n';
  const marketplace = { name: 'suian-zcode-plugins', plugins: [] };
  for (const name of names) {
    const version = name === common ? '2.0.0' : '1.0.0';
    const root = join(repoRoot, name, '.zcode-plugin');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'plugin.json'), JSON.stringify({ name, version }));
    marketplace.plugins.push({
      name, version, ...(name !== common && { dependencies: [common] }),
      source: { source: 'url', type: 'zip', url: `${baseUrl}/old/${name}-1.0.0.zip`, sha256: 'a'.repeat(64), stripRoot: false },
    });
  }
  const guidePath = join(repoRoot, 'offline', 'AGENTS.md');
  await mkdir(join(repoRoot, 'offline'));
  await writeFile(guidePath, guide);
  await writeFile(join(repoRoot, 'marketplace.json'), JSON.stringify(marketplace));
  await writeFile(join(repoRoot, '.gitignore'), '.scratch/\n');
  git('add', '--', '.');
  git('commit', '--quiet', '-m', 'test release candidate');
  const commit = git('rev-parse', 'HEAD');

  const outDir = join(repoRoot, '.scratch', 'release');
  const fileName = `${common}-2.0.0.zip`;
  await mkdir(join(outDir, 'zips'), { recursive: true });
  const zipPath = join(outDir, 'zips', fileName);
  const pluginBytes = Buffer.from('already verified plugin ZIP');
  await writeFile(zipPath, pluginBytes);
  await writeFile(join(outDir, 'notes.md'), notes);
  const staleCandidate = join(outDir, 'marketplace.candidate.json');
  await writeFile(staleCandidate, JSON.stringify(marketplace));
  await writeFile(join(outDir, 'release-record.json'), JSON.stringify({
    formatVersion: 2, commit, releaseTag: tag, baseUrl,
    toolchain: { node: process.version, platform: process.platform },
    plugins: { [common]: { pluginVersion: '2.0.0', zipPath: 'zips/' + fileName, zipSha256: digest(pluginBytes), buildInputPaths: [] } },
    sourceInputs: { [common]: await scanSourceInputs(join(repoRoot, common)) },
  }));
  const args = ['--out', outDir, '--title', title, '--notes-file', join(outDir, 'notes.md')];
  const finalize = ['--out', outDir, '--finalize'];
  const stateFile = join(outDir, `publish-${tag}.json`);
  const offlineName = 'zcode-plugins-offline-windows-x64.zip';
  let release, prepared = 0, draftCheckpoint, anonymousUnavailable = false;
  let tagTarget = commit, moveTagDuringDownload = false;
  let masterMarketplace = marketplace, moveTagDuringMasterCheck = false, failLatest = false;
  const stored = new Map();
  const requests = [];
  const releasePatches = [];
  const response = (data, status = 200) => ({ ok: status < 400, status, text: async () => String(data), json: async () => data });
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname;
    const method = options.method ?? 'GET';
    requests.push([method, path]);
    if (parsed.hostname === 'github.com') {
      assert.equal(options.headers, undefined, '公开下载不能附加 Token');
      if (anonymousUnavailable) return response('not found', 404);
      if (moveTagDuringDownload) tagTarget = 'b'.repeat(40);
      return { ok: true, arrayBuffer: async () => stored.get(path.split('/').at(-1)) };
    }
    assert.equal(options.headers.authorization, 'Bearer fixture-token');
    if (path.includes('/git/ref/tags/')) {
      return release && !release.draft ? response({ object: { type: 'commit', sha: tagTarget } }) : response('not found', 404);
    }
    if (path.endsWith('/contents/marketplace.json') && method === 'GET') {
      assert.equal(parsed.searchParams.get('ref'), 'master');
      assert.equal(options.headers.accept, 'application/vnd.github.raw+json');
      if (moveTagDuringMasterCheck) tagTarget = 'b'.repeat(40);
      return response(masterMarketplace);
    }
    if (path.endsWith('/releases/tags/' + tag)) return release && !release.draft ? response(release) : response('not found', 404);
    if (path.endsWith('/releases') && method === 'GET') return response(release ? [release] : []);
    if (path.endsWith('/releases') && method === 'POST') {
      assert.equal(release, undefined, '续作已有草稿不得重建');
      try { draftCheckpoint = JSON.parse(await readFile(stateFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const input = JSON.parse(options.body);
      assert.deepEqual(input, { tag_name: tag, target_commitish: commit, name: title, body: notes, draft: true, prerelease: true });
      release = { id: 1, ...input };
      return response(release, 201);
    }
    const releasePath = `/releases/${release.id}`;
    if (path.endsWith(`${releasePath}/assets`) && method === 'GET') {
      return response([...stored.entries()].map(([name, bytes]) => ({ name, digest: 'sha256:' + digest(bytes) })));
    }
    if (path.endsWith(`${releasePath}/assets`) && method === 'POST') {
      assert.equal(release.draft, true);
      stored.set(parsed.searchParams.get('name'), Buffer.from(options.body));
      return response({}, 201);
    }
    if (path.endsWith(releasePath) && method === 'PATCH') {
      const patch = JSON.parse(options.body);
      releasePatches.push(patch);
      if (failLatest && patch.make_latest) return response('latest rejected', 422);
      Object.assign(release, patch);
      return response(release);
    }
    assert.fail(`unexpected request: ${method} ${url}`);
  };
  const { main } = await import('../release-publish.mjs');
  const options = {
    repoRoot, token: 'fixture-token', fetchImpl,
    prepareOffline: async input => {
      prepared++;
      assert.equal(input.agentsText, guide);
      assert.equal(input.outDir, join(outDir, 'zips'));
      assert.equal(input.marketCandidate.plugins.length, 4);
      assert.equal(input.marketCandidate.plugins[0].source.url, `${baseUrl}/${tag}/${fileName}`);
      assert.deepEqual(input.marketCandidate.plugins.slice(1), marketplace.plugins.slice(1));
      assert.deepEqual(await readFile(input.zips[0].zipPath), pluginBytes);
      const bytes = Buffer.from('prepared offline ZIP');
      const zipPath = join(outDir, 'zips', offlineName);
      await writeFile(zipPath, bytes);
      return { fileName: offlineName, zipPath, sha256: digest(bytes) };
    },
  };
  await writeFile(guidePath, '# 未提交的指南不进入正式资产\n');
  await assert.rejects(main(args, options), /工作区.*提交/);
  assert.deepEqual(requests, [], '候选不可信时不得访问 GitHub');
  await writeFile(guidePath, guide);

  const draft = await main(args, options);
  assert.equal(draft.state.publishPending, true);
  assert.equal(prepared, 1);
  assert.deepEqual([...stored.keys()], [fileName, offlineName]);
  await t.test('尚未完成公开下载验证的草稿不能转正', async () => {
    await assert.rejects(main([...finalize, '--host-verified'], options), /未完成.*下载核验/);
    assert.deepEqual(releasePatches, []);
  });
  await t.test('匿名下载期间 tag 改指其他提交，不转正或交付市场候选', async () => {
    moveTagDuringDownload = true;
    try {
      const result = await main([...args, '--publish'], options);
      assert.equal(result.error?.code, 'tag_commit_mismatch');
      assert.equal(result.state.stage, 'verify-download');
      assert.equal(release.prerelease, true);
      assert.equal(result.report.marketCandidate, undefined);
      await assert.rejects(readFile(join(outDir, `marketplace.verified-${tag}.json`)), { code: 'ENOENT' });
    } finally {
      moveTagDuringDownload = false;
      tagTarget = commit;
    }
  });
  const published = await main([...args, '--publish'], options);
  assert.equal(prepared, 1, '续作必须使用已生成的凭证');
  assert.equal(published.error, undefined);
  assert.equal(published.state.stage, 'market-ready');
  assert.equal(release.draft, false);
  await t.test('--publish 交付市场候选但保留预发布', () => {
    assert.equal(release.prerelease, true);
    assert.equal(published.state.finalizePending, true);
    assert.deepEqual(releasePatches, [{ draft: false, prerelease: true }]);
    assert.ok(!requests.some(([, path]) => path.endsWith('/contents/marketplace.json')));
  });
  assert.deepEqual(published.state.downloads.map(record => record.fileName), [fileName, offlineName]);
  await t.test('首次写入草稿前已保存离线产物的候选凭证', () => {
    assert.equal(draftCheckpoint?.candidateCommit, commit);
    assert.equal(draftCheckpoint.offline.asset.fileName, offlineName);
  });
  await t.test('市场交接拿到的是本次已核验清单，不是先前的候选文件', async () => {
    assert.notEqual(published.report.marketCandidate, staleCandidate);
    assert.equal(published.report.marketCandidate, join(outDir, `marketplace.verified-${tag}.json`));
    const verified = JSON.parse(await readFile(published.report.marketCandidate, 'utf8'));
    assert.equal(verified.plugins[0].source.url, `${baseUrl}/${tag}/${fileName}`);
    assert.deepEqual(JSON.parse(await readFile(staleCandidate,'utf8')), marketplace);
  });
  await t.test('缺少宿主验收确认或远端 master 仍旧时不得转正', async () => {
    const before = requests.length;
    await assert.rejects(main(finalize, options), /宿主验收/);
    assert.equal(requests.length, before, '缺少宿主确认时不访问 GitHub');
    await assert.rejects(main([...finalize, '--host-verified'], options), /master.*common/);
    assert.deepEqual(releasePatches, [{ draft: false, prerelease: true }]);
  });
  await t.test('旧凭证未绑定 Release ID 时不能转正，续作补做匿名下载', async () => {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    for (const record of state.downloads) delete record.releaseId;
    await writeFile(stateFile, JSON.stringify(state));
    await assert.rejects(main([...finalize, '--host-verified'], options), /未完成公开下载核验/);
    const start = requests.length;
    const retry = await main([...args, '--publish'], options);
    assert.equal(retry.error, undefined);
    assert.equal(retry.state.stage, 'market-ready');
    const downloaded = requests.slice(start).filter(([, path]) => path.includes('/releases/download/'));
    assert.deepEqual(downloaded.map(([, path]) => path.split('/').at(-1)), [fileName, offlineName]);
    assert.equal(prepared, 1);
  });
  masterMarketplace = JSON.parse(await readFile(published.report.marketCandidate, 'utf8'));
  await t.test('同 tag 的 Release 重建后必须重新匿名下载，404 阻止交接与转正', async () => {
    release = { ...release, id: 2 };
    await assert.rejects(main([...finalize, '--host-verified'], options), /当前 Release.*不符/);
    const start = requests.length;
    anonymousUnavailable = true;
    try {
      const blocked = await main([...args, '--publish'], options);
      assert.equal(blocked.error?.code, 'download_failed');
      assert.equal(blocked.state.releaseId, 2);
      assert.equal(blocked.state.stage, 'verify-download');
      assert.equal(blocked.report.marketCandidate, undefined);
      assert.equal(blocked.state.marketSwitchPending, undefined);
      assert.equal(blocked.state.finalizePending, undefined);
      assert.deepEqual(blocked.state.downloads.map(record => [record.fileName, record.releaseId, record.reason]),
        [[fileName, 2, 'HTTP 404'], [offlineName, 2, 'HTTP 404']]);
      await assert.rejects(main([...finalize, '--host-verified'], options), /未完成.*下载核验/);
      assert.equal(release.prerelease, true);
    } finally {
      anonymousUnavailable = false;
    }
    const retry = await main([...args, '--publish'], options);
    assert.equal(retry.error, undefined);
    assert.equal(retry.state.stage, 'market-ready');
    assert.deepEqual(retry.state.downloads.map(record => [record.fileName, record.releaseId]),
      [[fileName, 2], [offlineName, 2]]);
    assert.equal(prepared, 1);
    assert.ok(requests.slice(start).every(([method]) => method === 'GET'), '不重传资产或修改 Release');
  });
  await t.test('master 版本和 URL 相同但摘要不符，仍不得转正', async () => {
    const source = masterMarketplace.plugins[0].source;
    const correct = source.sha256;
    source.sha256 = 'f'.repeat(64);
    try {
      await assert.rejects(main([...finalize, '--host-verified'], options), /master.*common/);
      assert.deepEqual(releasePatches, [{ draft: false, prerelease: true }]);
    } finally {
      source.sha256 = correct;
    }
  });
  await t.test('已核验的公开离线资产不再存在时不得转正', async () => {
    const bytes = stored.get(offlineName);
    stored.delete(offlineName);
    try {
      await assert.rejects(main([...finalize, '--host-verified'], options), /公开资产缺失.*offline/);
      assert.deepEqual(releasePatches, [{ draft: false, prerelease: true }]);
    } finally {
      stored.set(offlineName, bytes);
    }
  });
  await t.test('核对 master 期间 tag 改指其他提交时不得转正', async () => {
    moveTagDuringMasterCheck = true;
    try {
      await assert.rejects(main([...finalize, '--host-verified'], options), /tag.*候选/);
      assert.deepEqual(releasePatches, [{ draft: false, prerelease: true }]);
    } finally {
      moveTagDuringMasterCheck = false;
      tagTarget = commit;
    }
  });
  await t.test('宿主已验且 master 匹配后可单独转正，只改元数据', async () => {
    await rm(zipPath);
    await rm(join(outDir, 'zips', offlineName));
    const start = requests.length;
    const result = await main([...finalize, '--host-verified'], options);
    assert.equal(result.report.finalized, true);
    assert.equal(result.state.finalizePending, undefined);
    assert.equal(result.state.marketSwitchPending, undefined);
    assert.equal(release.prerelease, false);
    assert.equal(prepared, 1);
    assert.ok(requests.slice(start).every(([method, path]) => method !== 'POST' && !path.includes('/releases/download/')));
    assert.deepEqual(releasePatches, [{ draft: false, prerelease: true }, { prerelease: false }, { make_latest: 'true' }]);
    await main([...finalize, '--host-verified'], options);
    assert.equal(releasePatches.length, 3, '已经转正的 Release 不重复更新');
  });
  await t.test('Latest 标记请求失败时转正命令报错，不静默完成', async () => {
    // 转正只有一次：失败路径排在成功路径之后，先把夹具恢复成未转正。
    release.prerelease = true;
    failLatest = true;
    try {
      await assert.rejects(main([...finalize, '--host-verified'], options), /GitHub API 422/);
      assert.equal(release.prerelease, false, '解除预发布的请求已生效，失败不回滚转正');
    } finally {
      failLatest = false;
    }
  });
});

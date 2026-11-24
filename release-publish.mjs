// 正式发布入口：从已构建记录复用插件 ZIP，以最终候选提交生成并发布离线资产。
import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { createGithubRestApi, runReleasePipeline } from './release-github.mjs';
import { checkVersionConsistency, generateMarketplaceCandidate } from './release-marketplace.mjs';
import { buildOfflineReleaseAsset, OFFLINE_MARKETPLACE } from './release-offline.mjs';
import { gateCommitInputs, PLUGIN_ORDER, RECORD_NAME } from './release-orchestrate.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const usage = '用法：node release-publish.mjs --title "<Release 标题>" --notes-file <发布说明> [--out .scratch/release] [--publish]';
async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export async function main(argv = process.argv.slice(2), {
  repoRoot = root, token = process.env.GH_TOKEN, fetchImpl = fetch, prepareOffline = buildOfflineReleaseAsset,
} = {}) {
  const { values } = parseArgs({ args: argv, options: {
    out: { type: 'string', default: '.scratch/release' },
    title: { type: 'string' },
    'notes-file': { type: 'string' },
    publish: { type: 'boolean' },
    help: { type: 'boolean' },
  } });
  if (values.help) return { usage };
  if (!values.title?.trim() || !values['notes-file']) throw new Error(usage);
  if (!token) throw new Error('正式发布需由已授权的环境提供 GH_TOKEN');

  const git = async (...args) => (await run('git', args, { cwd: repoRoot, windowsHide: true, encoding: 'utf8' })).stdout;
  const candidateCommit = (await git('rev-parse', '--verify', 'HEAD')).trim();
  if ((await git('status', '--porcelain', '--untracked-files=all')).trim()) {
    throw new Error('发布工作区有未提交变更；请从干净的最终候选提交发布');
  }
  const outDir = resolve(repoRoot, values.out);
  const record = JSON.parse(await readFile(join(outDir, RECORD_NAME), 'utf8'));
  const { releaseTag, baseUrl } = record;
  const target = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/?$/.exec(baseUrl);
  if (!target || !/^[\w.-]+$/.test(releaseTag ?? '')) throw new Error('发布记录的 GitHub 下载根地址或 tag 无效');

  const zips = Object.entries(record.plugins ?? {}).map(([name, entry]) => {
    const fileName = `${name}-${entry.pluginVersion}.zip`;
    if (!PLUGIN_ORDER.includes(name) || entry.zipPath !== `zips/${fileName}`) {
      throw new Error(`发布记录中的插件或 ZIP 路径无效：${name}`);
    }
    return { name, version: entry.pluginVersion, fileName, zipPath: join(outDir, entry.zipPath), sha256: entry.zipSha256 };
  });
  if (!zips.length) throw new Error('发布记录没有本轮插件 ZIP');
  const gate = await gateCommitInputs({ repoRoot, record, outDir, commit: candidateCommit });
  if (!gate.ok) throw new Error(`发布门禁未通过：${JSON.stringify(gate)}`);

  // 候选清单与说明取自提交对象；不把未提交的指南或临时市场候选混入正式资产。
  const marketplace = JSON.parse(await git('show', `${candidateCommit}:marketplace.json`));
  if (marketplace.name !== OFFLINE_MARKETPLACE) throw new Error('最终候选缺少本仓的完整市场');
  const versionReport = await checkVersionConsistency({
    repoRoot, marketplace,
    pluginRoots: Object.fromEntries(PLUGIN_ORDER.map(name => [name, name])),
    stagedVersions: Object.fromEntries(zips.map(zip => [zip.name, zip.version])),
  });
  if (!versionReport.ok) throw new Error(`插件版本不一致：${JSON.stringify(versionReport.mismatches)}`);
  const marketCandidate = generateMarketplaceCandidate({
    current: marketplace, baseUrl, releaseTag,
    updates: zips.map(({ sha256, ...zip }) => ({ ...zip, zipSha256: sha256 })),
  });
  const agentsText = await git('show', `${candidateCommit}:offline/AGENTS.md`);
  const body = await readFile(resolve(values['notes-file']), 'utf8');
  if (!body.trim()) throw new Error('发布说明不能为空');

  const [, owner, repo] = target;
  const githubApi = createGithubRestApi({ owner, repo, token, fetchImpl });
  const download = async url => {
    const response = await fetchImpl(url);
    if (!response.ok) throw Object.assign(new Error(`下载失败：HTTP ${response.status} ${url}`), { httpStatus: response.status });
    return Buffer.from(await response.arrayBuffer());
  };
  const stateFile = join(outDir, `publish-${releaseTag}.json`);
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = {}; }
  const persistState = current => writeJson(stateFile, current);
  try {
    const result = await runReleasePipeline({
      state, githubApi, download, zips, releaseTag, candidateCommit, marketCandidate,
      authorize: { publish: values.publish === true }, releaseMetadata: { name: values.title, body },
      prepareOffline: inputs => prepareOffline({ ...inputs, agentsText, outDir: join(outDir, 'zips') }),
      persistState,
    });
    if (!result.error && result.state.stage === 'market-ready') {
      const verifiedPath = join(outDir, `marketplace.verified-${releaseTag}.json`);
      await writeJson(verifiedPath, marketCandidate);
      result.report.marketCandidate = verifiedPath;
    }
    return result;
  } finally {
    await persistState(state);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main();
    console.log(result.usage ?? JSON.stringify(result, null, 2));
    if (result.error) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

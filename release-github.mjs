// PKG-07：GitHub Release 发布流水线编排。GitHub API 与匿名下载全部依赖注入：
// 测试使用内存桩，不触真实网络写操作；真实 REST 适配器由 createGithubRestApi 提供，
// 仅在另行授权的正式发布中由人显式调用。
// 顺序强制（规格 9.3）：草稿资产齐全 -> 授权公开（先预发布）-> 匿名公开下载核验 ->
// 核验全部通过按授权转正式版 -> 市场就绪报告；下载核验失败不得转正，也不得切换市场。已发布资产不删除重传；
// 上传结果未知时先读取远端现状再续作，不盲重传；不能覆盖现有未知内容。
import { readFile } from 'node:fs/promises';
import { validateMarketplaceEntry } from './release-marketplace.mjs';

export const PIPELINE_STAGES = ['draft', 'upload', 'publish', 'verify-download', 'market-ready'];

const stageOrder = new Map(PIPELINE_STAGES.map((stage, index) => [stage, index]));
const reached = stage => stageOrder.get(stage) ?? -1;

/**
 * zips：[{ name, fileName, zipPath, sha256, bytes }]
 * candidateCommit：已验候选的完整提交 SHA（新 tag 和已有 tag 均须绑定）。
 * githubApi：{ getTagCommit, getReleaseByTag, createDraftRelease, listAssets, getAssetDigest,
 *              uploadAsset, updateRelease, assetDownloadUrl }
 * download(url)：匿名下载，成功返回 Buffer，失败抛错
 * authorize：{ publish: boolean }——publish 为 false 时停留在核验完成态
 * marketCandidate：候选市场清单（可选）；publish 后核对其 URL/摘要与资产一致
 * state：跨调用持久化（{stage, releaseId, assets, downloads, publishPending, finalizePending, marketSwitchPending}）
 */
export async function runReleasePipeline({ state, githubApi, download, zips, releaseTag, candidateCommit, authorize = {}, marketCandidate }) {
  const run = state ?? {};
  run.assets = run.assets ?? {};
  run.downloads = run.downloads ?? [];
  const report = { releaseTag, candidateCommit, zips: zips.map(zip => zip.fileName) };
  const fail = code => ({ state: run, report, error: { code } });
  if (!/^[0-9a-f]{40}$/.test(candidateCommit ?? '')) return fail('candidate_commit_invalid');
  if ((run.releaseTag && run.releaseTag !== releaseTag) || (run.candidateCommit && run.candidateCommit !== candidateCommit)) return fail('state_candidate_mismatch');
  const tagCommit = await githubApi.getTagCommit(releaseTag);
  if (tagCommit && tagCommit !== candidateCommit) return fail('tag_commit_mismatch');
  run.releaseTag = releaseTag;
  run.candidateCommit = candidateCommit;

  // 阶段一：读取现状，不存在同名才建草稿。
  let release = await githubApi.getReleaseByTag(releaseTag);
  if (!release) release = await githubApi.createDraftRelease({ tag: releaseTag, commit: candidateCommit });
  if (!tagCommit && release.target_commitish !== candidateCommit) return fail('draft_commit_mismatch');
  run.releaseId = release.id;
  if (reached(run.stage ?? 'draft') < reached('draft')) run.stage = 'draft';

  // 阶段二：逐资产核对/上传；已确认的不重传，未知内容不覆盖。
  const remoteAssets = await githubApi.listAssets(release);
  for (const zip of zips) {
    const existing = remoteAssets.find(asset => asset.name === zip.fileName);
    if (existing) {
      const digest = await githubApi.getAssetDigest(existing);
      if (digest == null) return fail('asset_unknown');
      if (digest !== zip.sha256) return fail('asset_conflict');
      run.assets[zip.fileName] = { uploaded: true, sha256: zip.sha256, reused: true };
      continue;
    }
    try {
      await githubApi.uploadAsset(release, { name: zip.fileName, zipPath: zip.zipPath, sha256: zip.sha256, bytes: zip.bytes });
    } catch (error) {
      if (!error.unknownResult) throw error;
      // 请求结果未知：先读取现状再续作，不盲重传。
      const fresh = await githubApi.getReleaseByTag(releaseTag);
      const freshAssets = fresh ? await githubApi.listAssets(fresh) : [];
      const landed = freshAssets.find(asset => asset.name === zip.fileName);
      if (!landed) return fail('upload_unknown');
      const digest = await githubApi.getAssetDigest(landed);
      if (digest == null) return fail('asset_unknown');
      if (digest !== zip.sha256) return fail('asset_conflict');
    }
    run.assets[zip.fileName] = { uploaded: true, sha256: zip.sha256 };
  }
  if (reached(run.stage) < reached('upload')) run.stage = 'upload';

  // 草稿没有匿名公开 URL；资产齐备后须先按授权公开，市场清单仍不切换。
  if (release.draft) {
    if (!authorize.publish) {
      run.publishPending = true;
      report.pending = '资产已备/待授权公开：Release 保持草稿，市场清单保持原正式版本';
      return { state: run, report };
    }
    const currentTagCommit = await githubApi.getTagCommit(releaseTag);
    if (currentTagCommit && currentTagCommit !== candidateCommit) return fail('tag_commit_mismatch');
    release = await githubApi.updateRelease(release, { draft: false, prerelease: true });
  }
  if (await githubApi.getTagCommit(releaseTag) !== candidateCommit) return fail('tag_commit_mismatch');
  delete run.publishPending;
  run.stage = 'publish';

  // 阶段四：公开后匿名下载；任何失败阻断市场就绪，不删除或替换已公开资产。
  const pendingDownloads = zips.filter(zip => !run.downloads.some(record => record.fileName === zip.fileName && record.ok
    && record.sha256 === zip.sha256 && record.url === githubApi.assetDownloadUrl(release, { name: zip.fileName })));
  for (const zip of pendingDownloads) {
    const url = githubApi.assetDownloadUrl(release, { name: zip.fileName });
    run.downloads = run.downloads.filter(record => record.fileName !== zip.fileName);
    try {
      const bytes = await download(url);
      const { createHash } = await import('node:crypto');
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== zip.sha256) {
        run.downloads.push({ fileName: zip.fileName, ok: false, reason: 'digest_mismatch' });
      } else {
        run.downloads.push({ fileName: zip.fileName, ok: true, url, sha256: digest });
      }
    } catch (error) {
      run.downloads.push({ fileName: zip.fileName, ok: false, reason: error.httpStatus ? `HTTP ${error.httpStatus}` : String(error.message ?? error) });
    }
  }
  if (reached(run.stage) < reached('verify-download')) run.stage = 'verify-download';
  if (zips.some(zip => !run.downloads.some(record => record.fileName === zip.fileName && record.ok && record.sha256 === zip.sha256))) return fail('download_failed');

  // 下载核验全部通过：预发布转正式版。转正与草稿公开共用 publish 授权——
  // 未授权（含省略）时保持预发布、保留核验结果并标记待转正，不替调用方改变正式发布状态；
  // 幂等——已正式（含人工先行转正）不再发补丁并清理残留标记；转正不等待市场清单切换授权。
  if (release.prerelease) {
    if (authorize.publish) {
      release = await githubApi.updateRelease(release, { prerelease: false });
      delete run.finalizePending;
    } else {
      run.finalizePending = true;
      report.pending = '下载核验通过/待授权转正式：Release 保持预发布，市场清单保持原正式版本';
    }
  } else {
    delete run.finalizePending;
  }

  // 阶段五：市场就绪——核对候选条目 URL/摘要与已公开资产一致；切换须另行授权。
  if (marketCandidate?.plugins) {
    for (const entry of marketCandidate.plugins) {
      if (entry.source?.type !== 'zip') continue;
      const shape = validateMarketplaceEntry(entry);
      if (!shape.ok) return fail('market_candidate_invalid');
      const zip = zips.find(item => item.name === entry.name);
      if (!zip) continue; // 未变条目保留其已发布 URL 和摘要。
      const expectedUrl = githubApi.assetDownloadUrl(release, { name: zip.fileName });
      if (entry.source.url !== expectedUrl) return fail('market_url_mismatch');
      if (zip.sha256 !== entry.source.sha256) return fail('market_digest_mismatch');
    }
    if (zips.some(zip => !marketCandidate.plugins.some(entry => entry.name === zip.name))) return fail('market_candidate_missing');
    run.stage = 'market-ready';
    run.marketSwitchPending = true;
    report.market = '候选市场清单与公开资产一致；正式合入 master 须另行授权';
  }
  return { state: run, report };
}

/**
 * 真实 GitHub REST 适配器（fetch 实现）。仅在获得发布授权的正式操作中由人显式使用；
 * 本票测试不调用本函数。网络层超时/复位错误标记 unknownResult，交由编排器先读现状。
 */
export function createGithubRestApi({ owner, repo, token, fetchImpl = fetch }) {
  const apiRoot = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const transient = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|aborted|network timeout/i;
  const request = async (path, init = {}) => {
    try {
      const response = await fetchImpl(path.startsWith('http') ? path : `${apiRoot}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
      if (!response.ok) {
        const error = new Error(`GitHub API ${response.status}: ${await response.text()}`);
        error.httpStatus = response.status;
        throw error;
      }
      return response.status === 204 ? null : await response.json();
    } catch (error) {
      if (transient.test(String(error.message ?? error.cause?.code ?? error))) {
        const unknown = new Error(`请求结果未知：${error.message}`);
        unknown.unknownResult = true;
        throw unknown;
      }
      throw error;
    }
  };
  return {
    async getTagCommit(tag) {
      let ref;
      try { ref = await request(`/git/ref/tags/${encodeURIComponent(tag)}`); }
      catch (error) { if (error.httpStatus === 404) return null; throw error; }
      let object = ref.object;
      while (object.type === 'tag') object = (await request(`/git/tags/${object.sha}`)).object;
      if (object.type !== 'commit') throw new Error(`Release tag ${tag} 没有指向提交`);
      return object.sha;
    },
    async getReleaseByTag(tag) {
      try {
        return await request(`/releases/tags/${encodeURIComponent(tag)}`);
      } catch (error) {
        if (error.httpStatus === 404) return null;
        throw error;
      }
    },
    async createDraftRelease({ tag, commit, name = tag, body = '' }) {
      if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('创建 Release 必须指定候选提交 SHA');
      return request('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: commit, name, body, draft: true, prerelease: true }) });
    },
    async listAssets(release) { return request(`/releases/${release.id}/assets?per_page=100`); },
    async getAssetDigest(asset) {
      if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) return asset.digest.slice('sha256:'.length);
      return null; // 无摘要视为未知内容，交由编排器拒绝覆盖
    },
    async uploadAsset(release, { name, readBytes, bytes, zipPath }) {
      // 载荷契约：编排器传 zipPath（从发布记录读盘），测试注入 readBytes/bytes；
      // 三者皆缺是调用方错误，静默上传空资产比报错更危险。
      const body = zipPath ? await readFile(zipPath) : (readBytes ?? bytes);
      if (!(body instanceof Uint8Array)) throw new Error(`uploadAsset(${name}) 需要 readBytes/bytes/zipPath 之一；载荷必须是字节数组，文件大小不能用作载荷`);
      return request(`https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body,
      });
    },
    async updateRelease(release, patch) {
      return request(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },
    assetDownloadUrl(release, asset) {
      return `https://github.com/${owner}/${repo}/releases/download/${release.tag_name ?? release.tag}/${asset.name}`;
    },
  };
}

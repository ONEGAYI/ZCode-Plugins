// PKG-07：GitHub Release 发布流水线编排。GitHub API 与匿名下载全部依赖注入：
// 测试使用内存桩，不触真实网络写操作；真实 REST 适配器由 createGithubRestApi 提供，
// 仅在另行授权的正式发布中由人显式调用。
// 本仓正式发行（规格 9.3）：草稿资产齐全 -> 授权公开为预发布 -> 匿名下载核验 -> 交接市场候选。
// 正式转正由 release-publish.mjs 的独立路径处理，无离线资产的通用调用仍按 publish 授权转正；两处共用 promoteRelease，转正含 Latest 标记。已发布资产不删除重传；
// 上传结果未知时先读取远端现状再续作，不盲重传；不能覆盖现有未知内容。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateMarketplaceEntry } from './release-marketplace.mjs';
import { OFFLINE_MARKETPLACE } from './release-offline.mjs';

export const PIPELINE_STAGES = ['draft', 'upload', 'publish', 'verify-download', 'market-ready'];

const stageOrder = new Map(PIPELINE_STAGES.map((stage, index) => [stage, index]));
const reached = stage => stageOrder.get(stage) ?? -1;

export function hasVerifiedDownload(downloads, releaseId, zip, url) {
  return downloads.some(record => record.ok && record.releaseId === releaseId
    && record.fileName === zip.fileName && record.sha256 === zip.sha256 && record.url === url);
}

/**
 * 预发布转正式，并标记为仓库 Latest。两次请求不合并：GitHub 规定草稿和预发布不能设为 Latest，
 * 同一请求先解除预发布再标记是否生效未经证实，被拒绝会让转正整体失败、Release 停在预发布。
 * 标记请求失败时转正已完成；已正式的 Release 不再转正，须人工执行 gh release edit <tag> --latest 补标。
 */
export async function promoteRelease(githubApi, release) {
  const promoted = await githubApi.updateRelease(release, { prerelease: false });
  await githubApi.updateRelease(release, { make_latest: 'true' });
  return promoted;
}

/**
 * zips：[{ name, fileName, zipPath, sha256, bytes }]
 * candidateCommit：已验候选的完整提交 SHA（新 tag 和已有 tag 均须绑定）。
 * githubApi：{ getTagCommit, getReleaseByTag, createDraftRelease, listAssets, getAssetDigest,
 *              uploadAsset, updateRelease, assetDownloadUrl }
 * download(url)：匿名下载，成功返回 Buffer，失败抛错
 * authorize：{ publish: boolean }——授权公开草稿；本仓离线发行公开后保持预发布
 * marketCandidate：候选市场清单；本仓正式发布须传全量候选，用于生成离线资产，
 *                  publish 后核对本轮插件条目的 URL/摘要（离线资产不进入市场清单）
 * prepareOffline：本仓正式入口提供已绑定候选提交的离线制包函数；通用调用方不需要
 * persistState：可选的持久化回调，确保已制包和下载核验结果可在进程中断后复用
 * releaseMetadata：新草稿的 { name, body }（可选），不改已有 Release 的标题或说明
 * state：跨调用持久化（{stage, releaseId, assets, downloads, publishPending, finalizePending, marketSwitchPending}）
 */
export async function runReleasePipeline({
  state, githubApi, download, zips, releaseTag, candidateCommit, authorize = {}, marketCandidate,
  prepareOffline, persistState, releaseMetadata,
}) {
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

  // 先制包，再动 GitHub 草稿。未变插件只进入离线包，不重发其独立 ZIP。
  let offlineAsset;
  const offlinePrepared = Boolean(run.offline);
  if (offlinePrepared || marketCandidate?.name === OFFLINE_MARKETPLACE) {
    const selection = JSON.stringify(marketCandidate);
    if (offlinePrepared && run.offline.selection !== selection) return fail('offline_candidate_mismatch');
    if (!offlinePrepared && !prepareOffline) return fail('offline_preparer_required');
    if (!offlinePrepared) {
      run.offline = { selection, asset: await prepareOffline({ marketCandidate, zips, download }) };
      await persistState?.(run);
    }
    offlineAsset = run.offline.asset;
    report.zips.push(offlineAsset.fileName);
  }
  const assets = offlineAsset ? [...zips, offlineAsset] : zips;

  // 阶段一：读取现状，不存在同名才建草稿。
  let release = await githubApi.getReleaseByTag(releaseTag);
  // 下载与组包可能持续数分钟；写草稿、资产之前不能沿用制包前的远端 tag。
  const writeTagCommit = offlineAsset ? await githubApi.getTagCommit(releaseTag) : tagCommit;
  if (writeTagCommit && writeTagCommit !== candidateCommit) return fail('tag_commit_mismatch');
  if (!release) release = await githubApi.createDraftRelease({ ...releaseMetadata, tag: releaseTag, commit: candidateCommit });
  if (!writeTagCommit && release.target_commitish !== candidateCommit) return fail('draft_commit_mismatch');
  // 同 tag 可能重建 Release；制包凭证仍属于候选提交，发布进度与下载凭证属于旧 Release。
  if (run.releaseId != null && run.releaseId !== release.id) {
    run.stage = 'draft';
    run.assets = {};
    run.downloads = [];
    delete run.publishPending;
    delete run.finalizePending;
    delete run.marketSwitchPending;
  }
  run.releaseId = release.id;
  if (reached(run.stage ?? 'draft') < reached('draft')) run.stage = 'draft';

  // 阶段二：逐资产核对/上传；已确认的不重传，未知内容不覆盖。
  const remoteAssets = await githubApi.listAssets(release);
  if (offlineAsset && !release.draft) {
    const missing = [offlineAsset, ...zips].find(zip => !remoteAssets.some(asset => asset.name === zip.fileName));
    if (missing) {
      report.missingAsset = missing.fileName;
      return fail(missing === offlineAsset ? 'offline_asset_missing_after_publish' : 'asset_missing_after_publish');
    }
  }
  for (const zip of assets) {
    const existing = remoteAssets.find(asset => asset.name === zip.fileName);
    if (existing) {
      const digest = await githubApi.getAssetDigest(existing);
      if (digest == null) return fail('asset_unknown');
      if (digest !== zip.sha256) return fail('asset_conflict');
      run.assets[zip.fileName] = { uploaded: true, sha256: zip.sha256, reused: true };
      continue;
    }
    if (offlinePrepared && zip === offlineAsset) {
      const digest = createHash('sha256').update(await readFile(zip.zipPath)).digest('hex');
      if (digest !== zip.sha256) return fail('offline_asset_changed');
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
  delete run.finalizePending;
  delete run.marketSwitchPending;
  run.stage = 'publish';

  // 阶段四：公开后匿名下载；任何失败阻断市场就绪，不删除或替换已公开资产。
  const publicUrl = zip => githubApi.assetDownloadUrl(release, { name: zip.fileName });
  const verifiedDownload = zip => hasVerifiedDownload(run.downloads, release.id, zip, publicUrl(zip));
  for (const zip of assets) {
    if (verifiedDownload(zip)) continue;
    const url = publicUrl(zip);
    const record = { fileName: zip.fileName, releaseId: release.id };
    run.downloads = run.downloads.filter(item => item.fileName !== zip.fileName);
    try {
      const bytes = await download(url);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== zip.sha256) {
        run.downloads.push({ ...record, ok: false, reason: 'digest_mismatch' });
      } else {
        run.downloads.push({ ...record, ok: true, url, sha256: digest });
      }
    } catch (error) {
      run.downloads.push({ ...record, ok: false, reason: error.httpStatus ? `HTTP ${error.httpStatus}` : String(error.message ?? error) });
    }
    await persistState?.(run);
  }
  if (reached(run.stage) < reached('verify-download')) run.stage = 'verify-download';
  if (!assets.every(verifiedDownload)) return fail('download_failed');

  // 离线发行的公开下载可能耗时；摘要一致不能代替交接前重新核对 tag。
  if (offlineAsset && await githubApi.getTagCommit(releaseTag) !== candidateCommit) {
    return fail('tag_commit_mismatch');
  }

  // 离线发行先交接候选；宿主验收和 master 核对完成后才可另行转正。
  // 不改变无离线资产的通用调用方此前的 publish 授权语义。
  if (release.prerelease) {
    if (authorize.publish && !offlineAsset) {
      release = await promoteRelease(githubApi, release);
    } else {
      run.finalizePending = true;
      report.pending = offlineAsset
        ? '下载核验通过：Release 保持预发布，待宿主验收、master 集成和转正授权'
        : '下载核验通过/待授权转正式：Release 保持预发布，市场清单保持原正式版本';
    }
  }

  // 阶段五：市场就绪——核对候选条目 URL/摘要与已公开资产一致；切换须另行授权。
  if (marketCandidate?.plugins) {
    for (const entry of marketCandidate.plugins) {
      if (entry.source?.type !== 'zip') continue;
      const shape = validateMarketplaceEntry(entry);
      if (!shape.ok) return fail('market_candidate_invalid');
      const zip = zips.find(item => item.name === entry.name);
      if (!zip) continue; // 未变条目保留其已发布 URL 和摘要。
      const expectedUrl = publicUrl(zip);
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
        if (error.httpStatus !== 404) throw error;
      }
      // 按 tag 接口查已公开版本，未公开草稿通过有写权限的 Release 列表查找。
      for (let page = 1; ; page += 1) {
        const releases = await request(`/releases?per_page=100&page=${page}`);
        const match = releases.find(release => release.tag_name === tag);
        if (match) return match;
        if (releases.length < 100) return null;
      }
    },
    async getLatestRelease() {
      try {
        return await request('/releases/latest');
      } catch (error) {
        if (error.httpStatus !== 404) throw error;
        return null; // 仓库没有正式版时没有 Latest
      }
    },
    async getMasterMarketplace() {
      return request('/contents/marketplace.json?ref=master', { headers: { accept: 'application/vnd.github.raw+json' } });
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

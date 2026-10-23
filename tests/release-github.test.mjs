// PKG-07 契约：GitHub Release 发布流水线（全桩注入，不触真实网络写操作）。
// 覆盖：新建、同名草稿续作、同名已发布资产复用/冲突、请求结果未知先读现状、
// 中断续作、匿名下载失败阻断公开、摘要不匹配阻断、不能覆盖现有未知内容；
// 顺序强制：草稿资产齐全 -> 按授权公开 -> 匿名下载核验 -> 市场就绪。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runReleasePipeline, PIPELINE_STAGES, createGithubRestApi } from '../release-github.mjs';

const shaOf = char => char.repeat(64);
const contentSha = content => createHash('sha256').update(content).digest('hex');
const makeZip = (name, shaChar, bytes = 10) => {
  const content = Buffer.alloc(bytes, shaChar.charCodeAt(0));
  return { name, fileName: `${name}.zip`, zipPath: `D:/zips/${name}.zip`, sha256: contentSha(content), bytes, content };
};
const zips = [makeZip('p', 'a'), makeZip('q', 'b')];
const COMMIT = 'a'.repeat(40);
const URL_BASE = 'https://github.com/o/r/releases/download/t-1';
const publicUrls = new Map([
  ['p.zip', `${URL_BASE}/p.zip`],
  ['q.zip', `${URL_BASE}/q.zip`],
]);
const allZips = [...zips];
// 匿名下载：按 URL 尾段映射回对应 ZIP 字节；未登记的 URL 返回 404。
const defaultDownload = async url => {
  const fileName = url.split('/').at(-1);
  const zip = allZips.find(item => item.fileName === fileName);
  if (!zip) {
    const error = new Error('404');
    error.httpStatus = 404;
    throw error;
  }
  return zip.content;
};

class RecordingApi {
  constructor({ release = null, assets = [], digestByAsset = null, uploadFailures = [], tagCommit = release ? COMMIT : null } = {}) {
    this.release = release ? {target_commitish: COMMIT, ...release} : null;
    this.tagCommit = tagCommit;
    this.assets = [...assets];              // [{ id, name, size }]
    this.digestByAsset = digestByAsset ?? (asset => allZips.find(zip => zip.fileName === asset.name)?.sha256 ?? null);
    this.uploadFailures = [...uploadFailures]; // 每次 uploadAsset 弹出一个错误
    this.calls = [];
    this.releasesCreated = 0;
    this.metadataUpdates = [];
  }
  async getReleaseByTag(tag) { this.calls.push(['getReleaseByTag', tag]); return this.release; }
  async getTagCommit() { return this.tagCommit; }
  async createDraftRelease({ tag, commit }) { this.calls.push(['createDraftRelease', tag]); this.releasesCreated += 1; this.release = { id: 1, draft: true, prerelease: false, tag, target_commitish: commit }; return this.release; }
  async listAssets(release) { this.calls.push(['listAssets', release.id]); return this.assets.map(asset => ({ ...asset })); }
  async getAssetDigest(asset) { return this.digestByAsset(asset); }
  async uploadAsset(release, { name }) {
    this.calls.push(['uploadAsset', name]);
    const failure = this.uploadFailures.shift();
    if (failure) throw failure;
    this.assets.push({ id: this.assets.length + 10, name, size: 1 });
    return this.assets.at(-1);
  }
  async updateRelease(release, patch) { this.calls.push(['updateRelease', release.id, patch]); Object.assign(this.release, patch); if(!this.release.draft)this.tagCommit=this.release.target_commitish;this.metadataUpdates.push(patch); return this.release; }
  assetDownloadUrl(release, asset) { return publicUrls.get(asset.name) ?? `${URL_BASE}/${asset.name}`; }
}

test('新建：草稿传齐资产后按授权公开，再从匿名 URL 核验', async () => {
  const api = new RecordingApi();
  const download = async url => {
    if(api.release.draft)throw Object.assign(new Error('draft is not public'),{httpStatus:404});
    return defaultDownload(url);
  };
  const result = await runReleasePipeline({
    state: {}, githubApi: api, download, zips, releaseTag: 't-1', candidateCommit: COMMIT,
    authorize: { publish: true },
  });
  assert.equal(result.state.stage, 'verify-download', JSON.stringify(result.error ?? result.state));
  assert.equal(api.releasesCreated, 1);
  assert.equal(api.assets.length, 2, '两个 ZIP 都已上传');
  assert.deepEqual(api.metadataUpdates, [{ draft: false, prerelease: true }, { prerelease: false }], '先预发布公开，下载核验通过后转正式');
  assert.equal(result.state.downloads.every(item => item.ok), true);
});

test('匿名下载失败保留已公开资产，但不得报告市场就绪', async () => {
  const api = new RecordingApi();
  const download = async () => { const error = new Error('404'); error.httpStatus = 404; throw error; };
  const result = await runReleasePipeline({
    state: {}, githubApi: api, download, zips, releaseTag: 't-1', candidateCommit: COMMIT,
    authorize: { publish: true },
  });
  assert.equal(result.error.code, 'download_failed');
  assert.equal(result.state.stage, 'verify-download');
  assert.equal(api.release.draft, false, '匿名核验只能发生在公开之后');
  assert.equal(api.release.prerelease, true, '下载核验未通过不得转正式');
  assert.equal(result.state.marketSwitchPending, undefined);
});

test('匿名下载摘要不匹配必须阻断市场就绪', async () => {
  const api = new RecordingApi();
  const download = async () => Buffer.from('tampered content');
  const result = await runReleasePipeline({
    state: {}, githubApi: api, download, zips, releaseTag: 't-1', candidateCommit: COMMIT,
    authorize: { publish: true },
  });
  assert.equal(result.state.stage, 'verify-download');
  assert.equal(result.error.code, 'download_failed');
  assert.equal(result.state.marketSwitchPending, undefined);
  assert.ok(result.state.downloads.some(item => !item.ok));
});

test('同名草稿续作：已传且摘要匹配的资产不重传，缺的补齐', async () => {
  const api = new RecordingApi({ release: { id: 7, draft: true, prerelease: false, tag: 't-1' }, assets: [{ id: 1, name: 'p.zip', size: 10 }] });
  const download = defaultDownload;
  const result = await runReleasePipeline({
    state: {}, githubApi: api, download, zips, releaseTag: 't-1', candidateCommit: COMMIT,
    authorize: { publish: true },
  });
  assert.equal(result.state.stage, 'verify-download');
  const uploads = api.calls.filter(call => call[0] === 'uploadAsset').map(call => call[1]);
  assert.deepEqual(uploads, ['q.zip'], '已有匹配资产只补缺失的');
});

test('同名已发布资产：摘要匹配即复用不重传；不匹配报冲突，不删除重传', async () => {
  const matching = new RecordingApi({ release: { id: 7, draft: false, prerelease: true, tag: 't-1' }, assets: [{ id: 1, name: 'p.zip', size: 10 }, { id: 2, name: 'q.zip', size: 10 }] });
  const download = defaultDownload;
  const reuse = await runReleasePipeline({ state: {}, githubApi: matching, download, zips, releaseTag: 't-1', candidateCommit: COMMIT, authorize: { publish: true } });
  assert.equal(reuse.state.stage, 'verify-download');
  assert.deepEqual(matching.metadataUpdates, [{ prerelease: false }], '续作在核验通过后补转正式，不改其他元数据');
  assert.deepEqual(matching.calls.filter(call => call[0] === 'uploadAsset'), [], '不得重传已发布资产');

  const conflicting = new RecordingApi({
    release: { id: 7, draft: false, prerelease: true, tag: 't-1' },
    assets: [{ id: 1, name: 'p.zip', size: 10 }, { id: 2, name: 'q.zip', size: 10 }],
    digestByAsset: asset => (asset.name === 'q.zip' ? shaOf('f') : shaOf('a')),
  });
  const conflict = await runReleasePipeline({ state: {}, githubApi: conflicting, download, zips, releaseTag: 't-1', candidateCommit: COMMIT, authorize: { publish: true } });
  assert.equal(conflict.error.code, 'asset_conflict', JSON.stringify(conflict.error));
  assert.deepEqual(conflicting.calls.filter(call => call[0] === 'uploadAsset'), [], '冲突时不得删除重传');
});

test('已正式 Release 续作幂等跳过，不重复发转正补丁', async () => {
  const published = new RecordingApi({
    release: { id: 7, draft: false, prerelease: false, tag: 't-1' },
    assets: [{ id: 1, name: 'p.zip', size: 10 }, { id: 2, name: 'q.zip', size: 10 }],
  });
  const done = await runReleasePipeline({ state: {}, githubApi: published, download: defaultDownload, zips, releaseTag: 't-1', candidateCommit: COMMIT, authorize: { publish: true } });
  assert.equal(done.error, undefined);
  assert.deepEqual(published.metadataUpdates, [], '已正式版不重发元数据补丁');
});

test('不能覆盖现有未知内容：同名资产无可用摘要时拒绝，不得盲传', async () => {
  const api = new RecordingApi({
    release: { id: 7, draft: true, prerelease: false, tag: 't-1' },
    assets: [{ id: 1, name: 'p.zip', size: 10 }],
    digestByAsset: () => null,
  });
  const download = defaultDownload;
  const result = await runReleasePipeline({ state: {}, githubApi: api, download, zips, releaseTag: 't-1', candidateCommit: COMMIT, authorize: { publish: true } });
  assert.equal(result.error.code, 'asset_unknown');
  assert.deepEqual(api.calls.filter(call => call[0] === 'uploadAsset'), [], '未知内容不得被覆盖');
});

test('请求结果未知：上传抛 unknown 后先读取现状再续作，不盲重传', async () => {
  const unknownError = new Error('socket hang up');
  unknownError.unknownResult = true;
  // 第一次上传 p.zip 结果未知，但实际已成功落库；续作必须通过读取现状确认而不是重传。
  const api = new RecordingApi({ uploadFailures: [unknownError] });
  const originalUpload = api.uploadAsset.bind(api);
  api.uploadAsset = async (release, input) => {
    if (input.name === 'p.zip' && !api.assets.some(asset => asset.name === 'p.zip')) {
      api.calls.push(['uploadAsset', 'p.zip']);
      api.uploadFailures.shift();
      api.assets.push({ id: 11, name: 'p.zip', size: 10 });
      throw unknownError;
    }
    return originalUpload(release, input);
  };
  const download = defaultDownload;
  const result = await runReleasePipeline({ state: {}, githubApi: api, download, zips, releaseTag: 't-1', candidateCommit: COMMIT, authorize: { publish: true } });
  assert.equal(result.state.stage, 'verify-download', JSON.stringify(result.error ?? result.state));
  const pUploads = api.calls.filter(call => call[0] === 'uploadAsset' && call[1] === 'p.zip');
  assert.equal(pUploads.length, 1, 'p.zip 只允许一次真实上传尝试');
  const readAfterUnknown = api.calls.filter(call => call[0] === 'listAssets').length >= 2;
  assert.equal(readAfterUnknown, true, '结果未知后必须先读取现状');
});

test('中断续作：状态文件已完成阶段跳过、未完成阶段从远端现状续作', async () => {
  // 预置状态：草稿已建、p.zip 已上传核验；远端实际也有 p.zip。续作只传 q.zip。
  const api = new RecordingApi({ release: { id: 7, draft: true, prerelease: false, tag: 't-1' }, assets: [{ id: 1, name: 'p.zip', size: 10 }] });
  const download = defaultDownload;
  const state = { stage: 'upload', releaseId: 7, assets: { 'p.zip': { uploaded: true, sha256: shaOf('a') } } };
  const result = await runReleasePipeline({ state, githubApi: api, download, zips, releaseTag: 't-1', candidateCommit: COMMIT, authorize: { publish: true } });
  assert.equal(result.state.stage, 'verify-download');
  const uploads = api.calls.filter(call => call[0] === 'uploadAsset').map(call => call[1]);
  assert.deepEqual(uploads, ['q.zip']);
  assert.equal(api.releasesCreated, 0, '续作不得重建草稿');
});

test('授权边界：publish 未授权时保持草稿，不访问尚未公开的 URL', async () => {
  const api = new RecordingApi();
  const download = async () => { throw new Error('不得访问草稿的匿名 URL'); };
  const result = await runReleasePipeline({ state: {}, githubApi: api, download, zips, releaseTag: 't-1', candidateCommit: COMMIT, authorize: { publish: false } });
  assert.equal(result.state.stage, 'upload');
  assert.deepEqual(result.state.downloads, []);
  assert.equal(result.state.publishPending, true);
  assert.deepEqual(api.metadataUpdates, []);
  assert.match(JSON.stringify(result.report), /授权/);
});

test('市场就绪：发布完成后核对候选条目 URL/摘要与资产一致，仅报告不切 master', async () => {
  const api = new RecordingApi();
  const download = defaultDownload;
  publicUrls.set('p-1.0.0.zip', `${URL_BASE}/p-1.0.0.zip`);
  const p = makeZip('p', 'a');
  p.fileName = 'p-1.0.0.zip';
  allZips.push(p);
  const candidateEntry = { name: 'p', version: '1.0.0', dependencies: ['suian-zcode-common'], source: { source: 'url', type: 'zip', url: `${URL_BASE}/p-1.0.0.zip`, sha256: p.sha256, stripRoot: false } };
  const result = await runReleasePipeline({
    state: {}, githubApi: api, download, zips: [p], releaseTag: 't-1', candidateCommit: COMMIT,
    authorize: { publish: true }, marketCandidate: { name: 'm', plugins: [candidateEntry] },
  });
  assert.equal(result.state.stage, 'market-ready', JSON.stringify(result.error ?? result.state));
  assert.equal(result.state.marketSwitchPending, true, '市场切换须另行授权，只报告就绪');
  assert.deepEqual(api.metadataUpdates, [{ draft: false, prerelease: true }, { prerelease: false }], '市场就绪前已转正式');
});

test('阶段常量暴露完整顺序，供编排器与文档引用', () => {
  assert.deepEqual(PIPELINE_STAGES, ['draft', 'upload', 'publish', 'verify-download', 'market-ready']);
});

test('已有 tag 必须匹配候选提交；错误绑定在上传或发布前拒绝', async () => {
  const api=new RecordingApi({release:{id:7,draft:true,tag:'t-1'},tagCommit:'b'.repeat(40)});
  const result=await runReleasePipeline({state:{},githubApi:api,zips,releaseTag:'t-1',candidateCommit:COMMIT,authorize:{publish:true},download:defaultDownload});
  assert.equal(result.error?.code,'tag_commit_mismatch');
  assert.equal(api.calls.some(call=>['uploadAsset','updateRelease','createDraftRelease'].includes(call[0])),false);
});

test('新建 Release 显式指定候选 SHA，REST 解析 annotated tag 到实际提交', async () => {
  const requests=[];
  const api=createGithubRestApi({owner:'o',repo:'r',token:'t',fetchImpl:async(url,init={})=>{
    requests.push({url,init});
    return {ok:true,status:200,json:async()=> url.includes('/git/ref/')?{object:{type:'tag',sha:'tag-object'}}:url.includes('/git/tags/')?{object:{type:'commit',sha:COMMIT}}:{id:9}};
  }});
  await api.createDraftRelease({tag:'t-1',commit:COMMIT});
  assert.equal(JSON.parse(requests[0].init.body).target_commitish,COMMIT);
  assert.equal(await api.getTagCommit('t-1'),COMMIT);
});

test('局部发行保留未变 common 的旧 URL 和摘要，不要求重发到本轮 tag', async () => {
  const api=new RecordingApi();
  const p=makeZip('suian-zcode-title','a');p.fileName='suian-zcode-title-1.0.0.zip';allZips.push(p);
  const old={name:'suian-zcode-common',version:'1.0.0',source:{source:'url',type:'zip',url:'https://github.com/o/r/releases/download/old-tag/suian-zcode-common-1.0.0.zip',sha256:'b'.repeat(64),stripRoot:false}};
  const current={name:p.name,version:'1.0.0',dependencies:['suian-zcode-common'],source:{source:'url',type:'zip',url:`${URL_BASE}/${p.fileName}`,sha256:p.sha256,stripRoot:false}};
  const before=structuredClone(old);
  const result=await runReleasePipeline({state:{},githubApi:api,download:defaultDownload,zips:[p],releaseTag: 't-1', candidateCommit: COMMIT,authorize:{publish:true},marketCandidate:{plugins:[old,current]}});
  assert.equal(result.error,undefined);
  assert.equal(result.state.stage,'market-ready');
  assert.deepEqual(old,before);
  assert.deepEqual(api.calls.filter(call=>call[0]==='uploadAsset').map(call=>call[1]),[p.fileName]);
});

test('下载临时失败后复用状态重试失败项，不重传资产，成功后解除阻断', async () => {
  const api=new RecordingApi(),state={};let attempts=0;
  const first=await runReleasePipeline({state,githubApi:api,zips:[zips[0]],releaseTag: 't-1', candidateCommit: COMMIT,authorize:{publish:true},download:async()=>{attempts++;throw new Error('temporary network failure');}});
  assert.equal(first.error.code,'download_failed');
  const resumed=await runReleasePipeline({state,githubApi:api,zips:[zips[0]],releaseTag: 't-1', candidateCommit: COMMIT,authorize:{publish:true},download:async url=>{attempts++;return defaultDownload(url);}});
  assert.equal(resumed.error,undefined);
  assert.equal(attempts,2);
  assert.equal(state.downloads.length,1);
  assert.equal(state.downloads[0].ok,true);
  assert.equal(api.calls.filter(call=>call[0]==='uploadAsset').length,1);
});

test('真实 REST 适配器：uploadAsset 从 zipPath 读盘上传，缺载荷拒绝而非静默空资产', async t => {
  const outDir = await mkdtemp(join(tmpdir(), 'pkg07-gh-real-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const zipPath = join(outDir, 'p.zip');
  const content = Buffer.from('zip-bytes');
  await writeFile(zipPath, content);
  const seen = [];
  const api = createGithubRestApi({
    owner: 'o', repo: 'r', token: 't',
    fetchImpl: async (url, init = {}) => { seen.push({ url, body: init.body }); return { ok: true, status: 201, json: async () => ({ id: 1 }) }; },
  });
  await api.uploadAsset({ id: 9 }, { name: 'p.zip', zipPath, bytes: content.length });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.includes('/releases/9/assets?name=p.zip'));
  assert.ok(Buffer.compare(seen[0].body, content) === 0, '上传体必须来自 zipPath 读盘，不得是空 Buffer');
  await assert.rejects(() => api.uploadAsset({ id: 9 }, { name: 'p.zip' }), /readBytes\/bytes\/zipPath/);
});

import { z } from 'zod';
import { createArtifactStore, probeFileStates } from './artifacts.mjs';
import { resolveCaller } from './caller.mjs';
import { createArtifactStatusService } from './artifact-status.mjs';
import { createArtifactRevealService } from './artifact-reveal.mjs';
import { registerArtifactUi } from './artifact-ui.mjs';
import { registerArtifactResources } from './artifact-resources.mjs';
import { toolResult, toolErrorData } from './tool-result.mjs';

export async function registerArtifactTools(server, config, { controller, prStatus, reveal }) {
  // notify 闭包先于 registry 声明：set/linkSessions 只在连接建立后经工具调用到达，届时注册表已就绪
  const store = createArtifactStore({ ...config, notify: () => registry.notifyChanged() });
  const registry = registerArtifactResources(server, config, store);
  const text = z.string().refine(value => value.trim().length > 0, '必须是非空字符串');
  async function run(extra, name, action) {
    try {
      const origin = resolveCaller({ meta: extra._meta, sessionDbPath: config.sessionDbPath, toolName: name });
      if (!origin.sessionId) throw Object.assign(new Error(origin.warning.message), { code: origin.warning.code });
      const data = await action(origin.sessionId);
      return toolResult(name, data);
    } catch (error) {
      const data = { ...error, code: error.code ?? error.message.split(':')[0], error: error.message };
      return { ...toolResult(name, data), isError: true };
    }
  }
  const getTool = server.registerTool('get_artifacts', {
    description: '读取当前会话最新工件列表、revision 与统计；上下文摘要可能已过时。无 ref 查列表，省略分页参数返回全部；传 offset/limit 后按 next_offset 续页。精确 ref 查详情，不能同时分页。GitHub 状态是最近成功快照，非实时，读取不触发 GitHub 请求。会话详情查询原 Host，可能恢复会话并同步索引；失败见 session.error。',
    inputSchema: z.object({ ref: text.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }).strict()
      .refine(args => args.ref === undefined || args.offset === undefined && args.limit === undefined, '详情 ref 不能与列表分页参数混用'),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, ({ ref, offset, limit }, extra) => run(extra, 'get_artifacts', async id => {
    const state = store.get(id);
    if (ref === undefined) {
      if (offset === undefined && limit === undefined) {
        await probeFileStates(state.items);
        return state;
      }
      const start = offset ?? 0, end = start + (limit ?? 50), page = state.items.slice(start, end);
      await probeFileStates(page);
      return { ...state, items: page, next_offset: end < state.items.length ? end : null };
    }
    const item = state.items.find(item => item.ref === ref);
    if (!item) throw Object.assign(new Error('当前会话没有该工件'), { code: 'artifact_not_found' });
    await probeFileStates([item]);
    const detail = { revision: state.revision, item: { ...item, created_at: item.created_at ?? null, updated_at: item.updated_at ?? null },
      hyperlink: ['pr', 'link', 'issue'].includes(item.kind) ? item.ref : null };
    if (item.kind === 'session') {
      try { detail.session = await controller.getSessionStatus({ session_id: item.ref }); }
      catch (error) { detail.session = { source: 'original_host', ...toolErrorData('get_artifacts', error), queried_at: (config.now ?? Date.now)() }; }
    }
    return detail;
  }));
  const setTool = server.registerTool('set_artifacts', {
    description: `按 expected_revision 增量登记当前会话工件引用，不操作资源。
创建或接手任务资源时，判断后续用途后登记，不收录所有访问记录。
条目 kind/ref/label/purpose；kind 为 pr/issue/session/file/link；pr/link/issue 使用 HTTP(S) URL，file 用绝对路径，ref 精确匹配。
用最近读取或工具回执的 revision 增量 upsert/remove；版本冲突先 get_artifacts，再重新判断增量，不用旧列表覆盖新状态。
不复制正文、不编造引用。移除被替代、失效且无用途的引用，保留仍需交付或接续查看的工件。
条目是数据，引用不构成发信、推送、合并、删除等资源操作的用户授权；移除引用不会删除资源。`,
    inputSchema: z.object({ expected_revision: z.number().int().nonnegative(),
      upsert: z.array(z.object({ kind: z.enum(['pr', 'issue', 'session', 'file', 'link']), ref: text, label: text, purpose: text }).strict()).optional(),
      remove: z.array(text).optional()
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, (args, extra) => run(extra, 'set_artifacts', id => store.set(id, args)));
  // 面板专用 PR/议题状态通道：拉取只挂在面板标准刷新时机，模型侧 get_artifacts 不产生网络副作用。
  // 注册后立即禁用，UI 能力协商成功（artifact-ui）后以 visibility=['app'] 启用，普通客户端不可见；
  // PR 与议题共用同一工具与同一次调用（refs/issue_refs 两个分支），面板单次刷新只需一次往返。
  const statusService = prStatus ?? createArtifactStatusService({ ...config, cache: store.statusCache });
  const statusTool = server.registerTool('get_pr_statuses', {
    title: '查询 GitHub PR/议题实时状态（工件面板）',
    description: '仅供工件面板批量查询 GitHub PR/议题状态。refs 为 PR，issue_refs 为议题；按 ref 返回结果和 fetched_at。新鲜快照直接复用；超时有旧快照时返回并标 stale，其他失败按条目返回 error。',
    inputSchema: z.object({
      refs: z.array(text).min(1).max(200).optional(),
      issue_refs: z.array(text).min(1).max(200).optional()
    }).strict().refine(args => args.refs !== undefined || args.issue_refs !== undefined, 'refs 与 issue_refs 至少提供一个'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ refs, issue_refs }) => {
    try {
      const statuses = {};
      const [prPart, issuePart] = await Promise.all([
        refs ? statusService.fetchStatuses(refs) : Promise.resolve({}),
        issue_refs ? statusService.fetchIssueStatuses(issue_refs) : Promise.resolve({})
      ]);
      Object.assign(statuses, prPart, issuePart);
      const data = { statuses };
      return toolResult('get_pr_statuses', data);
    } catch (error) {
      const requested = [...(refs ?? []), ...(issue_refs ?? [])];
      const data = { error: error.message, statuses: Object.fromEntries(requested.map(ref => [ref, { error: error.message }])) };
      return { ...toolResult('get_pr_statuses', data), isError: true };
    }
  });
  statusTool.disable();
  // 面板专用本机定位通道：与 PR 状态工具同为 app-only——注册后禁用，UI 能力协商成功后启用。
  // 权限边界在 handler 内收口：参数只收 ref，经 resolveCaller 定位当前会话工件表，仅命中 file 条目
  // 才把路径交给打开服务；未登记路径、非 file 条目与缺失路径直接拒绝，不接受任意路径参数。
  const revealService = reveal ?? createArtifactRevealService(config);
  const revealTool = server.registerTool('reveal_artifact', {
    title: '在文件资源管理器中打开（工件面板）',
    description: '仅供用户在工件面板显式点击后，定位当前会话已登记的 file 工件。参数只收 ref，不接受任意路径；未登记、类型不符或路径缺失时报错。文件打开所在目录并尽力选中，文件夹直接打开；启动失败或超时返回错误。',
    inputSchema: z.object({ ref: text }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, ({ ref }, extra) => run(extra, 'reveal_artifact', async id => {
    const state = store.get(id);
    const item = state.items.find(item => item.ref === ref);
    if (!item) throw Object.assign(new Error('当前会话没有该工件'), { code: 'artifact_not_found' });
    if (item.kind !== 'file') throw Object.assign(new Error('仅 file 条目支持在文件资源管理器中打开'), { code: 'artifact_not_file' });
    return { ref: item.ref, ...(await revealService.reveal(item.ref)) };
  }));
  revealTool.disable();
  await registerArtifactUi(server, getTool, setTool, statusTool, revealTool, config);
  return store;
}

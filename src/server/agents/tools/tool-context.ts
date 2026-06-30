import type { Subject } from '@/lib/contracts';
import type { AgentContext } from '../types';
import { parseFrontmatter } from '@/server/wiki/frontmatter';
import * as pagesRepo from '@/server/db/repos/pages-repo';

/**
 * 工具执行上下文（DI 接缝）：工具只声明 schema + 记录访问，数据源由 ctx 注入。
 * ingest 提供 overlay-backed 实现；query 提供已提交+混合检索实现（见 query-tools.ts）。
 */
export interface ToolContext {
  subject: Subject;
  readPage(slug: string): Promise<{ title: string; markdown: string } | null>;
  search(query: string, limit: number): Promise<Array<{ slug: string; title: string; summary: string }>>;
  listPages(): Promise<Array<{ slug: string; title: string; summary: string; tags: string[] }>>;
  /** query 累积访问页用于引用核查；ingest 不传。 */
  onAccess?(page: { slug: string; title: string; body?: string }): void;
  /** 可选 job 事件（ingest 经 agentCtx.emit）；query 不传（工具活动由流式响应携带）。 */
  emit?(type: string, message: string, data?: Record<string, unknown>): void;
  /** query 侧触发 re-enrich 任务（入队）；ingest 不传 → 工具在 ingest 中调用会优雅报错。 */
  reenrich?(slug: string): Promise<{ jobId: string }>;
  /** query 侧同步删除一页（Saga）；ingest 不传 → 工具在 ingest 中调用会优雅报错。 */
  deletePage?(slug: string): Promise<{ deletedSlug: string; brokenBacklinks: number }>;
  /** query 侧同步新建一页（Saga）；ingest 不传。 */
  createPage?(input: { title: string; body: string; summary?: string; tags?: string[] }):
    Promise<{ createdSlug: string }>;
  /** curate 侧合并两页（Saga）；仅 worker curate runner 注入。 */
  mergePages?(targetSlug: string, sourceSlug: string):
    Promise<{ mergedSlug: string; deletedSlug: string; referencesRepointed: number }>;
  /** curate 侧拆分一页（Saga）；仅 worker curate runner 注入。 */
  splitPage?(slug: string, hint?: string):
    Promise<{ primarySlug: string; pageSlugs: string[]; referencesRepointed: number }>;
  /** 逃生舱：仅 ingest-only 工具（commit_changeset / dispatch.skill）使用。 */
  agent?: AgentContext;
}

/** 从 AgentContext 构造 ingest 侧 ToolContext：读/搜走 overlay（含本 job 暂存页），列举走 pagesRepo。 */
export function agentToolContext(agentCtx: AgentContext): ToolContext {
  const subjectSlug = agentCtx.subject.slug;
  return {
    subject: agentCtx.subject,
    async readPage(slug) {
      const res = await agentCtx.overlay.readPage(subjectSlug, slug);
      if (!res) return null;
      const title = parseFrontmatter(res.markdown).data.title || slug;
      return { title, markdown: res.markdown };
    },
    async search(query, limit) {
      const hits = await agentCtx.overlay.search(subjectSlug, query);
      return hits.slice(0, limit).map((h) => ({ slug: h.slug, title: h.title, summary: h.summary }));
    },
    async listPages() {
      return pagesRepo
        .getAllPages(agentCtx.subject.id)
        .filter((p) => !pagesRepo.isMetaPage(p))
        .map((p) => ({ slug: p.slug, title: p.title, summary: p.summary ?? '', tags: (p.tags ?? []).filter((t) => t !== 'meta') }));
    },
    emit: (type, message, data) => agentCtx.emit(type, message, data),
    agent: agentCtx,
  };
}

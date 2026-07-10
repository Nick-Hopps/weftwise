/**
 * Curate tool-loop 的 worker 侧 ToolContext。
 * 只读：已提交 vault（readPageInSubject）+ 混合检索（hybridRankSlugs）+ 列举（过滤 meta）——与 query-tools 读侧同构。
 * 写：merge/split/delete/create 各先过 CurateGuard，allow→调 page-ops 内核→guard.record→emit curate:* 事件；
 *     deny→emit curate:skip + 抛错（工具层 catch 成 ok:false，把 reason 透传给模型）。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';
import { readPageInSubject } from '../wiki/wiki-store';
import { executePageMerge, executePageSplit, executePageDelete, executePageCreate } from '../wiki/page-ops';
import type { CurateGuard } from '../wiki/curate-plan';
import type { Subject } from '@/lib/contracts';
import type { ToolContext } from '@/server/agents/tools/tool-context';
import { createSubjectEvidenceReader } from '@/server/agents/tools/evidence-reader';

const SEARCH_LIMIT_DEFAULT = 8;

export function buildCurateToolContext(
  subject: Subject,
  deps: {
    guard: CurateGuard;
    jobId: string;
    emit: (type: string, message: string, data?: Record<string, unknown>) => void;
  },
): ToolContext {
  const { guard, jobId, emit } = deps;
  const evidence = createSubjectEvidenceReader(subject);
  return {
    subject,
    async readPage(slug) {
      if (!guard.isAllowed(slug)) return null;
      const page = pagesRepo.getPageBySlug(subject.id, slug);
      const doc = readPageInSubject(subject.slug, slug);
      if (!page || !doc) return null;
      return { title: page.title, markdown: doc.body };
    },
    async search(query, limit) {
      const slugs = await hybridRankSlugs(subject.id, query, limit ?? SEARCH_LIMIT_DEFAULT);
      const hits: Array<{ slug: string; title: string; summary: string }> = [];
      for (const slug of slugs) {
        if (!guard.isAllowed(slug)) continue;
        const p = pagesRepo.getPageBySlug(subject.id, slug);
        if (!p || pagesRepo.isMetaPage(p)) continue;
        hits.push({ slug, title: p.title, summary: p.summary ?? '' });
      }
      return hits;
    },
    async inspectPage(slug, include) {
      return evidence.inspectPage(slug, include);
    },
    async searchSources(input) {
      return evidence.searchSources(input);
    },
    async readSource(input) {
      return evidence.readSource(input);
    },
    async listPages(input, options) {
      return evidence.listPages(input, options);
    },
    emit,
    async mergePages(targetSlug, sourceSlug) {
      const d = guard.canMerge(targetSlug, sourceSlug);
      if (!d.ok) { emit('curate:skip', `Skip merge ${sourceSlug}→${targetSlug}: ${d.reason}`, { targetSlug, sourceSlug, reason: d.reason }); throw new Error(d.reason); }
      emit('curate:merge', `Merging "${sourceSlug}" into "${targetSlug}"…`, { targetSlug, sourceSlug });
      const res = await executePageMerge(jobId, subject, { targetSlug, sourceSlug });
      guard.record('merge');
      return res;
    },
    async splitPage(slug, hint) {
      const d = guard.canSplit(slug);
      if (!d.ok) { emit('curate:skip', `Skip split ${slug}: ${d.reason}`, { slug, reason: d.reason }); throw new Error(d.reason); }
      emit('curate:split', `Splitting "${slug}"…`, { sourceSlug: slug });
      const res = await executePageSplit(jobId, subject, { sourceSlug: slug, hint });
      guard.record('split');
      return { primarySlug: res.primarySlug, pageSlugs: res.pageSlugs, referencesRepointed: res.referencesRepointed };
    },
    async deletePage(slug) {
      const d = guard.canDelete(slug);
      if (!d.ok) { emit('curate:skip', `Skip delete ${slug}: ${d.reason}`, { slug, reason: d.reason }); throw new Error(d.reason); }
      emit('curate:delete', `Deleting "${slug}"…`, { slug });
      const res = await executePageDelete(jobId, subject, slug);
      guard.record('delete');
      return res;
    },
    async createPage(input) {
      const d = guard.canCreate();
      if (!d.ok) { emit('curate:skip', `Skip create "${input.title}": ${d.reason}`, { title: input.title, reason: d.reason }); throw new Error(d.reason); }
      const res = await executePageCreate(jobId, subject, input);
      guard.record('create');
      emit('curate:create', `Created "${res.createdSlug}".`, { slug: res.createdSlug });
      return res;
    },
  };
}

/**
 * Curate tool-loop 的 worker 侧 ToolContext。
 * 只读：已提交 vault（readPageInSubject）+ 混合检索（hybridRankSlugs）+ 列举（过滤 meta）——与 query-tools 读侧同构。
 * 写：merge/split/delete/create/metadataPatch/linkEnsure 各先过 CurateGuard，allow→调 page-ops 内核→guard.record→emit curate:* 事件；
 *     deny→emit curate:skip + 抛错（工具层 catch 成 ok:false，把 reason 透传给模型）。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';
import { readPageInSubject } from '../wiki/wiki-store';
import {
  executePageCreate,
  executePageDelete,
  executePageLinkEnsure,
  executePageMerge,
  executePageMetadataPatch,
  executePagePatch,
  executePageSplit,
} from '../wiki/page-ops';
import { applyPatchEdits } from '../wiki/page-operation-plan';
import { checkRewriteFidelity, FIDELITY_PROFILES } from '../wiki/rewrite-fidelity';
import type { CurateGuard } from '../wiki/curate-plan';
import type { Subject } from '@/lib/contracts';
import type { ToolContext } from '@/server/agents/tools/tool-context';
import { createSubjectEvidenceReader } from '@/server/agents/tools/evidence-reader';

const SEARCH_LIMIT_DEFAULT = 8;

/** 单个 Curate job 内串行化完整写临界区；前一写失败不阻塞后续写。 */
function createSerialWriteQueue(): <T>(write: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(write: () => Promise<T>): Promise<T> => {
    const result = tail.then(write);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

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
  const runWrite = createSerialWriteQueue();
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
      return runWrite(async () => {
        const d = guard.canMerge(targetSlug, sourceSlug);
        if (!d.ok) { emit('curate:skip', `Skip merge ${sourceSlug}→${targetSlug}: ${d.reason}`, { targetSlug, sourceSlug, reason: d.reason }); throw new Error(d.reason); }
        emit('curate:merge', `Merging "${sourceSlug}" into "${targetSlug}"…`, { targetSlug, sourceSlug });
        const res = await executePageMerge(jobId, subject, { targetSlug, sourceSlug });
        guard.record('merge');
        return res;
      });
    },
    async splitPage(slug, hint) {
      return runWrite(async () => {
        const d = guard.canSplit(slug);
        if (!d.ok) { emit('curate:skip', `Skip split ${slug}: ${d.reason}`, { slug, reason: d.reason }); throw new Error(d.reason); }
        emit('curate:split', `Splitting "${slug}"…`, { sourceSlug: slug });
        const res = await executePageSplit(jobId, subject, { sourceSlug: slug, hint });
        guard.record('split');
        return { primarySlug: res.primarySlug, pageSlugs: res.pageSlugs, referencesRepointed: res.referencesRepointed };
      });
    },
    async deletePage(slug) {
      return runWrite(async () => {
        const d = guard.canDelete(slug);
        if (!d.ok) { emit('curate:skip', `Skip delete ${slug}: ${d.reason}`, { slug, reason: d.reason }); throw new Error(d.reason); }
        emit('curate:delete', `Deleting "${slug}"…`, { slug });
        const res = await executePageDelete(jobId, subject, slug);
        guard.record('delete');
        return res;
      });
    },
    async createPage(input) {
      return runWrite(async () => {
        const d = guard.canCreate();
        if (!d.ok) { emit('curate:skip', `Skip create "${input.title}": ${d.reason}`, { title: input.title, reason: d.reason }); throw new Error(d.reason); }
        const res = await executePageCreate(jobId, subject, input);
        guard.record('create');
        emit('curate:create', `Created "${res.createdSlug}".`, { slug: res.createdSlug });
        return res;
      });
    },
    async metadataPatch(input) {
      return runWrite(async () => {
        const d = guard.canEditPage(input.slug);
        if (!d.ok) {
          emit('curate:skip', `Skip metadata update ${input.slug}: ${d.reason}`, {
            slug: input.slug,
            reason: d.reason,
          });
          throw new Error(d.reason);
        }
        const res = await executePageMetadataPatch(jobId, subject, input);
        guard.record('update');
        emit('curate:update', `Updated metadata for "${res.updatedSlug}".`, {
          slug: res.updatedSlug,
          changedFields: res.changedFields,
        });
        return res;
      });
    },
    async linkEnsure(input) {
      return runWrite(async () => {
        const d = guard.canEditPage(input.sourceSlug);
        if (!d.ok) {
          emit('curate:skip', `Skip link update ${input.sourceSlug}: ${d.reason}`, {
            slug: input.sourceSlug,
            reason: d.reason,
          });
          throw new Error(d.reason);
        }
        const res = await executePageLinkEnsure(jobId, subject, input);
        guard.record('update');
        emit('curate:update', `Maintained one link in "${res.updatedSlug}".`, {
          slug: res.updatedSlug,
          mode: res.mode,
        });
        return res;
      });
    },
    /**
     * 局部改正文。存在的理由只有一个：孤页的源页压根没提过目标概念时，`linkEnsure` 要求的
     * 「已存在的唯一自然锚点」不存在，补一句真实相关的话是唯一出路。
     *
     * `wiki.patch` 在 fix/query 两条既有路径上都没有忠实度护栏（精确唯一替换风险面小）。
     * 这里补上——Curate auto 是无人复核的后台任务，`FIDELITY_PROFILES.fix` 至少拦住
     * 「正文缩水」与「丢失原有链接」。护栏挡不住「顺手改写别处 / 一次插多段」，那部分只有
     * prompt 纪律，取舍已记录在 docs/specs/2026-07-29-curate-orphan-autofix.md 的 C1。
     */
    async patchPage(input) {
      return runWrite(async () => {
        const d = guard.canEditPage(input.slug);
        if (!d.ok) {
          emit('curate:skip', `Skip patch ${input.slug}: ${d.reason}`, {
            slug: input.slug,
            reason: d.reason,
          });
          throw new Error(d.reason);
        }

        const current = readPageInSubject(subject.slug, input.slug);
        if (!current) {
          const reason = `page "${input.slug}" could not be read`;
          emit('curate:skip', `Skip patch ${input.slug}: ${reason}`, { slug: input.slug, reason });
          throw new Error(reason);
        }
        // 先在内存里算出候选正文过护栏，再落 Saga——不过就一次盘都不写
        const candidate = applyPatchEdits(current.body, input.edits);
        const fidelity = checkRewriteFidelity(
          current.body,
          candidate,
          FIDELITY_PROFILES.fix,
        );
        if (!fidelity.ok) {
          const reason = `fidelity guard rejected the patch: ${fidelity.violations.join('; ')}`;
          emit('curate:skip', `Skip patch ${input.slug}: ${reason}`, {
            slug: input.slug,
            reason,
            violations: fidelity.violations,
          });
          throw new Error(reason);
        }

        const res = await executePagePatch(jobId, subject, input);
        guard.record('update');
        emit('curate:update', `Patched "${res.updatedSlug}" (${res.appliedEdits} edit(s)).`, {
          slug: res.updatedSlug,
          appliedEdits: res.appliedEdits,
        });
        return res;
      });
    },
  };
}

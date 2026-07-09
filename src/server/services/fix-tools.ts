/**
 * fix tool-loop 的 worker 侧 ToolContext。
 * 只读：已提交 vault（readPageInSubject）+ 混合检索（hybridRankSlugs）+ 列举（过滤 meta）——与 curate-tools 读侧同构。
 * 写：仅 update（不注入 createPage——断链只允许重链/解链，禁止补建 stub 页）；
 *     先过 FixGuard（写 cap + 保护页）再过忠实度（checkRewriteFidelity，profile 'fix'）；
 *     allow→调 page-ops 内核（坏链/残链由内核确定性拒绝）→guard.record→emit fix:page；
 *     deny→emit fix:skip/fix:warn + 抛错（工具层 catch 成 ok:false，把 reason 透传给模型）。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';
import { readPageInSubject } from '../wiki/wiki-store';
import { executePageUpdate } from '../wiki/page-ops';
import type { FixGuard } from './fix-deterministic';
import { checkRewriteFidelity, FIDELITY_PROFILES } from '@/server/wiki/rewrite-fidelity';
import type { Subject } from '@/lib/contracts';
import type { ToolContext } from '@/server/agents/tools/tool-context';

const LIST_CAP = 200;
const SEARCH_LIMIT_DEFAULT = 8;

export function buildFixToolContext(
  subject: Subject,
  deps: {
    guard: FixGuard;
    jobId: string;
    emit: (type: string, message: string, data?: Record<string, unknown>) => void;
  },
): ToolContext {
  const { guard, jobId, emit } = deps;
  return {
    subject,
    async readPage(slug) {
      const page = pagesRepo.getPageBySlug(subject.id, slug);
      const doc = readPageInSubject(subject.slug, slug);
      if (!page || !doc) return null;
      return { title: page.title, markdown: doc.body };
    },
    async search(query, limit) {
      const slugs = await hybridRankSlugs(subject.id, query, limit ?? SEARCH_LIMIT_DEFAULT);
      const hits: Array<{ slug: string; title: string; summary: string }> = [];
      for (const slug of slugs) {
        const p = pagesRepo.getPageBySlug(subject.id, slug);
        if (!p || pagesRepo.isMetaPage(p)) continue;
        hits.push({ slug, title: p.title, summary: p.summary ?? '' });
      }
      return hits;
    },
    async listPages() {
      return pagesRepo
        .getAllPages(subject.id)
        .filter((p) => !pagesRepo.isMetaPage(p))
        .slice(0, LIST_CAP)
        .map((p) => ({ slug: p.slug, title: p.title, summary: p.summary ?? '', tags: (p.tags ?? []).filter((t) => t !== 'meta') }));
    },
    emit,
    async updatePage(input) {
      const cap = guard.canWrite();
      if (!cap.ok) { emit('fix:skip', `Skip update ${input.slug}: ${cap.reason}`, { slug: input.slug, reason: cap.reason }); throw new Error(cap.reason); }
      const prot = guard.canEditPage(input.slug);
      if (!prot.ok) { emit('fix:skip', `Skip update ${input.slug}: ${prot.reason}`, { slug: input.slug, reason: prot.reason }); throw new Error(prot.reason); }
      const doc = readPageInSubject(subject.slug, input.slug);
      if (!doc) { const reason = `page "${input.slug}" not found`; emit('fix:skip', `Skip update ${input.slug}: ${reason}`, { slug: input.slug, reason }); throw new Error(reason); }
      const fidelity = checkRewriteFidelity(doc.body, input.body, FIDELITY_PROFILES.fix);
      if (!fidelity.ok) {
        // 通用短语保留（下游/测试据此识别忠实度拦截），后缀带上具体违规项让日志可诊断
        const reason = `edit dropped too much content: ${fidelity.violations.join('; ')}`;
        emit('fix:warn', `Rejected update ${input.slug}: ${reason}`, { slug: input.slug, reason, violations: fidelity.violations });
        throw new Error(reason);
      }
      const res = await executePageUpdate(jobId, subject, input);
      guard.record('update');
      emit('fix:page', `Repaired "${res.updatedSlug}".`, { slug: res.updatedSlug });
      return res;
    },
  };
}

/**
 * Ask AI 工具循环用的 subject-scoped ToolContext。
 *
 * 提供 buildQueryToolContext（消费 createBuiltinToolRegistry + compileToolSet），
 * 替代旧的内联 tool() 孤岛 buildQueryTools。
 * AccessedPages / createAccessedPages / subjectHasContent / accessedToContext 保持不变。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';
import { readPageInSubject } from '../wiki/wiki-store';
import type { PendingActionView, Subject, SubjectId } from '@/lib/contracts';
import type { ToolContext } from '@/server/agents/tools/tool-context';
import { webSearch } from '@/server/search/web-search';
import { createSubjectEvidenceReader } from '@/server/agents/tools/evidence-reader';
import { createPendingActionPreview } from './pending-action-service';

/** search_wiki 默认返回条数。 */
const SEARCH_LIMIT_DEFAULT = 8;

export interface QueryContextPage {
  slug: string;
  title: string;
  content: string;
  isCurrent?: boolean;
}

/** 模型本轮工具调用访问过的页：meta=搜索/列举命中；bodies=read_page 全文。 */
export interface AccessedPages {
  meta: Map<string, { title: string; summary: string }>;
  bodies: Map<string, { title: string; body: string }>;
  sourceRefs: Map<string, { sourceId: string; chunkId?: string }>;
}

export function createAccessedPages(): AccessedPages {
  return { meta: new Map(), bodies: new Map(), sourceRefs: new Map() };
}

/** 当前 subject 是否有任何非 meta 页（空 subject 守卫用）。 */
export function subjectHasContent(subjectId: SubjectId): boolean {
  return pagesRepo.getAllPages(subjectId).some((p) => !pagesRepo.isMetaPage(p));
}

export interface QueryToolContextOptions {
  conversationId?: string;
  onPendingAction?: (action: PendingActionView) => void;
}

/**
 * query 侧 ToolContext：读已提交正文、混合检索、列举全部（过滤 meta）；onAccess 累积引用。
 *
 * onAccess 路由（行为等价于旧 buildQueryTools）：
 *   - wiki.read 命中时传 body（非空字符串）→ 写 accessed.bodies（全文引用）
 *   - wiki.search / wiki.list 无 body → 写 accessed.meta（仅元数据引用）
 *   - 若 slug 已在 bodies 中，meta 写入被跳过（去重、不降级）
 */
export function buildQueryToolContext(
  subject: Subject,
  accessed: AccessedPages,
  options: QueryToolContextOptions = {},
): ToolContext {
  const evidence = createSubjectEvidenceReader(subject);
  const approvalCapabilities: Partial<ToolContext> = options.conversationId
    ? {
        conversationId: options.conversationId,
        previewChange: (input) => createPendingActionPreview({
          conversationId: options.conversationId!,
          subject,
          input,
        }),
        onPendingAction: options.onPendingAction,
      }
    : {};
  return {
    subject,
    ...approvalCapabilities,
    async readPage(slug) {
      const page = pagesRepo.getPageBySlug(subject.id, slug);
      const doc = readPageInSubject(subject.slug, slug);
      if (!page || !doc || doc.body.trim().length === 0) return null;
      return { title: page.title, markdown: doc.body };
    },
    async search(query, limit) {
      const slugs = await hybridRankSlugs(subject.id, query, limit ?? SEARCH_LIMIT_DEFAULT);
      const hits: Array<{ slug: string; title: string; summary: string }> = [];
      for (const slug of slugs) {
        const page = pagesRepo.getPageBySlug(subject.id, slug);
        if (!page || pagesRepo.isMetaPage(page)) continue;
        hits.push({ slug, title: page.title, summary: page.summary ?? '' });
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
    onAccess({ slug, title, body }) {
      if (body !== undefined && body.trim().length > 0) {
        accessed.bodies.set(slug, { title, body });
      } else if (!accessed.bodies.has(slug)) {
        accessed.meta.set(slug, { title, summary: '' });
      }
    },
    onSourceAccess({ sourceId, chunkId }) {
      accessed.sourceRefs.set(`${sourceId}\u0000${chunkId ?? ''}`, { sourceId, chunkId });
    },
    async webSearch(query) {
      return webSearch(query);
    },
  };
}

/**
 * 把模型访问过的页转成引用核查用的 context：read 过的用全文；
 * 只在搜索/列举里出现、未读的按需补读全文；去重、剔除空正文。
 */
export function accessedToContext(
  subject: Subject,
  accessed: AccessedPages,
): QueryContextPage[] {
  const out: QueryContextPage[] = [];
  const seen = new Set<string>();

  for (const [slug, { title, body }] of accessed.bodies) {
    if (seen.has(slug) || body.trim().length === 0) continue;
    seen.add(slug);
    out.push({ slug, title, content: body });
  }

  for (const [slug, { title }] of accessed.meta) {
    if (seen.has(slug)) continue;
    const doc = readPageInSubject(subject.slug, slug);
    const content = doc?.body ?? '';
    if (content.trim().length === 0) continue;
    seen.add(slug);
    out.push({ slug, title, content });
  }

  return out;
}

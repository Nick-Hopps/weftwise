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
import type { Subject, SubjectId } from '@/lib/contracts';
import type { ToolContext } from '@/server/agents/tools/tool-context';
import { enqueueReenrich } from './reenrich-enqueue';
import { deletePageInSubject, createPageInSubject, updatePageInSubject } from './page-write';
import { webSearch } from '@/server/search/web-search';

/** list_pages 单次返回的页数上限（超大 subject 截断）。 */
const LIST_PAGES_CAP = 200;
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
}

export function createAccessedPages(): AccessedPages {
  return { meta: new Map(), bodies: new Map() };
}

/** 当前 subject 是否有任何非 meta 页（空 subject 守卫用）。 */
export function subjectHasContent(subjectId: SubjectId): boolean {
  return pagesRepo.getAllPages(subjectId).some((p) => !pagesRepo.isMetaPage(p));
}

/**
 * query 侧 ToolContext：读已提交正文、混合检索、列举全部（过滤 meta）；onAccess 累积引用。
 *
 * onAccess 路由（行为等价于旧 buildQueryTools）：
 *   - wiki.read 命中时传 body（非空字符串）→ 写 accessed.bodies（全文引用）
 *   - wiki.search / wiki.list 无 body → 写 accessed.meta（仅元数据引用）
 *   - 若 slug 已在 bodies 中，meta 写入被跳过（去重、不降级）
 */
export function buildQueryToolContext(subject: Subject, accessed: AccessedPages): ToolContext {
  return {
    subject,
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
    async listPages() {
      const all = pagesRepo
        .getAllPages(subject.id)
        .filter((p) => !pagesRepo.isMetaPage(p))
        .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0));
      return all.slice(0, LIST_PAGES_CAP).map((p) => ({
        slug: p.slug,
        title: p.title,
        summary: p.summary ?? '',
        tags: (p.tags ?? []).filter((t) => t !== 'meta'),
      }));
    },
    onAccess({ slug, title, body }) {
      if (body !== undefined && body.trim().length > 0) {
        accessed.bodies.set(slug, { title, body });
      } else if (!accessed.bodies.has(slug)) {
        accessed.meta.set(slug, { title, summary: '' });
      }
    },
    async reenrich(slug) {
      return enqueueReenrich(subject.id, slug);
    },
    async deletePage(slug) {
      return deletePageInSubject(subject, slug);
    },
    async createPage(input) {
      return createPageInSubject(subject, input);
    },
    async updatePage(input) {
      return updatePageInSubject(subject, input);
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

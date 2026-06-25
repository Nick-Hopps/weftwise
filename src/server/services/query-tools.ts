/**
 * Ask AI 工具循环用的 subject-scoped 检索工具。
 *
 * 三个只读工具（list_pages / search_wiki / read_page）全部闭包绑定 subject，
 * 模型自驱检索；execute 把访问到的页累积进 AccessedPages，供事后引用核查。
 */
import { tool } from 'ai';
import type { CoreTool } from 'ai';
import { z } from 'zod';
import * as pagesRepo from '../db/repos/pages-repo';
import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';
import { readPageInSubject } from '../wiki/wiki-store';
import type { Subject, SubjectId } from '@/lib/contracts';

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

export function buildQueryTools(
  subject: Subject,
  accessed: AccessedPages,
): Record<string, CoreTool> {
  return {
    list_pages: tool({
      description:
        'List ALL pages in the current subject (slug, title, summary, tags). ' +
        'Use this FIRST for broad/overview/summary questions such as "what does this cover", ' +
        '"summarise X", or "how do A and B relate". Returns up to 200 most-recently-updated pages.',
      parameters: z.object({}),
      execute: async () => {
        const all = pagesRepo
          .getAllPages(subject.id)
          .filter((p) => !pagesRepo.isMetaPage(p))
          .sort((a, b) =>
            a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0,
          );
        const top = all.slice(0, LIST_PAGES_CAP);
        for (const p of top) {
          accessed.meta.set(p.slug, { title: p.title, summary: p.summary ?? '' });
        }
        return {
          pages: top.map((p) => ({
            slug: p.slug,
            title: p.title,
            summary: p.summary ?? '',
            tags: (p.tags ?? []).filter((t) => t !== 'meta'),
          })),
          truncated: all.length > LIST_PAGES_CAP,
          total: all.length,
        };
      },
    }),

    search_wiki: tool({
      description:
        'Search the current subject for pages relevant to a query (hybrid full-text + semantic). ' +
        'Returns matching pages (slug, title, summary). Issue SEVERAL focused searches with ' +
        'different keywords to maximise recall, then use read_page to get full content.',
      parameters: z.object({
        query: z.string().min(1).describe('Search keywords or a natural-language phrase'),
        limit: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe('Max results (default 8)'),
      }),
      execute: async ({ query, limit }) => {
        const slugs = await hybridRankSlugs(subject.id, query, limit ?? SEARCH_LIMIT_DEFAULT);
        const hits: { slug: string; title: string; summary: string }[] = [];
        for (const slug of slugs) {
          const page = pagesRepo.getPageBySlug(subject.id, slug);
          if (!page || pagesRepo.isMetaPage(page)) continue;
          accessed.meta.set(slug, { title: page.title, summary: page.summary ?? '' });
          hits.push({ slug, title: page.title, summary: page.summary ?? '' });
        }
        return { hits };
      },
    }),

    read_page: tool({
      description:
        'Read the full markdown body of a page in the current subject by its slug. ' +
        'Use after search_wiki/list_pages to get details and the exact wording needed for citations.',
      parameters: z.object({
        slug: z.string().min(1).describe('The page slug (not the title)'),
      }),
      execute: async ({ slug }) => {
        const page = pagesRepo.getPageBySlug(subject.id, slug);
        const doc = readPageInSubject(subject.slug, slug);
        if (!page || !doc || doc.body.trim().length === 0) {
          return { error: `Page "${slug}" not found in this subject.` };
        }
        accessed.bodies.set(slug, { title: page.title, body: doc.body });
        return { slug, title: page.title, body: doc.body };
      },
    }),
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

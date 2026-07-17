/**
 * Ask AI 工具循环用的 subject-scoped ToolContext。
 *
 * 提供 buildQueryToolContext（消费 createBuiltinToolRegistry + compileToolSet），
 * 替代旧的内联 tool() 孤岛 buildQueryTools。
 * AccessedPages / createAccessedPages / accessedToContext 保持兼容并扩展跨 Subject 身份。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';
import { readPageInSubject } from '../wiki/wiki-store';
import type { PendingActionView, SelectionAnchorInput, Subject } from '@/lib/contracts';
import type { ToolContext } from '@/server/agents/tools/tool-context';
import { webSearch } from '@/server/search/web-search';
import { createSubjectEvidenceReader } from '@/server/agents/tools/evidence-reader';
import {
  createPendingActionPreview,
  createPendingHistoryRevertPreview,
  createPendingWorkflowActionPreview,
} from './pending-action-service';
import { listHistory, readHistoryDiff } from './history-tools';
import { readWorkflowStatus } from './workflow-tools';

/** search_wiki 默认返回条数。 */
const SEARCH_LIMIT_DEFAULT = 8;
const CROSS_SUBJECT_LIMIT_MAX = 20;

function crossSubjectError(message: string): Error {
  return new Error(`[SUBJECT_OUT_OF_SCOPE] ${message}`);
}

function resolveOtherSubject(activeSubject: Subject, subjectSlug: string): Subject {
  if (subjectSlug === activeSubject.slug) {
    throw crossSubjectError(`Subject "${subjectSlug}" is the active subject; use the current-subject tools instead.`);
  }
  const subject = subjectsRepo.getBySlug(subjectSlug);
  if (!subject) {
    throw crossSubjectError(`Unknown subject "${subjectSlug}".`);
  }
  return subject;
}

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
  crossMeta: Map<string, {
    subjectSlug: string;
    slug: string;
    title: string;
    summary: string;
  }>;
  crossBodies: Map<string, {
    subjectSlug: string;
    slug: string;
    title: string;
    body: string;
  }>;
  sourceRefs: Map<string, { sourceId: string; chunkId?: string }>;
}

export function createAccessedPages(): AccessedPages {
  return {
    meta: new Map(),
    bodies: new Map(),
    crossMeta: new Map(),
    crossBodies: new Map(),
    sourceRefs: new Map(),
  };
}

export function crossSubjectPageKey(subjectSlug: string, slug: string): string {
  return `${subjectSlug}\u0000${slug}`;
}

export interface QueryToolContextOptions {
  conversationId?: string;
  onPendingAction?: (action: PendingActionView) => void;
  currentPageSlug?: string;
  selection?: SelectionAnchorInput;
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
        previewHistoryRevert: (operationId) => createPendingHistoryRevertPreview({
          conversationId: options.conversationId!,
          subject,
          operationId,
        }),
        previewWorkflowReenrich: (slug) => createPendingWorkflowActionPreview({
          conversationId: options.conversationId!,
          subject,
          input: { operation: 'workflow-reenrich-start', payload: { slug } },
        }),
        previewWorkflowResearch: (topic) => createPendingWorkflowActionPreview({
          conversationId: options.conversationId!,
          subject,
          input: { operation: 'workflow-research-start', payload: { topic } },
        }),
        previewWorkflowCancel: (jobId) => createPendingWorkflowActionPreview({
          conversationId: options.conversationId!,
          subject,
          input: { operation: 'workflow-cancel', payload: { jobId } },
        }),
        onPendingAction: options.onPendingAction,
      }
    : {};
  return {
    subject,
    ...approvalCapabilities,
    async listHistory(input) {
      return listHistory(subject, input);
    },
    async readHistoryDiff(input) {
      return readHistoryDiff(subject, input);
    },
    async readWorkflowStatus(jobId) {
      return readWorkflowStatus(subject, jobId);
    },
    async listSubjects() {
      const subjects = subjectsRepo.listSubjects()
        .map((entry) => ({
          id: entry.id,
          slug: entry.slug,
          name: entry.name,
          description: entry.description,
          pageCount: pagesRepo.getAllPages(entry.id).filter((page) => !pagesRepo.isMetaPage(page)).length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
      return { subjects };
    },
    async searchCrossSubject(input) {
      const limit = Math.min(input.limit ?? SEARCH_LIMIT_DEFAULT, CROSS_SUBJECT_LIMIT_MAX);
      const selectedSubjects = [...new Set(input.subjectSlugs)]
        .map((slug) => resolveOtherSubject(subject, slug));
      const rankedBySubject = await Promise.all(selectedSubjects.map(async (targetSubject) => {
        const slugs = await hybridRankSlugs(targetSubject.id, input.query, limit);
        return slugs.flatMap((slug) => {
          const page = pagesRepo.getPageBySlug(targetSubject.id, slug);
          if (!page || pagesRepo.isMetaPage(page)) return [];
          return [{
            subjectSlug: targetSubject.slug,
            slug: page.slug,
            title: page.title,
            summary: page.summary ?? '',
          }];
        });
      }));

      const hits: Awaited<ReturnType<NonNullable<ToolContext['searchCrossSubject']>>>['hits'] = [];
      for (let rank = 0; hits.length < limit; rank++) {
        let added = false;
        for (const subjectHits of rankedBySubject) {
          const hit = subjectHits[rank];
          if (!hit) continue;
          hits.push(hit);
          added = true;
          if (hits.length === limit) break;
        }
        if (!added) break;
      }
      return { hits };
    },
    async readCrossSubjectPage(input) {
      const targetSubject = resolveOtherSubject(subject, input.subjectSlug);
      const canonicalSlug = pagesRepo.resolvePageAlias(targetSubject.id, input.slug) ?? input.slug;
      const page = pagesRepo.getPageBySlug(targetSubject.id, canonicalSlug);
      const empty = {
        found: false,
        subjectSlug: targetSubject.slug,
        slug: input.slug,
        title: null,
        body: null,
      };
      if (!page || pagesRepo.isMetaPage(page)) return empty;
      const doc = readPageInSubject(targetSubject.slug, canonicalSlug);
      if (!doc || doc.body.trim().length === 0) return empty;
      return {
        found: true,
        subjectSlug: targetSubject.slug,
        slug: page.slug,
        title: page.title,
        body: doc.body,
      };
    },
    async readPage(slug) {
      const canonicalSlug = pagesRepo.resolvePageAlias(subject.id, slug) ?? slug;
      const page = pagesRepo.getPageBySlug(subject.id, canonicalSlug);
      const doc = readPageInSubject(subject.slug, canonicalSlug);
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
    onAccess({ subjectSlug, slug, title, body }) {
      if (subjectSlug && subjectSlug !== subject.slug) {
        const key = crossSubjectPageKey(subjectSlug, slug);
        if (body !== undefined && body.trim().length > 0) {
          accessed.crossBodies.set(key, { subjectSlug, slug, title, body });
          accessed.crossMeta.delete(key);
        } else if (!accessed.crossBodies.has(key)) {
          accessed.crossMeta.set(key, { subjectSlug, slug, title, summary: '' });
        }
        return;
      }
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

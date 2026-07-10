import type {
  InspectSection,
  PageListInput,
  PageListResult,
  Source,
  SourceReadInput,
  SourceReadResult,
  SourceSearchInput,
  SourceSearchResult,
  Subject,
  WikiInspection,
  WikiPage,
} from '@/lib/contracts';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { getSourceMetadata } from '@/server/sources/source-store';
import { isSourceStale } from '@/server/sources/source-staleness';

const ALL_INSPECT_SECTIONS: InspectSection[] = [
  'links',
  'backlinks',
  'sources',
  'health',
];
const SOURCE_SEARCH_DEFAULT = 5;
const SOURCE_SEARCH_MAX = 10;
const SOURCE_EXCERPT_MAX = 2_000;
const SOURCE_EXCERPT_TOTAL_MAX = 12_000;
const SOURCE_READ_DEFAULT = 8_000;
const SOURCE_READ_MAX = 20_000;

interface SourceChunk {
  id: string;
  heading: string;
  text: string;
}

interface PageCursor {
  version: 1;
  sort: 'title' | 'updated';
  tag: string | null;
  lastValue: string;
  lastSlug: string;
}

export interface SubjectEvidenceReader {
  inspectPage(slug: string, include?: InspectSection[]): WikiInspection;
  searchSources(input: SourceSearchInput): SourceSearchResult;
  readSource(input: SourceReadInput): SourceReadResult;
  listPages(
    input?: PageListInput,
    options?: { allowedPageSlugs?: ReadonlySet<string> },
  ): PageListResult;
}

export function emptyWikiInspection(): WikiInspection {
  return {
    found: false,
    page: null,
    outgoing: [],
    backlinks: [],
    sources: [],
    health: {
      brokenLinks: 0,
      inboundCount: 0,
      outboundCount: 0,
      sourceCount: 0,
    },
  };
}

/** 读取页面关系、来源和轻量健康信息，不暴露页面正文。 */
export function inspectPageEvidence(
  subject: Subject,
  slug: string,
  include: InspectSection[] = ALL_INSPECT_SECTIONS,
): WikiInspection {
  const page = pagesRepo.getPageBySlug(subject.id, slug);
  if (!page || pagesRepo.isMetaPage(page)) return emptyWikiInspection();

  const requested = new Set(include);
  const needLinks = requested.has('links') || requested.has('health');
  const needBacklinks = requested.has('backlinks') || requested.has('health');
  const needSources = requested.has('sources') || requested.has('health');

  const links = needLinks
    ? pagesRepo.getAllLinks(subject.id).filter((link) => link.sourceSlug === slug)
    : [];
  const resolvedLinks = links.map((link) => {
    const targetSubject = subjectsRepo.getById(link.targetSubjectId);
    const target = pagesRepo.getPageBySlug(link.targetSubjectId, link.targetSlug);
    return {
      subjectSlug: targetSubject?.slug ?? '',
      slug: link.targetSlug,
      title: target?.title ?? null,
      context: link.context,
      resolved: target !== null,
    };
  });

  const backlinkPages = needBacklinks
    ? pagesRepo.getBacklinks(subject.id, slug)
    : [];
  const linkedSources = needSources
    ? sourcesRepo.getSourcesForPage(subject.id, slug)
    : [];

  return {
    found: true,
    page: {
      slug: page.slug,
      title: page.title,
      summary: page.summary ?? '',
      tags: page.tags ?? [],
      updatedAt: page.updatedAt,
    },
    outgoing: requested.has('links') ? resolvedLinks : [],
    backlinks: requested.has('backlinks')
      ? backlinkPages.map((backlink) => ({
          subjectSlug: subjectsRepo.getById(backlink.subjectId)?.slug ?? '',
          slug: backlink.slug,
          title: backlink.title,
        }))
      : [],
    sources: requested.has('sources')
      ? linkedSources.map((source) => ({
          id: source.id,
          filename: source.filename,
          originUrl: readOriginUrl(
            getSourceMetadata(source.id) ?? parseMetadataJson(source.metadataJson),
          ),
          parsedAt: source.parsedAt,
          stale: isSourceStale(subject.slug, source),
        }))
      : [],
    health: requested.has('health')
      ? {
          brokenLinks: resolvedLinks.filter((link) => !link.resolved).length,
          inboundCount: backlinkPages.length,
          outboundCount: links.length,
          sourceCount: linkedSources.length,
        }
      : {
          brokenLinks: 0,
          inboundCount: 0,
          outboundCount: 0,
          sourceCount: 0,
        },
  };
}

/** 在当前 Subject 的解析后来源块中执行确定性词项检索。 */
export function searchSourceEvidence(
  subject: Subject,
  input: SourceSearchInput,
): SourceSearchResult {
  const terms = termsOf(input.query);
  if (terms.length === 0) return { hits: [] };

  const candidates = resolveSourceCandidates(subject, input);
  const hits: SourceSearchResult['hits'] = [];
  for (const source of candidates) {
    const chunks = readValidChunks(getSourceMetadata(source.id));
    for (const chunk of chunks) {
      const score = terms.reduce(
        (total, term) => total
          + occurrences(chunk.heading, term) * 2
          + occurrences(chunk.text, term),
        0,
      );
      if (score === 0) continue;
      hits.push({
        sourceId: source.id,
        filename: source.filename,
        chunkId: chunk.id,
        heading: chunk.heading,
        excerpt: excerptAroundFirstMatch(chunk.text, terms),
        score,
      });
    }
  }

  hits.sort(compareSourceHits);
  const limit = Math.min(
    SOURCE_SEARCH_MAX,
    Math.max(1, Math.floor(input.limit ?? SOURCE_SEARCH_DEFAULT)),
  );
  const bounded: SourceSearchResult['hits'] = [];
  let excerptTotal = 0;
  for (const hit of hits) {
    if (bounded.length >= limit || excerptTotal >= SOURCE_EXCERPT_TOTAL_MAX) break;
    const remaining = SOURCE_EXCERPT_TOTAL_MAX - excerptTotal;
    const excerpt = hit.excerpt.slice(0, remaining);
    bounded.push({ ...hit, excerpt });
    excerptTotal += excerpt.length;
  }
  return { hits: bounded };
}

/** 按 chunk 或拼接后的逻辑文本读取受限窗口。 */
export function readSourceEvidence(
  subject: Subject,
  input: SourceReadInput,
): SourceReadResult {
  const source = sourcesRepo.getSource(input.sourceId);
  if (!source || source.subjectId !== subject.id) {
    throw sourceError(
      'SOURCE_OUT_OF_SCOPE',
      'Source is not available in the current subject.',
    );
  }

  const chunks = readValidChunks(getSourceMetadata(source.id));
  if (chunks.length === 0) {
    throw sourceError(
      'SOURCE_CONTENT_UNAVAILABLE',
      `Source "${source.id}" has no parsed chunks.`,
    );
  }

  const selected = input.chunkId
    ? chunks.find((chunk) => chunk.id === input.chunkId)?.text
    : chunks.map((chunk) => chunk.text).join('\n\n');
  if (selected === undefined) {
    throw sourceError(
      'SOURCE_CONTENT_UNAVAILABLE',
      `Chunk "${input.chunkId}" is unavailable.`,
    );
  }

  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limit = Math.min(
    SOURCE_READ_MAX,
    Math.max(1, Math.floor(input.limit ?? SOURCE_READ_DEFAULT)),
  );
  const content = selected.slice(offset, offset + limit);
  const end = offset + content.length;
  const truncated = end < selected.length;
  return {
    sourceId: source.id,
    filename: source.filename,
    chunkId: input.chunkId ?? null,
    content,
    nextOffset: truncated ? end : null,
    truncated,
  };
}

/** 使用版本化 keyset cursor 列举当前 Subject 页面。 */
export function listPageEvidence(
  subject: Subject,
  input: PageListInput = {},
  options: { allowedPageSlugs?: ReadonlySet<string> } = {},
): PageListResult {
  const sort = input.sort ?? 'title';
  const tag = input.tag ?? null;
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
  const cursor = input.cursor ? decodeCursor(input.cursor, sort, tag) : null;

  const candidates = pagesRepo
    .getAllPages(subject.id)
    .filter((page) => !pagesRepo.isMetaPage(page))
    .filter((page) => tag === null || page.tags.includes(tag))
    .filter((page) => !options.allowedPageSlugs || options.allowedPageSlugs.has(page.slug))
    .sort((a, b) => comparePages(a, b, sort))
    .filter((page) => !cursor || isAfterCursor(page, cursor));

  const window = candidates.slice(0, limit + 1);
  const pageWindow = window.slice(0, limit);
  const hasMore = window.length > limit;
  const lastPage = pageWindow.at(-1);
  return {
    pages: pageWindow.map((page) => ({
      slug: page.slug,
      title: page.title,
      summary: page.summary ?? '',
      tags: page.tags.filter((pageTag) => pageTag !== 'meta'),
      updatedAt: page.updatedAt,
    })),
    nextCursor: hasMore && lastPage
      ? encodeCursor({
          version: 1,
          sort,
          tag,
          lastValue: sort === 'title' ? lastPage.title : lastPage.updatedAt,
          lastSlug: lastPage.slug,
        })
      : null,
  };
}

export function createSubjectEvidenceReader(subject: Subject): SubjectEvidenceReader {
  return {
    inspectPage: (slug, include) => inspectPageEvidence(subject, slug, include),
    searchSources: (input) => searchSourceEvidence(subject, input),
    readSource: (input) => readSourceEvidence(subject, input),
    listPages: (input, options) => listPageEvidence(subject, input, options),
  };
}

function resolveSourceCandidates(subject: Subject, input: SourceSearchInput): Source[] {
  const explicit = input.sourceIds === undefined
    ? null
    : input.sourceIds.map((sourceId) => {
        const source = sourcesRepo.getSource(sourceId);
        if (!source || source.subjectId !== subject.id) {
          throw sourceError(
            'SOURCE_OUT_OF_SCOPE',
            'Source is not available in the current subject.',
          );
        }
        return source;
      });
  const pageSources = input.pageSlug === undefined
    ? null
    : sourcesRepo.getSourcesForPage(subject.id, input.pageSlug);

  let candidates: Source[];
  if (explicit && pageSources) {
    const explicitIds = new Set(explicit.map((source) => source.id));
    candidates = pageSources.filter((source) => explicitIds.has(source.id));
  } else if (explicit) {
    candidates = explicit;
  } else if (pageSources) {
    candidates = pageSources;
  } else {
    candidates = sourcesRepo.listSourcesForSubject(subject.id);
  }

  return [...new Map(
    candidates
      .filter((source) => source.subjectId === subject.id)
      .map((source) => [source.id, source]),
  ).values()];
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(
  raw: string,
  sort: PageCursor['sort'],
  tag: string | null,
): PageCursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    const cursor = value as Record<string, unknown>;
    if (
      cursor.version !== 1
      || (cursor.sort !== 'title' && cursor.sort !== 'updated')
      || cursor.sort !== sort
      || (cursor.tag !== null && typeof cursor.tag !== 'string')
      || cursor.tag !== tag
      || typeof cursor.lastValue !== 'string'
      || typeof cursor.lastSlug !== 'string'
    ) {
      throw new Error('mismatch');
    }
    return cursor as unknown as PageCursor;
  } catch {
    throw new Error(
      '[INVALID_CURSOR] Cursor is invalid or does not match the requested filters.',
    );
  }
}

function comparePages(
  a: WikiPage,
  b: WikiPage,
  sort: PageCursor['sort'],
): number {
  const aValue = sort === 'title' ? a.title : a.updatedAt;
  const bValue = sort === 'title' ? b.title : b.updatedAt;
  const valueOrder = sort === 'title'
    ? compareText(aValue, bValue)
    : compareText(bValue, aValue);
  return valueOrder || compareText(a.slug, b.slug);
}

function isAfterCursor(page: WikiPage, cursor: PageCursor): boolean {
  const value = cursor.sort === 'title' ? page.title : page.updatedAt;
  if (cursor.sort === 'title') {
    return value > cursor.lastValue
      || (value === cursor.lastValue && page.slug > cursor.lastSlug);
  }
  return value < cursor.lastValue
    || (value === cursor.lastValue && page.slug > cursor.lastSlug);
}

function termsOf(query: string): string[] {
  return query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const text = haystack.toLocaleLowerCase();
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function excerptAroundFirstMatch(text: string, terms: string[]): string {
  if (text.length <= SOURCE_EXCERPT_MAX) return text;
  const lower = text.toLocaleLowerCase();
  const firstMatch = terms.reduce((first, term) => {
    const index = lower.indexOf(term);
    return index >= 0 && (first < 0 || index < first) ? index : first;
  }, -1);
  const centeredStart = firstMatch < 0
    ? 0
    : Math.max(0, firstMatch - Math.floor(SOURCE_EXCERPT_MAX / 2));
  const start = Math.min(centeredStart, text.length - SOURCE_EXCERPT_MAX);
  return text.slice(start, start + SOURCE_EXCERPT_MAX);
}

function compareSourceHits(
  a: SourceSearchResult['hits'][number],
  b: SourceSearchResult['hits'][number],
): number {
  if (a.score !== b.score) return b.score - a.score;
  return compareText(a.filename, b.filename)
    || compareText(a.sourceId, b.sourceId)
    || compareText(a.chunkId, b.chunkId);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readValidChunks(metadata: Record<string, unknown> | null): SourceChunk[] {
  if (!Array.isArray(metadata?.chunks)) return [];
  return metadata.chunks.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const chunk = value as Record<string, unknown>;
    if (
      typeof chunk.id !== 'string'
      || typeof chunk.heading !== 'string'
      || typeof chunk.text !== 'string'
    ) {
      return [];
    }
    return [{ id: chunk.id, heading: chunk.heading, text: chunk.text }];
  });
}

function sourceError(
  code: 'SOURCE_OUT_OF_SCOPE' | 'SOURCE_CONTENT_UNAVAILABLE',
  message: string,
): Error {
  return new Error(`[${code}] ${message}`);
}

function readOriginUrl(metadata: Record<string, unknown> | null): string | null {
  return typeof metadata?.originUrl === 'string' && metadata.originUrl.length > 0
    ? metadata.originUrl
    : null;
}

function parseMetadataJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

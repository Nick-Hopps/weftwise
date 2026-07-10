import { beforeEach, describe, expect, it, vi } from 'vitest';

const pages = vi.hoisted(() => ({
  getPageBySlug: vi.fn(), getAllLinks: vi.fn(), getBacklinks: vi.fn(), isMetaPage: vi.fn(),
}));
const subjects = vi.hoisted(() => ({ getById: vi.fn() }));
const sources = vi.hoisted(() => ({
  listSourcesForSubject: vi.fn(), getSourcesForPage: vi.fn(), getSource: vi.fn(),
}));
const sourceStore = vi.hoisted(() => ({ getSourceMetadata: vi.fn() }));

vi.mock('@/server/db/repos/pages-repo', () => pages);
vi.mock('@/server/db/repos/subjects-repo', () => subjects);
vi.mock('@/server/db/repos/sources-repo', () => sources);
vi.mock('@/server/sources/source-store', () => sourceStore);
vi.mock('@/server/sources/source-staleness', () => ({ isSourceStale: vi.fn() }));

import { readSourceEvidence, searchSourceEvidence } from '../evidence-reader';

const subject = {
  id: 'sub1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as const;

function source(id: string, subjectId = 'sub1', filename = `${id}.md`) {
  return {
    id, subjectId, filename, contentHash: `hash-${id}`, parsedAt: '2026-01-01', metadataJson: '{}',
  };
}

function chunks(...items: Array<[string, string, string]>) {
  return {
    chunks: items.map(([id, heading, text]) => ({ id, heading, text, tokenCount: 1 })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sources.listSourcesForSubject.mockReturnValue([]);
  sources.getSourcesForPage.mockReturnValue([]);
  sources.getSource.mockReturnValue(null);
  sourceStore.getSourceMetadata.mockReturnValue(null);
});

describe('searchSourceEvidence', () => {
  it('按 heading×2 + text 评分并确定性排序', () => {
    sources.listSourcesForSubject.mockReturnValue([
      source('s-a', 'sub1', 'a.md'), source('s-b', 'sub1', 'b.md'), source('s-c', 'sub1', 'c.md'),
    ]);
    sourceStore.getSourceMetadata.mockImplementation((id: string) => {
      if (id === 's-a') return chunks(['c0', 'Alpha Alpha', 'alpha body']);
      if (id === 's-b') return chunks(['c1', '', 'alpha alpha']);
      return chunks(['c2', '', 'unrelated']);
    });

    const result = searchSourceEvidence(subject, { query: 'alpha', limit: 10 });

    expect(result.hits.map((hit) => [hit.sourceId, hit.score])).toEqual([
      ['s-a', 5], ['s-b', 2],
    ]);
  });

  it('同分时按 filename、sourceId、chunkId 升序', () => {
    sources.listSourcesForSubject.mockReturnValue([
      source('z', 'sub1', 'a.md'), source('a', 'sub1', 'a.md'), source('b', 'sub1', 'b.md'),
    ]);
    sourceStore.getSourceMetadata.mockImplementation((id: string) => (
      id === 'a'
        ? chunks(['c2', '', 'hit'], ['c1', '', 'hit'])
        : chunks(['c0', '', 'hit'])
    ));

    const result = searchSourceEvidence(subject, { query: 'hit', limit: 10 });

    expect(result.hits.map((hit) => `${hit.filename}:${hit.sourceId}:${hit.chunkId}`)).toEqual([
      'a.md:a:c1', 'a.md:a:c2', 'a.md:z:c0', 'b.md:b:c0',
    ]);
  });

  it('支持 subject 全量、页面来源、显式 IDs 与两者交集', () => {
    const a = source('a');
    const b = source('b');
    const c = source('c');
    sources.listSourcesForSubject.mockReturnValue([a, b, c]);
    sources.getSourcesForPage.mockReturnValue([a, c]);
    sources.getSource.mockImplementation((id: string) => ({ a, b, c }[id as 'a' | 'b' | 'c'] ?? null));
    sourceStore.getSourceMetadata.mockReturnValue(chunks(['chunk', '', 'needle']));

    expect(searchSourceEvidence(subject, { query: 'needle' }).hits.map((hit) => hit.sourceId))
      .toEqual(['a', 'b', 'c']);
    expect(searchSourceEvidence(subject, { query: 'needle', pageSlug: 'page' }).hits.map((hit) => hit.sourceId))
      .toEqual(['a', 'c']);
    expect(searchSourceEvidence(subject, { query: 'needle', sourceIds: ['b', 'c'] }).hits.map((hit) => hit.sourceId))
      .toEqual(['b', 'c']);
    expect(searchSourceEvidence(subject, {
      query: 'needle', pageSlug: 'page', sourceIds: ['b', 'c'],
    }).hits.map((hit) => hit.sourceId)).toEqual(['c']);
  });

  it('source 不存在或越过 Subject 时统一拒绝', () => {
    sources.getSource.mockImplementation((id: string) => (
      id === 'foreign' ? source('foreign', 'sub2') : null
    ));

    expect(() => searchSourceEvidence(subject, { query: 'alpha', sourceIds: ['missing'] }))
      .toThrow(/SOURCE_OUT_OF_SCOPE/);
    expect(() => searchSourceEvidence(subject, { query: 'alpha', sourceIds: ['foreign'] }))
      .toThrow(/SOURCE_OUT_OF_SCOPE/);
  });

  it('限制单条 excerpt 与总 excerpt 长度', () => {
    const longSources = Array.from({ length: 7 }, (_, index) => source(`s${index}`));
    sources.listSourcesForSubject.mockReturnValue(longSources);
    sourceStore.getSourceMetadata.mockReturnValue(chunks(['c0', '', `needle${'x'.repeat(4_000)}`]));

    const result = searchSourceEvidence(subject, { query: 'needle', limit: 10 });

    expect(result.hits).toHaveLength(6);
    expect(result.hits.every((hit) => hit.excerpt.length <= 2_000)).toBe(true);
    expect(result.hits.reduce((sum, hit) => sum + hit.excerpt.length, 0)).toBeLessThanOrEqual(12_000);
  });

  it('跳过损坏或无 chunks 的 sidecar，不阻断其他来源', () => {
    sources.listSourcesForSubject.mockReturnValue([source('bad'), source('empty'), source('good')]);
    sourceStore.getSourceMetadata.mockImplementation((id: string) => {
      if (id === 'bad') return { chunks: [{ id: 1, heading: '', text: 'needle' }] };
      if (id === 'empty') return { chunks: [] };
      return chunks(['c0', '', 'needle']);
    });

    expect(searchSourceEvidence(subject, { query: 'needle' }).hits.map((hit) => hit.sourceId))
      .toEqual(['good']);
  });
});

describe('readSourceEvidence', () => {
  it('按 chunk 和 offset/limit 返回可继续窗口', () => {
    sources.getSource.mockReturnValue(source('s-a', 'sub1', 'a.md'));
    sourceStore.getSourceMetadata.mockReturnValue(chunks(['c0', 'H', '0123456789']));

    expect(readSourceEvidence(subject, {
      sourceId: 's-a', chunkId: 'c0', offset: 3, limit: 4,
    })).toEqual({
      sourceId: 's-a', filename: 'a.md', chunkId: 'c0',
      content: '3456', nextOffset: 7, truncated: true,
    });
  });

  it('未指定 chunk 时按原顺序用两个换行拼接', () => {
    sources.getSource.mockReturnValue(source('s-a', 'sub1', 'a.md'));
    sourceStore.getSourceMetadata.mockReturnValue(chunks(
      ['c0', 'H0', 'first'], ['c1', 'H1', 'second'],
    ));

    expect(readSourceEvidence(subject, { sourceId: 's-a' })).toEqual({
      sourceId: 's-a', filename: 'a.md', chunkId: null,
      content: 'first\n\nsecond', nextOffset: null, truncated: false,
    });
  });

  it('offset 超过末尾返回空窗口，limit 最大为 20000', () => {
    sources.getSource.mockReturnValue(source('s-a'));
    sourceStore.getSourceMetadata.mockReturnValue(chunks(['c0', '', 'x'.repeat(25_000)]));

    expect(readSourceEvidence(subject, {
      sourceId: 's-a', chunkId: 'c0', limit: 50_000,
    }).content).toHaveLength(20_000);
    expect(readSourceEvidence(subject, {
      sourceId: 's-a', chunkId: 'c0', offset: 30_000,
    })).toEqual({
      sourceId: 's-a', filename: 's-a.md', chunkId: 'c0',
      content: '', nextOffset: null, truncated: false,
    });
  });

  it('source 不存在或越过 Subject 时统一拒绝', () => {
    sources.getSource.mockReturnValueOnce(null).mockReturnValueOnce(source('foreign', 'sub2'));

    expect(() => readSourceEvidence(subject, { sourceId: 'missing' }))
      .toThrow(/SOURCE_OUT_OF_SCOPE/);
    expect(() => readSourceEvidence(subject, { sourceId: 'foreign' }))
      .toThrow(/SOURCE_OUT_OF_SCOPE/);
  });

  it('无有效 chunks 或未知 chunk 时返回内容不可用', () => {
    sources.getSource.mockReturnValue(source('s-a'));
    sourceStore.getSourceMetadata.mockReturnValueOnce({ chunks: [] });
    expect(() => readSourceEvidence(subject, { sourceId: 's-a' }))
      .toThrow(/SOURCE_CONTENT_UNAVAILABLE/);

    sourceStore.getSourceMetadata.mockReturnValue(chunks(['c0', '', 'body']));
    expect(() => readSourceEvidence(subject, { sourceId: 's-a', chunkId: 'missing' }))
      .toThrow(/SOURCE_CONTENT_UNAVAILABLE/);
  });
});

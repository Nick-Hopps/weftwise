import { describe, it, expect } from 'vitest';
import { extractCitationsFromAnswer, pickExcerpt } from '../citation-extract';
import type { AccessedPages } from '../query-tools';

function accessedWith(bodies: Record<string, { title: string; body: string }>): AccessedPages {
  return { meta: new Map(), bodies: new Map(Object.entries(bodies)) };
}

describe('extractCitationsFromAnswer', () => {
  const body = 'SQLite 使用 WAL 模式提升并发读性能。写事务仍然串行。FTS5 提供全文索引。';

  it('解析 [[slug]] 并与 bodies 求交集，excerpt 来自页面原文', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    const out = extractCitationsFromAnswer(
      'SQLite 的 WAL 模式提升了并发读性能 [[sqlite]]。',
      accessed,
      'general',
    );
    expect(out).toHaveLength(1);
    expect(out[0].pageSlug).toBe('sqlite');
    expect(body.includes(out[0].excerpt)).toBe(true);
  });

  it('未 read 过的页（幻觉链接 / 仅 search 命中）被丢弃', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    accessed.meta.set('postgres', { title: 'Postgres', summary: '' });
    const out = extractCitationsFromAnswer(
      '参见 [[postgres]] 与 [[ghost-page]] 和 [[sqlite]]。',
      accessed,
      'general',
    );
    expect(out.map((c) => c.pageSlug)).toEqual(['sqlite']);
  });

  it('[[Title]] 形式经 accessed 标题兜底解析到 slug', () => {
    const accessed = accessedWith({ 'wal-mode': { title: 'WAL Mode', body } });
    const out = extractCitationsFromAnswer('详见 [[WAL Mode]]。', accessed, 'general');
    expect(out.map((c) => c.pageSlug)).toEqual(['wal-mode']);
  });

  it('同 slug 多次出现只留一条（取首次锚点）；跨主题前缀链接丢弃', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    const out = extractCitationsFromAnswer(
      'WAL 提升并发 [[sqlite]]，另见 [[other-subject:sqlite]]，FTS5 相关 [[sqlite]]。',
      accessed,
      'general',
    );
    expect(out).toHaveLength(1);
  });

  it('无任何 wikilink → 空数组', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    expect(extractCitationsFromAnswer('没有引用的回答。', accessed, 'general')).toEqual([]);
  });
});

describe('pickExcerpt', () => {
  const body = [
    '# 标题',
    '',
    'SQLite 使用 WAL 模式提升并发读性能。写事务仍然串行执行。',
    '',
    'FTS5 是 SQLite 的全文索引扩展。它支持 BM25 排序。',
  ].join('\n');

  it('选中与锚点词重叠最高的句子', () => {
    const ex = pickExcerpt('FTS5 提供全文索引能力', body);
    expect(ex).toContain('FTS5');
    expect(ex).not.toContain('# 标题');
  });

  it('零重叠时回落正文开头', () => {
    const ex = pickExcerpt('完全无关的锚点文本 zzz', body);
    expect(ex.length).toBeGreaterThan(0);
    expect(body.includes(ex)).toBe(true);
  });

  it('excerpt 长度受上限约束（≤400 字符）', () => {
    const long = 'A'.repeat(1000) + '。' + 'B'.repeat(1000) + '。';
    expect(pickExcerpt('AAAA', long).length).toBeLessThanOrEqual(400);
  });
});

import { describe, it, expect } from 'vitest';
import { extractCitationsFromAnswer, pickExcerpt } from '../citation-extract';
import type { AccessedPages } from '../query-tools';

function accessedWith(bodies: Record<string, { title: string; body: string }>): AccessedPages {
  return {
    meta: new Map(),
    bodies: new Map(Object.entries(bodies)),
    crossMeta: new Map(),
    crossBodies: new Map(),
    sourceRefs: new Map(),
  };
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

  it('同 slug 多次出现只留一条（取首次锚点）；未读的跨主题链接丢弃', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    const out = extractCitationsFromAnswer(
      'WAL 提升并发 [[sqlite]]，另见 [[other-subject:sqlite]]，FTS5 相关 [[sqlite]]。',
      accessed,
      'general',
    );
    expect(out).toHaveLength(1);
  });

  it('只接受真实跨主题 read 的复合身份，并返回 subjectSlug', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    accessed.crossBodies.set('notes\0sqlite', {
      subjectSlug: 'notes',
      slug: 'sqlite',
      title: 'Notes SQLite',
      body: 'Notes 中的 SQLite 页面只讨论备份策略。',
    });
    accessed.crossBodies.set('archive\0sqlite', {
      subjectSlug: 'archive',
      slug: 'sqlite',
      title: 'Archive SQLite',
      body: 'Archive 中的 SQLite 页面只讨论旧版本。',
    });

    const out = extractCitationsFromAnswer(
      '本主题并发说明 [[sqlite]]；备份说明 [[notes:sqlite]]；旧版本 [[archive:sqlite]]；伪造 [[ghost:sqlite]]。',
      accessed,
      'general',
    );
    expect(out.map((citation) => [citation.subjectSlug, citation.pageSlug])).toEqual([
      [undefined, 'sqlite'],
      ['notes', 'sqlite'],
      ['archive', 'sqlite'],
    ]);
  });

  it('跨主题标题形式只在对应 Subject 的已读页面内解析', () => {
    const accessed = accessedWith({});
    accessed.crossBodies.set('notes\0wal-mode', {
      subjectSlug: 'notes',
      slug: 'wal-mode',
      title: 'WAL Mode',
      body,
    });
    const out = extractCitationsFromAnswer(
      '详见 [[notes:WAL Mode]] 与伪造的 [[archive:WAL Mode]]。',
      accessed,
      'general',
    );
    expect(out).toEqual([expect.objectContaining({
      subjectSlug: 'notes',
      pageSlug: 'wal-mode',
    })]);
  });

  it('多个 Subject 存在同名标题时按显式 Subject 解析各自 canonical slug', () => {
    const accessed = accessedWith({
      'general-shared': { title: 'Shared Title', body: 'General 正文。' },
    });
    accessed.crossBodies.set('notes\0notes-shared', {
      subjectSlug: 'notes',
      slug: 'notes-shared',
      title: 'Shared Title',
      body: 'Notes 正文。',
    });
    accessed.crossBodies.set('archive\0archive-shared', {
      subjectSlug: 'archive',
      slug: 'archive-shared',
      title: 'Shared Title',
      body: 'Archive 正文。',
    });

    const out = extractCitationsFromAnswer(
      '本主题 [[Shared Title]]；笔记 [[notes:Shared Title]]；归档 [[archive:Shared Title]]。',
      accessed,
      'general',
    );
    expect(out.map((citation) => [citation.subjectSlug, citation.pageSlug])).toEqual([
      [undefined, 'general-shared'],
      ['notes', 'notes-shared'],
      ['archive', 'archive-shared'],
    ]);
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

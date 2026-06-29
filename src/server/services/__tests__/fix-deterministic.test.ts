import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../wiki/frontmatter';
import {
  fixMissingFrontmatter,
  partitionFindings,
  buildFixWorklist,
  bodyShrankTooMuch,
  findRelatedPageSlugs,
  buildSubjectReportLines,
} from '../fix-deterministic';
import type { LintFinding, WikiDocument } from '@/lib/contracts';

function doc(over: Partial<WikiDocument['frontmatter']> = {}, body = 'Body text'): WikiDocument {
  return {
    frontmatter: { title: '', created: '', updated: '', tags: [], sources: [], ...over },
    body,
    links: [],
  };
}

const f = (type: LintFinding['type'], pageSlug: string, description = 'd'): LintFinding => ({
  type,
  severity: 'warning',
  pageSlug,
  description,
  suggestedFix: null,
});

describe('fixMissingFrontmatter', () => {
  const NOW = '2026-06-24T00:00:00.000Z';

  it('空 title 用 slug 兜底', () => {
    const out = fixMissingFrontmatter('my-page', doc(), NOW);
    const { data } = parseFrontmatter(out);
    expect(data.title).toBe('my-page');
  });

  it('缺失时间戳被 stamp 为 now', () => {
    const out = fixMissingFrontmatter('p', doc(), NOW);
    const { data } = parseFrontmatter(out);
    expect(data.created).toBe(NOW);
    expect(data.updated).toBe(NOW);
  });

  it('已有 created 被保留', () => {
    const out = fixMissingFrontmatter('p', doc({ created: '2025-01-01T00:00:00.000Z' }), NOW);
    const { data } = parseFrontmatter(out);
    expect(data.created).toBe('2025-01-01T00:00:00.000Z');
  });

  it('tags/sources 保证为数组', () => {
    const out = fixMissingFrontmatter('p', doc(), NOW);
    const { data } = parseFrontmatter(out);
    expect(Array.isArray(data.tags)).toBe(true);
    expect(Array.isArray(data.sources)).toBe(true);
  });

  it('正文逐字保留', () => {
    const out = fixMissingFrontmatter('p', doc({}, 'Hello\n\nWorld'), NOW);
    const { body } = parseFrontmatter(out);
    expect(body.trim()).toBe('Hello\n\nWorld');
  });

  it('已有 title 不被覆盖', () => {
    const out = fixMissingFrontmatter('p', doc({ title: 'Real Title' }), NOW);
    const { data } = parseFrontmatter(out);
    expect(data.title).toBe('Real Title');
  });
});

describe('partitionFindings', () => {
  it('按修复机制分三桶', () => {
    const findings = [
      f('missing-frontmatter', 'a'),
      f('broken-link', 'b'),
      f('missing-crossref', 'c'),
      f('contradiction', 'd'),
      f('orphan', 'e'),
      f('stale-source', 'g'),
      f('coverage-gap', 'h'),
    ];
    const { frontmatter, llm, ignored } = partitionFindings(findings);
    expect(frontmatter.map((x) => x.pageSlug)).toEqual(['a']);
    expect(llm.map((x) => x.type).sort()).toEqual(['broken-link', 'contradiction', 'missing-crossref']);
    expect(ignored.map((x) => x.type).sort()).toEqual(['coverage-gap', 'orphan', 'stale-source']);
  });
});

describe('buildFixWorklist', () => {
  it('合并确定性与语义并按 type+slug+description 去重', () => {
    const det = [f('broken-link', 'a', 'L1'), f('broken-link', 'a', 'L1')];
    const sem = [f('missing-crossref', 'a', 'X')];
    const out = buildFixWorklist(det, sem);
    expect(out).toHaveLength(2);
  });

  it('同页不同 description 的 broken-link 各自保留', () => {
    const det = [f('broken-link', 'a', 'L1'), f('broken-link', 'a', 'L2')];
    const out = buildFixWorklist(det, []);
    expect(out).toHaveLength(2);
  });
});

describe('bodyShrankTooMuch', () => {
  it('修复后正文不足原文 50% → 返回 true', () => {
    const original = 'a'.repeat(100);
    const shrunken = 'a'.repeat(10);
    expect(bodyShrankTooMuch(original, shrunken)).toBe(true);
  });

  it('小幅外科式收缩（96/100）→ 返回 false', () => {
    const original = 'a'.repeat(100);
    const trimmed = 'a'.repeat(96);
    expect(bodyShrankTooMuch(original, trimmed)).toBe(false);
  });

  it('原文为空 → 始终返回 false', () => {
    expect(bodyShrankTooMuch('', 'anything')).toBe(false);
    expect(bodyShrankTooMuch('   ', '')).toBe(false);
  });
});

describe('findRelatedPageSlugs', () => {
  const roster = [
    { slug: 'react', title: 'React' },
    { slug: 'vue', title: 'Vue' },
    { slug: 'category', title: 'Category Theory' },
  ];

  it('contradiction 描述含对方 slug → 召回对方、排除自身', () => {
    const findings = [f('contradiction', 'react', 'react conflicts with vue on lifecycle')];
    expect(findRelatedPageSlugs('react', findings, roster)).toEqual(['vue']);
  });

  it('描述含 roster title（大小写不敏感整词）→ 召回', () => {
    const findings = [f('missing-crossref', 'react', 'mentions VUE but no link')];
    expect(findRelatedPageSlugs('react', findings, roster)).toContain('vue');
  });

  it('词边界：cat 不命中 category 子串', () => {
    const roster2 = [{ slug: 'cat', title: 'Cat' }];
    const findings = [f('broken-link', 'p', 'see the category page')];
    expect(findRelatedPageSlugs('p', findings, roster2)).toEqual([]);
  });

  it('contradiction 兜底：描述无匹配但有其他 contradiction 页 → 召回（排除自身）', () => {
    const findings = [f('contradiction', 'react', 'states something is true')];
    const out = findRelatedPageSlugs('react', findings, roster, new Set(['vue', 'react']));
    expect(out).toEqual(['vue']);
  });

  it('非 contradiction 不触发兜底', () => {
    const findings = [f('broken-link', 'react', 'no roster names here')];
    expect(findRelatedPageSlugs('react', findings, roster, new Set(['vue']))).toEqual([]);
  });

  it('上限 cap=4 且去重', () => {
    const big = Array.from({ length: 8 }, (_, i) => ({ slug: `p${i}`, title: `P${i}` }));
    const desc = big.map((r) => r.slug).join(' ');
    const findings = [f('contradiction', 'src', desc), f('broken-link', 'src', desc)];
    const out = findRelatedPageSlugs('src', findings, big);
    expect(out).toHaveLength(4);
    expect(new Set(out).size).toBe(4);
  });
});

describe('buildSubjectReportLines', () => {
  it('按 pageSlug 分组、按首次出现保序、行格式 type: desc', () => {
    const wl = [
      f('broken-link', 'a', 'L1'),
      f('contradiction', 'b', 'C1'),
      f('missing-crossref', 'a', 'X1'),
    ];
    const out = buildSubjectReportLines(wl);
    expect(out.map((p) => p.slug)).toEqual(['a', 'b']);
    expect(out[0].lines).toEqual(['broken-link: L1', 'missing-crossref: X1']);
    expect(out[1].lines).toEqual(['contradiction: C1']);
  });

  it('超长描述被截断并加省略号', () => {
    const long = 'x'.repeat(300);
    const out = buildSubjectReportLines([f('broken-link', 'a', long)]);
    expect(out[0].lines[0].endsWith('…')).toBe(true);
    expect(out[0].lines[0].length).toBeLessThan(220);
  });
});

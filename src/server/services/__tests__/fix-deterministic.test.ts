import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../wiki/frontmatter';
import {
  fixMissingFrontmatter,
  partitionFindings,
  buildFixWorklist,
  buildSubjectReportLines,
  createFixGuard,
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

// bodyShrankTooMuch 已退役收编到 wiki/rewrite-fidelity.ts::checkRewriteFidelity（profile 'fix'），
// 其行为矩阵覆盖在 src/server/wiki/__tests__/rewrite-fidelity.test.ts。

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

describe('createFixGuard', () => {
  it('canWrite 达到 cap 后拒绝', () => {
    const g = createFixGuard({ caps: { writes: 2 } });
    expect(g.canWrite().ok).toBe(true);
    g.record('update'); g.record('create');
    const d = g.canWrite();
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/limit of 2 edits/);
  });
  it('canEditPage 拒绝保护页 index/log，放行普通页', () => {
    const g = createFixGuard({ caps: { writes: 5 } });
    expect(g.canEditPage('index').ok).toBe(false);
    expect(g.canEditPage('log').ok).toBe(false);
    expect(g.canEditPage('eigen').ok).toBe(true);
  });
  it('totals 累加准确', () => {
    const g = createFixGuard({ caps: { writes: 5 } });
    g.record('update'); g.record('update'); g.record('create');
    expect(g.totals()).toEqual({ update: 2, create: 1, writes: 3 });
  });
});

describe('partitionFindings — orphan-source', () => {
  it('orphan-source 归入 ignored 桶（不进 Fix issues）', async () => {
    const { partitionFindings } = await import('../fix-deterministic');
    const finding = {
      type: 'orphan-source' as const,
      severity: 'warning' as const,
      pageSlug: '',
      description: 'Source "a.md" was ingested but its ingest job failed.',
      suggestedFix: null,
      sourceId: 'src-1',
      sourceFilename: 'a.md',
      failedJobId: 'job-1',
    };
    const { frontmatter, llm, ignored } = partitionFindings([finding]);
    expect(frontmatter).toHaveLength(0);
    expect(llm).toHaveLength(0);
    expect(ignored).toEqual([finding]);
  });
});

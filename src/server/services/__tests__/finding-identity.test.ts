import { describe, expect, it } from 'vitest';
import type { LintFinding, SubjectId } from '@/lib/contracts';
import { findingId, identifyFindings } from '../finding-identity';

type IdentityInput = LintFinding & {
  subjectId: SubjectId;
  subjectSlug: string;
  id?: string;
};

const base: IdentityInput = {
  type: 'broken-link',
  severity: 'warning',
  pageSlug: 'start',
  description: 'Broken   [[Ghost]]\r\nlink',
  suggestedFix: '创建缺失页面',
  subjectId: 'subject-1',
  subjectSlug: 'general',
};

describe('findingId', () => {
  it('遵循固定 canonical 协议生成 golden digest', () => {
    const goldenInput: IdentityInput = {
      type: 'stale-source',
      severity: 'critical',
      pageSlug: 'unicode-page',
      description: ' Ａ  value\r\nnext ',
      suggestedFix: '更新来源',
      sourceId: 'source-golden',
      sourceFilename: 'ignored.md',
      failedJobId: 'failed-job-golden',
      subjectId: 'subject-golden',
      subjectSlug: 'golden',
      id: 'f'.repeat(64),
    };

    // finding ID 是持久化兼容协议；算法变化必须提升 lint-finding:vN。
    expect(findingId(goldenInput)).toBe(
      'c0090e0a6bfed1184eadf5144ed192565cd68778ed9ed8a6a95810d213f1390f',
    );
  });

  it('返回 64 位小写十六进制，并规范化空白与换行', () => {
    const id = findingId(base);
    const normalizedId = findingId({
      ...base,
      description: 'Broken [[Ghost]] link',
    });
    const unicodeNormalizedId = findingId({
      ...base,
      description: 'Ｂｒｏｋｅｎ [[Ghost]] link',
    });

    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(normalizedId);
    expect(id).toBe(unicodeNormalizedId);
  });

  it.each([
    ['subjectId', {}, { subjectId: 'subject-2' }],
    ['type', {}, { type: 'orphan' }],
    ['pageSlug', {}, { pageSlug: 'another-page' }],
    ['sourceId', {}, { sourceId: 'source-1' }],
    [
      'sourceFilename fallback',
      { sourceFilename: 'source-a.md' },
      { sourceFilename: 'source-b.md' },
    ],
    ['description', {}, { description: 'Different description' }],
  ] as const)(
    '%s 变化时返回不同 ID',
    (_field, original, changed) => {
      expect(findingId({ ...base, ...changed })).not.toBe(
        findingId({ ...base, ...original }),
      );
    },
  );

  it.each([
    ['severity', { severity: 'critical' }],
    ['suggestedFix', { suggestedFix: null }],
    ['failedJobId', { failedJobId: 'failed-job-1' }],
    ['subjectSlug', { subjectSlug: 'another-subject' }],
    ['id', { id: 'f'.repeat(64) }],
  ] as const)('%s 变化时不改变 ID', (_field, change) => {
    expect(findingId({ ...base, ...change })).toBe(findingId(base));
  });
});

describe('identifyFindings', () => {
  it('按重新计算的 ID 去重，并保留首次出现顺序', () => {
    const first: IdentityInput = {
      ...base,
      id: 'f'.repeat(64),
    };
    const duplicate: IdentityInput = {
      ...base,
      id: 'e'.repeat(64),
      severity: 'info',
      suggestedFix: null,
      description: ' Broken [[Ghost]]   link ',
    };
    const different: IdentityInput = {
      ...base,
      pageSlug: 'different',
      description: 'Different finding',
    };

    const identified = identifyFindings([first, duplicate, different]);

    expect(identified).toHaveLength(2);
    expect(identified.map((finding) => finding.pageSlug)).toEqual([
      'start',
      'different',
    ]);
    expect(identified[0]?.id).not.toBe(first.id);
    expect(identified[0]).toEqual({ ...first, id: findingId(first) });
    expect(identified[1]?.id).toBe(findingId(different));
  });
});

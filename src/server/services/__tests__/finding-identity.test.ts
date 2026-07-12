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

  it('忽略 severity、suggestedFix 与 failedJobId', () => {
    const changedMetadata: IdentityInput = {
      ...base,
      severity: 'critical',
      suggestedFix: null,
      failedJobId: 'failed-job-1',
    };

    expect(findingId(changedMetadata)).toBe(findingId(base));
  });

  it.each([
    ['subjectId', { subjectId: 'subject-2' }],
    ['pageSlug', { pageSlug: 'another-page' }],
    ['sourceId', { sourceId: 'source-1' }],
    ['description', { description: 'Different description' }],
  ] as const)('%s 变化时返回不同 ID', (_field, change) => {
    expect(findingId({ ...base, ...change })).not.toBe(findingId(base));
  });
});

describe('identifyFindings', () => {
  it('按重新计算的 ID 去重，并保留首次出现顺序', () => {
    const duplicate: IdentityInput = {
      ...base,
      id: 'f'.repeat(64),
      severity: 'info',
      suggestedFix: null,
      description: ' Broken [[Ghost]]   link ',
    };
    const different: IdentityInput = {
      ...base,
      pageSlug: 'different',
      description: 'Different finding',
    };

    const identified = identifyFindings([base, duplicate, different]);

    expect(identified).toHaveLength(2);
    expect(identified.map((finding) => finding.pageSlug)).toEqual([
      'start',
      'different',
    ]);
    expect(identified[0]).toMatchObject({
      severity: base.severity,
      suggestedFix: base.suggestedFix,
      id: findingId(base),
    });
    expect(identified[1]?.id).toBe(findingId(different));
  });
});

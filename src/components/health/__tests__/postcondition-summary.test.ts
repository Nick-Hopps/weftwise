import { describe, expect, it } from 'vitest';
import type { PostconditionReport } from '@/lib/contracts';
import {
  buildPostconditionNotice,
  extractPostconditionReport,
} from '../postcondition-summary';
import { createI18n } from '@/lib/i18n/translator';

const { t } = createI18n('zh-CN');

const cleanReport: PostconditionReport = {
  status: 'clean',
  checkedAt: '2026-07-12T08:00:00.000Z',
  scope: {
    jobId: 'job-1',
    subjectId: 's1',
    createdSlugs: [],
    updatedSlugs: ['a'],
    deletedSlugs: [],
    touchedSlugs: ['a'],
    operationIds: ['op-1'],
  },
  residualFindings: [],
  semanticStatus: 'clean',
  verificationError: null,
};

const residualReport: PostconditionReport = {
  ...cleanReport,
  status: 'residual',
  semanticStatus: 'residual',
  residualFindings: [
    {
      type: 'broken-link',
      severity: 'warning',
      pageSlug: 'a',
      description: 'a 仍链接到不存在的页面',
    },
    {
      type: 'orphan-page',
      severity: 'info',
      pageSlug: 'b',
      description: 'b 没有任何入链',
    },
  ],
};

describe('extractPostconditionReport', () => {
  it('从 verify:complete 的嵌套 data 中解析报告', () => {
    expect(
      extractPostconditionReport({
        type: 'fix:verify:complete',
        data: { message: 'done', data: { postcondition: cleanReport } },
      }),
    ).toEqual(cleanReport);
  });

  it('非法或不完整数据返回 null', () => {
    expect(extractPostconditionReport(undefined)).toBeNull();
    expect(
      extractPostconditionReport({
        type: 'fix:verify:complete',
        data: { data: { postcondition: { status: 'clean' } } },
      }),
    ).toBeNull();
  });
});

describe('buildPostconditionNotice', () => {
  it('clean 映射为成功提示', () => {
    expect(buildPostconditionNotice(cleanReport, t)).toEqual({
      tone: 'success',
      title: '后置校验通过',
      details: ['未发现残留问题。'],
    });
  });

  it('residual 映射为警告并最多展示三个有界摘要', () => {
    const longText = '很长的残留说明'.repeat(40);
    const report: PostconditionReport = {
      ...residualReport,
      residualFindings: [
        ...residualReport.residualFindings,
        { ...residualReport.residualFindings[0], pageSlug: 'c', description: longText },
        { ...residualReport.residualFindings[0], pageSlug: 'd', description: '第四条' },
      ],
    };
    const original = structuredClone(report);

    const notice = buildPostconditionNotice(report, t);

    expect(notice.tone).toBe('warning');
    expect(notice.title).toBe('发现 4 个残留问题');
    expect(notice.details).toHaveLength(3);
    expect(notice.details[2].length).toBeLessThanOrEqual(180);
    expect(report).toEqual(original);
  });

  it('semantic failed 优先显示语义复检未完成', () => {
    const notice = buildPostconditionNotice({
      ...residualReport,
      semanticStatus: 'failed',
      verificationError: 'Fix 语义后置复检未完成。',
    }, t);

    expect(notice.tone).toBe('warning');
    expect(notice.title).toBe('语义复检未完成');
    expect(notice.details.join(' ')).toContain('结构校验已完成');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LintFinding,
  PostconditionScope,
  Subject,
} from '@/lib/contracts';

const generateMock = vi.hoisted(() => vi.fn());
vi.mock('@/server/llm/provider-registry', () => ({
  generateStructuredOutput: generateMock,
}));

const wikiMock = vi.hoisted(() => ({
  scanWikiPages: vi.fn(() => [
    {
      subjectSlug: 'general',
      slug: 'a',
      relativePath: 'wiki/general/a.md',
      path: '/vault/wiki/general/a.md',
      content: '# A\nCurrent A content.',
    },
    {
      subjectSlug: 'general',
      slug: 'b',
      relativePath: 'wiki/general/b.md',
      path: '/vault/wiki/general/b.md',
      content: '# B\nCurrent B content.',
    },
  ]),
}));
vi.mock('@/server/wiki/wiki-store', () => wikiMock);

vi.mock('@/server/db/repos/pages-repo', () => ({
  getAllPages: vi.fn(() => [
    { subjectId: 's1', slug: 'a', title: 'A' },
    { subjectId: 's1', slug: 'b', title: 'B' },
  ]),
}));
vi.mock('@/server/db/repos/settings-repo', () => ({
  getWikiLanguage: vi.fn(() => 'Chinese'),
}));

import {
  MAX_SEMANTIC_PROMPT_CHARS,
  MAX_SEMANTIC_RECHECK_FINDINGS,
  recheckFixSemanticPostconditions,
  semanticFindingId,
} from '../fix-semantic-postcondition';

const subject: Subject = {
  id: 's1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
};

const scope: PostconditionScope = {
  jobId: 'job-1',
  subjectId: 's1',
  createdSlugs: [],
  updatedSlugs: ['a'],
  deletedSlugs: [],
  touchedSlugs: ['a'],
  operationIds: ['op-1'],
};

function finding(
  type: LintFinding['type'],
  pageSlug: string,
  description: string,
): LintFinding {
  return {
    type,
    severity: 'warning',
    pageSlug,
    description,
    suggestedFix: null,
  };
}

const contradiction = finding('contradiction', 'a', 'A 与 b 中的说法冲突');
const missingLink = finding('missing-crossref', 'a', 'a 提到 b 但没有 wikilink');

describe('recheckFixSemanticPostconditions', () => {
  beforeEach(() => {
    generateMock.mockReset();
    wikiMock.scanWikiPages.mockClear();
  });

  it('只调用一次 lint 结构化复检并映射 resolved / residual', async () => {
    generateMock.mockResolvedValue({
      decisions: [
        {
          findingId: semanticFindingId(contradiction),
          status: 'resolved',
          reason: '两页现已一致',
        },
        {
          findingId: semanticFindingId(missingLink),
          status: 'residual',
          reason: '仍是纯文本提及',
        },
      ],
    });

    const result = await recheckFixSemanticPostconditions({
      subject,
      scope,
      findings: [contradiction, missingLink],
      shouldCancel: () => false,
    });

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0]).toBe('lint');
    expect(generateMock.mock.calls[0]).toHaveLength(6);
    expect(generateMock.mock.calls[0][5]).toEqual({ usageSubjectId: subject.id });
    expect(result).toEqual({
      status: 'residual',
      residualFindings: [
        expect.objectContaining({
          type: 'missing-crossref',
          pageSlug: 'a',
          description: expect.stringContaining('仍是纯文本提及'),
        }),
      ],
      error: null,
    });
  });

  it.each([
    ['空 finding', [], scope],
    ['纯确定性 finding', [finding('broken-link', 'a', 'broken')], scope],
    ['空 operation scope', [contradiction], { ...scope, operationIds: [] }],
  ])('%s 不调用模型并返回 clean', async (_name, findings, currentScope) => {
    const result = await recheckFixSemanticPostconditions({
      subject,
      scope: currentScope,
      findings,
      shouldCancel: () => false,
    });

    expect(generateMock).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'clean', residualFindings: [], error: null });
  });

  it('缺失、重复与未知 decision 都保守保留原 finding', async () => {
    generateMock.mockResolvedValue({
      decisions: [
        {
          findingId: semanticFindingId(contradiction),
          status: 'resolved',
          reason: 'resolved once',
        },
        {
          findingId: semanticFindingId(contradiction),
          status: 'resolved',
          reason: 'duplicate',
        },
        {
          findingId: 'f'.repeat(64),
          status: 'resolved',
          reason: 'unknown',
        },
      ],
    });

    const result = await recheckFixSemanticPostconditions({
      subject,
      scope,
      findings: [contradiction, missingLink],
      shouldCancel: () => false,
    });

    expect(result.status).toBe('residual');
    expect(result.residualFindings.map((item) => item.type).sort()).toEqual([
      'contradiction',
      'missing-crossref',
    ]);
  });

  it('超过单次 finding 上限的条目不进入模型且保守 residual', async () => {
    const findings = Array.from(
      { length: MAX_SEMANTIC_RECHECK_FINDINGS + 1 },
      (_, index) => finding('missing-crossref', 'a', `missing ${index}`),
    );
    generateMock.mockResolvedValue({
      decisions: findings.slice(0, MAX_SEMANTIC_RECHECK_FINDINGS).map((item) => ({
        findingId: semanticFindingId(item),
        status: 'resolved',
        reason: 'resolved',
      })),
    });

    const result = await recheckFixSemanticPostconditions({
      subject,
      scope,
      findings,
      shouldCancel: () => false,
    });

    expect(result.status).toBe('residual');
    expect(result.residualFindings).toEqual([
      expect.objectContaining({ description: expect.stringContaining('missing 40') }),
    ]);
  });

  it('异常长 Subject 描述也不能突破最终 prompt 字符硬上限', async () => {
    generateMock.mockResolvedValue({
      decisions: [
        {
          findingId: semanticFindingId(contradiction),
          status: 'resolved',
          reason: 'resolved',
        },
      ],
    });

    await recheckFixSemanticPostconditions({
      subject: { ...subject, description: 'x'.repeat(200_000) },
      scope,
      findings: [contradiction],
      shouldCancel: () => false,
    });

    expect(String(generateMock.mock.calls[0][3]).length).toBeLessThanOrEqual(
      MAX_SEMANTIC_PROMPT_CHARS,
    );
  });

  it('模型异常时返回 failed，并用安全文案保留全部原 finding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    generateMock.mockRejectedValue(new Error('/private/vault secret failure'));

    const result = await recheckFixSemanticPostconditions({
      subject,
      scope,
      findings: [contradiction, missingLink],
      shouldCancel: () => false,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Fix 语义后置复检未完成。');
    expect(result.error).not.toContain('/private/vault');
    expect(result.residualFindings).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('调用前或调用后取消都返回 failed，不把 finding 判为已解决', async () => {
    const before = await recheckFixSemanticPostconditions({
      subject,
      scope,
      findings: [contradiction],
      shouldCancel: () => true,
    });
    expect(generateMock).not.toHaveBeenCalled();
    expect(before.status).toBe('failed');

    generateMock.mockResolvedValue({
      decisions: [
        {
          findingId: semanticFindingId(contradiction),
          status: 'resolved',
          reason: 'resolved',
        },
      ],
    });
    let checks = 0;
    const after = await recheckFixSemanticPostconditions({
      subject,
      scope,
      findings: [contradiction],
      shouldCancel: () => ++checks > 1,
    });

    expect(generateMock).toHaveBeenCalledOnce();
    expect(after.status).toBe('failed');
    expect(after.residualFindings).toHaveLength(1);
  });
});

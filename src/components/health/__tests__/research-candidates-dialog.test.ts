import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResearchRunView } from '@/lib/contracts';
import {
  defaultResearchCandidateIds,
  ResearchCandidatesDialog,
  researchRunRetryable,
} from '../research-candidates-dialog';

vi.mock('@/components/ui/tag', async () => {
  const ReactModule = await import('react');
  return {
    Tag: ({ children }: React.PropsWithChildren) => ReactModule.createElement('span', null, children),
  };
});

vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, disabled }: React.PropsWithChildren<{ disabled?: boolean }>) =>
      ReactModule.createElement('button', { disabled }, children),
  };
});

function run(status: ResearchRunView['status'] = 'awaiting-approval'): ResearchRunView {
  return {
    id: 'run-1',
    subjectId: 'subject-1',
    researchJobId: 'research-1',
    origin: 'topic',
    lintJobId: null,
    topic: 'topic',
    topics: ['topic'],
    queries: ['query'],
    candidateSetHash: 'hash',
    status,
    version: 1,
    verificationLintJobId: status === 'verifying' ? 'lint-verify' : null,
    findings: [],
    candidates: [
      {
        id: 'candidate-a',
        url: 'https://example.com/a',
        normalizedUrl: 'https://example.com/a',
        title: 'A',
        snippet: 'A snippet',
        score: 3,
        reason: null,
        rank: 0,
        decision: status === 'awaiting-approval' ? 'pending' : 'approved',
        delivery: status === 'awaiting-approval' ? null : {
          status: status === 'completed' ? 'completed' : 'running',
          sourceId: 'source-a',
          ingestJobId: 'ingest-a',
          operationIds: [],
          touchedPages: [],
          commitSha: status === 'completed' ? 'commit-a' : null,
          attemptCount: 1,
          completedAt: status === 'completed' ? '2026-07-14T00:00:00.000Z' : null,
          error: null,
        },
      },
      {
        id: 'candidate-b',
        url: 'https://example.com/b',
        normalizedUrl: 'https://example.com/b',
        title: 'B',
        snippet: 'B snippet',
        score: 2,
        reason: null,
        rank: 1,
        decision: status === 'awaiting-approval' ? 'pending' : 'rejected',
        delivery: null,
      },
    ],
    approval: status === 'awaiting-approval' ? null : {
      id: 'approval-1',
      selectedCandidateIds: ['candidate-a'],
      coordinatorJobId: 'coordinator-1',
      createdAt: '2026-07-14T00:00:00.000Z',
    },
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    completedAt: status === 'completed' ? '2026-07-14T01:00:00.000Z' : null,
    error: null,
  };
}

describe('ResearchCandidatesDialog', () => {
  it('用 candidate ID 作为默认选择，且只默认勾选 score=3', () => {
    expect([...defaultResearchCandidateIds(run())]).toEqual(['candidate-a']);
    const html = renderToStaticMarkup(React.createElement(ResearchCandidatesDialog, {
      run: run(),
      onClose: vi.fn(),
      onApprove: vi.fn(),
      onDismiss: vi.fn(),
      onRetry: vi.fn(),
      acting: false,
    }));

    expect(html).toContain('data-candidate-id="candidate-a"');
    expect(html).toContain('data-candidate-id="candidate-b"');
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain('Approve 1');
    expect(html).toContain('Dismiss');
  });

  it.each([
    ['importing', 'Importing approved candidates'],
    ['verifying', 'Verifying imported knowledge'],
    ['completed', 'Research completed'],
    ['partial', 'Research partially completed'],
    ['failed', 'Research failed'],
    ['dismissed', 'Research dismissed'],
    ['empty', 'No candidates found'],
  ] as const)('%s 展示持久化 run 状态且不再显示批准按钮', (status, text) => {
    const html = renderToStaticMarkup(React.createElement(ResearchCandidatesDialog, {
      run: run(status),
      onClose: vi.fn(),
      onApprove: vi.fn(),
      onDismiss: vi.fn(),
      onRetry: vi.fn(),
      acting: false,
    }));

    expect(html).toContain(text);
    expect(html).not.toContain('Approve 1');
  });

  it('delivery 状态与 child job 可见，普通关闭和显式 dismiss 使用独立命令', () => {
    const html = renderToStaticMarkup(React.createElement(ResearchCandidatesDialog, {
      run: run('importing'),
      onClose: vi.fn(),
      onApprove: vi.fn(),
      onDismiss: vi.fn(),
      onRetry: vi.fn(),
      acting: false,
    }));

    expect(html).toContain('running');
    expect(html).toContain('ingest-a');
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain('Dismiss');
  });

  function failedRun(): ResearchRunView {
    const base = run('failed');
    return {
      ...base,
      candidates: base.candidates.map((candidate) => candidate.delivery
        ? {
          ...candidate,
          delivery: {
            ...candidate.delivery,
            status: 'failed' as const,
            completedAt: '2026-07-14T00:10:00.000Z',
            error: { code: 'RESEARCH_CANDIDATE_IMPORT_FAILED', message: 'fetch failed' },
          },
        }
        : candidate),
    };
  }

  it('failed run 且存在 failed delivery 时提供 Retry 按钮', () => {
    expect(researchRunRetryable(failedRun())).toBe(true);
    const html = renderToStaticMarkup(React.createElement(ResearchCandidatesDialog, {
      run: failedRun(),
      onClose: vi.fn(),
      onApprove: vi.fn(),
      onDismiss: vi.fn(),
      onRetry: vi.fn(),
      acting: false,
    }));

    expect(html).toContain('Retry failed imports');
    expect(html).not.toContain('Approve 1');
  });

  it('非 failed run、verification 后失败或无 failed delivery 均不可重试', () => {
    expect(researchRunRetryable(run('failed'))).toBe(false);
    expect(researchRunRetryable(run('partial'))).toBe(false);
    expect(researchRunRetryable(run('importing'))).toBe(false);
    expect(researchRunRetryable({
      ...failedRun(),
      verificationLintJobId: 'lint-verify',
    })).toBe(false);
    expect(researchRunRetryable({
      ...failedRun(),
      origin: 'findings',
      findings: [{
        findingId: 'finding-1',
        finding: {
          id: 'finding-1',
          subjectId: 'subject-1',
          subjectSlug: 'general',
          type: 'coverage-gap',
          severity: 'warning',
          pageSlug: 'source',
          description: 'Missing topic',
          suggestedFix: null,
        },
        verificationStatus: 'unverifiable',
        verifiedAt: '2026-07-14T01:00:00.000Z',
        verificationFinding: null,
      }],
    })).toBe(false);
    const html = renderToStaticMarkup(React.createElement(ResearchCandidatesDialog, {
      run: run('failed'),
      onClose: vi.fn(),
      onApprove: vi.fn(),
      onDismiss: vi.fn(),
      onRetry: vi.fn(),
      acting: false,
    }));
    expect(html).not.toContain('Retry failed imports');
  });
});

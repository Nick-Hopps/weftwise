import { describe, expect, it } from 'vitest';
import type { Job, RemediationContext } from '@/lib/contracts';
import {
  contextKey,
  findDuplicateRemediationJob,
  normalizeRemediationContext,
  readRemediationContext,
} from '../remediation-context';

const BASE_CONTEXT: RemediationContext = {
  lintJobId: 'lint-1',
  findingIds: ['finding-b', 'finding-a'],
  action: 'fix',
};

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'fix',
    status: 'pending',
    subjectId: 'subject-1',
    paramsJson: JSON.stringify({ remediationContext: BASE_CONTEXT }),
    resultJson: null,
    createdAt: '2026-07-13T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    ...overrides,
  };
}

describe('normalizeRemediationContext', () => {
  it('对 findingIds 去重并按字典序排序，同时保留其他字段', () => {
    const context: RemediationContext = {
      lintJobId: 'lint-1',
      findingIds: ['finding-b', 'finding-a', 'finding-b'],
      action: 'curate',
    };

    expect(normalizeRemediationContext(context)).toEqual({
      lintJobId: 'lint-1',
      findingIds: ['finding-a', 'finding-b'],
      action: 'curate',
    });
    expect(context.findingIds).toEqual(['finding-b', 'finding-a', 'finding-b']);
  });
});

describe('contextKey', () => {
  it('finding 顺序和重复项不影响幂等键', () => {
    const reordered: RemediationContext = {
      ...BASE_CONTEXT,
      findingIds: ['finding-a', 'finding-b', 'finding-a'],
    };

    expect(contextKey('subject-1', BASE_CONTEXT)).toBe(
      contextKey('subject-1', reordered)
    );
  });

  it('subject、lint job、action 或 findingIds 任一变化都会改变幂等键', () => {
    const baseKey = contextKey('subject-1', BASE_CONTEXT);
    const variants: Array<[string, RemediationContext]> = [
      ['subject-2', BASE_CONTEXT],
      ['subject-1', { ...BASE_CONTEXT, lintJobId: 'lint-2' }],
      ['subject-1', { ...BASE_CONTEXT, action: 'curate' }],
      ['subject-1', { ...BASE_CONTEXT, findingIds: ['finding-a'] }],
    ];

    for (const [subjectId, context] of variants) {
      expect(contextKey(subjectId, context)).not.toBe(baseKey);
    }
  });

  it('finding ID 含逗号时仍生成无碰撞幂等键', () => {
    const left: RemediationContext = {
      ...BASE_CONTEXT,
      findingIds: ['a,b', 'c'],
    };
    const right: RemediationContext = {
      ...BASE_CONTEXT,
      findingIds: ['a', 'b,c'],
    };

    expect(contextKey('subject-1', left)).not.toBe(
      contextKey('subject-1', right)
    );
  });

  it('字段含 NUL 时不会与字段边界拼接产生碰撞', () => {
    const left: RemediationContext = {
      ...BASE_CONTEXT,
      lintJobId: 'job',
    };
    const right: RemediationContext = {
      ...BASE_CONTEXT,
      lintJobId: 'lint\0job',
    };

    expect(contextKey('subject\0lint', left)).not.toBe(
      contextKey('subject', right)
    );
  });
});

describe('readRemediationContext', () => {
  it('安全解析并规范化合法 remediationContext', () => {
    const job = makeJob({
      paramsJson: JSON.stringify({
        sourceId: 'source-1',
        remediationContext: {
          lintJobId: 'lint-1',
          findingIds: ['finding-b', 'finding-a', 'finding-b'],
          action: 're-ingest',
        },
      }),
    });

    expect(readRemediationContext(job)).toEqual({
      lintJobId: 'lint-1',
      findingIds: ['finding-a', 'finding-b'],
      action: 're-ingest',
    });
  });

  it.each([
    ['损坏 JSON', '{'],
    ['null context', JSON.stringify({ remediationContext: null })],
    ['数组 context', JSON.stringify({ remediationContext: [] })],
    [
      'lintJobId 非 string',
      JSON.stringify({ remediationContext: { ...BASE_CONTEXT, lintJobId: 1 } }),
    ],
    [
      'findingIds 非数组',
      JSON.stringify({ remediationContext: { ...BASE_CONTEXT, findingIds: 'finding-a' } }),
    ],
    [
      'findingIds 含非 string',
      JSON.stringify({ remediationContext: { ...BASE_CONTEXT, findingIds: ['finding-a', 1] } }),
    ],
    [
      '非法 action',
      JSON.stringify({ remediationContext: { ...BASE_CONTEXT, action: 'review-source' } }),
    ],
  ])('%s 返回 null 且不抛出', (_name, paramsJson) => {
    expect(() => readRemediationContext(makeJob({ paramsJson }))).not.toThrow();
    expect(readRemediationContext(makeJob({ paramsJson }))).toBeNull();
  });
});

describe('findDuplicateRemediationJob', () => {
  it('复用相同 subject 和 context 的 pending 或 running 任务', () => {
    const pending = makeJob({ id: 'pending' });
    const running = makeJob({
      id: 'running',
      status: 'running',
      createdAt: '2026-07-13T11:00:00.000Z',
    });

    expect(
      findDuplicateRemediationJob(
        [pending, running],
        'subject-1',
        BASE_CONTEXT,
        '2026-07-13T12:00:00.000Z'
      )?.id
    ).toBe('running');
  });

  it('仅复用尚未被新 lint 复检的 completed 任务', () => {
    const afterLint = makeJob({
      id: 'after-lint',
      status: 'completed',
      completedAt: '2026-07-13T12:00:01.000Z',
    });
    const beforeLint = makeJob({
      id: 'before-lint',
      status: 'completed',
      completedAt: '2026-07-13T11:59:59.000Z',
    });
    const equalLint = makeJob({
      id: 'equal-lint',
      status: 'completed',
      completedAt: '2026-07-13T12:00:00.000Z',
    });
    const withoutCompletedAt = makeJob({
      id: 'without-completed-at',
      status: 'completed',
      completedAt: null,
    });

    expect(
      findDuplicateRemediationJob(
        [beforeLint, equalLint, afterLint],
        'subject-1',
        BASE_CONTEXT,
        '2026-07-13T12:00:00.000Z'
      )?.id
    ).toBe('after-lint');
    expect(
      findDuplicateRemediationJob(
        [beforeLint, equalLint],
        'subject-1',
        BASE_CONTEXT,
        '2026-07-13T12:00:00.000Z'
      )
    ).toBeNull();
    expect(
      findDuplicateRemediationJob(
        [withoutCompletedAt],
        'subject-1',
        BASE_CONTEXT,
        '2026-07-13T12:00:00.000Z'
      )?.id
    ).toBe('without-completed-at');
    expect(
      findDuplicateRemediationJob(
        [beforeLint],
        'subject-1',
        BASE_CONTEXT,
        null
      )?.id
    ).toBe('before-lint');
  });

  it('不复用 failed、跨 subject 或不同 context 的任务', () => {
    const jobs = [
      makeJob({ id: 'failed', status: 'failed' }),
      makeJob({ id: 'other-subject', subjectId: 'subject-2' }),
      makeJob({
        id: 'other-context',
        paramsJson: JSON.stringify({
          remediationContext: { ...BASE_CONTEXT, action: 'curate' },
        }),
      }),
    ];

    expect(
      findDuplicateRemediationJob(
        jobs,
        'subject-1',
        BASE_CONTEXT,
        '2026-07-13T12:00:00.000Z'
      )
    ).toBeNull();
  });

  it('选择 createdAt 最新的匹配任务且不受输入顺序影响', () => {
    const older = makeJob({ id: 'older', createdAt: '2026-07-13T10:00:00.000Z' });
    const newer = makeJob({ id: 'newer', createdAt: '2026-07-13T11:00:00.000Z' });
    const jobs = [older, newer];

    expect(
      findDuplicateRemediationJob(jobs, 'subject-1', BASE_CONTEXT, null)?.id
    ).toBe('newer');
    expect(
      findDuplicateRemediationJob([...jobs].reverse(), 'subject-1', BASE_CONTEXT, null)?.id
    ).toBe('newer');
    expect(jobs.map((job) => job.id)).toEqual(['older', 'newer']);
  });

  it('createdAt 相同时按 job.id 字典序稳定选择且不受输入顺序影响', () => {
    const smallerId = makeJob({
      id: 'job-a',
      createdAt: '2026-07-13T11:00:00.000Z',
    });
    const largerId = makeJob({
      id: 'job-z',
      createdAt: '2026-07-13T11:00:00.000Z',
    });

    expect(
      findDuplicateRemediationJob(
        [smallerId, largerId],
        'subject-1',
        BASE_CONTEXT,
        null
      )?.id
    ).toBe('job-z');
    expect(
      findDuplicateRemediationJob(
        [largerId, smallerId],
        'subject-1',
        BASE_CONTEXT,
        null
      )?.id
    ).toBe('job-z');
  });
});

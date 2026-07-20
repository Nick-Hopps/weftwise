import { describe, expect, it } from 'vitest';
import {
  finishUrlAuthRecovery,
  initialUrlAuthRecoveryState,
  observeUrlAuthChallenge,
  reopenUrlAuthChallenge,
  type UrlAuthRecoveryRequest,
} from '../url-auth-recovery-state';

function request(
  challengeId: string,
  jobId = challengeId,
): UrlAuthRecoveryRequest {
  return {
    jobId,
    subjectId: 's1',
    label: `${jobId}.html`,
    challenge: {
      challengeId,
      status: 401,
      authOrigin: 'https://example.com',
      sourceId: `source-${jobId}`,
    },
  };
}

describe('url-auth-recovery-state', () => {
  it('同一持久化 challenge 自动提示一次，多个任务保持观察顺序', () => {
    const first = observeUrlAuthChallenge(initialUrlAuthRecoveryState(), request('challenge-1'));
    const duplicate = observeUrlAuthChallenge(first, request('challenge-1'));
    const second = observeUrlAuthChallenge(duplicate, request('challenge-2'));

    expect(duplicate).toBe(first);
    expect(second.queue.map((item) => item.challenge.challengeId)).toEqual([
      'challenge-1',
      'challenge-2',
    ]);
    expect(second.promptedChallengeIds).toEqual(new Set(['challenge-1', 'challenge-2']));
  });

  it('关闭只移除当前请求且不再次自动弹出，手动入口可以重开', () => {
    const observed = observeUrlAuthChallenge(
      initialUrlAuthRecoveryState(),
      request('challenge-1'),
    );
    const closed = finishUrlAuthRecovery(observed, 'challenge-1');
    expect(closed.queue).toEqual([]);
    expect(observeUrlAuthChallenge(closed, request('challenge-1'))).toBe(closed);

    const reopened = reopenUrlAuthChallenge(closed, request('challenge-1'));
    expect(reopened.queue).toEqual([request('challenge-1')]);
  });

  it('完成队首后保留后续 challenge，新事件身份仍可再次提示', () => {
    const queued = observeUrlAuthChallenge(
      observeUrlAuthChallenge(initialUrlAuthRecoveryState(), request('challenge-1', 'job-1')),
      request('challenge-2', 'job-2'),
    );
    const next = finishUrlAuthRecovery(queued, 'challenge-1');
    const repeatedJob = observeUrlAuthChallenge(next, request('challenge-3', 'job-1'));

    expect(repeatedJob.queue.map((item) => item.challenge.challengeId)).toEqual([
      'challenge-2',
      'challenge-3',
    ]);
  });
});

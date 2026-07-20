import { describe, expect, it } from 'vitest';
import {
  finishUrlAuthRecovery,
  initialUrlAuthRecoveryState,
  selectUrlAuthRecovery,
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
  it('初始状态不选择任务，只有显式操作才进入授权恢复', () => {
    const initial = initialUrlAuthRecoveryState();
    expect(initial.selected).toBeNull();

    const selected = selectUrlAuthRecovery(initial, request('challenge-1'));
    expect(selected.selected).toEqual(request('challenge-1'));
  });

  it('重复选择同一 challenge 保持引用，选择另一任务时原子替换', () => {
    const first = selectUrlAuthRecovery(
      initialUrlAuthRecoveryState(),
      request('challenge-1'),
    );
    expect(selectUrlAuthRecovery(first, request('challenge-1'))).toBe(first);
    expect(selectUrlAuthRecovery(first, request('challenge-2')).selected)
      .toEqual(request('challenge-2'));
  });

  it('关闭只清除匹配的显式选择', () => {
    const selected = selectUrlAuthRecovery(
      initialUrlAuthRecoveryState(),
      request('challenge-1'),
    );
    expect(finishUrlAuthRecovery(selected, 'other')).toBe(selected);
    expect(finishUrlAuthRecovery(selected, 'challenge-1').selected).toBeNull();
  });
});

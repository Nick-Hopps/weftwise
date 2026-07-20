import type { UrlAuthChallenge } from '@/lib/ingest-auth';

export interface UrlAuthRecoveryRequest {
  jobId: string;
  subjectId: string | null;
  label: string;
  challenge: UrlAuthChallenge;
}

export interface UrlAuthRecoveryState {
  queue: UrlAuthRecoveryRequest[];
  promptedChallengeIds: ReadonlySet<string>;
}

export function initialUrlAuthRecoveryState(): UrlAuthRecoveryState {
  return { queue: [], promptedChallengeIds: new Set() };
}

/** SSE 自动观察入口：同一持久化 challenge 在当前页面会话只提示一次。 */
export function observeUrlAuthChallenge(
  state: UrlAuthRecoveryState,
  request: UrlAuthRecoveryRequest,
): UrlAuthRecoveryState {
  const challengeId = request.challenge.challengeId;
  if (state.promptedChallengeIds.has(challengeId)) return state;
  return {
    queue: enqueueUnique(state.queue, request),
    promptedChallengeIds: new Set(state.promptedChallengeIds).add(challengeId),
  };
}

/** 用户主动点击任务行时允许重新打开已经关闭过的 challenge。 */
export function reopenUrlAuthChallenge(
  state: UrlAuthRecoveryState,
  request: UrlAuthRecoveryRequest,
): UrlAuthRecoveryState {
  const queue = enqueueUnique(state.queue, request);
  return queue === state.queue ? state : { ...state, queue };
}

export function finishUrlAuthRecovery(
  state: UrlAuthRecoveryState,
  challengeId: string,
): UrlAuthRecoveryState {
  const queue = state.queue.filter(
    (request) => request.challenge.challengeId !== challengeId,
  );
  return queue.length === state.queue.length ? state : { ...state, queue };
}

function enqueueUnique(
  queue: readonly UrlAuthRecoveryRequest[],
  request: UrlAuthRecoveryRequest,
): UrlAuthRecoveryRequest[] {
  if (queue.some((item) => item.challenge.challengeId === request.challenge.challengeId)) {
    return queue as UrlAuthRecoveryRequest[];
  }
  return [...queue, request];
}

import type { UrlAuthChallenge } from '@/lib/ingest-auth';

export interface UrlAuthRecoveryRequest {
  jobId: string;
  subjectId: string | null;
  label: string;
  challenge: UrlAuthChallenge;
}

export interface UrlAuthRecoveryState {
  selected: UrlAuthRecoveryRequest | null;
}

export function initialUrlAuthRecoveryState(): UrlAuthRecoveryState {
  return { selected: null };
}

/** 只有用户显式选择授权重试时才打开对话框。 */
export function selectUrlAuthRecovery(
  state: UrlAuthRecoveryState,
  request: UrlAuthRecoveryRequest,
): UrlAuthRecoveryState {
  return state.selected?.challenge.challengeId === request.challenge.challengeId
    ? state
    : { selected: request };
}

export function finishUrlAuthRecovery(
  state: UrlAuthRecoveryState,
  challengeId: string,
): UrlAuthRecoveryState {
  return state.selected?.challenge.challengeId === challengeId
    ? { selected: null }
    : state;
}

export type ResetConfirmationState = 'idle' | 'pending';
export type ResetConfirmationDecision = 'requested' | 'confirm' | 'cancel' | 'unclear';

export function applyResetConfirmationDecision(
  state: ResetConfirmationState,
  decision: ResetConfirmationDecision,
): { state: ResetConfirmationState; shouldReset: boolean } {
  if (decision === 'requested') return { state: 'pending', shouldReset: false };
  if (decision === 'confirm') {
    return { state: 'idle', shouldReset: state === 'pending' };
  }
  if (decision === 'cancel') return { state: 'idle', shouldReset: false };
  return { state, shouldReset: false };
}

export function resetIntentContext(
  state: ResetConfirmationState,
): 'reset-confirmation' | undefined {
  return state === 'pending' ? 'reset-confirmation' : undefined;
}

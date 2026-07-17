import { describe, expect, it } from 'vitest';
import {
  applyResetConfirmationDecision,
  resetIntentContext,
  type ResetConfirmationState,
} from '../reset-confirmation-state';

describe('applyResetConfirmationDecision', () => {
  it('requested 进入 pending，但不执行重置', () => {
    expect(applyResetConfirmationDecision('idle', 'requested')).toEqual({
      state: 'pending',
      shouldReset: false,
    });
  });

  it('只有 pending + confirm 才允许执行重置', () => {
    expect(applyResetConfirmationDecision('pending', 'confirm')).toEqual({
      state: 'idle',
      shouldReset: true,
    });
    expect(applyResetConfirmationDecision('idle', 'confirm')).toEqual({
      state: 'idle',
      shouldReset: false,
    });
  });

  it('cancel 退出确认态，unclear 保持原状态', () => {
    expect(applyResetConfirmationDecision('pending', 'cancel')).toEqual({
      state: 'idle',
      shouldReset: false,
    });
    expect(applyResetConfirmationDecision('pending', 'unclear')).toEqual({
      state: 'pending',
      shouldReset: false,
    });
  });
});

describe('resetIntentContext', () => {
  it.each([
    ['idle', undefined],
    ['pending', 'reset-confirmation'],
  ] as const)('%s -> %s', (state, expected) => {
    expect(resetIntentContext(state as ResetConfirmationState)).toBe(expected);
  });
});

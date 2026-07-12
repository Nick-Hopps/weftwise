import { describe, it, expect } from 'vitest';
import {
  POSTCONDITION_JOB_EVENT_TYPES,
  shouldResetRetryBudget,
  shouldReconnect,
  statusOnConnect,
  terminalStatusForEvent,
  isAuthoritativeTerminal,
} from '../job-stream-logic';

describe('POSTCONDITION_JOB_EVENT_TYPES', () => {
  it('注册 Fix 与 Curate 的开始和完成事件', () => {
    expect(POSTCONDITION_JOB_EVENT_TYPES).toEqual([
      'fix:verify:start',
      'fix:verify:complete',
      'curate:verify:start',
      'curate:verify:complete',
    ]);
  });
});

describe('shouldResetRetryBudget', () => {
  it('resets the budget on a genuinely new event (a real cursor id)', () => {
    // A real persisted event carries a UUID id and advances the cursor — a
    // reconnect that delivers real progress has earned a fresh retry budget.
    expect(shouldResetRetryBudget('a1b2c3d4-real-uuid')).toBe(true);
  });

  it("does NOT reset the budget on the synthetic terminal marker ('final')", () => {
    // The server re-sends `id: final` on EVERY reconnect to a terminal job.
    // If that reset the retry budget, MAX_RECONNECT_ATTEMPTS would never engage
    // and the stream would reconnect forever — the root cause of the flicker.
    expect(shouldResetRetryBudget('final')).toBe(false);
  });

  it('does NOT reset the budget for an event without an id', () => {
    expect(shouldResetRetryBudget(undefined)).toBe(false);
    expect(shouldResetRetryBudget('')).toBe(false);
  });
});

describe('shouldReconnect', () => {
  const base = { closed: false, sawTerminal: false, attempts: 0, maxAttempts: 5 };

  it('reconnects on a transient error while still streaming and under the cap', () => {
    expect(shouldReconnect(base)).toBe(true);
  });

  it('NEVER reconnects once a terminal event has been observed', () => {
    // Terminal latch: even with attempts to spare, a job we have seen finish
    // must not be re-subscribed by the auto-reconnect (prevents the
    // streaming↔failed oscillation that flickers the pill).
    expect(shouldReconnect({ ...base, sawTerminal: true })).toBe(false);
  });

  it('stops reconnecting once the attempt cap is reached', () => {
    expect(shouldReconnect({ ...base, attempts: 5 })).toBe(false);
    expect(shouldReconnect({ ...base, attempts: 6 })).toBe(false);
  });

  it('never reconnects after the subscription is closed', () => {
    expect(shouldReconnect({ ...base, closed: true })).toBe(false);
  });
});

describe('statusOnConnect', () => {
  it('shows streaming on the initial connect from idle', () => {
    expect(statusOnConnect('idle', false)).toBe('streaming');
  });

  it('shows streaming on an explicit (re)subscribe even from a terminal state', () => {
    // A user-driven retry re-subscribes (isReconnect=false) and should
    // immediately reflect work-in-progress again.
    expect(statusOnConnect('failed', false)).toBe('streaming');
    expect(statusOnConnect('completed', false)).toBe('streaming');
  });

  it('does NOT revert a terminal status back to streaming on an auto-reconnect', () => {
    // The flicker: an auto-reconnect must not flip failed/completed back to
    // streaming (which would re-show the pill, then a terminal event hides it
    // again, ad infinitum).
    expect(statusOnConnect('failed', true)).toBe('failed');
    expect(statusOnConnect('completed', true)).toBe('completed');
  });

  it('keeps streaming on an auto-reconnect of a still-running job', () => {
    expect(statusOnConnect('streaming', true)).toBe('streaming');
    expect(statusOnConnect('idle', true)).toBe('streaming');
  });
});

describe('terminalStatusForEvent', () => {
  it('maps job:completed to completed', () => {
    expect(terminalStatusForEvent('job:completed')).toBe('completed');
  });

  it('maps job:failed and job:cancelled to failed', () => {
    expect(terminalStatusForEvent('job:failed')).toBe('failed');
    expect(terminalStatusForEvent('job:cancelled')).toBe('failed');
  });

  it('returns null for non-terminal events', () => {
    expect(terminalStatusForEvent('job:retrying')).toBeNull();
    expect(terminalStatusForEvent('ingest:planning')).toBeNull();
    expect(terminalStatusForEvent('agent:step')).toBeNull();
  });
});

describe('isAuthoritativeTerminal', () => {
  it('latches on the synthetic final marker', () => {
    expect(isAuthoritativeTerminal('job:failed', 'final')).toBe(true);
    expect(isAuthoritativeTerminal('job:completed', 'final')).toBe(true);
  });

  it('does NOT latch on a real terminal event replayed from history', () => {
    // A retried job replays its old job:failed before a later job:retrying.
    // Latching here would strand the resumable job on a stale failure.
    expect(isAuthoritativeTerminal('job:failed', 'a1b2c3d4-real-uuid')).toBe(false);
    expect(isAuthoritativeTerminal('job:completed', 'some-real-id')).toBe(false);
  });

  it('does NOT latch on non-terminal events even with the final id', () => {
    expect(isAuthoritativeTerminal('job:retrying', 'final')).toBe(false);
    expect(isAuthoritativeTerminal('ingest:planning', 'final')).toBe(false);
  });
});

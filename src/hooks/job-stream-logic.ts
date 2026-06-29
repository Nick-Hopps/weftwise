// Pure decision logic for `useJobStream`, extracted so the reconnect / terminal
// rules are unit-testable without a DOM or a live EventSource. The hook wires
// these into its stateful effect; the subtle correctness lives here.

export type JobStreamStatus = 'idle' | 'streaming' | 'completed' | 'failed';

/**
 * The synthetic end-of-stream marker the SSE server appends for a terminal job
 * (see `server/jobs/events.ts`). It is NOT a real `job_events` row id, so it is
 * never recorded as the resume cursor.
 */
export const SYNTHETIC_FINAL_ID = 'final';

/**
 * Should receiving an event refresh the auto-reconnect budget?
 *
 * Only a genuinely new event — one that advances the resume cursor — counts as
 * progress worth resetting the retry counter for. Crucially, the server re-sends
 * `id: final` on *every* reconnect to an already-terminal job; if that reset the
 * budget, `MAX_RECONNECT_ATTEMPTS` would never engage and the stream would
 * reconnect forever (the root cause of the status flicker). So `final` — and any
 * id-less event — must NOT reset the budget.
 */
export function shouldResetRetryBudget(lastEventId: string | undefined): boolean {
  return !!lastEventId && lastEventId !== SYNTHETIC_FINAL_ID;
}

/**
 * Should the hook auto-reconnect after a connection error?
 *
 * Never once we've observed the job reach a terminal state (the terminal latch
 * that stops the streaming↔failed oscillation), never after the subscription is
 * torn down, and never past the attempt cap.
 */
export function shouldReconnect(opts: {
  closed: boolean;
  sawTerminal: boolean;
  attempts: number;
  maxAttempts: number;
}): boolean {
  if (opts.closed || opts.sawTerminal) return false;
  return opts.attempts < opts.maxAttempts;
}

/**
 * The status to show when (re)opening the EventSource.
 *
 * An explicit (re)subscribe — initial mount, or a user-driven retry that bumps
 * the reconnect key — always reflects work-in-progress (`streaming`). But an
 * *auto*-reconnect must not revert an already-terminal status back to streaming:
 * doing so re-shows the pill, the replayed terminal event hides it again, and it
 * flickers indefinitely.
 */
export function statusOnConnect(
  current: JobStreamStatus,
  isReconnect: boolean,
): JobStreamStatus {
  if (isReconnect && (current === 'failed' || current === 'completed')) {
    return current;
  }
  return 'streaming';
}

/** The terminal status implied by an event type, or null if it isn't terminal. */
export function terminalStatusForEvent(type: string): JobStreamStatus | null {
  if (type === 'job:completed') return 'completed';
  if (type === 'job:failed' || type === 'job:cancelled') return 'failed';
  return null;
}

/**
 * Is this event the server's authoritative "the job is terminal right now"
 * marker — i.e. the synthetic `final` event, sent only when `queue.get()` reports
 * a terminal status, and always followed by the stream closing?
 *
 * Only this should latch the subscription closed. A *real* terminal event
 * replayed from history can be stale: a retried job has its old `job:failed`
 * sitting before a later `job:retrying`, so closing on the replayed failure would
 * strand a resumable job. A running (retried) job never re-emits `final`, so the
 * stream stays open and streams the resumed run instead.
 */
export function isAuthoritativeTerminal(
  eventType: string,
  lastEventId: string | undefined,
): boolean {
  return terminalStatusForEvent(eventType) !== null && lastEventId === SYNTHETIC_FINAL_ID;
}

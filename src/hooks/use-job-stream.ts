'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  shouldResetRetryBudget,
  shouldReconnect,
  statusOnConnect,
  terminalStatusForEvent,
  isAuthoritativeTerminal,
  type JobStreamStatus,
} from './job-stream-logic';

export interface JobStreamEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
}

export type { JobStreamStatus };

interface UseJobStreamResult {
  events: JobStreamEvent[];
  status: JobStreamStatus;
  latestMessage: string;
  reset: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;
// A full ingest emits ~800 events; retain enough that the live view's timeline
// keeps every phase from the start of a long run (not just the tail).
const MAX_EVENTS = 1200;

export function useJobStream(jobId: string | null, reconnectKey = 0): UseJobStreamResult {
  const [events, setEvents] = useState<JobStreamEvent[]>([]);
  const [status, setStatus] = useState<JobStreamStatus>('idle');
  const [latestMessage, setLatestMessage] = useState<string>('');
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const reconnectAttemptsRef = useRef(0);
  const statusRef = useRef<JobStreamStatus>('idle');
  // Latches true once we observe the job reach a terminal state. It survives
  // auto-reconnects within a subscription (unlike statusRef, which connect()
  // resets) so a finished job is never re-subscribed — only an explicit
  // re-subscribe (jobId / reconnectKey change) clears it.
  const terminalRef = useRef(false);

  function updateStatus(next: JobStreamStatus) {
    statusRef.current = next;
    setStatus(next);
  }

  const reset = useCallback(() => {
    setEvents([]);
    updateStatus('idle');
    setLatestMessage('');
    lastEventIdRef.current = undefined;
    reconnectAttemptsRef.current = 0;
    terminalRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!jobId) {
      reset();
      return;
    }

    // A fresh (re)subscription: clear the terminal latch and retry budget so a
    // retried job can stream again, but keep lastEventIdRef so we resume from
    // the cursor (past the prior failure) rather than replaying stale history.
    terminalRef.current = false;
    reconnectAttemptsRef.current = 0;

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function connect(isReconnect = false) {
      if (closed) return;

      updateStatus(statusOnConnect(statusRef.current, isReconnect));

      // EventSource uses Last-Event-ID header for resume on reconnect.
      // We also pass it as a query param for the initial connection with a known cursor.
      // Include apiKey for authentication (EventSource cannot send Authorization headers).
      const lastId = lastEventIdRef.current;
      const params = new URLSearchParams();
      if (lastId) params.set('lastEventId', lastId);
      const apiKey = typeof window !== 'undefined'
        ? (process.env.NEXT_PUBLIC_WIKI_API_KEY ?? '')
        : '';
      if (apiKey) params.set('apiKey', apiKey);
      const qs = params.toString();
      const url = `/api/jobs/${jobId}/events${qs ? `?${qs}` : ''}`;

      source = new EventSource(url);

      const handleEvent = (event: MessageEvent, eventType: string) => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          parsed = { message: event.data };
        }

        const streamEvent: JobStreamEvent = {
          type: eventType,
          data: parsed,
          id: event.lastEventId || undefined,
        };

        // Advance the resume cursor only for genuinely new events, skipping the
        // synthetic 'final' marker (see events.ts) — otherwise a stale cursor
        // would replay the old job:failed on every reconnect. The retry budget
        // resets on the SAME condition: only real forward progress earns a fresh
        // budget, so a terminal job that re-sends only 'final' on each reconnect
        // can't keep the counter pinned at 0 and loop forever.
        if (shouldResetRetryBudget(event.lastEventId)) {
          lastEventIdRef.current = event.lastEventId;
          reconnectAttemptsRef.current = 0;
        }

        setEvents((prev) => {
          const next = [...prev, streamEvent];
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        });

        const message =
          (parsed.message as string) ||
          (parsed.step as string) ||
          (parsed.description as string) ||
          '';
        if (message) {
          setLatestMessage(message);
        }

        const terminalStatus = terminalStatusForEvent(eventType);
        if (terminalStatus) {
          // Reflect the terminal status for display. We do NOT close here on a
          // real (replayed) terminal event — it may be stale history before a
          // later job:retrying. Only the authoritative 'final' marker (below)
          // latches the subscription closed.
          updateStatus(terminalStatus);
          if (eventType === 'job:failed') {
            setLatestMessage((parsed.error as string) || 'Job failed');
          } else if (eventType === 'job:cancelled') {
            // Cancel reuses the 'failed' channel; latestMessage carries the nuance.
            setLatestMessage('Job cancelled by user');
          }
        } else if (eventType === 'job:retrying') {
          // Auto-retry (worker) or manual retry: flow back into progress so a
          // later authoritative terminal can latch.
          updateStatus('streaming');
        }

        if (isAuthoritativeTerminal(eventType, event.lastEventId)) {
          // The server says the job is terminal right now and is closing the
          // stream. Latch so the auto-reconnect can never re-subscribe to this
          // finished job — this is what stops the flicker loop.
          terminalRef.current = true;
          source?.close();
        }
      };

      source.onmessage = (event: MessageEvent) => {
        handleEvent(event, 'message');
      };

      const namedEventTypes = [
        // Job lifecycle (emitted by worker)
        'job:completed',
        'job:failed',
        'job:cancelled',
        'job:retrying',
        // Ingest events
        'ingest:start',
        'ingest:resuming',
        'ingest:parsing',
        'ingest:chunking',
        'ingest:reading-wiki',
        'ingest:llm',
        'ingest:planned',
        'ingest:validating',
        'ingest:validation-failed',
        'ingest:applying',
        'ingest:complete',
        'ingest:warn',
        'ingest:planning',
        'ingest:committing',
        // Agent runtime events (orchestrator)
        'agent:run-started',
        'agent:run-completed',
        'agent:step',
        'agent:error',
        // Lint events
        'lint:scope',
        'lint:deterministic:start',
        'lint:deterministic:done',
        'lint:semantic:start',
        'lint:semantic:done',
        'lint:semantic:error',
        'lint:complete',
        // Save-to-wiki events
        'save:start',
        'save:complete',
        // Curate events
        'curate:start',
        'curate:plan',
        'curate:merge',
        'curate:split',
        'curate:delete',
        'curate:create',
        'curate:skip',
        'curate:warn',
        'curate:complete',
        // Re-enrich events
        'reenrich:start',
        // Fix events
        'fix:start',
        'fix:deterministic',
        'fix:page',
        'fix:create',
        'fix:skip',
        'fix:warn',
        'fix:complete',
      ];

      const listeners: Array<{ type: string; handler: (e: Event) => void }> = [];

      for (const eventType of namedEventTypes) {
        const handler = (e: Event) => {
          handleEvent(e as MessageEvent, eventType);
        };
        source.addEventListener(eventType, handler);
        listeners.push({ type: eventType, handler });
      }

      source.onerror = () => {
        if (closed) return;

        // Clean up the current connection
        for (const { type, handler } of listeners) {
          source?.removeEventListener(type, handler);
        }
        source?.close();

        // Auto-reconnect only for a transient drop of a live job — never once
        // we've latched terminal, and never past the cap (refs avoid stale
        // closures). The cap genuinely engages now that the retry budget only
        // resets on real forward progress, so a terminal job can't loop.
        if (
          shouldReconnect({
            closed,
            sawTerminal: terminalRef.current,
            attempts: reconnectAttemptsRef.current,
            maxAttempts: MAX_RECONNECT_ATTEMPTS,
          })
        ) {
          reconnectAttemptsRef.current++;
          reconnectTimer = setTimeout(() => connect(true), RECONNECT_DELAY_MS);
        } else {
          updateStatus(statusRef.current === 'completed' ? 'completed' : 'failed');
        }
      };
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, reconnectKey]);

  return { events, status, latestMessage, reset };
}

'use client';
import { useState, useEffect, useCallback, useRef } from 'react';

export interface JobStreamEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
}

export type JobStreamStatus = 'idle' | 'streaming' | 'completed' | 'failed';

interface UseJobStreamResult {
  events: JobStreamEvent[];
  status: JobStreamStatus;
  latestMessage: string;
  reset: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;
const MAX_EVENTS = 200;

export function useJobStream(jobId: string | null): UseJobStreamResult {
  const [events, setEvents] = useState<JobStreamEvent[]>([]);
  const [status, setStatus] = useState<JobStreamStatus>('idle');
  const [latestMessage, setLatestMessage] = useState<string>('');
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const reconnectAttemptsRef = useRef(0);
  const statusRef = useRef<JobStreamStatus>('idle');

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!jobId) {
      reset();
      return;
    }

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function connect() {
      if (closed) return;

      updateStatus('streaming');

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
        reconnectAttemptsRef.current = 0;

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

        if (event.lastEventId) {
          lastEventIdRef.current = event.lastEventId;
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

        if (eventType === 'job:completed') {
          updateStatus('completed');
          source?.close();
        } else if (eventType === 'job:failed') {
          updateStatus('failed');
          const errMsg = (parsed.error as string) || 'Job failed';
          setLatestMessage(errMsg);
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
        'job:retrying',
        // Ingest events
        'ingest:start',
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

        // Auto-reconnect if not in terminal state (use ref to avoid stale closure)
        if (
          reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS &&
          statusRef.current !== 'completed' && statusRef.current !== 'failed'
        ) {
          reconnectAttemptsRef.current++;
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
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
  }, [jobId]);

  return { events, status, latestMessage, reset };
}

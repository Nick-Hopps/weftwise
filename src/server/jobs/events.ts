import * as jobsRepo from '../db/repos/jobs-repo';
import * as queue from './queue';

export function emit(
  jobId: string,
  type: string,
  message: string,
  data?: Record<string, unknown>
): void {
  jobsRepo.appendJobEvent(jobId, type, message, data);
}

// Maximum SSE stream lifetime to prevent connection leaks (H4 fix)
const MAX_STREAM_LIFETIME_MS = 30 * 60 * 1000; // 30 minutes

export function createEventStream(
  jobId: string,
  lastEventId?: string
): ReadableStream {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let lifetimeTimerId: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (lifetimeTimerId !== null) {
      clearTimeout(lifetimeTimerId);
      lifetimeTimerId = null;
    }
  }

  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      function sendSSE(
        eventId: string,
        eventType: string,
        data: unknown
      ): void {
        const chunk =
          `id: ${eventId}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(chunk));
      }

      function sendHeartbeat(): void {
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }

      let lastSeenId: string | undefined = lastEventId;
      let heartbeatCount = 0;

      // Send existing events first
      const existingEvents = jobsRepo.getJobEvents(jobId, lastSeenId);
      for (const event of existingEvents) {
        sendSSE(event.id, event.type, {
          message: event.message,
          data: event.dataJson ? JSON.parse(event.dataJson) : null,
          createdAt: event.createdAt,
        });
        lastSeenId = event.id;
      }

      // Check if job is already terminal after sending existing events
      const initialJob = queue.get(jobId);
      if (
        initialJob &&
        (initialJob.status === 'completed' || initialJob.status === 'failed')
      ) {
        sendSSE('final', `job:${initialJob.status}`, {
          status: initialJob.status,
          resultJson: initialJob.resultJson,
          completedAt: initialJob.completedAt,
        });
        cleanup();
        controller.close();
        return;
      }

      // Auto-close after max lifetime to prevent connection leaks
      lifetimeTimerId = setTimeout(() => {
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      }, MAX_STREAM_LIFETIME_MS);

      // Poll for new events
      intervalId = setInterval(() => {
        if (closed) return;

        try {
          // Send heartbeat every ~5s (every 5th 1000ms tick)
          heartbeatCount++;
          if (heartbeatCount % 5 === 0) {
            sendHeartbeat();
          }

          const newEvents = jobsRepo.getJobEvents(jobId, lastSeenId);
          for (const event of newEvents) {
            sendSSE(event.id, event.type, {
              message: event.message,
              data: event.dataJson ? JSON.parse(event.dataJson) : null,
              createdAt: event.createdAt,
            });
            lastSeenId = event.id;
          }

          // Check if job has reached terminal state
          const job = queue.get(jobId);
          if (
            job &&
            (job.status === 'completed' || job.status === 'failed')
          ) {
            sendSSE('final', `job:${job.status}`, {
              status: job.status,
              resultJson: job.resultJson,
              completedAt: job.completedAt,
            });
            cleanup();
            controller.close();
          }
        } catch {
          cleanup();
          controller.close();
        }
      }, 1000);
    },
    cancel() {
      cleanup();
    },
  });
}

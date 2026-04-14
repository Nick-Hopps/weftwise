import { NextRequest } from 'next/server';
import { createEventStream } from '@/server/jobs/events';
import { requireAuth } from '@/server/middleware/auth';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;
  // Support both standard Last-Event-ID header and query param fallback
  const lastEventId =
    request.headers.get('last-event-id') ??
    request.nextUrl.searchParams.get('lastEventId') ??
    undefined;

  const stream = createEventStream(id, lastEventId);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

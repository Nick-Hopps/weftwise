import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth } from '@/server/middleware/auth';

export const runtime = 'nodejs';

/**
 * POST /api/lint
 * Enqueues a lint job and returns the job ID for SSE status tracking.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const job = queue.enqueue('lint');
  return NextResponse.json({ jobId: job.id });
}

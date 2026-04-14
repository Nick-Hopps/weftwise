import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth } from '@/server/middleware/auth';
import type { Job } from '@/lib/contracts';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { searchParams } = request.nextUrl;
  const status = searchParams.get('status') as Job['status'] | null;
  const type = searchParams.get('type') as Job['type'] | null;

  const jobs = queue.list({
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
  });

  return NextResponse.json(jobs);
}

import { NextResponse } from 'next/server';
import { PendingActionError } from '@/server/services/pending-action-service';

export function pendingActionErrorResponse(error: unknown): NextResponse {
  if (error instanceof PendingActionError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        action: error.action ?? null,
      },
      { status: error.httpStatus },
    );
  }

  console.error('[pending-actions] unexpected route error', error);
  return NextResponse.json(
    {
      error: 'Action execution failed.',
      code: 'ACTION_APPLY_FAILED',
      action: null,
    },
    { status: 500 },
  );
}

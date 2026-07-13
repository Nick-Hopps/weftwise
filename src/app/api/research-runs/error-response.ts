import { NextResponse } from 'next/server';
import { ResearchApprovalServiceError } from '@/server/services/research-approval-service';

export function researchRunErrorResponse(error: unknown): NextResponse {
  if (error instanceof ResearchApprovalServiceError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error.run ? { run: error.run } : {}),
      },
      { status: error.httpStatus },
    );
  }

  console.error('[research-runs] unexpected route error', error);
  return NextResponse.json(
    { error: 'Research request failed.' },
    { status: 500 },
  );
}

export function invalidResearchSelectionResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Research candidate selection is invalid.',
      code: 'RESEARCH_SELECTION_INVALID',
    },
    { status: 400 },
  );
}

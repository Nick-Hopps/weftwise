import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { approveResearchRun } from '@/server/services/research-approval-service';
import {
  invalidResearchSelectionResponse,
  researchRunErrorResponse,
} from '../../error-response';

export const runtime = 'nodejs';

const ApproveResearchRunBodySchema = z.object({
  candidateIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(100),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  subjectId: z.string().trim().min(1),
}).strict().superRefine((body, context) => {
  if (new Set(body.candidateIds).size !== body.candidateIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateIds'],
      message: 'candidateIds must not contain duplicates',
    });
  }
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return invalidResearchSelectionResponse();
  }
  const parsed = ApproveResearchRunBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidResearchSelectionResponse();

  const { subject, error } = resolveSubjectFromRequest(request, {
    required: true,
    body: parsed.data,
  });
  if (error) return error;

  const { id } = await params;
  try {
    const result = approveResearchRun({
      runId: id,
      subjectId: subject.id,
      candidateIds: parsed.data.candidateIds,
      expectedVersion: parsed.data.expectedVersion,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
  } catch (routeError) {
    return researchRunErrorResponse(routeError);
  }
}

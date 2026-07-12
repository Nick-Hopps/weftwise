import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import {
  RemediationRequestError,
  remediate,
} from '@/server/services/remediation-service';

export const runtime = 'nodejs';

const ACTIONS = new Set(['fix', 'curate', 'research', 're-ingest']);

/** POST /api/health/remediations —— 统一执行当前 Health 快照的处置动作。 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', code: 'invalid-json' },
      { status: 400 },
    );
  }
  if (!isRecord(parsedBody)) {
    return NextResponse.json(
      { error: 'JSON body must be an object', code: 'invalid-body' },
      { status: 400 },
    );
  }
  const body = parsedBody;

  const resolution = resolveSubjectFromRequest(request, {
    required: true,
    body,
  });
  if (resolution.error) return resolution.error;

  try {
    const lintJobId = readLintJobId(body.lintJobId);
    const findingIds = readFindingIds(body.findingIds);
    const action = readAction(body.action);
    const result = await remediate({
      subject: resolution.subject,
      lintJobId,
      findingIds,
      action,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof RemediationRequestError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error('[health-remediation] request failed', error);
    return NextResponse.json(
      { error: 'Health remediation failed', code: 'internal-error' },
      { status: 500 },
    );
  }
}

function readLintJobId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RemediationRequestError(
      400,
      'invalid-lint-job-id',
      'lintJobId must be a non-empty string',
    );
  }
  return value;
}

function readFindingIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new RemediationRequestError(
      400,
      'invalid-finding-count',
      'findingIds must contain 1-100 values',
    );
  }
  if (!value.every((findingId) => typeof findingId === 'string')) {
    throw new RemediationRequestError(
      400,
      'invalid-finding-id',
      'findingIds must be strings',
    );
  }
  return value;
}

function readAction(
  value: unknown,
): 'fix' | 'curate' | 'research' | 're-ingest' {
  if (typeof value !== 'string' || !ACTIONS.has(value)) {
    throw new RemediationRequestError(
      400,
      'invalid-action',
      'action must be fix, curate, research, or re-ingest',
    );
  }
  return value as 'fix' | 'curate' | 'research' | 're-ingest';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

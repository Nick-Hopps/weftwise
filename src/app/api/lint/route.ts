import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import {
  LintVerificationError,
  resolveLintVerificationContext,
} from '@/server/services/lint-verification';
import type { LintVerificationRequest } from '@/lib/contracts';

export const runtime = 'nodejs';

/**
 * POST /api/lint
 *
 * 默认是 subject-scoped 开放式发现；`{ allSubjects: true }` 触发全量发现。
 * Health 的 Fix/Curate 闭环可传 verification，只复核原快照，不发现新语义 finding。
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const bodyRecord = isRecord(body) ? body : null;
  const allSubjects = bodyRecord?.allSubjects === true;
  const verification = readVerification(bodyRecord?.verification);

  if (bodyRecord && Object.prototype.hasOwnProperty.call(bodyRecord, 'verification') && !verification) {
    return NextResponse.json(
      { error: 'verification must contain baselineLintJobId and remediationJobId' },
      { status: 400 },
    );
  }

  if (allSubjects) {
    if (verification) {
      return NextResponse.json(
        { error: 'verification is only supported for one subject' },
        { status: 400 },
      );
    }
    const job = queue.enqueue('lint', {}, null);
    return NextResponse.json({ jobId: job.id, scope: 'all-subjects' });
  }

  const resolution = resolveSubjectFromRequest(request, { body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  if (verification) {
    try {
      resolveLintVerificationContext(subject.id, verification);
    } catch (error) {
      if (error instanceof LintVerificationError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: 409 },
        );
      }
      throw error;
    }
  }

  const job = queue.enqueue(
    'lint',
    { subjectId: subject.id, ...(verification ? { verification } : {}) },
    subject.id,
  );
  return NextResponse.json({
    jobId: job.id,
    subjectId: subject.id,
    subjectSlug: subject.slug,
    mode: verification ? 'verification' : 'discovery',
  });
}

function readVerification(value: unknown): LintVerificationRequest | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.baselineLintJobId !== 'string'
    || value.baselineLintJobId.trim().length === 0
    || typeof value.remediationJobId !== 'string'
    || value.remediationJobId.trim().length === 0
  ) {
    return null;
  }
  return {
    baselineLintJobId: value.baselineLintJobId,
    remediationJobId: value.remediationJobId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

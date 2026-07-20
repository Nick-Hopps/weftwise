import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as queue from '@/server/jobs/queue';
import * as events from '@/server/jobs/events';
import { getJobEvents } from '@/server/db/repos/jobs-repo';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import { readUrlSourceReference } from '@/server/sources/url-source';
import {
  createSourceAuthGrant,
  deleteSourceAuthGrant,
  normalizeSourceAuthHeaders,
} from '@/server/sources/source-auth-grant';
import { retryResearchIngestJob } from '@/server/services/research-approval-service';
import { researchRunErrorResponse } from '../../../research-runs/error-response';

export const runtime = 'nodejs';

interface AuthChallenge {
  status: 401 | 403;
  authOrigin: string;
  sourceId: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    body = value as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let headers: ReturnType<typeof normalizeSourceAuthHeaders>;
  try {
    headers = normalizeSourceAuthHeaders({
      cookie: body.cookie,
      authorization: body.authorization,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid authentication headers' },
      { status: 400 },
    );
  }

  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { id } = await params;
  const job = queue.get(id);
  if (!job || job.subjectId !== resolution.subject.id) {
    return NextResponse.json({ error: 'Ingest job not found' }, { status: 404 });
  }
  if (job.type !== 'ingest') {
    return NextResponse.json({ error: 'Only URL ingest jobs can receive authentication' }, { status: 422 });
  }
  if (job.status !== 'failed') {
    return NextResponse.json(
      { error: `Cannot authenticate a job with status "${job.status}"` },
      { status: 409 },
    );
  }

  const jobParams = parseRecord(job.paramsJson);
  if (!jobParams) {
    return NextResponse.json({ error: 'Ingest job parameters are invalid' }, { status: 409 });
  }
  const hasResearchProvenance = Object.prototype.hasOwnProperty.call(
    jobParams,
    'researchProvenance',
  );
  const researchProvenance = parseResearchProvenance(jobParams.researchProvenance);
  if (hasResearchProvenance && !researchProvenance) {
    return NextResponse.json(
      { error: 'Research provenance for this ingest is invalid.' },
      { status: 409 },
    );
  }
  const sourceId = typeof jobParams.sourceId === 'string' ? jobParams.sourceId : '';
  const source = sourceId ? sourcesRepo.getSource(sourceId) : null;
  if (!source || source.subjectId !== resolution.subject.id || !readUrlSourceReference(source)) {
    return NextResponse.json({ error: 'URL source not found' }, { status: 404 });
  }

  const challenge = currentAuthChallenge(getJobEvents(id));
  if (!challenge || challenge.sourceId !== sourceId) {
    return NextResponse.json(
      { error: 'This ingest is not currently waiting for URL authentication' },
      { status: 409 },
    );
  }

  let grant: { id: string; expiresAt: string };
  try {
    grant = createSourceAuthGrant({
      jobId: id,
      sourceId,
      authOrigin: challenge.authOrigin,
      ...headers,
    });
  } catch {
    return NextResponse.json({ error: 'Could not store URL authentication' }, { status: 500 });
  }

  let researchRun: ReturnType<typeof retryResearchIngestJob>['run'] | undefined;
  if (researchProvenance) {
    try {
      researchRun = retryResearchIngestJob({
        ...researchProvenance,
        ingestJobId: id,
        subjectId: resolution.subject.id,
        sourceAuthGrantId: grant.id,
      }).run;
    } catch (error) {
      deleteSourceAuthGrant(grant.id);
      return researchRunErrorResponse(error);
    }
  } else {
    const requeued = queue.requeueJobWithParams(id, { sourceAuthGrantId: grant.id });
    if (!requeued) {
      deleteSourceAuthGrant(grant.id);
      return NextResponse.json(
        { error: 'The ingest changed before authentication could be applied' },
        { status: 409 },
      );
    }
  }

  const previousGrantId = typeof jobParams.sourceAuthGrantId === 'string'
    ? jobParams.sourceAuthGrantId
    : null;
  if (previousGrantId && previousGrantId !== grant.id) {
    try {
      deleteSourceAuthGrant(previousGrantId);
    } catch {
      // 新 grant 已原子接管 job；旧 grant 最迟由 TTL 清理。
    }
  }

  events.emit(id, 'job:retrying', 'Authentication supplied - retrying URL ingest', {
    manual: true,
    authenticated: true,
    ...(researchProvenance ? { research: true, runId: researchProvenance.runId } : {}),
  });
  return NextResponse.json(
    {
      jobId: id,
      status: 'pending',
      expiresAt: grant.expiresAt,
      ...(researchRun ? { researchRun } : {}),
    },
    { status: 202 },
  );
}

/**
 * 旧 auth-required 之后只要发生过 retry，就不能再拿旧 challenge 给新失败授权。
 * 新一轮 401/403 会在 retry 后追加新的 auth-required，再次成为当前 challenge。
 */
function currentAuthChallenge(jobEvents: ReturnType<typeof getJobEvents>): AuthChallenge | null {
  for (let index = jobEvents.length - 1; index >= 0; index -= 1) {
    const event = jobEvents[index]!;
    if (event.type === 'job:retrying') return null;
    if (event.type !== 'ingest:auth-required') continue;
    const data = parseRecord(event.dataJson);
    if (
      data?.code !== 'url-auth-required'
      || (data.status !== 401 && data.status !== 403)
      || typeof data.authOrigin !== 'string'
      || typeof data.sourceId !== 'string'
    ) return null;
    return {
      status: data.status,
      authOrigin: data.authOrigin,
      sourceId: data.sourceId,
    };
  }
  return null;
}

function parseRecord(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseResearchProvenance(value: unknown): {
  runId: string;
  approvalId: string;
  candidateId: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3
    || !keys.every((key) => ['runId', 'approvalId', 'candidateId'].includes(key))
    || ![record.runId, record.approvalId, record.candidateId]
      .every((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
  ) return null;
  return record as { runId: string; approvalId: string; candidateId: string };
}

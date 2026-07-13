import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { isWebSearchConfigured } from '@/server/search/web-search';
import { selectLatestFindings } from '@/server/services/lint-latest';
import { normalizeRemediationContext } from '@/server/services/remediation-context';
import {
  MAX_RESEARCH_FINDING_IDS,
  ResearchScopeError,
  resolveTopicsFromFindingIds,
} from '@/server/services/research-scope';

export const runtime = 'nodejs';

/**
 * POST /api/research — 缺口/主题触发联网研究，入队 'research' job（只发现不写入）。
 * body: { findingIds: string[], lintJobId: string } | { topic: string }（二选一）
 *  - findingIds：当前 subject 最新 completed lint 快照里 coverage-gap / thin-page findings 的稳定 ID；
 *    lintJobId 必须精确匹配该快照，避免陈旧选择误触发。
 *  - topic：手动自由文本。
 * web search 未配置 → 422（先去设置里配好）。
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let parsedBody: unknown = {};
  try {
    parsedBody = (await request.json()) ?? {};
  } catch {
    parsedBody = {};
  }
  const body = isRecord(parsedBody) ? parsedBody : {};

  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  if (hasOwn(body, 'gapIds')) {
    return NextResponse.json(
      { error: 'gapIds is no longer supported; use findingIds with lintJobId' },
      { status: 400 },
    );
  }

  const hasFindingIds = hasOwn(body, 'findingIds');
  const hasTopic = hasOwn(body, 'topic');
  if (hasFindingIds === hasTopic) {
    return NextResponse.json({ error: 'Provide either findingIds or topic' }, { status: 400 });
  }

  let findingParams:
    | {
      findingIds: string[];
      lintJobId: string;
      remediationContext: ReturnType<typeof normalizeRemediationContext>;
    }
    | undefined;
  let topic: string | undefined;

  if (hasFindingIds) {
    if (
      !Array.isArray(body.findingIds)
      || body.findingIds.length === 0
      || body.findingIds.length > MAX_RESEARCH_FINDING_IDS
      || !body.findingIds.every(
        (findingId) => typeof findingId === 'string' && /^[0-9a-f]{64}$/.test(findingId),
      )
      || typeof body.lintJobId !== 'string'
      || body.lintJobId.trim().length === 0
    ) {
      return NextResponse.json(
        { error: 'findingIds require a current lintJobId and 64 character hex IDs' },
        { status: 400 },
      );
    }

    const findingIds = body.findingIds as string[];
    const lintJobId = body.lintJobId;
    const latestLint = queue.listLatestCompletedLint(subject.id);
    const latest = selectLatestFindings(latestLint ? [latestLint] : []);
    if (latest.jobId !== lintJobId) {
      return NextResponse.json({ error: 'Research lint snapshot is stale' }, { status: 409 });
    }

    try {
      resolveTopicsFromFindingIds(subject.id, lintJobId, findingIds);
    } catch (error) {
      if (error instanceof ResearchScopeError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      console.error('[research] unexpected finding scope error', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const remediationContext = normalizeRemediationContext({
      lintJobId,
      findingIds,
      action: 'research',
    });
    findingParams = {
      findingIds: remediationContext.findingIds,
      lintJobId,
      remediationContext,
    };
  } else {
    if (typeof body.topic !== 'string' || body.topic.trim().length === 0) {
      return NextResponse.json({ error: 'Provide either findingIds or topic' }, { status: 400 });
    }
    topic = body.topic.trim();
  }

  if (!isWebSearchConfigured()) {
    return NextResponse.json(
      { error: 'Web search is not configured. Set it up in Settings before running research.' },
      { status: 422 },
    );
  }

  const params = findingParams
    ? { ...findingParams, subjectId: subject.id }
    : { topic: topic!, subjectId: subject.id };
  const job = queue.enqueue('research', params, subject.id);

  return NextResponse.json(
    { jobId: job.id, subjectId: subject.id, subjectSlug: subject.slug },
    { status: 202 },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

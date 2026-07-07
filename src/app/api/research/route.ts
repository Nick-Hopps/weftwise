import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { isWebSearchConfigured } from '@/server/search/web-search';
import { selectLatestFindings } from '@/server/services/lint-latest';

export const runtime = 'nodejs';

/**
 * POST /api/research — 缺口/主题触发联网研究，入队 'research' job（只发现不写入）。
 * body: { gapIds?: string[], topic?: string }（二选一）
 *  - gapIds：最近 lint 快照里 coverage-gap findings 的数组下标（十进制字符串）；服务端重新读取
 *    快照校验存在（轻微过期无害——见 design doc）。
 *  - topic：手动自由文本。
 * web search 未配置 → 422（先去设置里配好）。
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: { gapIds?: unknown; topic?: unknown } = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }

  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const hasGapIds = Array.isArray(body.gapIds) && body.gapIds.length > 0;
  const hasTopic = typeof body.topic === 'string' && body.topic.trim().length > 0;

  if (hasGapIds && hasTopic) {
    return NextResponse.json({ error: 'Provide either "gapIds" or "topic", not both' }, { status: 400 });
  }
  if (!hasGapIds && !hasTopic) {
    return NextResponse.json({ error: 'Missing "gapIds" or "topic"' }, { status: 400 });
  }

  let gapIds: string[] | undefined;
  if (hasGapIds) {
    const raw = body.gapIds as unknown[];
    if (!raw.every((g) => typeof g === 'string')) {
      return NextResponse.json({ error: '"gapIds" must be an array of strings' }, { status: 400 });
    }
    gapIds = raw as string[];

    // 服务端重新读取最近快照校验 gapIds 至少命中一条 coverage-gap finding。
    const latest = selectLatestFindings(
      queue.list({ type: 'lint', status: 'completed', subjectId: subject.id }),
    );
    const indices = new Set(gapIds);
    const hit = latest.findings.some(
      (f, i) => f.type === 'coverage-gap' && indices.has(String(i)),
    );
    if (!hit) {
      return NextResponse.json(
        { error: 'None of the provided gapIds reference a current coverage-gap finding' },
        { status: 400 },
      );
    }
  }

  if (!isWebSearchConfigured()) {
    return NextResponse.json(
      { error: 'Web search is not configured. Set it up in Settings before running research.' },
      { status: 422 },
    );
  }

  const topic = hasTopic ? (body.topic as string).trim() : undefined;
  const job = queue.enqueue('research', { gapIds, topic, subjectId: subject.id }, subject.id);

  return NextResponse.json(
    { jobId: job.id, subjectId: subject.id, subjectSlug: subject.slug },
    { status: 202 },
  );
}

import { NextRequest, NextResponse } from 'next/server';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import type { Subject } from '@/lib/contracts';

const SUBJECT_COOKIE = 'wiki_subject';

export type SubjectResolution =
  | { subject: Subject; error: null }
  | { subject: null; error: NextResponse };

interface ResolveSubjectOptions {
  /**
   * When `false`, missing/unknown subject falls back to `general` — or, once
   * general has been deleted, to the first existing project. When `true`,
   * missing/unknown subject results in a 400/404 error response.
   * Defaults to `false`.
   */
  required?: boolean;
  /**
   * When provided, the subjectId is read from this body object before falling
   * back to query/cookie/general. Body fields take priority over cookies.
   */
  body?: unknown;
}

function readSubjectFromBody(body: unknown): {
  id?: string;
  slug?: string;
} {
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  return {
    id: typeof record.subjectId === 'string' ? record.subjectId : undefined,
    slug: typeof record.subjectSlug === 'string' ? record.subjectSlug : undefined,
  };
}

/**
 * Resolve the target Subject for a request, honouring (in priority order):
 *   1. `?subjectId=<uuid>` query param
 *   2. `?s=<slug>` query param (deep-link friendly)
 *   3. body `subjectId` / `subjectSlug` (POST/PUT/PATCH bodies)
 *   4. `wiki_subject=<slug>` cookie (set by the frontend store)
 *   5. fallback to `general`, or the first project once general was deleted
 *      (unless `required` is true)
 *
 * Returns either `{ subject }` or `{ error }` so callers can pattern-match
 * without try/catch noise.
 */
export function resolveSubjectFromRequest(
  request: NextRequest,
  options: ResolveSubjectOptions = {}
): SubjectResolution {
  const { required = false, body } = options;

  const queryId = request.nextUrl.searchParams.get('subjectId');
  const querySlug = request.nextUrl.searchParams.get('s');
  const bodyParts = readSubjectFromBody(body);
  const cookieSlug = request.cookies.get(SUBJECT_COOKIE)?.value;

  const candidateId = queryId ?? bodyParts.id ?? null;
  const candidateSlug = querySlug ?? bodyParts.slug ?? cookieSlug ?? null;

  if (candidateId) {
    const found = subjectsRepo.getById(candidateId);
    if (!found) {
      return { subject: null, error: subjectNotFound(candidateId) };
    }
    return { subject: found, error: null };
  }

  if (candidateSlug) {
    const found = subjectsRepo.getBySlug(candidateSlug);
    if (!found) {
      if (required) {
        return { subject: null, error: subjectNotFound(candidateSlug) };
      }
      return resolveFallbackOrFail(required);
    }
    return { subject: found, error: null };
  }

  if (required) {
    return {
      subject: null,
      error: NextResponse.json(
        { error: 'subjectId is required for this endpoint' },
        { status: 400 }
      ),
    };
  }

  return resolveFallbackOrFail(false);
}

/**
 * 兜底解析：优先 `general`，它已被用户删除时退到第一个 project。
 * **刻意不在这里补建 project**——读路径不该有副作用；能走到「零 project」只可能是
 * 数据库被外部清空，而删除路径与启动期已各自兜住不变量。
 */
function resolveFallbackOrFail(required: boolean): SubjectResolution {
  const fallback = subjectsRepo.getFallbackSubject();
  if (!fallback) {
    return {
      subject: null,
      error: NextResponse.json(
        { error: 'No project exists yet. Create one before using this endpoint.' },
        { status: 500 }
      ),
    };
  }
  if (required) {
    return {
      subject: null,
      error: NextResponse.json(
        { error: 'subjectId is required for this endpoint' },
        { status: 400 }
      ),
    };
  }
  return { subject: fallback, error: null };
}

function subjectNotFound(idOrSlug: string): NextResponse {
  return NextResponse.json(
    { error: `Subject "${idOrSlug}" not found` },
    { status: 404 }
  );
}

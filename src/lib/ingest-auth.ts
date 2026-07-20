import type { JobStreamEvent } from '@/hooks/use-job-stream';
import type { ResearchRunView } from '@/lib/contracts';

export interface UrlAuthChallenge {
  challengeId: string;
  status: 401 | 403;
  authOrigin: string;
  sourceId: string;
}

export interface UrlAuthSubmissionResult {
  jobId: string;
  status: 'pending';
  expiresAt: string;
  researchRun?: ResearchRunView;
}

export function buildUrlAuthSubmissionBody(input: {
  subjectId: string | null;
  cookie: string;
  authorization: string;
}): Record<string, string> {
  const cookie = input.cookie.trim();
  const authorization = input.authorization.trim();
  return {
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(cookie ? { cookie } : {}),
    ...(authorization ? { authorization } : {}),
  };
}

/**
 * 从持久化 SSE 历史中归约当前认证挑战。旧 challenge 后只要出现 retry 就失效；
 * 新一轮 401/403 会追加在 retry 后并重新生效。
 */
export function currentUrlAuthChallenge(
  events: ReadonlyArray<Pick<JobStreamEvent, 'type' | 'data' | 'id'>>,
): UrlAuthChallenge | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'job:retrying' || event.type === 'job:cancelled') return null;
    if (event.type !== 'ingest:auth-required') continue;
    if (typeof event.id !== 'string' || !event.id.trim()) return null;
    const payload = nestedPayload(event.data);
    if (
      payload.code !== 'url-auth-required'
      || (payload.status !== 401 && payload.status !== 403)
      || typeof payload.authOrigin !== 'string'
      || !isHttpOrigin(payload.authOrigin)
      || typeof payload.sourceId !== 'string'
      || !payload.sourceId.trim()
    ) return null;
    return {
      challengeId: event.id,
      status: payload.status,
      authOrigin: payload.authOrigin,
      sourceId: payload.sourceId,
    };
  }
  return null;
}

/** 列表恢复只读取安全 error code；具体 origin/source 仍以持久化 SSE challenge 为准。 */
export function jobResultRequiresUrlAuth(resultJson: string | null | undefined): boolean {
  if (!resultJson) return false;
  try {
    const value = JSON.parse(resultJson) as {
      cancelled?: unknown;
      error?: { code?: unknown };
    };
    return value?.cancelled !== true
      && value?.error?.code === 'url-auth-required';
  } catch {
    return false;
  }
}

function nestedPayload(data: Record<string, unknown>): Record<string, unknown> {
  const value = data.data;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (value === url.origin || value === `${url.origin}/`);
  } catch {
    return false;
  }
}

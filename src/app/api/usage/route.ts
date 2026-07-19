import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { summarizeUsage } from '@/server/db/repos/usage-repo';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import type { UsageWindow } from '@/lib/contracts';

export const runtime = 'nodejs';

// 时间窗口对应的毫秒数
const WINDOW_MS: Record<Exclude<UsageWindow, 'all'>, number> = {
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

/**
 * GET /api/usage?window=7d|30d|all&subjectId=<id> — LLM 用量统计。
 * 缺省 subjectId 查询全部项目；显式项目必须存在。只读，仅 requireAuth。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const param = request.nextUrl.searchParams.get('window');
  const window: UsageWindow = param === '7d' || param === 'all' ? param : '30d';
  const sinceMs = window === 'all' ? undefined : Date.now() - WINDOW_MS[window];
  const rawSubjectId = request.nextUrl.searchParams.get('subjectId')?.trim();
  const subjectId = rawSubjectId || undefined;
  if (subjectId && !subjectsRepo.getById(subjectId)) {
    return NextResponse.json({ error: 'Unknown subjectId' }, { status: 400 });
  }

  return NextResponse.json({
    window,
    subjectId: subjectId ?? null,
    rows: summarizeUsage({ sinceMs, ...(subjectId ? { subjectId } : {}) }),
  });
}

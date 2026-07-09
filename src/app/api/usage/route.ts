import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { summarizeUsage } from '@/server/db/repos/usage-repo';
import type { UsageWindow } from '@/lib/contracts';

export const runtime = 'nodejs';

// 时间窗口对应的毫秒数
const WINDOW_MS: Record<Exclude<UsageWindow, 'all'>, number> = {
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

/**
 * GET /api/usage?window=7d|30d|all — LLM 用量统计（设置页 Usage 面板）。
 * app 级资源，非 subject-scoped；只读，仅 requireAuth；非法/缺省 window 按 30d。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const param = request.nextUrl.searchParams.get('window');
  const window: UsageWindow = param === '7d' || param === 'all' ? param : '30d';
  const sinceMs = window === 'all' ? undefined : Date.now() - WINDOW_MS[window];

  return NextResponse.json({ window, rows: summarizeUsage(sinceMs) });
}

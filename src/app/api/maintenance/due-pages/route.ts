import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { getMaintenanceScope } from '@/server/db/repos/settings-repo';
import * as maturityRepo from '@/server/db/repos/maturity-repo';
import type { MaintenanceDuePagesResult } from '@/lib/contracts';

export const runtime = 'nodejs';

/** 单次返回上限：到期页由 sweep 持续消化，预览前 100 条足够判断，不做分页。 */
const DUE_PAGES_LIMIT = 100;

/**
 * GET /api/maintenance/due-pages
 *
 * 只读到期页面明细，供 Settings 的 "Pages due now" 预览。scope 与
 * `/api/maintenance/status` 同源（settings-repo），total 与 dueCount 同口径。
 * 维护是全局调度，不绑 subject；仅 requireAuth。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const scope = getMaintenanceScope();
  const subjectIds = scope.mode === 'subjects' ? scope.subjectIds : undefined;
  const nowIso = new Date().toISOString();
  const result: MaintenanceDuePagesResult = {
    total: maturityRepo.countDue(nowIso, subjectIds),
    entries: maturityRepo.listDueDetailed(nowIso, DUE_PAGES_LIMIT, subjectIds),
    limit: DUE_PAGES_LIMIT,
  };
  return NextResponse.json(result);
}

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import {
  getMaintenanceEnabled,
  getMaintenanceLastSweepAt,
  getMaintenanceSweepIntervalHours,
} from '@/server/db/repos/settings-repo';
import * as maturityRepo from '@/server/db/repos/maturity-repo';
import type { MaintenanceStatus } from '@/lib/contracts';

export const runtime = 'nodejs';

/**
 * GET /api/maintenance/status
 *
 * 只读维护层运行态：开关、上次 sweep 时间、节律、当前到期页数（跨主题全量，与 sweep 同口径）。
 * 维护是全局调度，不绑 subject；仅 requireAuth。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const status: MaintenanceStatus = {
    enabled: getMaintenanceEnabled(),
    lastSweepAt: getMaintenanceLastSweepAt(),
    sweepIntervalHours: getMaintenanceSweepIntervalHours(),
    dueCount: maturityRepo.countDue(new Date().toISOString()),
  };
  return NextResponse.json(status);
}

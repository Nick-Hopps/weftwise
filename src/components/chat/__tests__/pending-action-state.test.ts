import { describe, expect, it } from 'vitest';
import type { PendingActionView } from '@/lib/contracts';
import { replacePendingActions, upsertPendingAction } from '../pending-action-state';

function action(actionId: string, status: PendingActionView['status'] = 'pending'): PendingActionView {
  return {
    actionId,
    conversationId: 'c1',
    operation: 'update',
    status,
    expiresAt: '2026-07-11T12:00:00.000Z',
    operationId: null,
    jobId: null,
    error: null,
    kind: 'page-change',
    preHead: 'head-1',
    summary: `Action ${actionId}`,
    affectedPages: [{ slug: actionId, action: 'update' }],
    diff: `diff ${actionId}`,
    warnings: [],
  };
}

describe('pending action 客户端状态', () => {
  it('审批应用后移除原卡片', () => {
    const pending = action('a1');
    const applied = { ...pending, status: 'applied' as const };
    expect(upsertPendingAction([pending], applied)).toEqual([]);
  });

  it('审批拒绝后移除原卡片', () => {
    const pending = action('a1');
    const rejected = { ...pending, status: 'rejected' as const };
    expect(upsertPendingAction([pending], rejected)).toEqual([]);
  });

  it('新 action 追加到末尾，保持服务端既有顺序', () => {
    const first = action('a1');
    const second = { ...action('a2'), expiresAt: '2026-07-11T11:00:00.000Z' };
    expect(upsertPendingAction([first], second)).toEqual([first, second]);
  });

  it('会话恢复忽略已结束审批，并去除重复 actionId', () => {
    const first = action('a1');
    const firstApplied = { ...first, status: 'applied' as const };
    const second = action('a2');
    expect(replacePendingActions([first, second, firstApplied])).toEqual([second]);
  });
});

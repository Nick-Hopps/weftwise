import { describe, expect, it } from 'vitest';
import type { PendingActionView } from '@/lib/contracts';
import { selectActiveTagAction } from '../tag-governance-state';

function action(status: PendingActionView['status'], operation: PendingActionView['operation'] = 'tag-batch') {
  return { status, operation } as PendingActionView;
}

describe('selectActiveTagAction', () => {
  it('跳过终态与其他 operation，返回最新进行中 tag-batch', () => {
    expect(selectActiveTagAction([
      action('applied'),
      action('pending', 'delete'),
      action('executing'),
      action('pending'),
    ])?.status).toBe('executing');
  });

  it('没有进行中审批时返回 null', () => {
    expect(selectActiveTagAction([action('rejected'), action('failed')])).toBeNull();
  });
});

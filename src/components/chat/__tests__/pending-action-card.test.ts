import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PendingActionView } from '@/lib/contracts';
import { PendingActionCard } from '../pending-action-card';

vi.stubGlobal('React', React);

function imageAction(overrides: Partial<PendingActionView> = {}): PendingActionView {
  return {
    actionId: 'action-image-1',
    conversationId: 'conversation-1',
    operation: 'workflow-image-insert-start',
    status: 'pending',
    kind: 'workflow',
    preHead: 'head-1',
    summary: '为 page-a 的选中内容生成配图',
    affectedPages: [{ slug: 'page-a', action: 'update' }],
    diff: null,
    warnings: ['批准后才会生成一张图片并尝试插入正文。'],
    imageInsert: {
      selection: 'Selected **Markdown** paragraph.',
      prompt: 'Explain the write-ahead log visually.',
      alt: 'Write-ahead log sequence diagram',
      aspectRatio: '16:9',
      style: 'Editorial technical diagram',
    },
    expiresAt: '2026-07-17T00:30:00.000Z',
    operationId: null,
    jobId: null,
    error: null,
    ...overrides,
  };
}

describe('PendingActionCard image insert', () => {
  it('展示选区、prompt、alt、比例、风格与批准后生成语义', () => {
    const html = renderToStaticMarkup(React.createElement(PendingActionCard, {
      action: imageAction(),
      busy: false,
      onApprove: vi.fn(),
      onReject: vi.fn(),
    }));

    expect(html).toContain('Proposed illustration');
    expect(html).toContain('Selected **Markdown** paragraph.');
    expect(html).toContain('Explain the write-ahead log visually.');
    expect(html).toContain('Write-ahead log sequence diagram');
    expect(html).toContain('16:9');
    expect(html).toContain('Editorial technical diagram');
    expect(html).toContain('One image will be generated after approval');
  });

  it('applied 只表示后台任务已启动，不宣称图片已经插入', () => {
    const html = renderToStaticMarkup(React.createElement(PendingActionCard, {
      action: imageAction({ status: 'applied', jobId: 'image-job-1' }),
      busy: false,
      onApprove: vi.fn(),
      onReject: vi.fn(),
    }));

    expect(html).toContain('Illustration task started');
    expect(html).not.toContain('Illustration inserted');
  });
});

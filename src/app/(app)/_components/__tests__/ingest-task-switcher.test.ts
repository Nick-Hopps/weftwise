import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IngestTaskSwitcher } from '../ingest-task-switcher';
import type { IngestTask } from '@/lib/ingest-task-list';

const tasks: IngestTask[] = [
  {
    id: 'job-a',
    sourceName: 'architecture.md',
    queueStatus: 'running',
    createdAt: '2026-07-15T00:00:00.000Z',
    checkpointProgress: null,
  },
  {
    id: 'job-b',
    sourceName: 'https://example.com/reference',
    queueStatus: 'pending',
    createdAt: '2026-07-15T00:00:01.000Z',
    checkpointProgress: null,
  },
  {
    id: 'job-c',
    sourceName: 'broken.pdf',
    queueStatus: 'failed',
    createdAt: '2026-07-15T00:00:02.000Z',
    checkpointProgress: null,
  },
];

describe('IngestTaskSwitcher', () => {
  it('展示全部任务、状态和当前选中任务', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        IngestTaskSwitcher,
        {
          tasks,
          selectedId: 'job-b',
          onSelect: () => undefined,
          error: '1 URL could not be queued',
        },
        React.createElement('div', null, 'Selected task detail'),
      ),
    );

    expect(html).toContain('3 sources');
    expect(html).toContain('architecture.md');
    expect(html).toContain('https://example.com/reference');
    expect(html).toContain('broken.pdf');
    expect(html).toContain('Running');
    expect(html).toContain('Queued');
    expect(html).toContain('Failed');
    expect(html).toContain('1 URL could not be queued');
    expect(html).toContain('Selected task detail');
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>.*https:\/\/example\.com\/reference/);
  });
});

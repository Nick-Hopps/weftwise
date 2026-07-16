import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceMetric,
  WorkspacePage,
  WorkspacePageHeader,
  WorkspaceState,
  WorkspaceSummary,
  WorkspaceToolbar,
} from '../workspace-page';

describe('知识运维页面布局原语', () => {
  it('使用统一宽度并渲染页头身份、上下文和动作', () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkspacePage,
        null,
        createElement(WorkspacePageHeader, {
          icon: createElement('span', { 'aria-hidden': true }, '#'),
          title: 'Tags',
          description: 'Current subject',
          meta: '12 pages',
          actions: createElement('button', { type: 'button' }, 'Review'),
        }),
      ),
    );

    expect(html).toContain('max-w-[1080px]');
    expect(html).toContain('<h1');
    expect(html).toContain('Tags</h1>');
    expect(html).toContain('Current subject');
    expect(html).toContain('12 pages');
    expect(html).toContain('<button type="button">Review</button>');
  });

  it('以无卡片指标带和 sticky 工具栏组织工作区', () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkspaceSummary,
        { 'aria-label': 'Summary' },
        createElement(WorkspaceMetric, { label: 'Open findings', value: 7 }),
      ),
    );
    const toolbar = renderToStaticMarkup(
      createElement(WorkspaceToolbar, { 'aria-label': 'Filters' }, 'Controls'),
    );

    expect(html).toContain('aria-label="Summary"');
    expect(html).toContain('border-y');
    expect(html).toContain('Open findings');
    expect(html).toContain('tabular-nums');
    expect(toolbar).toContain('aria-label="Filters"');
    expect(toolbar).toContain('sticky');
    expect(toolbar).toContain('backdrop-blur');
  });

  it('提供一致的语义化状态区和可选动作', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceState, {
        title: 'No operations yet',
        description: 'Changes will appear here.',
        action: createElement('button', { type: 'button' }, 'Retry'),
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('min-h-48');
    expect(html).toContain('No operations yet');
    expect(html).toContain('Changes will appear here.');
    expect(html).toContain('Retry');
  });
});

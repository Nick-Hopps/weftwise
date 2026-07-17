import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolActivityIcon } from '../tool-activity-icon';

describe('ToolActivityIcon', () => {
  it('把工具语义映射为装饰性的 Lucide SVG', () => {
    const html = renderToStaticMarkup(React.createElement(ToolActivityIcon, { tool: 'wiki_search' }));

    expect(html).toContain('<svg');
    expect(html).toContain('data-tool-icon="search"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('🔍');
  });

  it('未知工具使用稳定的 activity 回退图标', () => {
    const html = renderToStaticMarkup(React.createElement(ToolActivityIcon, { tool: 'unknown_tool' }));

    expect(html).toContain('data-tool-icon="activity"');
  });
});

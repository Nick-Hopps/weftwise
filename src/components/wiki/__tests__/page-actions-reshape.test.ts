import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReshapeStatus } from '../page-actions';

Object.assign(globalThis, { React });

function render(state: 'loading' | 'refreshing' | 'reshaped', showOriginal = false): string {
  return renderToStaticMarkup(React.createElement(ReshapeStatus, {
    state,
    showOriginal,
    onToggle: vi.fn(),
    onRefresh: vi.fn(),
    onCancel: vi.fn(),
  }));
}

describe('ReshapeStatus', () => {
  it('首次生成与刷新都提供 Cancel', () => {
    expect(render('loading')).toContain('Cancel');
    expect(render('refreshing')).toContain('Refreshing reshape');
    expect(render('refreshing')).toContain('Cancel');
  });

  it('成功版本同时提供 Refresh 与原文切换', () => {
    const reshaped = render('reshaped');
    expect(reshaped).toContain('Refresh');
    expect(reshaped).toContain('Show original');
    expect(render('reshaped', true)).toContain('Show reshaped');
  });
});

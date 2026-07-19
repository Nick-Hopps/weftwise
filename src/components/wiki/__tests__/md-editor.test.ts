import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { React });

const dynamicCapture = vi.hoisted(() => ({
  loaderText: '',
  options: undefined as { loading?: () => React.ReactNode } | undefined,
}));

vi.mock('next/dynamic', async () => {
  const ReactModule = await import('react');
  return {
    default: (
      loader: () => Promise<unknown>,
      options?: { loading?: () => React.ReactNode },
    ) => {
      dynamicCapture.loaderText = loader.toString();
      dynamicCapture.options = options;
      return function DynamicEditorStub(props: Record<string, unknown>) {
        return ReactModule.createElement('div', {
          'data-preview': props.preview,
          'data-highlight-enable': String(props.highlightEnable),
        });
      };
    },
  };
});

vi.mock('@/stores/ui-store', () => ({
  useUIStore: (selector: (state: { darkMode: boolean }) => unknown) => selector({ darkMode: false }),
}));

import { MdEditor } from '../md-editor';

describe('MdEditor 性能边界', () => {
  it('默认只挂载源码编辑区并关闭全文语法高亮', () => {
    const html = renderToStaticMarkup(
      React.createElement(MdEditor, { value: '# Title', onChange: () => {} }),
    );

    expect(html).toContain('data-preview="edit"');
    expect(html).toContain('data-highlight-enable="false"');
  });

  it('使用轻量入口并在动态模块加载时显示状态占位', () => {
    expect(dynamicCapture.loaderText).toContain('@uiw/react-md-editor/nohighlight');

    const loading = dynamicCapture.options?.loading?.();
    expect(loading).toBeTruthy();
    expect(renderToStaticMarkup(loading as React.ReactElement)).toContain('role="status"');
  });
});

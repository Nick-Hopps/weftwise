'use client';

import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useUIStore } from '@/stores/ui-store';
import { useI18n } from '@/components/i18n-provider';

// @uiw/react-md-editor 触碰 window，必须 ssr:false 且只在 client 组件内动态加载。
// nohighlight 入口避免每次输入都用 Prism 同步处理整篇 Markdown；富预览仍由 EditorPreview 提供。
const MDEditor = dynamic(() => import('@uiw/react-md-editor/nohighlight'), {
  ssr: false,
  loading: () => <EditorLoading />,
});

interface MdEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** 自定义预览渲染器：传入则替换 MDEditor 自带预览，保证与阅读页一致。 */
  previewRenderer?: (source: string) => ReactNode;
}

function EditorLoading() {
  const { t } = useI18n();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex h-full flex-col border border-border bg-surface"
    >
      <span className="sr-only">{t('wiki.editor.loading')}</span>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {Array.from({ length: 8 }, (_, index) => (
          <span key={index} className="h-8 w-8 animate-pulse rounded bg-subtle" />
        ))}
      </div>
      <div className="flex-1 animate-pulse bg-subtle/40" />
    </div>
  );
}

export function MdEditor({ value, onChange, previewRenderer }: MdEditorProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  return (
    <div className="wiki-md-editor h-full" data-color-mode={darkMode ? 'dark' : 'light'}>
      <MDEditor
        value={value}
        onChange={(v) => onChange(v ?? '')}
        height="100%"
        preview="edit"
        highlightEnable={false}
        components={
          previewRenderer
            ? { preview: (source) => <>{previewRenderer(source)}</> }
            : undefined
        }
      />
    </div>
  );
}

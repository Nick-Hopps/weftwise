'use client';

import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useUIStore } from '@/stores/ui-store';

// @uiw/react-md-editor 触碰 window，必须 ssr:false 且只在 client 组件内动态加载。
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

interface MdEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** 自定义预览渲染器：传入则替换 MDEditor 自带预览，保证与阅读页一致。 */
  previewRenderer?: (source: string) => ReactNode;
}

export function MdEditor({ value, onChange, previewRenderer }: MdEditorProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  return (
    <div className="wiki-md-editor h-full" data-color-mode={darkMode ? 'dark' : 'light'}>
      <MDEditor
        value={value}
        onChange={(v) => onChange(v ?? '')}
        height="100%"
        preview="live"
        components={
          previewRenderer
            ? { preview: (source) => <>{previewRenderer(source)}</> }
            : undefined
        }
      />
    </div>
  );
}

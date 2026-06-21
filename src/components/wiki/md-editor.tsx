'use client';

import dynamic from 'next/dynamic';
import { useUIStore } from '@/stores/ui-store';

// @uiw/react-md-editor 触碰 window，必须 ssr:false 且只在 client 组件内动态加载。
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

interface MdEditorProps {
  value: string;
  onChange: (next: string) => void;
  height?: number;
}

export function MdEditor({ value, onChange, height = 520 }: MdEditorProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  return (
    <div data-color-mode={darkMode ? 'dark' : 'light'}>
      <MDEditor
        value={value}
        onChange={(v) => onChange(v ?? '')}
        height={height}
        preview="live"
      />
    </div>
  );
}

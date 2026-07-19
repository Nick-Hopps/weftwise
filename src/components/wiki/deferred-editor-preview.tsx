'use client';

import { useEffect, useState } from 'react';
import { EditorPreview } from './editor-preview';

export const EDITOR_PREVIEW_DEBOUNCE_MS = 400;

interface DeferredEditorPreviewProps {
  source: string;
  titleSlugMap?: Record<string, string>;
  slug: string;
}

/**
 * 编辑器富预览只在用户短暂停顿后更新，避免逐键重复执行完整 Markdown / KaTeX / Mermaid 渲染。
 * 初次切到 Live 或 Preview 时组件才会挂载，并立即显示当时的完整源码。
 */
export function DeferredEditorPreview({ source, titleSlugMap, slug }: DeferredEditorPreviewProps) {
  const [previewSource, setPreviewSource] = useState(source);

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewSource(source), EDITOR_PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [source]);

  return <EditorPreview source={previewSource} titleSlugMap={titleSlugMap} slug={slug} />;
}

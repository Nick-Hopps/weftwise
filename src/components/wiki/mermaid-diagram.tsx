'use client';

import React, { useCallback, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useI18n } from '@/components/i18n-provider';
import { MermaidPreview } from './mermaid-preview';
import { MermaidSvg } from './mermaid-svg';

/**
 * 渲染单个 mermaid 图。mermaid 仅在浏览器可用，故：
 * - 模块顶层不 import mermaid（保证 markdown-client 在 node 测试/SSR 可加载）；
 * - 同步先渲染占位容器（带 data-mermaid-src 便于测试/降级）；
 * - useEffect 内动态 import 并渲染 SVG；失败则回退展示源码。
 *
 * 注意 `suppressErrorRendering: true`：mermaid 11 在 render 失败时默认会把一张
 * "Syntax error" 占位图注入到 `document.body`（id 为 `d<给定 id>` 的 div），且不会清理。
 * 由于 App Router 软导航不重置 body，这些孤儿节点会跨页累积、越攒越多。开启该选项后
 * render 失败只抛异常、不注入占位图，交由下方 catch 走 <pre> 源码回退。
 */
export default function MermaidDiagram({ code }: { code: string }) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  return (
    <div className="group/diagram relative my-5 w-full">
      <MermaidSvg
        code={code}
        ariaLabel={t('wiki.diagram.ariaLabel')}
        onReadyChange={setReady}
        className="w-full overflow-x-auto"
      />
      {ready && (
        <IconButton
          ref={triggerRef}
          type="button"
          intent="outline"
          size="sm"
          onClick={() => setPreviewOpen(true)}
          aria-label={t('wiki.diagram.openPreview')}
          data-tip={t('wiki.diagram.openPreview')}
          className="tip tip-l !absolute right-1 -top-4 z-10 bg-surface/90 opacity-100 shadow-xs backdrop-blur-sm sm:opacity-0 sm:group-hover/diagram:opacity-100 sm:focus:opacity-100"
        >
          <Maximize2 aria-hidden />
        </IconButton>
      )}
      <MermaidPreview code={code} open={previewOpen} onClose={closePreview} />
    </div>
  );
}

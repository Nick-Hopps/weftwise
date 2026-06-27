'use client';

import React, { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

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
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true });
        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (failed) {
    return (
      <pre className="bg-prose-code-bg text-prose-code rounded-md p-4 overflow-x-auto my-4 text-sm font-mono">
        {code}
      </pre>
    );
  }

  return (
    <div
      ref={ref}
      data-mermaid-src={code}
      className={cn('mermaid-diagram my-4 flex justify-center overflow-x-auto')}
    />
  );
}

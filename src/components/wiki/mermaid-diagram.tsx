'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { createMermaidConfig } from './mermaid-theme';

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
  const reactId = useId();
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  // Mermaid 把颜色写进 SVG；主题变化时必须重新渲染，不能只依赖外层 CSS。
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDarkMode(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setReady(false);
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize(createMermaidConfig(darkMode));
        const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          const svgElement = ref.current.querySelector('svg');
          svgElement?.setAttribute('role', 'img');
          svgElement?.setAttribute('aria-label', 'Diagram');
          setReady(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [code, darkMode, reactId]);

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
      data-ready={ready ? 'true' : 'false'}
      aria-busy={!ready}
      className={cn('mermaid-diagram my-5 flex min-h-24 w-full justify-center overflow-x-auto py-2')}
    />
  );
}

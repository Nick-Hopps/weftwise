'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { createMermaidConfig } from './mermaid-theme';

interface MermaidSvgProps {
  code: string;
  ariaLabel: string;
  className?: string;
  naturalSize?: boolean;
  scale?: number;
  onReadyChange?: (ready: boolean) => void;
}

function viewBoxWidth(svg: SVGElement): number | null {
  const values = svg.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number);
  const width = values?.length === 4 ? values[2] : Number.NaN;
  return Number.isFinite(width) && width! > 0 ? width! : null;
}

export function MermaidSvg({
  code,
  ariaLabel,
  className,
  naturalSize = false,
  scale = 1,
  onReadyChange,
}: MermaidSvgProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const readyCallbackRef = useRef(onReadyChange);
  const naturalWidthRef = useRef<number | null>(null);
  const scaleRef = useRef(scale);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    readyCallbackRef.current = onReadyChange;
  }, [onReadyChange]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDarkMode(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!naturalSize || !ready || !ref.current) return;
    const svg = ref.current.querySelector('svg');
    const width = naturalWidthRef.current;
    if (!svg || width === null) return;
    svg.style.width = `${Math.round(width * scale)}px`;
  }, [naturalSize, ready, scale]);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setReady(false);
    readyCallbackRef.current?.(false);
    naturalWidthRef.current = null;
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
          svgElement?.setAttribute('aria-label', ariaLabel);
          if (svgElement && naturalSize) {
            naturalWidthRef.current = viewBoxWidth(svgElement);
            if (naturalWidthRef.current !== null) {
              svgElement.style.width = `${Math.round(naturalWidthRef.current * scaleRef.current)}px`;
            }
          }
          setReady(true);
          readyCallbackRef.current?.(true);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
          readyCallbackRef.current?.(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [ariaLabel, code, darkMode, naturalSize, reactId]);

  if (failed) {
    return (
      <pre className="my-4 overflow-x-auto rounded-md bg-prose-code-bg p-4 font-mono text-sm text-prose-code">
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
      className={cn('mermaid-diagram flex min-h-24 justify-center py-2', className)}
    />
  );
}

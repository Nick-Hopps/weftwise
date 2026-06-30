'use client';

import { useEffect, useState, type RefObject } from 'react';
import {
  normalizeSelectionText,
  truncateForContext,
  findNearestHeadingText,
  type HeadingScanNode,
} from '@/lib/selection-text';

export interface SelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface SelectionInfo {
  text: string;
  section: string | null;
  rect: SelectionRect;
}

/**
 * 追踪 `containerRef` 容器内的文本选区。
 * - 拖拽中不输出，松手（pointerup）后才计算；
 * - 选区折叠 / 落在容器外 / 滚动 / 改窗尺寸时输出 null。
 */
export function useTextSelection(
  containerRef: RefObject<HTMLElement | null>,
): SelectionInfo | null {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);

  useEffect(() => {
    const compute = () => {
      const sel = window.getSelection();
      const container = containerRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !container) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      // 选区必须完全落在正文容器内。
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const norm = normalizeSelectionText(sel.toString());
      if (!norm) {
        setSelection(null);
        return;
      }
      const domRect = range.getBoundingClientRect();
      if (domRect.width === 0 && domRect.height === 0) {
        setSelection(null);
        return;
      }
      const startNode = range.startContainer;
      const startEl =
        startNode.nodeType === Node.TEXT_NODE
          ? startNode.parentElement
          : (startNode as Element);
      const section = findNearestHeadingText(
        startEl as unknown as HeadingScanNode | null,
      );
      setSelection({
        text: truncateForContext(norm),
        section,
        rect: {
          top: domRect.top,
          left: domRect.left,
          width: domRect.width,
          height: domRect.height,
        },
      });
    };

    // 松手后选区已定型，延一帧再算，避免读到中间态。
    const onPointerUp = () => window.setTimeout(compute, 0);
    // 选区被折叠（点击空白）立即收起按钮。
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    // 滚动 / resize 后 rect 失效，直接收起。
    const onInvalidate = () => setSelection(null);

    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('scroll', onInvalidate, true);
    window.addEventListener('resize', onInvalidate);
    return () => {
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', onInvalidate, true);
      window.removeEventListener('resize', onInvalidate);
    };
  }, [containerRef]);

  return selection;
}

/** 选中文本作为对话上下文时的字符上限，防超长选区撑爆请求体。 */
export const MAX_SELECTION_CONTEXT_CHARS = 4000;

/**
 * 最近标题扫描所需的最小 DOM 结构子集。
 * 运行时传入真实 `Element`，测试时传入手搓假节点——两者结构兼容。
 */
export interface HeadingScanNode {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly previousElementSibling: HeadingScanNode | null;
  readonly parentElement: HeadingScanNode | null;
}

/** 从 Range 端点向上查找 Markdown 顶层块所需的最小 DOM 子集。 */
export interface SelectionBlockScanNode {
  readonly parentElement: SelectionBlockScanNode | null;
  getAttribute(name: string): string | null;
}

export interface SelectionBlockRange {
  blockStart: number;
  blockEnd: number;
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4']);

/** trim 选区文本；空或纯空白返回 null（调用方据此不弹按钮）。 */
export function normalizeSelectionText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 截断到上限；超出则截断并补省略号。 */
export function truncateForContext(text: string, max = MAX_SELECTION_CONTEXT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 由选中文本派生稳定 id（同文本同 id → 引用列表去重）。djb2 哈希。 */
export function selectionRefId(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `sel-${(hash >>> 0).toString(36)}`;
}

/** 从选区起点元素向上找最近的 h1~h4 标题文本；找不到返回 null。 */
export function findNearestHeadingText(start: HeadingScanNode | null): string | null {
  let node = start;
  while (node) {
    let sib: HeadingScanNode | null = node;
    while (sib) {
      if (HEADING_TAGS.has(sib.tagName)) {
        const t = sib.textContent?.trim();
        return t && t.length > 0 ? t : null;
      }
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

function blockOffsets(start: SelectionBlockScanNode | null): SelectionBlockRange | null {
  let node = start;
  while (node) {
    const startRaw = node.getAttribute('data-md-block-start');
    const endRaw = node.getAttribute('data-md-block-end');
    if (startRaw !== null && endRaw !== null) {
      const blockStart = Number(startRaw);
      const blockEnd = Number(endRaw);
      if (
        Number.isSafeInteger(blockStart)
        && Number.isSafeInteger(blockEnd)
        && blockStart >= 0
        && blockEnd > blockStart
      ) {
        return { blockStart, blockEnd };
      }
      return null;
    }
    node = node.parentElement;
  }
  return null;
}

/** 合并 Range 首尾所属顶层块；缺少可信属性或倒置时拒绝生成写入锚点。 */
export function findSelectionBlockRange(
  start: SelectionBlockScanNode | null,
  end: SelectionBlockScanNode | null,
): SelectionBlockRange | null {
  const first = blockOffsets(start);
  const last = blockOffsets(end);
  if (!first || !last || first.blockStart > last.blockStart || first.blockEnd > last.blockEnd) {
    return null;
  }
  return { blockStart: first.blockStart, blockEnd: last.blockEnd };
}

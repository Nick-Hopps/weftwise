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

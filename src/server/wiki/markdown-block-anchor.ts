import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Root } from 'mdast';
import type { SelectionAnchorInput } from '@/lib/contracts';

const CONTEXT_CHARS = 160;

export interface PersistedMarkdownBlockAnchor {
  start: number;
  end: number;
  markdown: string;
  prefix: string;
  suffix: string;
  quote: string;
  section: string | null;
}

interface BlockRange {
  start: number;
  end: number;
}

function topLevelBlocks(body: string): BlockRange[] {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(body) as Root;
  return tree.children.flatMap((node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start === undefined || end === undefined || end <= start ? [] : [{ start, end }];
  });
}

function isCompleteBlockRange(blocks: readonly BlockRange[], start: number, end: number): boolean {
  const startIndex = blocks.findIndex((block) => block.start === start);
  const endIndex = blocks.findIndex((block) => block.end === end);
  return startIndex >= 0 && endIndex >= startIndex;
}

export function createMarkdownBlockAnchor(
  body: string,
  input: SelectionAnchorInput,
): PersistedMarkdownBlockAnchor {
  if (input.sourceKind !== 'canonical') {
    throw new Error('Switch to Original before inserting an illustration.');
  }
  const quote = input.quote.trim();
  if (!quote) throw new Error('Selection quote is required.');
  if (
    !Number.isSafeInteger(input.blockStart)
    || !Number.isSafeInteger(input.blockEnd)
    || input.blockStart < 0
    || input.blockEnd > body.length
    || input.blockEnd <= input.blockStart
    || !isCompleteBlockRange(topLevelBlocks(body), input.blockStart, input.blockEnd)
  ) {
    throw new Error('Selection must align to a complete Markdown block boundary.');
  }
  return {
    start: input.blockStart,
    end: input.blockEnd,
    markdown: body.slice(input.blockStart, input.blockEnd),
    prefix: body.slice(Math.max(0, input.blockStart - CONTEXT_CHARS), input.blockStart),
    suffix: body.slice(input.blockEnd, input.blockEnd + CONTEXT_CHARS),
    quote,
    section: input.section?.trim() || null,
  };
}

function contextMatches(body: string, candidate: BlockRange, anchor: PersistedMarkdownBlockAnchor): boolean {
  const prefix = body.slice(Math.max(0, candidate.start - anchor.prefix.length), candidate.start);
  const suffix = body.slice(candidate.end, candidate.end + anchor.suffix.length);
  return prefix === anchor.prefix && suffix === anchor.suffix;
}

export function resolveMarkdownBlockAnchor(
  body: string,
  anchor: PersistedMarkdownBlockAnchor,
): BlockRange {
  const blocks = topLevelBlocks(body);
  if (
    body.slice(anchor.start, anchor.end) === anchor.markdown
    && isCompleteBlockRange(blocks, anchor.start, anchor.end)
  ) {
    return { start: anchor.start, end: anchor.end };
  }

  const candidates: BlockRange[] = [];
  let from = 0;
  while (from <= body.length - anchor.markdown.length) {
    const start = body.indexOf(anchor.markdown, from);
    if (start < 0) break;
    const end = start + anchor.markdown.length;
    if (isCompleteBlockRange(blocks, start, end)) candidates.push({ start, end });
    from = start + 1;
  }
  if (candidates.length === 1) return candidates[0];
  const contextual = candidates.filter((candidate) => contextMatches(body, candidate, anchor));
  if (contextual.length === 1) return contextual[0];
  throw new Error('Selected Markdown block can no longer be resolved to one unique location.');
}

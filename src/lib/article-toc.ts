import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import type { Heading, Node, Parent, Root } from 'mdast';
import type { Plugin } from 'unified';
import { SUBJECT_SLUG_RE } from '@/lib/slug';

export interface ArticleTocHeading {
  id: string;
  text: string;
  depth: 2 | 3 | 4;
}

interface HeadingData {
  hProperties?: Record<string, unknown>;
}

const WIKILINK_RE = /\[\[([^\[\]]+?)\]\]/g;

function isParent(node: Node): node is Parent {
  return 'children' in node && Array.isArray((node as Parent).children);
}

function visibleWikiLinkText(inner: string): string {
  const pipeIndex = inner.indexOf('|');
  if (pipeIndex >= 0) return inner.slice(pipeIndex + 1).trim();

  let body = inner;
  const colonIndex = inner.indexOf(':');
  if (colonIndex > 0 && SUBJECT_SLUG_RE.test(inner.slice(0, colonIndex).trim())) {
    body = inner.slice(colonIndex + 1);
  }
  const hashIndex = body.indexOf('#');
  return (hashIndex >= 0 ? body.slice(0, hashIndex) : body).trim();
}

function visibleText(node: Node): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if (node.type === 'image' && 'alt' in node) {
    return typeof node.alt === 'string' ? node.alt : '';
  }
  if (node.type === 'break') return ' ';
  if (!isParent(node)) return '';
  return node.children.map(visibleText).join('');
}

function headingText(heading: Heading): string {
  return visibleText(heading)
    .replace(WIKILINK_RE, (_match, inner: string) => visibleWikiLinkText(inner))
    .replace(/\s+/g, ' ')
    .trim();
}

function headingId(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

export function annotateArticleHeadings(tree: Root): ArticleTocHeading[] {
  const counts = new Map<string, number>();
  const headings: ArticleTocHeading[] = [];

  for (const node of tree.children) {
    if (node.type !== 'heading' || node.depth < 2 || node.depth > 4) continue;

    const text = headingText(node) || 'Section';
    const baseId = headingId(text);
    const count = (counts.get(baseId) ?? 0) + 1;
    counts.set(baseId, count);
    const id = count === 1 ? baseId : `${baseId}-${count}`;
    const data = (node.data ?? {}) as HeadingData;
    const depth = node.depth as ArticleTocHeading['depth'];
    node.data = {
      ...node.data,
      hProperties: { ...data.hProperties, id },
    };
    headings.push({ id, text, depth });
  }

  return headings;
}

export const remarkArticleHeadings: Plugin<[], Root> = () => (tree: Root) => {
  annotateArticleHeadings(tree);
};

export function extractArticleToc(markdown: string): ArticleTocHeading[] {
  const tree = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).parse(markdown) as Root;
  return annotateArticleHeadings(tree);
}

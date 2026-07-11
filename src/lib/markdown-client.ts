'use client';

import React, { createElement } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import remarkMath from 'remark-math';
import rehypeReact from 'rehype-react';
import rehypeKatex from 'rehype-katex';
import * as prod from 'react/jsx-runtime';
import type { Root as MdastRoot, Text as MdastText, Node as MdastNode, Parent as MdastParent } from 'mdast';
import type { Code as MdastCode } from 'mdast';
import type { Plugin } from 'unified';
import WikiLinkComponent from '@/components/wiki/wiki-link';
import MermaidDiagram from '@/components/wiki/mermaid-diagram';

// ---------------------------------------------------------------------------
// Types for custom wikiLink AST node
// ---------------------------------------------------------------------------

interface WikiLinkNode {
  type: 'wikiLink';
  target: string;
  targetSubjectSlug: string | null;
  alias: string | null;
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
    hChildren?: Array<{ type: string; value: string }>;
  };
}

import { normalizeSlug, SUBJECT_SLUG_RE } from '@/lib/slug';

// ---------------------------------------------------------------------------
// remarkWikiLinks plugin
// ---------------------------------------------------------------------------
// Scans all Text nodes and replaces `[[...]]` spans with WikiLinkNode nodes.
//
// Mirror of src/server/wiki/wikilinks.ts. Recognises:
//   [[Page]]                        — same subject as the page being rendered
//   [[Page|Alias]]                  — same subject, with display alias
//   [[Page#Section]]                — same subject, with section anchor
//   [[other-subject:Page]]          — cross-subject link
//   [[other-subject:Page|Alias]]    — cross-subject with alias
// The `subject:` prefix only activates when the prefix matches a kebab-case
// slug; otherwise the entire token is treated as a page title.

const WIKILINK_RE = /\[\[([^\[\]]+?)\]\]/g;

type SlugResolver = (title: string) => string | undefined;

interface ParsedWikiLinkInner {
  targetSubjectSlug: string | null;
  pagePart: string;
  rawTitle: string;
  alias: string | null;
}

function parseWikiLinkInner(inner: string): ParsedWikiLinkInner {
  const pipeIdx = inner.indexOf('|');
  const beforeAlias = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
  const aliasRaw =
    pipeIdx === -1 ? null : inner.slice(pipeIdx + 1).trim() || null;

  let targetSubjectSlug: string | null = null;
  let body = beforeAlias;
  const colonIdx = beforeAlias.indexOf(':');
  if (colonIdx > 0) {
    const candidate = beforeAlias.slice(0, colonIdx).trim();
    if (SUBJECT_SLUG_RE.test(candidate)) {
      targetSubjectSlug = candidate;
      body = beforeAlias.slice(colonIdx + 1);
    }
  }

  const hashIdx = body.indexOf('#');
  const pagePart = hashIdx === -1 ? body : body.slice(0, hashIdx);
  const rawTitle = pagePart.trim();

  return { targetSubjectSlug, pagePart, rawTitle, alias: aliasRaw };
}

function buildWikiLinkHref(target: string, subjectSlug: string | null): string {
  return subjectSlug
    ? `/wiki/${target}?s=${subjectSlug}`
    : `/wiki/${target}`;
}

/**
 * Create a remarkWikiLinks plugin that optionally resolves page titles
 * to slugs via a provided resolver function.
 */
function createRemarkWikiLinks(resolver?: SlugResolver): Plugin<[], MdastRoot> {
  return function () {
    return function transformer(tree: MdastRoot) {
      visitMdast(tree, resolver);
    };
  };
}

function visitMdast(node: MdastNode, resolver?: SlugResolver): void {
  if (isParent(node)) {
    const nextChildren: MdastNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text') {
        const textNode = child as MdastText;
        const replacements = splitTextForWikiLinks(textNode.value, resolver);
        nextChildren.push(...replacements);
      } else {
        visitMdast(child, resolver);
        nextChildren.push(child);
      }
    }
    (node as MdastParent).children = nextChildren as MdastParent['children'];
  }
}

function isParent(node: MdastNode): node is MdastParent {
  return 'children' in node && Array.isArray((node as MdastParent).children);
}

/**
 * Split a plain text string into an array of MdastText and WikiLinkNode nodes.
 */
function splitTextForWikiLinks(text: string, resolver?: SlugResolver): MdastNode[] {
  const result: MdastNode[] = [];
  let lastIndex = 0;
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = WIKILINK_RE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) {
      result.push({ type: 'text', value: before } as MdastText);
    }

    const inner = match[1];
    const { targetSubjectSlug, pagePart, rawTitle, alias } =
      parseWikiLinkInner(inner);
    const target = resolver?.(rawTitle) ?? normalizeSlug(rawTitle);

    if (target) {
      const href = buildWikiLinkHref(target, targetSubjectSlug);
      const hProperties: Record<string, string> = {
        href,
        'data-wiki-link': target,
      };
      if (targetSubjectSlug) {
        hProperties['data-wiki-subject'] = targetSubjectSlug;
      }

      const wikiLinkNode: WikiLinkNode = {
        type: 'wikiLink',
        target,
        targetSubjectSlug,
        alias,
        data: {
          hName: 'a',
          hProperties,
          hChildren: [
            {
              type: 'text',
              value: alias ?? (pagePart.trim() || target),
            },
          ],
        },
      };
      result.push(wikiLinkNode as unknown as MdastNode);
    }

    lastIndex = match.index + match[0].length;
  }

  const tail = text.slice(lastIndex);
  if (tail) {
    result.push({ type: 'text', value: tail } as MdastText);
  }

  return result;
}

// ---------------------------------------------------------------------------
// remarkCallouts plugin
// ---------------------------------------------------------------------------
// 把首段首行匹配 `[!type]` 的 blockquote 重标为 <div data-callout=type>，
// 并剥离 `[!type]` 标记（保留紧随其后的 emoji/标题文字作为容器首行）。
// 仅改 hast 提示（hName/hProperties），不改 mdast 结构，故 wikilink/math 子节点照常处理。

const CALLOUT_RE = /^\[!([\w-]+)\]\s*/;

function createRemarkCallouts(): Plugin<[], MdastRoot> {
  return function () {
    return function transformer(tree: MdastRoot) {
      visitCallouts(tree);
    };
  };
}

function visitCallouts(node: MdastNode): void {
  if (!isParent(node)) return;
  for (const child of node.children) {
    if (child.type === 'blockquote') {
      tagCalloutBlockquote(child as MdastParent);
    }
    visitCallouts(child);
  }
}

function tagCalloutBlockquote(bq: MdastParent): void {
  const firstPara = bq.children[0];
  if (!firstPara || firstPara.type !== 'paragraph' || !isParent(firstPara)) return;
  const firstText = firstPara.children[0];
  if (!firstText || firstText.type !== 'text') return;
  const value = (firstText as MdastText).value;
  const m = CALLOUT_RE.exec(value);
  if (!m) return;

  const type = m[1].toLowerCase();
  (firstText as MdastText).value = value.slice(m[0].length);
  const node = bq as MdastNode & { data?: Record<string, unknown> };
  node.data = {
    ...node.data,
    hName: 'div',
    hProperties: {
      className: ['callout', `callout-${type}`],
      'data-callout': type,
    },
  };
}

// ---------------------------------------------------------------------------
// remarkMermaid plugin
// ---------------------------------------------------------------------------
// 把 lang==='mermaid' 的 code 节点重标为自定义元素 <mermaiddiagram code="...">，
// 由 rehype-react 映射到 MermaidDiagram 组件（client 端 useEffect 渲染 SVG）。

function createRemarkMermaid(): Plugin<[], MdastRoot> {
  return function () {
    return function transformer(tree: MdastRoot) {
      visitMermaid(tree);
    };
  };
}

function visitMermaid(node: MdastNode): void {
  if (!isParent(node)) return;
  for (const child of node.children) {
    if (child.type === 'code' && (child as MdastCode).lang === 'mermaid') {
      const codeNode = child as MdastNode & { data?: Record<string, unknown> };
      codeNode.data = {
        ...codeNode.data,
        hName: 'mermaiddiagram',
        hProperties: { code: (child as MdastCode).value },
        hChildren: [],
      };
    }
    visitMermaid(child);
  }
}

// ---------------------------------------------------------------------------
// Production JSX runtime options for rehype-react
// ---------------------------------------------------------------------------

const prodRuntime = prod as unknown as {
  jsx: (type: unknown, props: unknown, key?: string) => React.ReactElement;
  jsxs: (type: unknown, props: unknown, key?: string) => React.ReactElement;
  Fragment: unknown;
};

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

/**
 * Render a markdown string (potentially with Obsidian-style YAML frontmatter
 * and [[wikilinks]]) into a React element.
 *
 * This is a synchronous, client-side pipeline — no code highlighting (avoids
 * the async rehype-pretty-code) but handles all core markdown constructs plus
 * wikilinks correctly.
 */
export function renderMarkdown(
  content: string,
  titleSlugMap?: Record<string, string>,
  options?: { math?: boolean },
): React.ReactElement {
  const enableMath = options?.math ?? false;
  const resolver: SlugResolver | undefined = titleSlugMap
    ? (title: string) => titleSlugMap[title] ?? titleSlugMap[title.toLowerCase()]
    : undefined;

  // mdast 阶段：remark-math（可选）必须先于 wikilink 扫描，
  // 这样 $…$ 先被切成 math 节点，wikilink 扫描器（只处理 [[…]] 文本）碰不到公式内部。
  let remark = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm);
  if (enableMath) remark = remark.use(remarkMath);
  remark = remark.use(createRemarkCallouts()).use(createRemarkMermaid()).use(createRemarkWikiLinks(resolver));

  // 桥接到 hast 后进入 rehype 阶段：rehype-katex（可选）渲染 math 节点；
  // throwOnError:false 保证非法 LaTeX 不会让同步 processSync 抛错、整页崩溃。
  let rehype = remark.use(remarkRehype, { allowDangerousHtml: false });
  if (enableMath) rehype = rehype.use(rehypeKatex, { throwOnError: false });

  const file = rehype
    .use(rehypeReact, {
      Fragment: prodRuntime.Fragment,
      jsx: prodRuntime.jsx,
      jsxs: prodRuntime.jsxs,
      elementAttributeNameCase: 'react',
      stylePropertyNameCase: 'dom',
      components: {
        // Map anchor tags that carry data-wiki-link to the WikiLink component
        a: function WikiLinkAnchorRenderer(
          props: React.ComponentPropsWithoutRef<'a'>
        ) {
          const wikiSlug = props['data-wiki-link' as keyof typeof props] as
            | string
            | undefined;
          if (wikiSlug) {
            const wikiSubject =
              (props['data-wiki-subject' as keyof typeof props] as
                | string
                | undefined) ?? null;
            return createElement(
              WikiLinkComponent,
              {
                href: buildWikiLinkHref(wikiSlug, wikiSubject),
                slug: wikiSlug,
                subjectSlug: wikiSubject ?? undefined,
              },
              props.children,
            );
          }
          // Regular external / internal link
          return createElement('a', props);
        },
        mermaiddiagram: function MermaidRenderer(props: { code?: string }) {
          return createElement(MermaidDiagram, { code: props.code ?? '' });
        },
      },
    })
    .processSync(content);

  return file.result as React.ReactElement;
}

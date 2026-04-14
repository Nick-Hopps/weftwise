'use client';

import React, { createElement } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeReact from 'rehype-react';
import * as prod from 'react/jsx-runtime';
import type { Root as MdastRoot, Text as MdastText, Node as MdastNode, Parent as MdastParent } from 'mdast';
import type { Plugin } from 'unified';
import WikiLinkComponent from '@/components/wiki/wiki-link';

// ---------------------------------------------------------------------------
// Types for custom wikiLink AST node
// ---------------------------------------------------------------------------

interface WikiLinkNode {
  type: 'wikiLink';
  target: string;
  alias: string | null;
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
    hChildren?: Array<{ type: string; value: string }>;
  };
}

import { normalizeSlug } from '@/lib/slug';

// ---------------------------------------------------------------------------
// remarkWikiLinks plugin
// ---------------------------------------------------------------------------
// Scans all Text nodes and replaces `[[...]]` spans with WikiLinkNode nodes.

const WIKILINK_RE = /\[\[([^\[\]]+?)\]\]/g;

type SlugResolver = (title: string) => string | undefined;

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
    const pipeIdx = inner.indexOf('|');
    const targetPart = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
    const aliasPart = pipeIdx === -1 ? null : inner.slice(pipeIdx + 1).trim() || null;

    // Strip section anchor
    const hashIdx = targetPart.indexOf('#');
    const pagePart = hashIdx === -1 ? targetPart : targetPart.slice(0, hashIdx);
    const rawTitle = pagePart.trim();
    const target = resolver?.(rawTitle) ?? normalizeSlug(rawTitle);

    if (target) {
      const wikiLinkNode: WikiLinkNode = {
        type: 'wikiLink',
        target,
        alias: aliasPart,
        data: {
          hName: 'a',
          hProperties: {
            href: `/wiki/${target}`,
            'data-wiki-link': target,
          },
          hChildren: [
            {
              type: 'text',
              value: aliasPart ?? (pagePart.trim() || target),
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
): React.ReactElement {
  const resolver: SlugResolver | undefined = titleSlugMap
    ? (title: string) => titleSlugMap[title] ?? titleSlugMap[title.toLowerCase()]
    : undefined;

  const file = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(createRemarkWikiLinks(resolver))
    .use(remarkRehype, { allowDangerousHtml: false })
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
            return createElement(WikiLinkComponent, {
              href: `/wiki/${wikiSlug}`,
              slug: wikiSlug,
              children: props.children,
            });
          }
          // Regular external / internal link
          return createElement('a', props);
        },
      },
    })
    .processSync(content);

  return file.result as React.ReactElement;
}

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
import type { Code as MdastCode, Blockquote as MdastBlockquote } from 'mdast';
import type { Plugin } from 'unified';
import WikiLinkComponent from '@/components/wiki/wiki-link';
import MermaidDiagram from '@/components/wiki/mermaid-diagram';
import { CalloutIcon } from '@/components/wiki/callout-icon';
import { QuizBlock, type QuizInteractiveContext } from '@/components/wiki/quiz-block';
import { remarkArticleHeadings } from '@/lib/article-toc';

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
import { fnv1a } from '@/lib/stable-hash';

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
// 并剥离 `[!type]` 标记及旧版标题开头的已知 emoji。
// 仅改 hast 提示（hName/hProperties），不改 mdast 结构，故 wikilink/math 子节点照常处理。

const CALLOUT_RE = /^\[!([\w-]+)\]\s*/;
const LEGACY_CALLOUT_ICON_RE = /^(?:\u{1F4A1}|\u{1F4DD}|\u{2753}|\u{1F517}|\u{26A0}\u{FE0F}?|\u{1F4CA}|\u{1F4C8}|\u{1F4C9}|\u{1F9E9}|\u{1F9E0})\s*/u;

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
  (firstText as MdastText).value = value.slice(m[0].length).replace(LEGACY_CALLOUT_ICON_RE, '');
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
// remarkSelectionBlocks plugin
// ---------------------------------------------------------------------------

type MdastNodeWithData = MdastNode & {
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

/** 把顶层 mdast block 的 UTF-16 offset 透传到 DOM，供 Range 形成可信块级锚点。 */
function createRemarkSelectionBlocks(): Plugin<[], MdastRoot> {
  return function () {
    return function transformer(tree: MdastRoot) {
      for (const child of tree.children) {
        if (child.type === 'yaml') continue;
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined || end <= start) continue;
        const node = child as MdastNodeWithData;
        node.data = {
          ...node.data,
          hProperties: {
            ...(node.data?.hProperties ?? {}),
            'data-md-block-start': String(start),
            'data-md-block-end': String(end),
          },
        };
      }
    };
  };
}

// ---------------------------------------------------------------------------
// remarkQuiz plugin
// ---------------------------------------------------------------------------
// 把 `[!quiz]` callout 按**第一个** thematicBreak 切成问题段 / 答案段，答案段包进
// `data-quiz-answer` 容器（渲染时折叠，不剧透），并给 callout 打上 `data-quiz-id`。
//
// 为什么用 `---` 而不是 `<details>`：`allowDangerousHtml: false`，raw HTML 根本不渲染。
// 为什么用 `---` 而不是「答案：」：thematicBreak 是**语言无关**的，不会随 wikiLanguage 漂移。
//
// 顺序约束：必须排在 `createRemarkCallouts()`（复用它打好的 `data-callout` 标记，不重复
// 解析 `[!type]`）**和** `createRemarkSelectionBlocks()` 之后。后者依赖解析期的
// `node.position` 计算 offset，而本插件会插入没有 position 的包装节点——它只重构
// blockquote **内部**、不影响顶层块 offset，但排最后是零成本的保险。

function createRemarkQuiz(): Plugin<[], MdastRoot> {
  return function () {
    return function transformer(tree: MdastRoot) {
      visitQuizzes(tree);
    };
  };
}

function visitQuizzes(node: MdastNode): void {
  if (!isParent(node)) return;
  for (const child of node.children) {
    if (isQuizCallout(child)) splitQuizCallout(child as MdastParent & MdastNodeWithData);
    visitQuizzes(child);
  }
}

function isQuizCallout(node: MdastNode): boolean {
  const data = (node as MdastNodeWithData).data;
  return data?.hProperties?.['data-callout'] === 'quiz';
}

function splitQuizCallout(bq: MdastParent & MdastNodeWithData): void {
  const breakIndex = bq.children.findIndex((c) => c.type === 'thematicBreak');

  // 无分隔符 = 存量页形态：不切分，但仍然给它 quiz 身份（自评交互照样需要）。
  const question = breakIndex === -1 ? bq.children : bq.children.slice(0, breakIndex);
  const answer = breakIndex === -1 ? [] : bq.children.slice(breakIndex + 1);

  // hash 只取**问题段**：证据是关于「这道题」的，enricher 重跑时润色答案措辞
  // 不应该让「他答对过」这件事失效。
  bq.data = {
    ...bq.data,
    hProperties: {
      ...(bq.data?.hProperties ?? {}),
      'data-quiz-id': fnv1a(collectPlainText(question)),
    },
  };

  if (answer.length === 0) return;

  // 包装节点借用 blockquote 的形状（可容纳块级子节点），由 hName 改渲染成 div。
  const wrapper: MdastBlockquote & MdastNodeWithData = {
    type: 'blockquote',
    children: answer as MdastBlockquote['children'],
    data: { hName: 'div', hProperties: { 'data-quiz-answer': '' } },
  };

  bq.children = [...question, wrapper];
}

/**
 * 收集子树里的可见文本，**剔除全部空白**——enricher 重跑时换行位置常有变化，
 * 而重排版不该让「他答对过」这件事失效。不能只折叠空白：CJK 的软换行不含空格，
 * 折叠成单空格反而会让重排版前后的哈希不同。
 */
function collectPlainText(nodes: readonly MdastNode[]): string {
  const parts: string[] = [];
  const walk = (node: MdastNode): void => {
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
      parts.push((node as MdastText).value);
      return;
    }
    if (isParent(node)) node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return parts.join('').replace(/\s+/g, '');
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

export interface RenderOptions {
  math?: boolean;
  headingAnchors?: boolean;
  selectionBlocks?: boolean;
  /**
   * 正文交互块的能力上下文。**只有 Wiki 阅读页会传**——`renderMarkdown` 另外五个
   * 消费方（Chat / 编辑器预览 / Source 查看器 / URL 阅读模式 / Sources 分栏）
   * 要么没有页面身份，要么语境是编辑，都不该发证据（决策 9）。
   *
   * 不传时 quiz 照样切分、答案照样折叠，只是没有判分按钮——不是运行时判空，
   * 是 `<QuizBlock>` 根本拿不到 `pageSlug`。
   */
  interactive?: QuizInteractiveContext;
}

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
  options?: RenderOptions,
): React.ReactElement {
  const interactive = options?.interactive;
  const enableMath = options?.math ?? false;
  const resolver: SlugResolver | undefined = titleSlugMap
    ? (title: string) => titleSlugMap[title] ?? titleSlugMap[title.toLowerCase()]
    : undefined;

  // mdast 阶段：remark-math（可选）必须先于 wikilink 扫描，
  // 这样 $…$ 先被切成 math 节点，wikilink 扫描器（只处理 [[…]] 文本）碰不到公式内部。
  let remark = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm);
  if (enableMath) remark = remark.use(remarkMath);
  if (options?.headingAnchors) remark = remark.use(remarkArticleHeadings);
  remark = remark.use(createRemarkCallouts()).use(createRemarkMermaid()).use(createRemarkWikiLinks(resolver));
  if (options?.selectionBlocks) remark = remark.use(createRemarkSelectionBlocks());
  // 必须排在 selectionBlocks 之后：本插件会插入没有 position 的包装节点（决策 6）。
  remark = remark.use(createRemarkQuiz());

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
            // E3：只有「被明确告知不必重讲」的概念才挂纠错入口。
            //
            // **必须同时比对 subject**：本覆盖同时处理 `[[slug]]` 与
            // `[[other-subject:slug]]`，而 assumedKnown 里只装当前 subject 的裸 slug。
            // 只比 slug 的话，指向别的 subject 同名页的链接会挂上入口——点下去把负证据
            // 写到当前 subject 那一页，归错了页。跨主题同名 slug 在本项目合法且常见。
            const sameSubject = wikiSubject === null || wikiSubject === interactive?.subjectSlug;
            const assumedKnown =
              sameSubject && (interactive?.assumedKnown?.includes(wikiSlug) ?? false);
            return createElement(
              WikiLinkComponent,
              {
                href: buildWikiLinkHref(wikiSlug, wikiSubject),
                slug: wikiSlug,
                subjectSlug: wikiSubject ?? undefined,
                assumedKnown,
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
        div: function CalloutRenderer(props: React.ComponentPropsWithoutRef<'div'>) {
          const calloutType = props['data-callout' as keyof typeof props];
          if (typeof calloutType !== 'string') return createElement('div', props);
          const quizId = props['data-quiz-id' as keyof typeof props];
          if (calloutType === 'quiz' && typeof quizId === 'string') {
            // 能力只从这里流入：`interactive` 是 renderMarkdown 的入参，
            // QuizBlock 自己既不知道也无从推断当前是阅读页还是编辑器预览。
            return createElement(QuizBlock, { ...props, quizId, interactive }, props.children);
          }
          return createElement(
            'div',
            props,
            createElement(CalloutIcon, { type: calloutType }),
            props.children,
          );
        },
      },
    })
    .processSync(content);

  return file.result as React.ReactElement;
}

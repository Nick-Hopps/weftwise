'use client';

import { useMemo, type ReactNode } from 'react';
import FrontmatterDisplay from './frontmatter-display';
import { renderMarkdown } from '@/lib/markdown-client';

interface PageRendererProps {
  content: string;
  /** Kept in props for compatibility with call-sites; unused in read-only mode. */
  rawContent?: string;
  /** Kept in props for call-site compatibility; the re-enrich button that consumed it was removed — do not re-add a usage here. */
  slug: string;
  title?: string;
  tags?: string[];
  sources?: string[];
  created?: string;
  updated?: string;
  titleSlugMap?: Record<string, string>;
  /** 标题行右侧动作条节点（透传给 FrontmatterDisplay）。 */
  actions?: ReactNode;
  /** 渲染在 FrontmatterDisplay 之后、正文之前（复用 article 的 reading 宽度）。 */
  headerExtra?: ReactNode;
  subjectSlug?: string;
  /**
   * 保留以兼容调用方；正文统一用 `max-w-reading` 宽测度，分栏时由窄栏自然收窄，
   * 不再额外收紧 measure。
   */
  narrow?: boolean;
}

// 默认变量保持 16px / 28px；用户调字号时用相对行高维持同一阅读节奏。
const proseClassName = `
  font-prose text-[length:var(--wiki-body-font-size)] leading-[1.75] text-prose-body
  [&>h1:first-child]:hidden
  [&>h1]:mb-5 [&>h1]:mt-12 [&>h1]:font-display [&>h1]:text-[28px] [&>h1]:font-semibold [&>h1]:leading-9 [&>h1]:tracking-normal [&>h1]:text-prose-heading
  [&>h2]:mb-3 [&>h2]:mt-10 [&>h2]:text-[22px] [&>h2]:font-semibold [&>h2]:leading-8 [&>h2]:tracking-normal [&>h2]:text-prose-heading
  [&>h3]:mb-2.5 [&>h3]:mt-8 [&>h3]:text-[18px] [&>h3]:font-semibold [&>h3]:leading-7 [&>h3]:text-prose-heading
  [&>h4]:mb-2 [&>h4]:mt-6 [&>h4]:text-[16px] [&>h4]:font-semibold [&>h4]:text-prose-heading
  [&>p]:mb-5
  [&>ul]:mb-5 [&>ul]:list-disc [&>ul]:space-y-2 [&>ul]:pl-6
  [&>ol]:mb-5 [&>ol]:list-decimal [&>ol]:space-y-2 [&>ol]:pl-6
  [&>blockquote]:my-6 [&>blockquote]:border-l-2 [&>blockquote]:border-prose-quote [&>blockquote]:py-0.5 [&>blockquote]:pl-5 [&>blockquote]:text-prose-muted
  [&_.callout]:my-6 [&_.callout]:rounded-md [&_.callout]:border-l-[3px] [&_.callout]:bg-subtle/70 [&_.callout]:py-3.5 [&_.callout]:pl-5 [&_.callout]:pr-4
  [&_.callout>p]:mb-2 [&_.callout>p:last-child]:mb-0 [&_.callout>ul]:mb-2 [&_.callout>ul]:pl-5 [&_.callout>ul]:list-disc
  [&_.callout-intuition]:border-amber-400 [&_.callout-example]:border-sky-400 [&_.callout-quiz]:border-[rgb(var(--brand-warp))]
  [&_.callout-background]:border-slate-400 [&_.callout-diagram]:border-teal-400 [&_.callout-pitfall]:border-rose-400
  [&>pre]:my-6 [&>pre]:overflow-x-auto [&>pre]:rounded-md [&>pre]:bg-prose-code-bg [&>pre]:p-5 [&>pre]:font-mono [&>pre]:text-sm [&>pre]:leading-6 [&>pre]:text-prose-code
  [&_code]:bg-prose-code-bg [&_code]:text-prose-code [&_code]:rounded-sm [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.875em] [&_code]:font-mono
  [&>pre_code]:bg-transparent [&>pre_code]:p-0
  [&>hr]:my-10 [&>hr]:border-border-subtle
  [&>table]:my-6 [&>table]:block [&>table]:w-full [&>table]:overflow-x-auto [&>table]:border-collapse [&>table]:text-sm
  [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-subtle
  [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2
  [&_img]:mx-auto [&_img]:my-8 [&_img]:h-auto [&_img]:w-auto [&_img]:max-h-[min(32rem,70vh)] [&_img]:max-w-full [&_img]:rounded-md [&_img]:object-contain
  [&_strong]:font-semibold [&_strong]:text-prose-heading
  [&_em]:italic
  [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden
  [&_a]:text-link [&_a]:transition-colors [&_a]:duration-fast [&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-4 [&_a]:decoration-link/40 [&_a]:hover:text-link-hover [&_a]:hover:decoration-link-hover
`;

export default function PageRenderer({
  content,
  slug,
  title,
  tags = [],
  sources = [],
  created = '',
  updated = '',
  titleSlugMap,
  actions,
  headerExtra,
  subjectSlug,
}: PageRendererProps) {
  const rendered = useMemo(
    () => renderMarkdown(content, titleSlugMap, {
      math: true,
      headingAnchors: true,
      selectionBlocks: true,
    }),
    [content, titleSlugMap],
  );

  return (
    <article className="wp-rise mx-auto w-full min-w-0 max-w-[var(--reading-max-width)] px-5 py-8 sm:px-8 sm:py-12">
      {title && (
        <FrontmatterDisplay
          title={title}
          tags={tags}
          sources={sources}
          created={created}
          updated={updated}
          actions={actions}
          subjectSlug={subjectSlug}
        />
      )}
      {headerExtra}
      <div className={`${proseClassName} [&>h2]:scroll-mt-20 [&>h3]:scroll-mt-20 [&>h4]:scroll-mt-20`}>
        {rendered}
      </div>
    </article>
  );
}

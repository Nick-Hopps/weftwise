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

// Typography scale tuned for reading flow. Uses semantic `prose-*` color
// tokens and the `text-md` scale step (15px / 24px) registered in Tailwind
// config so one place controls sizing.
const proseClassName = `
  font-sans text-md text-prose-body
  [&>h1]:text-2xl [&>h1]:font-semibold [&>h1]:text-prose-heading [&>h1]:tracking-tight [&>h1]:mt-10 [&>h1]:mb-4 [&>h1]:leading-tight
  [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:text-prose-heading [&>h2]:mt-8 [&>h2]:mb-3 [&>h2]:leading-snug
  [&>h3]:text-lg [&>h3]:font-semibold [&>h3]:text-prose-heading [&>h3]:mt-6 [&>h3]:mb-2
  [&>h4]:text-md [&>h4]:font-semibold [&>h4]:text-prose-heading [&>h4]:mt-5 [&>h4]:mb-1.5
  [&>p]:mb-4
  [&>ul]:mb-4 [&>ul]:pl-6 [&>ul]:list-disc [&>ul]:space-y-1.5
  [&>ol]:mb-4 [&>ol]:pl-6 [&>ol]:list-decimal [&>ol]:space-y-1.5
  [&>blockquote]:border-l-2 [&>blockquote]:border-prose-quote [&>blockquote]:pl-4 [&>blockquote]:py-0.5 [&>blockquote]:my-4 [&>blockquote]:text-prose-muted
  [&_.callout]:my-4 [&_.callout]:rounded-md [&_.callout]:border-l-4 [&_.callout]:pl-4 [&_.callout]:pr-3 [&_.callout]:py-2.5 [&_.callout]:bg-subtle
  [&_.callout>p]:mb-2 [&_.callout>p:last-child]:mb-0 [&_.callout>ul]:mb-2 [&_.callout>ul]:pl-5 [&_.callout>ul]:list-disc
  [&_.callout-intuition]:border-amber-400 [&_.callout-example]:border-sky-400 [&_.callout-quiz]:border-violet-400
  [&_.callout-background]:border-slate-400 [&_.callout-diagram]:border-teal-400 [&_.callout-pitfall]:border-rose-400
  [&>pre]:bg-prose-code-bg [&>pre]:text-prose-code [&>pre]:rounded-md [&>pre]:p-4 [&>pre]:overflow-x-auto [&>pre]:my-4 [&>pre]:text-sm [&>pre]:font-mono
  [&_code]:bg-prose-code-bg [&_code]:text-prose-code [&_code]:rounded-sm [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.875em] [&_code]:font-mono
  [&>pre_code]:bg-transparent [&>pre_code]:p-0
  [&>hr]:my-8 [&>hr]:border-border
  [&>table]:w-full [&>table]:border-collapse [&>table]:my-4 [&>table]:text-sm
  [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-subtle
  [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2
  [&>img]:rounded-md [&>img]:my-6 [&>img]:max-w-full [&>img]:border [&>img]:border-border
  [&_strong]:font-semibold [&_strong]:text-prose-heading
  [&_em]:italic
  [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden
  [&_a]:text-accent [&_a]:transition-colors [&_a]:duration-fast [&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-4 [&_a]:decoration-accent/40 [&_a]:hover:decoration-accent
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
  const rendered = useMemo(() => renderMarkdown(content, titleSlugMap, { math: true }), [content, titleSlugMap]);

  return (
    <article className="wp-rise mx-auto px-6 py-10 max-w-[var(--reading-max-width)]">
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
      <div className={proseClassName}>{rendered}</div>
    </article>
  );
}

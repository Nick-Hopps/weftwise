'use client';

import PageRenderer from './page-renderer';

interface EditorPreviewProps {
  source: string;
  titleSlugMap?: Record<string, string>;
  slug: string;
}

/**
 * 编辑器预览面板：复用阅读页 PageRenderer 渲染正文，确保 wikilink / callout /
 * mermaid / 数学公式 / 排版与阅读页逐项一致。
 * 不传 title → PageRenderer 跳过 FrontmatterDisplay（仅正文一致）；
 * renderMarkdown 的 remarkFrontmatter 会自动剥离 `---` frontmatter 块。
 */
export function EditorPreview({ source, titleSlugMap, slug }: EditorPreviewProps) {
  return <PageRenderer content={source} slug={slug} titleSlugMap={titleSlugMap} />;
}

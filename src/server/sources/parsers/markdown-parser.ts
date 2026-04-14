import matter from 'gray-matter';
import type { ParsedSource } from '../parser-registry';

export function parseMarkdown(filename: string, content: string): ParsedSource {
  const parsed = matter(content);
  const body = parsed.content.trim();
  const frontmatterData = parsed.data as Record<string, unknown>;

  // Extract title from frontmatter or first heading
  let title = '';
  if (typeof frontmatterData.title === 'string') {
    title = frontmatterData.title;
  } else {
    const headingMatch = body.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      title = headingMatch[1].trim();
    } else {
      title = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    }
  }

  return {
    title,
    cleanText: body,
    metadata: frontmatterData,
  };
}

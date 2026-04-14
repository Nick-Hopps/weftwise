import TurndownService from 'turndown';
import type { ParsedSource } from '../parser-registry';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

export function parseHtml(filename: string, content: string): ParsedSource {
  // Extract title from <title> tag
  let title = '';
  const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // Fall back to first <h1>
  if (!title) {
    const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) {
      title = h1Match[1].trim();
    }
  }

  // Fall back to filename
  if (!title) {
    title = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  }

  const cleanText = turndown.turndown(content);

  return {
    title,
    cleanText,
    metadata: {},
  };
}

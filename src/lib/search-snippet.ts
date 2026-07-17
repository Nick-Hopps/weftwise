export interface SearchSnippetSegment {
  text: string;
  highlighted: boolean;
}

const OPEN_MARK = '<mark>';
const CLOSE_MARK = '</mark>';

/** 将 SQLite FTS 受控标记拆为 React 可安全渲染的纯文本段。 */
export function parseSearchSnippet(snippet: string): SearchSnippetSegment[] {
  if (!snippet) return [];

  const segments: SearchSnippetSegment[] = [];
  let cursor = 0;

  while (cursor < snippet.length) {
    const openIndex = snippet.indexOf(OPEN_MARK, cursor);
    if (openIndex === -1) {
      segments.push({ text: snippet.slice(cursor), highlighted: false });
      break;
    }

    const contentStart = openIndex + OPEN_MARK.length;
    const closeIndex = snippet.indexOf(CLOSE_MARK, contentStart);
    if (closeIndex === -1) {
      segments.push({ text: snippet.slice(cursor), highlighted: false });
      break;
    }

    if (openIndex > cursor) {
      segments.push({ text: snippet.slice(cursor, openIndex), highlighted: false });
    }
    if (closeIndex > contentStart) {
      segments.push({
        text: snippet.slice(contentStart, closeIndex),
        highlighted: true,
      });
    }

    cursor = closeIndex + CLOSE_MARK.length;
  }

  return segments;
}

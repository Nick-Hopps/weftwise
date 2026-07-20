import TurndownService from 'turndown';
import type { ParsedSource } from '../parser-registry';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.remove(['script', 'style', 'noscript', 'template']);

const HTML_ENTITY_RE = /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;

function decodeHtmlEntities(value: string): string {
  return value.replace(HTML_ENTITY_RE, (entity, body: string) => {
    const normalized = body.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized === 'nbsp') return ' ';
    const radix = normalized.startsWith('#x') ? 16 : 10;
    const digits = normalized.replace(/^#x?/, '');
    const codePoint = Number.parseInt(digits, radix);
    return Number.isFinite(codePoint)
      && codePoint > 0
      && codePoint <= 0x10ffff
      && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function normalizeHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTagAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributeRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of tag.matchAll(attributeRe)) {
    const name = match[1]!.toLowerCase();
    if (name === '<meta') continue;
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function readMetaContent(content: string, keys: string[]): string | undefined {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const tags = content.match(/<meta\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi) ?? [];
  for (const tag of tags) {
    const attributes = parseTagAttributes(tag);
    const key = (attributes.name ?? attributes.property ?? '').toLowerCase();
    if (!wanted.has(key) || !attributes.content) continue;
    const value = normalizeHtmlText(attributes.content);
    if (value) return value;
  }
  return undefined;
}

export function parseHtml(filename: string, content: string): ParsedSource {
  const titleMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let webTitle = titleMatch ? normalizeHtmlText(titleMatch[1]) : '';

  if (!webTitle) {
    webTitle = readMetaContent(content, ['og:title', 'twitter:title']) ?? '';
  }

  // Fall back to first <h1>
  if (!webTitle) {
    const h1Match = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
      webTitle = normalizeHtmlText(h1Match[1]);
    }
  }

  // Fall back to filename
  const title = webTitle || filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const description = readMetaContent(content, [
    'description',
    'og:description',
    'twitter:description',
  ]);

  const cleanText = turndown.turndown(content);

  return {
    title,
    cleanText,
    metadata: {
      ...(webTitle ? { webTitle } : {}),
      ...(description ? { description } : {}),
    },
  };
}

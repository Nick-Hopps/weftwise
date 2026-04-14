import path from 'path';
import { parseMarkdown } from './parsers/markdown-parser';
import { parseHtml } from './parsers/html-parser';
import { parsePdfBuffer } from './parsers/pdf-parser';

export interface ParsedSource {
  title: string;
  cleanText: string;
  metadata: Record<string, unknown>;
}

/**
 * Parse a source file by extension. Synchronous for text-based formats.
 * For PDF, use `parseSourceAsync` instead.
 */
export function parseSource(filename: string, content: string): ParsedSource {
  const ext = path.extname(filename).toLowerCase();

  switch (ext) {
    case '.md':
    case '.mdx':
      return parseMarkdown(filename, content);
    case '.html':
    case '.htm':
      return parseHtml(filename, content);
    case '.txt':
    default: {
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      const title = lines[0] ?? filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      return { title, cleanText: content, metadata: {} };
    }
  }
}

/**
 * Async source parser that handles both text and binary formats.
 * PDF files must be passed as a Buffer; text formats use the string content.
 */
export async function parseSourceAsync(
  filename: string,
  content: string,
  buffer?: Buffer | null,
): Promise<ParsedSource> {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
    if (!buffer) {
      throw new Error(`PDF parsing requires a Buffer. No buffer provided for: ${filename}`);
    }
    return parsePdfBuffer(buffer);
  }

  return parseSource(filename, content);
}

/**
 * Returns true if the file extension requires binary (Buffer) parsing.
 */
export function requiresBuffer(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.pdf';
}

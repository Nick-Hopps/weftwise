import pdfParse from 'pdf-parse';
import type { ParsedSource } from '../parser-registry';

export interface PdfMetadata extends Record<string, unknown> {
  numPages: number;
  info: Record<string, unknown>;
}

export async function parsePdfBuffer(buffer: Buffer): Promise<ParsedSource> {
  const data = await pdfParse(buffer);

  const info = (data.info ?? {}) as Record<string, unknown>;
  const numPages: number = data.numpages ?? 0;

  // Extract title from PDF info.Title or first non-empty line of text
  let title = '';
  if (typeof info.Title === 'string' && info.Title.trim()) {
    title = info.Title.trim();
  } else {
    const firstLine = data.text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    title = firstLine ?? 'Untitled';
  }

  const metadata: PdfMetadata = {
    numPages,
    info,
  };

  return {
    title,
    cleanText: data.text,
    metadata,
  };
}

/**
 * Synchronous-compatible shim for the parser-registry interface.
 * PDFs require async processing — callers that need full results should
 * use `parsePdfBuffer` directly with the raw file Buffer.
 *
 * This function returns a placeholder so the registry can still register a
 * parser without breaking the synchronous interface contract.
 */
export function parsePdf(_filename: string, content: string): ParsedSource {
  // content here is assumed to be already-extracted text (fallback path)
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const title = lines[0] ?? 'Untitled PDF';
  return {
    title,
    cleanText: content,
    metadata: {},
  };
}

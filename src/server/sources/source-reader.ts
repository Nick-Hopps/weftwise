import path from 'path';
import * as sourcesRepo from '../db/repos/sources-repo';
import { getSourceMetadata, getRawSourceContent } from './source-store';
import { analyzeHtmlSafety } from './html-safety';
import { readUrlSourceReference } from './url-source';
import type { PageSourceDoc, PageSourceFormat, Subject } from '@/lib/contracts';

/** Per-source content caps — sources can be whole books, so we never ship the
 *  full text to the client; we send enough to "trace a claim to its origin". */
const TEXT_CAP = 120_000;

interface SidecarChunk {
  id?: string;
  heading?: string;
  text?: string;
}

interface SourceSidecar {
  savedAt?: string;
  chunks?: SidecarChunk[];
}

function formatFor(filename: string): PageSourceFormat {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'text';
}

const FORMAT_LABEL: Record<PageSourceFormat, string> = {
  pdf: 'PDF',
  markdown: 'Markdown',
  html: 'HTML',
  text: 'Text',
};

/**
 * Assemble the source documents a page was written from, ready for the split
 * reading view. Pulls parsed text from the metadata sidecar (`chunks`) and the
 * original file from `vault/raw/`, capping content for large sources.
 */
export function readPageSources(
  subject: Pick<Subject, 'id' | 'slug'>,
  pageSlug: string,
): PageSourceDoc[] {
  const sources = sourcesRepo.getSourcesForPage(subject.id, pageSlug);
  const docs: PageSourceDoc[] = [];

  for (const src of sources) {
    const urlReference = readUrlSourceReference(src);
    const format = urlReference ? 'html' : formatFor(src.filename);
    const sidecar = (getSourceMetadata(src.id) as SourceSidecar | null) ?? {};
    const added = (sidecar.savedAt ?? src.parsedAt ?? '').slice(0, 10);

    const base = { id: src.id, name: src.filename, format, added } as PageSourceDoc;

    if (urlReference) {
      docs.push({
        ...base,
        meta: 'Web',
        sourceUrl: urlReference.originUrl,
      });
      continue;
    }

    // pdf 在客户端由浏览器原生阅读器加载，只下发元数据。
    if (format === 'pdf') {
      docs.push({ ...base, meta: FORMAT_LABEL[format] });
      continue;
    }

    // html：读原文做启发式危险扫描，只下发 verdict（仍不下发 HTML 正文 payload，
    // iframe 通过 /api/sources/<id>/raw 自行加载完整文件）。
    if (format === 'html') {
      const html = getRawSourceContent(subject.slug, src.filename) ?? '';
      docs.push({ ...base, meta: FORMAT_LABEL[format], htmlSafety: analyzeHtmlSafety(html) });
      continue;
    }

    // markdown / text —— 优先用原始文件，回退到解析后的 chunks。
    const chunks = Array.isArray(sidecar.chunks) ? sidecar.chunks : [];
    const raw = getRawSourceContent(subject.slug, src.filename);
    const full = raw ?? chunks.map((c) => c.text ?? '').join('\n\n');
    const truncated = full.length > TEXT_CAP;
    const content = truncated ? full.slice(0, TEXT_CAP) : full;
    docs.push({ ...base, meta: FORMAT_LABEL[format], text: content, truncated });
  }

  return docs;
}

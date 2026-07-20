import type { Source } from '@/lib/contracts';
import { parseSourceAsync, requiresBuffer } from './parser-registry';
import { getRawSourceBuffer, getRawSourceContent } from './source-store';
import { fetchUrlSource, type UrlFetchCredentials } from './url-fetcher';
import { readUrlSourceReference } from './url-source';

export interface SourceLoaderDependencies {
  fetchUrlSource?: typeof fetchUrlSource;
  getRawSourceContent?: typeof getRawSourceContent;
  getRawSourceBuffer?: typeof getRawSourceBuffer;
  credentials?: UrlFetchCredentials;
}

export interface LoadedSourceForIngest {
  kind: 'raw' | 'url';
  cleanText: string;
  title?: string;
  description?: string;
}

/** worker 的唯一 Source 正文入口：URL 现场抓取，普通文件继续从 vault/raw 读取。 */
export async function loadSourceForIngest(
  source: Source,
  subjectSlug: string,
  dependencies: SourceLoaderDependencies = {},
): Promise<LoadedSourceForIngest> {
  const urlReference = readUrlSourceReference(source);
  if (urlReference) {
    const fetchSource = dependencies.fetchUrlSource ?? fetchUrlSource;
    const fetched = dependencies.credentials
      ? await fetchSource(urlReference.originUrl, { credentials: dependencies.credentials })
      : await fetchSource(urlReference.originUrl);
    const parsed = await parseSourceAsync(fetched.filename, fetched.content);
    return {
      kind: 'url',
      cleanText: parsed.cleanText,
      title: typeof parsed.metadata.webTitle === 'string' ? parsed.metadata.webTitle : undefined,
      description: typeof parsed.metadata.description === 'string'
        ? parsed.metadata.description
        : undefined,
    };
  }

  const readContent = dependencies.getRawSourceContent ?? getRawSourceContent;
  const readBuffer = dependencies.getRawSourceBuffer ?? getRawSourceBuffer;
  let textContent = '';
  let bufferContent: Buffer | null = null;
  if (requiresBuffer(source.filename)) {
    bufferContent = readBuffer(subjectSlug, source.filename);
    if (!bufferContent) throw new Error(`Source file not found: ${source.filename}`);
  } else {
    const raw = readContent(subjectSlug, source.filename);
    if (!raw) throw new Error(`Source file not found: ${source.filename}`);
    textContent = raw;
  }
  const parsed = await parseSourceAsync(source.filename, textContent, bufferContent);
  return { kind: 'raw', cleanText: parsed.cleanText };
}

import { createHash } from 'node:crypto';
import type { Source } from '@/lib/contracts';
import { deriveUrlFilename } from './url-fetcher';
import { validateHttpUrl } from './url-safety';

export const URL_SOURCE_KIND = 'url' as const;

export interface UrlSourceIdentity {
  originUrl: string;
  filename: string;
  contentHash: string;
}

export interface UrlSourceReference {
  originUrl: string;
  title?: string;
  description?: string;
}

export const URL_SOURCE_TITLE_MAX_LENGTH = 300;
export const URL_SOURCE_DESCRIPTION_MAX_LENGTH = 1000;

export interface UrlSourcePresentation {
  title?: string;
  description?: string;
}

function normalizePresentationText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function normalizeUrlSourcePresentation(
  presentation: { title?: unknown; description?: unknown },
): UrlSourcePresentation {
  return {
    title: normalizePresentationText(presentation.title, URL_SOURCE_TITLE_MAX_LENGTH),
    description: normalizePresentationText(
      presentation.description,
      URL_SOURCE_DESCRIPTION_MAX_LENGTH,
    ),
  };
}

export function urlSourceDisplayTitle(reference: UrlSourceReference): string {
  if (reference.title) return reference.title;
  const hostname = new URL(reference.originUrl).hostname.replace(/^www\./i, '');
  return hostname || reference.originUrl;
}

/** URL Source 以规范化链接而非远程正文作为稳定身份。 */
export function createUrlSourceIdentity(rawUrl: string): UrlSourceIdentity {
  const originUrl = validateHttpUrl(rawUrl.trim()).toString();
  return {
    originUrl,
    filename: deriveUrlFilename(originUrl, '.html'),
    contentHash: createHash('sha256')
      .update(`url\0${originUrl}`)
      .digest('hex')
      .slice(0, 16),
  };
}

/**
 * 从 SQLite metadata 识别 URL Source。兼容上线前已保存 originUrl、但没有 kind 的记录；
 * 非法/私网 URL fail-closed，避免 archive import 注入浏览器内网预览地址。
 */
export function readUrlSourceReference(
  source: Pick<Source, 'metadataJson'>,
): UrlSourceReference | null {
  let metadata: unknown;
  try {
    metadata = JSON.parse(source.metadataJson);
  } catch {
    return null;
  }
  if (!isRecord(metadata) || typeof metadata.originUrl !== 'string') return null;
  if (metadata.kind !== undefined && metadata.kind !== URL_SOURCE_KIND) return null;
  try {
    return {
      originUrl: validateHttpUrl(metadata.originUrl).toString(),
      ...normalizeUrlSourcePresentation({
        title: metadata.title,
        description: metadata.description,
      }),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

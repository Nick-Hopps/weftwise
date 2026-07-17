/**
 * Subject 归档（导出/导入）纯内核：manifest 契约与 zip entry 路径安全校验。
 * 零 IO——文件系统与 zip 编解码在 subject-archive.ts。
 */

import { SUBJECT_SLUG_RE } from '@/lib/slug';
import type { Subject } from '@/lib/contracts';

export const SUBJECT_ARCHIVE_FORMAT_VERSION = 1;

/** 归档内的白名单目录（subject 相对布局，与原 slug 解耦） */
export const ARCHIVE_DIRS = ['wiki', 'raw', 'assets', 'sources'] as const;
export type ArchiveDir = (typeof ARCHIVE_DIRS)[number];

export const MANIFEST_FILENAME = 'manifest.json';

export class ArchiveError extends Error {
  constructor(
    public code:
      | 'invalid-manifest'
      | 'unsupported-version'
      | 'invalid-entry'
      | 'invalid-archive',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface SubjectArchiveManifest {
  formatVersion: number;
  exportedAt: string;
  subject: {
    slug: string;
    name: string;
    description: string;
    augmentationLevel: Subject['augmentationLevel'];
  };
}

export function buildManifest(subject: Subject, exportedAt: string): SubjectArchiveManifest {
  return {
    formatVersion: SUBJECT_ARCHIVE_FORMAT_VERSION,
    exportedAt,
    subject: {
      slug: subject.slug,
      name: subject.name,
      description: subject.description,
      augmentationLevel: subject.augmentationLevel,
    },
  };
}

export function parseManifest(json: string): SubjectArchiveManifest {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ArchiveError('invalid-manifest', 'manifest.json is not valid JSON');
  }
  if (typeof data !== 'object' || data === null) {
    throw new ArchiveError('invalid-manifest', 'manifest.json must be an object');
  }
  const manifest = data as Partial<SubjectArchiveManifest>;
  if (manifest.formatVersion !== SUBJECT_ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveError(
      'unsupported-version',
      `Unsupported archive formatVersion ${String(manifest.formatVersion)} (expected ${SUBJECT_ARCHIVE_FORMAT_VERSION})`,
    );
  }
  const subject = manifest.subject;
  if (
    !subject
    || typeof subject.slug !== 'string'
    || typeof subject.name !== 'string'
    || subject.name.trim() === ''
  ) {
    throw new ArchiveError('invalid-manifest', 'manifest.subject requires slug and name');
  }
  if (!SUBJECT_SLUG_RE.test(subject.slug)) {
    throw new ArchiveError('invalid-manifest', `manifest.subject.slug "${subject.slug}" is not a valid slug`);
  }
  return {
    formatVersion: SUBJECT_ARCHIVE_FORMAT_VERSION,
    exportedAt: typeof manifest.exportedAt === 'string' ? manifest.exportedAt : '',
    subject: {
      slug: subject.slug,
      name: subject.name,
      description: typeof subject.description === 'string' ? subject.description : '',
      augmentationLevel: subject.augmentationLevel ?? 'standard',
    },
  };
}

/**
 * 校验 zip entry 名并返回归一化的安全相对路径；不合法返回 null。
 * 只允许 `manifest.json` 与白名单目录下的文件；拒绝 `..`、绝对路径与空段。
 */
export function validateEntryPath(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized === MANIFEST_FILENAME) return normalized;
  if (normalized === '' || normalized.startsWith('/') || normalized.endsWith('/')) return null;
  const segments = normalized.split('/');
  if (segments.length < 2) return null;
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (!(ARCHIVE_DIRS as readonly string[]).includes(segments[0])) return null;
  return normalized;
}

/**
 * 把归档内路径映射为目标 subject 的 vault 相对路径。
 * `sources/` 映射到 `.llm-wiki/sources/<slug>/`，其余目录插入 slug 段。
 * manifest.json 或未知目录返回 null。
 */
export function mapEntryToVaultRelPath(entryName: string, slug: string): string | null {
  const safe = validateEntryPath(entryName);
  if (safe === null || safe === MANIFEST_FILENAME) return null;
  const idx = safe.indexOf('/');
  const dir = safe.slice(0, idx) as ArchiveDir;
  const rest = safe.slice(idx + 1);
  if (dir === 'sources') return `.llm-wiki/sources/${slug}/${rest}`;
  return `${dir}/${slug}/${rest}`;
}

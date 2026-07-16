/**
 * File-system operations for the wiki vault.
 * Reads and writes markdown pages, raw source files, and arbitrary vault files.
 *
 * Subject-aware vault layout:
 *   vault/wiki/<subject-slug>/<page-slug>.md
 *   vault/raw/<subject-slug>/<filename>
 *   vault/.llm-wiki/sources/<subject-slug>/<source-id>.json
 */

import fs from 'fs';
import path from 'path';
import { vaultPath } from '../config/env';
import { parseWikiDocument } from './markdown';
import type { WikiDocument, TitleResolver } from './markdown';
import {
  buildWikiPath,
  parseWikiPath,
  slugFromWikiPath,
} from './page-identity';
import type { ExtractWikiLinksOptions } from './wikilinks';

export type ReadPageOptions = ExtractWikiLinksOptions;

interface ScannedPage {
  /** Subject slug derived from the parent directory under `vault/wiki/`. */
  subjectSlug: string;
  /** Slug within the subject (post-`<subject>/` prefix, no `.md`). */
  slug: string;
  /** Vault-relative path, e.g. `wiki/general/foo.md`. */
  relativePath: string;
  /** Absolute filesystem path. */
  path: string;
  /** Raw file content. */
  content: string;
}

/**
 * Read a wiki page located at `vault/wiki/<subjectSlug>/<slug>.md`.
 *
 * Accepts either a `TitleResolver` (legacy) or a `ReadPageOptions` object
 * (preferred — carries `currentSubjectSlug` so wikilinks can be parsed
 * correctly).
 */
export function readPageInSubject(
  subjectSlug: string,
  slug: string,
  options?: TitleResolver | ReadPageOptions,
): WikiDocument | null {
  const filePath = vaultPath('wiki', subjectSlug, `${slug}.md`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');

  if (typeof options === 'function') {
    return parseWikiDocument(raw, { currentSubjectSlug: subjectSlug, titleResolver: options });
  }
  return parseWikiDocument(raw, {
    currentSubjectSlug: subjectSlug,
    ...(options ?? {}),
  });
}

/**
 * Legacy: read a page using a flat slug that already encodes the subject prefix.
 *
 * `slug = "general/foo"` → `vault/wiki/general/foo.md`
 * `slug = "foo"`         → `vault/wiki/foo.md` (pre-subjects layout)
 *
 * Prefer `readPageInSubject(subjectSlug, slug, options)` for new code.
 */
export function readPageBySlug(
  slug: string,
  titleResolver?: TitleResolver,
): WikiDocument | null {
  const filePath = vaultPath('wiki', `${slug}.md`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');

  const parts = parseWikiPath(`wiki/${slug}.md`);
  const currentSubjectSlug = parts?.subjectSlug ?? '';
  return parseWikiDocument(raw, { currentSubjectSlug, titleResolver });
}

/**
 * Recursively scan `vault/wiki/` for all `.md` files.
 *
 * Without arguments: scans every subject directory.
 * With `subjectSlug`: limits the scan to `vault/wiki/<subjectSlug>/`.
 */
export function scanWikiPages(subjectSlug?: string): ScannedPage[] {
  const wikiDir = subjectSlug
    ? vaultPath('wiki', subjectSlug)
    : vaultPath('wiki');
  if (!fs.existsSync(wikiDir)) {
    return [];
  }

  const results: ScannedPage[] = [];
  const wikiRoot = vaultPath('wiki');

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const relativePath = path
          .relative(vaultPath(), fullPath)
          .replace(/\\/g, '/');
        const parts = parseWikiPath(relativePath);
        if (!parts) continue;
        if (subjectSlug && parts.subjectSlug !== subjectSlug) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        results.push({
          subjectSlug: parts.subjectSlug,
          slug: parts.slug,
          relativePath,
          path: fullPath,
          content,
        });
      }
    }
  }

  walk(wikiDir);

  // Surface wiki/<subject>/... shape only — the wikiRoot constant is exported
  // via `relativePath` in each result for callers that need the legacy form.
  void wikiRoot;
  return results;
}

/**
 * Legacy: derive the flat-slug form (`<subject>/<slug>` or just `<slug>`) from
 * a scanned page entry. Convenience for callers that haven't migrated to the
 * subject-aware shape yet.
 */
export function legacyScanSlug(entry: ScannedPage): string {
  return slugFromWikiPath(entry.relativePath);
}

/**
 * Write a batch of files to the vault.
 * Each entry's `path` is relative to the vault root (e.g. `"wiki/general/my-page.md"`).
 * Parent directories are created automatically.
 */
export function writeVaultFiles(entries: { path: string; content: string; contentEncoding?: 'utf8' | 'base64' }[]): void {
  for (const entry of entries) {
    const fullPath = vaultPath(entry.path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (entry.contentEncoding === 'base64') {
      fs.writeFileSync(fullPath, Buffer.from(entry.content, 'base64'));
    } else {
      fs.writeFileSync(fullPath, entry.content, 'utf-8');
    }
  }
}

/**
 * Read a raw source file from `vault/raw/<subjectSlug>/<filename>`.
 * Falls back to legacy `vault/raw/<filename>` if no subject-scoped file exists.
 * Returns `null` when neither path exists.
 */
export function readRawSource(
  subjectSlug: string,
  filename: string,
): string | null {
  const subjectScoped = vaultPath('raw', subjectSlug, filename);
  if (fs.existsSync(subjectScoped)) {
    return fs.readFileSync(subjectScoped, 'utf-8');
  }
  const legacy = vaultPath('raw', filename);
  if (fs.existsSync(legacy)) {
    return fs.readFileSync(legacy, 'utf-8');
  }
  return null;
}

/**
 * Delete a file from the vault.
 * `relativePath` is relative to the vault root (e.g. `"wiki/general/old-page.md"`).
 * Silently succeeds if the file does not exist.
 */
export function deleteVaultFile(relativePath: string): void {
  const fullPath = vaultPath(relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

/** Read a generated subject asset without allowing path traversal. */
export function readVaultAsset(
  subjectSlug: string,
  filename: string,
): { data: Buffer; contentType: string } | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(subjectSlug) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i.test(filename)) {
    return null;
  }
  const fullPath = vaultPath('assets', subjectSlug, filename);
  if (!fs.existsSync(fullPath)) return null;
  const ext = path.extname(filename).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { data: fs.readFileSync(fullPath), contentType };
}

export { buildWikiPath };

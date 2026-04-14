/**
 * File-system operations for the wiki vault.
 * Reads and writes markdown pages, raw source files, and arbitrary vault files.
 */

import fs from 'fs';
import path from 'path';
import { vaultPath } from '../config/env';
import { parseWikiDocument } from './markdown';
import type { WikiDocument, TitleResolver } from './markdown';
import { slugFromWikiPath } from './page-identity';

/**
 * Read a single wiki page by its slug.
 * Resolves to `vault/wiki/{slug}.md`.
 * Returns `null` when the file does not exist.
 */
export function readPageBySlug(slug: string, titleResolver?: TitleResolver): WikiDocument | null {
  const filePath = vaultPath('wiki', `${slug}.md`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseWikiDocument(raw, titleResolver);
}

/**
 * Recursively scan `vault/wiki/` for all `.md` files.
 * Returns an array of `{ slug, path, content }` objects where:
 * - `slug` is the relative wiki slug derived from the file path
 * - `path` is the absolute filesystem path
 * - `content` is the raw file content
 */
export function scanWikiPages(): { slug: string; path: string; content: string }[] {
  const wikiDir = vaultPath('wiki');
  if (!fs.existsSync(wikiDir)) {
    return [];
  }

  const results: { slug: string; path: string; content: string }[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Compute relative path from vault root, e.g. "wiki/some-page.md"
        const relativePath = path.relative(vaultPath(), fullPath).replace(/\\/g, '/');
        const slug = slugFromWikiPath(relativePath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        results.push({ slug, path: fullPath, content });
      }
    }
  }

  walk(wikiDir);
  return results;
}

/**
 * Write a batch of files to the vault.
 * Each entry's `path` is relative to the vault root (e.g. `"wiki/my-page.md"`).
 * Parent directories are created automatically.
 */
export function writeVaultFiles(entries: { path: string; content: string }[]): void {
  for (const entry of entries) {
    const fullPath = vaultPath(entry.path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, entry.content, 'utf-8');
  }
}

/**
 * Read a raw source file from `vault/raw/{filename}`.
 * Returns the raw string content, or `null` when the file does not exist.
 */
export function readRawSource(filename: string): string | null {
  const filePath = vaultPath('raw', filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Delete a file from the vault.
 * `relativePath` is relative to the vault root (e.g. `"wiki/old-page.md"`).
 * Silently succeeds if the file does not exist.
 */
export function deleteVaultFile(relativePath: string): void {
  const fullPath = vaultPath(relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

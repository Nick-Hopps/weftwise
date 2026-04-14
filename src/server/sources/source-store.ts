import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { vaultPath } from '../config/env';
import * as sourcesRepo from '../db/repos/sources-repo';

export interface SavedSourceResult {
  id: string;
  contentHash: string;
}

interface SourceMetadataFile {
  id: string;
  filename: string;
  contentHash: string;
  savedAt: string;
}

/**
 * Persist a raw source file to vault/raw/<filename>, record its hash,
 * write a metadata JSON sidecar, and upsert the sources DB record.
 */
export function saveRawSource(
  filename: string,
  content: Buffer | string,
): SavedSourceResult {
  // 1. Write raw file to vault/raw/<filename>
  const rawDir = vaultPath('raw');
  fs.mkdirSync(rawDir, { recursive: true });

  // Sanitize filename to prevent path traversal (C1 fix)
  const safeFilename = path.basename(filename);
  if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
    throw new Error(`Invalid filename: ${filename}`);
  }
  const rawFilePath = path.join(rawDir, safeFilename);
  // Verify resolved path is still within rawDir
  const resolved = path.resolve(rawFilePath);
  if (!resolved.startsWith(path.resolve(rawDir))) {
    throw new Error(`Filename escapes raw directory: ${filename}`);
  }
  fs.writeFileSync(rawFilePath, content);

  // 2. Compute SHA-256 hash (first 16 hex chars)
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const contentHash = createHash('sha256').update(buf).digest('hex').slice(0, 16);

  // 3. Check for existing source with same hash + filename (dedup)
  const existing = sourcesRepo.getSourceByHash(contentHash);
  if (existing && path.basename(existing.filename) === safeFilename) {
    // Reuse existing source record, just update the timestamp
    sourcesRepo.upsertSource({
      ...existing,
      parsedAt: null, // reset so it gets re-parsed
    });
    return { id: existing.id, contentHash };
  }

  // 4. Generate a new source ID
  const id = randomUUID();

  // 5. Write metadata JSON sidecar
  const metaDir = vaultPath('.llm-wiki', 'sources');
  fs.mkdirSync(metaDir, { recursive: true });
  const metaFilePath = path.join(metaDir, `${id}.json`);
  const metaContent: SourceMetadataFile = {
    id,
    filename: safeFilename, // store sanitized filename for consistency
    contentHash,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaFilePath, JSON.stringify(metaContent, null, 2), 'utf-8');

  // 6. Upsert sources table with sanitized filename
  sourcesRepo.upsertSource({
    id,
    filename: safeFilename,
    contentHash,
    parsedAt: null,
    metadataJson: JSON.stringify(metaContent),
  });

  return { id, contentHash };
}

/**
 * Read the metadata JSON for a source by ID.
 * Returns null if no sidecar file exists.
 */
export function getSourceMetadata(id: string): Record<string, unknown> | null {
  const metaFilePath = vaultPath('.llm-wiki', 'sources', `${id}.json`);
  try {
    const raw = fs.readFileSync(metaFilePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read the raw content of a source file by original filename as UTF-8 text.
 * Returns null if the file does not exist.
 */
export function getRawSourceContent(filename: string): string | null {
  const safeFilename = path.basename(filename);
  const rawFilePath = vaultPath('raw', safeFilename);
  const resolved = path.resolve(rawFilePath);
  if (!resolved.startsWith(path.resolve(vaultPath('raw')))) {
    return null;
  }
  try {
    return fs.readFileSync(rawFilePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read the raw content of a source file as a Buffer (for binary formats like PDF).
 * Returns null if the file does not exist.
 */
export function getRawSourceBuffer(filename: string): Buffer | null {
  const safeFilename = path.basename(filename);
  const rawFilePath = vaultPath('raw', safeFilename);
  const resolved = path.resolve(rawFilePath);
  if (!resolved.startsWith(path.resolve(vaultPath('raw')))) {
    return null;
  }
  try {
    return fs.readFileSync(rawFilePath);
  } catch {
    return null;
  }
}

/**
 * Update source metadata sidecar with page linkage info for rebuild.
 */
export function updateSourcePageLinks(sourceId: string, pageSlugs: string[]): void {
  const metaFilePath = vaultPath('.llm-wiki', 'sources', `${sourceId}.json`);
  try {
    const raw = fs.readFileSync(metaFilePath, 'utf-8');
    const meta = JSON.parse(raw) as Record<string, unknown>;
    meta.linkedPages = pageSlugs;
    fs.writeFileSync(metaFilePath, JSON.stringify(meta, null, 2), 'utf-8');
  } catch {
    // If sidecar doesn't exist, skip
  }
}

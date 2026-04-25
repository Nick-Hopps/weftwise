import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { vaultPath } from '../config/env';
import * as sourcesRepo from '../db/repos/sources-repo';
import type { Subject, SubjectId } from '@/lib/contracts';

export interface SavedSourceResult {
  id: string;
  contentHash: string;
}

interface SourceMetadataFile {
  id: string;
  subjectId: SubjectId;
  subjectSlug: string;
  filename: string;
  contentHash: string;
  savedAt: string;
}

function rawDirFor(subjectSlug: string): string {
  return vaultPath('raw', subjectSlug);
}

function sourcesMetaDirFor(subjectSlug: string): string {
  return vaultPath('.llm-wiki', 'sources', subjectSlug);
}

/**
 * Persist a raw source file to vault/raw/<subjectSlug>/<filename>, record its
 * hash, write a metadata JSON sidecar, and upsert the sources DB record.
 *
 * Source de-duplication is scoped by subject: the same content can exist
 * independently in two subjects.
 */
export function saveRawSource(
  subject: Pick<Subject, 'id' | 'slug'>,
  filename: string,
  content: Buffer | string
): SavedSourceResult {
  const rawDir = rawDirFor(subject.slug);
  fs.mkdirSync(rawDir, { recursive: true });

  const safeFilename = path.basename(filename);
  if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
    throw new Error(`Invalid filename: ${filename}`);
  }
  const rawFilePath = path.join(rawDir, safeFilename);
  const resolved = path.resolve(rawFilePath);
  if (!resolved.startsWith(path.resolve(rawDir))) {
    throw new Error(`Filename escapes raw directory: ${filename}`);
  }
  fs.writeFileSync(rawFilePath, content);

  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const contentHash = createHash('sha256').update(buf).digest('hex').slice(0, 16);

  const existing = sourcesRepo.getSourceByHash(subject.id, contentHash);
  if (existing && path.basename(existing.filename) === safeFilename) {
    sourcesRepo.upsertSource({
      ...existing,
      parsedAt: null,
    });
    return { id: existing.id, contentHash };
  }

  const id = randomUUID();
  const metaDir = sourcesMetaDirFor(subject.slug);
  fs.mkdirSync(metaDir, { recursive: true });
  const metaFilePath = path.join(metaDir, `${id}.json`);
  const metaContent: SourceMetadataFile = {
    id,
    subjectId: subject.id,
    subjectSlug: subject.slug,
    filename: safeFilename,
    contentHash,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaFilePath, JSON.stringify(metaContent, null, 2), 'utf-8');

  sourcesRepo.upsertSource({
    id,
    subjectId: subject.id,
    filename: safeFilename,
    contentHash,
    parsedAt: null,
    metadataJson: JSON.stringify(metaContent),
  });

  return { id, contentHash };
}

export function getSourceMetadata(id: string): Record<string, unknown> | null {
  // Sidecar lookup: walk subject subdirectories, fall back to legacy flat path.
  const metaRoot = vaultPath('.llm-wiki', 'sources');
  if (!fs.existsSync(metaRoot)) return null;

  for (const entry of fs.readdirSync(metaRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = path.join(metaRoot, entry.name, `${id}.json`);
      if (fs.existsSync(candidate)) {
        try {
          return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        } catch {
          return null;
        }
      }
    }
  }

  // Legacy flat layout
  const legacy = vaultPath('.llm-wiki', 'sources', `${id}.json`);
  if (fs.existsSync(legacy)) {
    try {
      return JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

export function getRawSourceContent(
  subjectSlug: string,
  filename: string
): string | null {
  const safeFilename = path.basename(filename);
  const rawDir = rawDirFor(subjectSlug);
  const candidate = path.join(rawDir, safeFilename);
  const resolved = path.resolve(candidate);
  if (resolved.startsWith(path.resolve(rawDir))) {
    try {
      return fs.readFileSync(candidate, 'utf-8');
    } catch {
      // fall through to legacy
    }
  }

  // Legacy flat layout: vault/raw/<filename>
  const legacy = vaultPath('raw', safeFilename);
  const legacyResolved = path.resolve(legacy);
  if (legacyResolved.startsWith(path.resolve(vaultPath('raw')))) {
    try {
      return fs.readFileSync(legacy, 'utf-8');
    } catch {
      return null;
    }
  }
  return null;
}

export function getRawSourceBuffer(
  subjectSlug: string,
  filename: string
): Buffer | null {
  const safeFilename = path.basename(filename);
  const rawDir = rawDirFor(subjectSlug);
  const candidate = path.join(rawDir, safeFilename);
  const resolved = path.resolve(candidate);
  if (resolved.startsWith(path.resolve(rawDir))) {
    try {
      return fs.readFileSync(candidate);
    } catch {
      // fall through to legacy
    }
  }

  const legacy = vaultPath('raw', safeFilename);
  const legacyResolved = path.resolve(legacy);
  if (legacyResolved.startsWith(path.resolve(vaultPath('raw')))) {
    try {
      return fs.readFileSync(legacy);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Update the metadata sidecar with the slugs of pages this source contributed
 * to. Best-effort — failures here do not block the saga.
 */
export function updateSourcePageLinks(sourceId: string, pageSlugs: string[]): void {
  const meta = getSourceMetadata(sourceId);
  if (!meta) return;
  const subjectSlug =
    typeof meta.subjectSlug === 'string' ? meta.subjectSlug : null;
  const candidatePath = subjectSlug
    ? path.join(sourcesMetaDirFor(subjectSlug), `${sourceId}.json`)
    : vaultPath('.llm-wiki', 'sources', `${sourceId}.json`);
  try {
    const updated = { ...meta, linkedPages: pageSlugs };
    fs.writeFileSync(candidatePath, JSON.stringify(updated, null, 2), 'utf-8');
  } catch {
    // best-effort
  }
}

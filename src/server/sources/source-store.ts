import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { vaultPath } from '../config/env';
import * as sourcesRepo from '../db/repos/sources-repo';
import type { Subject, SubjectId } from '@/lib/contracts';

export interface SavedSourceResult {
  id: string;
  contentHash: string;
  /** 本次调用是否创建了新的 canonical source 行。 */
  created: boolean;
}

interface SourceMetadataFile {
  id: string;
  subjectId: SubjectId;
  subjectSlug: string;
  filename: string;
  contentHash: string;
  savedAt: string;
  /** 网页来源的原始 URL（URL ingest 溯源用）。 */
  originUrl?: string;
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
  content: Buffer | string,
  extra?: { originUrl?: string },
): SavedSourceResult {
  const safeFilename = path.basename(filename);
  if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
    throw new Error(`Invalid filename: ${filename}`);
  }

  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const contentHash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const existing = sourcesRepo.getSourceByIdentity(subject.id, contentHash, safeFilename);

  const rawDir = rawDirFor(subject.slug);
  fs.mkdirSync(rawDir, { recursive: true });
  const rawFilePath = path.join(rawDir, safeFilename);
  const resolved = path.resolve(rawFilePath);
  if (!resolved.startsWith(path.resolve(rawDir))) {
    throw new Error(`Filename escapes raw directory: ${filename}`);
  }
  const rawExisted = fs.existsSync(rawFilePath);
  const previousRaw = rawExisted ? fs.readFileSync(rawFilePath) : null;
  let candidateMetaPath: string | null = null;
  let sourceResolved = false;
  let rawWriteAttempted = false;
  try {
    rawWriteAttempted = true;
    fs.writeFileSync(rawFilePath, content);
    if (existing) {
      sourcesRepo.upsertSource({
        ...existing,
        parsedAt: null,
      });
      return { id: existing.id, contentHash, created: false };
    }

    const id = randomUUID();
    const metaDir = sourcesMetaDirFor(subject.slug);
    fs.mkdirSync(metaDir, { recursive: true });
    candidateMetaPath = path.join(metaDir, `${id}.json`);
    const metaContent: SourceMetadataFile = {
      id,
      subjectId: subject.id,
      subjectSlug: subject.slug,
      filename: safeFilename,
      contentHash,
      savedAt: new Date().toISOString(),
      ...(extra?.originUrl ? { originUrl: extra.originUrl } : {}),
    };
    fs.writeFileSync(candidateMetaPath, JSON.stringify(metaContent, null, 2), 'utf-8');

    const candidate = {
      id,
      subjectId: subject.id,
      filename: safeFilename,
      contentHash,
      parsedAt: null,
      metadataJson: JSON.stringify(metaContent),
    };
    const winner = sourcesRepo.insertSourceOrGetWinner(candidate);
    sourceResolved = true;
    if (!winner.inserted) {
      // 相同 raw 路径内容一致；只清理 loser 自己 UUID 命名的 sidecar。
      try {
        fs.rmSync(candidateMetaPath, { force: true });
      } catch {
        sourcesRepo.recordSourceSidecarCleanup({
          loserId: id,
          winnerId: winner.source.id,
          subjectSlug: subject.slug,
          filename: safeFilename,
        });
      }
    }

    return {
      id: winner.source.id,
      contentHash,
      created: winner.inserted,
    };
  } catch (error) {
    // winner 已确定后 raw 属于 canonical source，不能再用并发前快照覆盖。
    if (sourceResolved) throw error;
    try {
      if (candidateMetaPath) fs.rmSync(candidateMetaPath, { force: true });
    } catch {
      // best-effort
    }
    if (rawWriteAttempted) restoreRawFile(rawFilePath, rawExisted, previousRaw);
    throw error;
  }
}

function restoreRawFile(
  rawFilePath: string,
  existed: boolean,
  previous: Buffer | null,
): void {
  try {
    if (existed && previous) fs.writeFileSync(rawFilePath, previous);
    else fs.rmSync(rawFilePath, { force: true });
  } catch {
    // best-effort：保留原始 DB 异常作为主错误。
  }
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
 * 把确定性切块结果写入 metadata sidecar（权威源，SQLite 仅缓存）。
 * Best-effort —— 失败不阻塞 ingest。
 */
export function updateSourceChunks(
  sourceId: string,
  chunks: Array<{ id: string; heading: string; text: string; tokenCount: number }>
): void {
  const meta = getSourceMetadata(sourceId);
  if (!meta) return;
  const subjectSlug =
    typeof meta.subjectSlug === 'string' ? meta.subjectSlug : null;
  const candidatePath = subjectSlug
    ? path.join(sourcesMetaDirFor(subjectSlug), `${sourceId}.json`)
    : vaultPath('.llm-wiki', 'sources', `${sourceId}.json`);
  try {
    const updated = { ...meta, chunks };
    fs.writeFileSync(candidatePath, JSON.stringify(updated, null, 2), 'utf-8');
  } catch {
    // best-effort
  }
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

/**
 * 删除 source 的落盘文件：subject-scoped raw 文件 + sidecar（含 legacy 平铺 sidecar）。
 * Best-effort：文件缺失/删除失败均静默。
 * 刻意**不删** legacy 平铺 raw（vault/raw/<filename>）——它按 filename 命名，
 * 可能与其他 subject 的同名 source 共享，删除有误伤风险；由 stale-source 检查兜底提示。
 */
export function deleteRawSourceFiles(
  subjectSlug: string,
  filename: string,
  sourceId: string,
): void {
  const safeFilename = path.basename(filename);
  const candidates = [
    path.join(rawDirFor(subjectSlug), safeFilename),
    path.join(sourcesMetaDirFor(subjectSlug), `${sourceId}.json`),
    vaultPath('.llm-wiki', 'sources', `${sourceId}.json`), // legacy 平铺 sidecar（UUID 命名，无歧义）
  ];
  for (const p of candidates) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // best-effort
    }
  }
}

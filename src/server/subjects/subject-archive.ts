/**
 * Subject 归档服务：导出 zip / 从 zip 导入为新 subject。
 *
 * 归档布局（subject 相对，便于导入换 slug）：
 *   manifest.json + wiki/** + raw/** + assets/** + sources/**（source 侧车）
 *
 * DB 中可再生数据（embeddings/对话/research/renditions 等）不进归档，
 * 与 rebuildDatabaseFromVault 的恢复口径一致。
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { vaultPath } from '../config/env';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as sourcesRepo from '../db/repos/sources-repo';
import { indexTouchedPages } from '../wiki/indexer';
import { scanWikiPages } from '../wiki/wiki-store';
import { commitVaultChanges } from '../git/git-service';
import { acquireVaultLock } from '../wiki/vault-mutex';
import type { Source, Subject } from '@/lib/contracts';
import {
  ArchiveError,
  MANIFEST_FILENAME,
  buildManifest,
  mapEntryToVaultRelPath,
  parseManifest,
  validateEntryPath,
  type ArchiveDir,
} from './subject-archive-core';

/** 归档目录 → 该 subject 的 vault 绝对目录 */
function subjectVaultDirs(slug: string): Record<ArchiveDir, string> {
  return {
    wiki: vaultPath('wiki', slug),
    raw: vaultPath('raw', slug),
    assets: vaultPath('assets', slug),
    sources: vaultPath('.llm-wiki', 'sources', slug),
  };
}

function addDirToZip(zip: AdmZip, absDir: string, archivePrefix: string): void {
  if (!fs.existsSync(absDir)) return;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    const rel = `${archivePrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      addDirToZip(zip, abs, rel);
    } else if (entry.isFile()) {
      zip.addFile(rel, fs.readFileSync(abs));
    }
  }
}

/** 导出 subject 为 zip Buffer（调用方负责持 vault 锁）。 */
export function exportSubjectArchive(subject: Subject): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    MANIFEST_FILENAME,
    Buffer.from(JSON.stringify(buildManifest(subject, new Date().toISOString()), null, 2)),
  );
  const dirs = subjectVaultDirs(subject.slug);
  for (const dir of Object.keys(dirs) as ArchiveDir[]) {
    addDirToZip(zip, dirs[dir], dir);
  }
  return zip.toBuffer();
}

export interface ImportStats {
  pages: number;
  sources: number;
  assets: number;
}

export interface ImportResult {
  subject: Subject;
  stats: ImportStats;
}

/** 从 `.llm-wiki/sources/<slug>/*.json` 侧车恢复 sources + page_sources（同 rebuild 口径）。 */
function restoreSourcesForSubject(subject: Subject): number {
  const dir = vaultPath('.llm-wiki', 'sources', subject.slug);
  if (!fs.existsSync(dir)) return 0;
  let restored = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as Source & {
        linkedPages?: string[];
      };
      sourcesRepo.upsertSource({
        id: data.id,
        subjectId: subject.id,
        filename: data.filename,
        contentHash: data.contentHash,
        parsedAt: data.parsedAt ?? null,
        metadataJson: data.metadataJson ?? JSON.stringify(data),
      });
      restored++;
      for (const pageSlug of data.linkedPages ?? []) {
        sourcesRepo.linkPageSource(subject.id, pageSlug, data.id);
      }
    } catch {
      // 跳过损坏侧车，同 rebuild
    }
  }
  return restored;
}

export interface ImportOptions {
  /** 覆盖 manifest 中的 slug（冲突换名用） */
  slugOverride?: string;
}

/**
 * 从 zip Buffer 导入为新 subject。
 * 抛 ArchiveError（包不合法，零落盘）或 SubjectError（slug 冲突/非法）。
 * 落盘/索引阶段失败会清理 vault 目录并回滚新建 subject。
 */
export async function importSubjectArchive(
  buffer: Buffer,
  options: ImportOptions = {},
): Promise<ImportResult> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ArchiveError('invalid-archive', 'File is not a valid zip archive');
  }

  const manifestEntry = zip.getEntry(MANIFEST_FILENAME);
  if (!manifestEntry) {
    throw new ArchiveError('invalid-manifest', 'Archive is missing manifest.json');
  }
  const manifest = parseManifest(manifestEntry.getData().toString('utf-8'));

  // 先整体校验 entry 路径，任何非法 entry 直接拒绝（零落盘）。
  const fileEntries = zip.getEntries().filter((e) => !e.isDirectory);
  for (const entry of fileEntries) {
    if (validateEntryPath(entry.entryName) === null) {
      throw new ArchiveError('invalid-entry', `Illegal archive entry: ${entry.entryName}`);
    }
  }

  const slug = options.slugOverride?.trim() || manifest.subject.slug;
  const release = await acquireVaultLock();
  // create 抛 SubjectError（invalid-slug / slug-conflict）由路由映射
  let subject: Subject;
  try {
    subject = subjectsRepo.create({
      slug,
      name: manifest.subject.name,
      description: manifest.subject.description,
    });
  } catch (error) {
    release();
    throw error;
  }
  if (manifest.subject.augmentationLevel !== subject.augmentationLevel) {
    subject = subjectsRepo.setAugmentationLevel(subject.id, manifest.subject.augmentationLevel);
  }

  const dirs = subjectVaultDirs(subject.slug);
  try {
    let assets = 0;
    for (const entry of fileEntries) {
      const rel = mapEntryToVaultRelPath(entry.entryName, subject.slug);
      if (rel === null) continue; // manifest.json
      if (rel.startsWith(`assets/${subject.slug}/`)) assets++;
      const abs = vaultPath(...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, entry.getData());
    }

    const pages = scanWikiPages(subject.slug);
    indexTouchedPages(subject.id, pages.map((p) => p.slug));
    const sources = restoreSourcesForSubject(subject);

    try {
      await commitVaultChanges(
        `[subject:${subject.slug}] Import subject from archive`,
        [
          `wiki/${subject.slug}`,
          `raw/${subject.slug}`,
          `assets/${subject.slug}`,
          `.llm-wiki/sources/${subject.slug}`,
        ],
      );
    } catch {
      // git 失败非致命，与既有路由一致
    }

    return { subject, stats: { pages: pages.length, sources, assets } };
  } catch (error) {
    // 回滚：删 vault 目录 + 删新建 subject（含已写入的索引行）
    for (const dir of Object.values(dirs)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    try {
      subjectsRepo.deleteWithContents(subject.id);
    } catch {
      // 尽力清理；失败留给 rebuild 兜底
    }
    throw error;
  } finally {
    release();
  }
}

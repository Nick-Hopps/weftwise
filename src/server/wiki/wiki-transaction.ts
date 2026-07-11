/**
 * Transactional wiki changeset execution using the Saga pattern.
 *
 * Flow:
 *   createChangeset → validateChangeset → applyChangeset
 *                                             ↓ (on error)
 *                                        rollbackChangeset
 *
 * Subject-aware: every changeset is scoped to exactly one subject. Cross-subject
 * wikilinks are validated against the target subject's pages but never written
 * to a different subject's vault.
 */

import { randomUUID } from 'crypto';
import {
  getVaultHead,
  commitVaultChanges,
  restoreToHead,
  cleanUntrackedPaths,
} from '../git/git-service';
import { writeVaultFiles, deleteVaultFile } from './wiki-store';
import { indexTouchedPages } from './indexer';
import { validateFrontmatter } from './frontmatter';
import { parseFrontmatter } from './frontmatter';
import { extractWikiLinks } from './wikilinks';
import { getRawDb } from '../db/client';
import * as pagesRepo from '../db/repos/pages-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { parseWikiPath } from './page-identity';
import { acquireVaultLock } from './vault-mutex';
import type { Changeset, ChangesetEntry, Subject } from '@/lib/contracts';

/**
 * Build an in-memory Changeset object from a list of entries.
 * Does not touch the filesystem or database — use `applyChangeset` for that.
 */
export function createChangeset(
  jobId: string,
  subject: Pick<Subject, 'id' | 'slug'>,
  entries: ChangesetEntry[]
): Changeset {
  return {
    id: randomUUID(),
    jobId,
    subjectId: subject.id,
    subjectSlug: subject.slug,
    entries,
    preHead: '',
    postHead: null,
    status: 'pending',
  };
}

/**
 * Validate a changeset.  Errors block the apply; warnings are surfaced to the
 * caller so they can decide whether to proceed.
 *
 * Cross-subject wikilinks (`[[other-subject:Page]]`) are checked against the
 * referenced subject's page set; missing target subjects yield warnings.
 */
export function validateChangeset(
  changeset: Changeset
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Verify the subject still exists.
  const subject = subjectsRepo.getById(changeset.subjectId);
  if (!subject) {
    errors.push(`Subject ${changeset.subjectId} no longer exists`);
    return { valid: false, errors, warnings };
  }

  // Verify every changeset path belongs to the changeset's subject.
  for (const entry of changeset.entries) {
    if (!entry.path || entry.path.trim() === '') {
      errors.push(`${entry.action} entry has an empty path`);
      continue;
    }

    const parts = parseWikiPath(entry.path);
    if (!parts) {
      errors.push(`[${entry.path}] Path is not a valid wiki path`);
      continue;
    }
    if (parts.subjectSlug !== subject.slug) {
      errors.push(
        `[${entry.path}] Path subject "${parts.subjectSlug}" does not match changeset subject "${subject.slug}"`
      );
    }
  }

  // Per-entry frontmatter + wikilink syntax validation.
  for (const entry of changeset.entries) {
    if (entry.action === 'delete') continue;
    if (entry.content === null || entry.content === undefined) {
      errors.push(`Entry "${entry.path}" has no content for action "${entry.action}"`);
      continue;
    }
    try {
      const parsed = parseFrontmatter(entry.content);
      const result = validateFrontmatter(parsed.data as unknown as Record<string, unknown>);
      if (!result.valid) {
        for (const err of result.errors) {
          errors.push(`[${entry.path}] Frontmatter: ${err}`);
        }
      }
    } catch (err) {
      errors.push(`[${entry.path}] Could not parse frontmatter: ${String(err)}`);
      continue;
    }

    try {
      const { body } = parseFrontmatter(entry.content);
      extractWikiLinks(body, { currentSubjectSlug: subject.slug });
    } catch (err) {
      errors.push(`[${entry.path}] Could not parse wikilinks: ${String(err)}`);
    }
  }

  // Link-target validation: known slugs in the changeset's subject + any creates
  // that this changeset is about to add.
  const knownSlugs = new Set(pagesRepo.getAllPages(subject.id).map((p) => p.slug));
  for (const entry of changeset.entries) {
    if (entry.action !== 'create') continue;
    const parts = parseWikiPath(entry.path);
    if (parts && parts.subjectSlug === subject.slug) {
      knownSlugs.add(parts.slug);
    }
  }

  const titleMap = pagesRepo.getTitleToSlugMap(subject.id);
  const targetSubjectCache = new Map<string, Subject | null>();
  const resolveSubject = (slug: string): Subject | null => {
    if (targetSubjectCache.has(slug)) return targetSubjectCache.get(slug) ?? null;
    const found = subjectsRepo.getBySlug(slug);
    targetSubjectCache.set(slug, found);
    return found;
  };

  for (const entry of changeset.entries) {
    if (entry.action === 'delete' || !entry.content) continue;
    let body: string;
    try {
      ({ body } = parseFrontmatter(entry.content));
    } catch {
      continue;
    }

    const links = extractWikiLinks(body, { currentSubjectSlug: subject.slug });
    for (const link of links) {
      const targetSubjectSlug = link.targetSubjectSlug || subject.slug;

      if (targetSubjectSlug === subject.slug) {
        if (
          !knownSlugs.has(link.target) &&
          !titleMap.has(link.target) &&
          !titleMap.has(link.target.toLowerCase())
        ) {
          warnings.push(`[${entry.path}] Unresolved wikilink: ${link.raw}`);
        }
        continue;
      }

      const targetSubject = resolveSubject(targetSubjectSlug);
      if (!targetSubject) {
        warnings.push(`[${entry.path}] Unknown subject in wikilink: ${link.raw}`);
        continue;
      }
      const exists = pagesRepo.getPageBySlug(targetSubject.id, link.target);
      if (!exists) {
        warnings.push(`[${entry.path}] Unresolved cross-subject wikilink: ${link.raw}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export interface SourceLinkOps {
  /** 每个 source → 其关联的页 slug 列表（多源：ingest 原始源 + 本次核查引用的网页源）。 */
  links: Array<{ sourceId: string; pageSlugs: string[] }>;
  /** 提交前已写入 vault 工作树、需纳入本 commit 的额外文件路径（raw 源文件 + sidecar 初始内容），相对 vault 根。sidecar 的 linkedPages 富化（updateSourcePageLinks）发生在 commit 之后，不进入本 commit（best-effort 旁路，可由 rebuild 重建）。 */
  extraStagePaths?: string[];
  /** 返回 true 表示本次真正新插入了一行（用于回滚补偿判定，重复 ingest 命中已存在的行时返回 false）。 */
  linkPageSource: (subjectId: string, pageSlug: string, sourceId: string) => boolean;
  updateSourcePageLinks: (sourceId: string, pageSlugs: string[]) => void;
  /** 回滚补偿：删除单条 (subject, page, source) 链接；缺省时回滚不清理 page_sources（兼容旧调用方）。 */
  unlinkPageSource?: (subjectId: string, pageSlug: string, sourceId: string) => void;
  /** sidecar 更新失败时的告警出口；缺省时静默（不影响 changeset 提交）。 */
  onWarning?: (message: string) => void;
}

export interface ApplyChangesetOptions {
  expectedPreHead?: string;
}

export class ActionStalePreviewError extends Error {
  readonly code = 'ACTION_STALE_PREVIEW' as const;

  constructor(
    readonly expectedHead: string,
    readonly actualHead: string,
  ) {
    super('Vault HEAD changed after preview; refresh and approve the new preview.');
    this.name = 'ActionStalePreviewError';
  }
}

export async function applyChangeset(
  changeset: Changeset,
  sourceOps?: SourceLinkOps,
  options: ApplyChangesetOptions = {},
): Promise<Changeset> {
  const release = await acquireVaultLock();

  try {
    const preHead = await getVaultHead();
    if (options.expectedPreHead !== undefined && options.expectedPreHead !== preHead) {
      throw new ActionStalePreviewError(options.expectedPreHead, preHead);
    }

    const db = getRawDb();
    const operationId = changeset.id;
    db
      .prepare(
        `INSERT OR REPLACE INTO operations
         (id, job_id, subject_id, pre_head, post_head, changeset_json, status)
         VALUES (?, ?, ?, '', NULL, ?, 'pending')`
      )
      .run(
        operationId,
        changeset.jobId,
        changeset.subjectId,
        JSON.stringify(changeset.entries)
      );

    const working = { ...changeset, preHead };

    db
      .prepare(`UPDATE operations SET pre_head = ? WHERE id = ?`)
      .run(preHead, operationId);

    // 本次 apply 期间真正新插入的 (page, source) 对——只有这些才是回滚需要
    // 补偿的行；重复 ingest 命中已存在的行 linkPageSource 会返回 false，
    // 不计入，避免误删预先存在的溯源数据。声明在 try 外层，确保 catch 里
    // 也能拿到（即便在写入这一步之前就失败也传空数组，无副作用）。
    const insertedSourceLinks: Array<{ pageSlug: string; sourceId: string }> = [];

    try {
      const writeEntries: { path: string; content: string }[] = [];
      const deleteEntries: string[] = [];
      for (const entry of working.entries) {
        if (entry.action === 'create' || entry.action === 'update') {
          if (entry.content !== null && entry.content !== undefined) {
            writeEntries.push({ path: entry.path, content: entry.content });
          }
        } else if (entry.action === 'delete') {
          deleteEntries.push(entry.path);
        }
      }

      writeVaultFiles(writeEntries);
      for (const p of deleteEntries) {
        deleteVaultFile(p);
      }

      const touchedSlugs = collectTouchedSlugs(working.subjectSlug, working.entries);

      const updateIndex = db.transaction(() => {
        indexTouchedPages(working.subjectId, touchedSlugs);

        if (sourceOps) {
          for (const link of sourceOps.links) {
            for (const slug of link.pageSlugs) {
              const inserted = sourceOps.linkPageSource(working.subjectId, slug, link.sourceId);
              if (inserted) {
                insertedSourceLinks.push({ pageSlug: slug, sourceId: link.sourceId });
              }
            }
          }
        }
      });

      updateIndex();

      const affectedPaths = working.entries.map((e) => e.path);
      const stagePaths =
        sourceOps?.extraStagePaths && sourceOps.extraStagePaths.length > 0
          ? [...affectedPaths, ...sourceOps.extraStagePaths]
          : affectedPaths;
      const postHead = await commitVaultChanges(
        `[subject:${working.subjectSlug}] Apply changeset ${working.id} (job: ${working.jobId}) [cs:${working.id}]`,
        stagePaths
      );

      db
        .prepare(
          `UPDATE operations SET post_head = ?, status = 'applied' WHERE id = ?`
        )
        .run(postHead, operationId);

      // sidecar（.llm-wiki/sources/<subject>/*.json）写入放在 git commit
      // 成功之后：commit 已落地即代表 page_sources 索引已生效，sidecar 只是
      // 溯源展示的旁路缓存，failure 不应回滚已提交的 changeset，也天然不
      // 需要回滚补偿（commit 前从不触碰 sidecar 文件）。
      if (sourceOps) {
        for (const link of sourceOps.links) {
          try {
            sourceOps.updateSourcePageLinks(link.sourceId, link.pageSlugs);
          } catch (err) {
            sourceOps.onWarning?.(
              `Failed to update source page links for source ${link.sourceId}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      }

      return { ...working, postHead, status: 'applied' };
    } catch (err) {
      await rollbackChangeset(
        { ...working, preHead },
        { insertedSourceLinks, unlinkPageSource: sourceOps?.unlinkPageSource }
      );
      throw err;
    }
  } finally {
    release();
  }
}

export interface SourceLinkCompensation {
  /** 本次 apply 期间真正新插入、需要回滚删除的 (page, source) 对。 */
  insertedSourceLinks?: Array<{ pageSlug: string; sourceId: string }>;
  /** 删除单条 (subject, page, source) 链接；缺省时不清理 page_sources（兼容旧调用方/无 sourceOps 场景）。 */
  unlinkPageSource?: (subjectId: string, pageSlug: string, sourceId: string) => void;
}

/**
 * Revert the vault to the changeset's preHead and reindex slugs in the
 * affected subject. Idempotent — calling it multiple times is safe.
 *
 * `compensation` (optional) additionally deletes `page_sources` rows that
 * were newly inserted during the failed apply — pre-existing rows (e.g. a
 * repeat ingest hitting the same page/source pair) are never touched, since
 * only rows `linkPageSource` reported as newly-inserted are tracked here.
 */
export async function rollbackChangeset(
  changeset: Changeset,
  compensation?: SourceLinkCompensation
): Promise<void> {
  if (changeset.preHead) {
    await restoreToHead(changeset.preHead);
  }

  // reset --hard 不删未跟踪文件：本次 create 的新页在首次 commit 前正是
  // 未跟踪状态，必须显式清理，否则文件残留磁盘，且下方重索引会把它写回 DB
  //（等于回滚失效）。preHead 为空（vault 尚无 commit）时同理，所有写入
  // 均为未跟踪文件，清理后即完成回滚。
  try {
    await cleanUntrackedPaths(changeset.entries.map((e) => e.path));
  } catch {
    // best effort — 残留文件会在下次 rebuild/lint 中暴露
  }

  try {
    const sqlite = getRawDb();
    const touchedSlugs = collectTouchedSlugs(changeset.subjectSlug, changeset.entries);
    const reindex = sqlite.transaction(() => {
      indexTouchedPages(changeset.subjectId, touchedSlugs);
    });
    reindex();
  } catch {
    // best effort
  }

  if (compensation?.insertedSourceLinks?.length && compensation.unlinkPageSource) {
    for (const { pageSlug, sourceId } of compensation.insertedSourceLinks) {
      try {
        compensation.unlinkPageSource(changeset.subjectId, pageSlug, sourceId);
      } catch {
        // best effort — 残留行会在下次 rebuild/lint 中暴露
      }
    }
  }

  try {
    const sqlite = getRawDb();
    sqlite
      .prepare(`UPDATE operations SET status = ? WHERE id = ?`)
      .run('rolled-back', changeset.id);
  } catch {
    // ignore — operation row may not exist yet
  }
}

export function collectTouchedSlugs(subjectSlug: string, entries: ChangesetEntry[]): string[] {
  const slugs = new Set<string>();
  for (const entry of entries) {
    const parts = parseWikiPath(entry.path);
    if (!parts) continue;
    if (parts.subjectSlug !== subjectSlug) continue;
    slugs.add(parts.slug);
  }
  return [...slugs];
}

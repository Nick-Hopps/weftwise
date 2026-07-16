import { randomUUID } from 'crypto';
import { eq, asc, sql } from 'drizzle-orm';
import { getDb, getRawDb } from '../client';
import { subjects, pages } from '../schema';
import type { Subject } from '@/lib/contracts';
import { SUBJECT_SLUG_RE } from '@/lib/slug';

export class SubjectError extends Error {
  constructor(
    public code:
      | 'invalid-slug'
      | 'slug-conflict'
      | 'not-found'
      | 'protected'
      | 'has-inbound-refs'
      | 'active-jobs'
      | 'maintenance',
    message: string,
  ) {
    super(message);
    this.name = 'SubjectError';
  }
}

export function listSubjects(): Subject[] {
  const db = getDb();
  return db.select().from(subjects).orderBy(asc(subjects.name)).all().map(rowToSubject);
}

export function getById(id: string): Subject | null {
  const db = getDb();
  const row = db.select().from(subjects).where(eq(subjects.id, id)).get();
  return row ? rowToSubject(row) : null;
}

export function getBySlug(slug: string): Subject | null {
  const db = getDb();
  const row = db.select().from(subjects).where(eq(subjects.slug, slug)).get();
  return row ? rowToSubject(row) : null;
}

export function getBySlugOrThrow(slug: string): Subject {
  const subject = getBySlug(slug);
  if (!subject) {
    throw new SubjectError('not-found', `Subject "${slug}" not found`);
  }
  return subject;
}

export interface CreateSubjectInput {
  slug: string;
  name: string;
  description?: string;
}

export function create(input: CreateSubjectInput): Subject {
  const slug = input.slug.trim().toLowerCase();
  if (!SUBJECT_SLUG_RE.test(slug)) {
    throw new SubjectError(
      'invalid-slug',
      `Subject slug must be lowercase kebab-case (got "${input.slug}")`
    );
  }
  if (getBySlug(slug)) {
    throw new SubjectError('slug-conflict', `Subject "${slug}" already exists`);
  }

  const now = new Date().toISOString();
  const subject: Subject = {
    id: randomUUID(),
    slug,
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    augmentationLevel: 'standard',
    createdAt: now,
    updatedAt: now,
  };

  const db = getDb();
  db.insert(subjects).values(subject).run();
  return subject;
}

export interface RenameSubjectInput {
  name?: string;
  description?: string;
}

export function rename(id: string, input: RenameSubjectInput): Subject {
  const subject = getById(id);
  if (!subject) {
    throw new SubjectError('not-found', `Subject ${id} not found`);
  }

  const updates: Partial<Subject> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) updates.name = input.name.trim();
  if (input.description !== undefined) updates.description = input.description.trim();

  const db = getDb();
  db.update(subjects).set(updates).where(eq(subjects.id, id)).run();
  return { ...subject, ...updates } as Subject;
}

export function countPages(subjectId: string): number {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(pages)
    .where(eq(pages.subjectId, subjectId))
    .get();
  return Number(result?.count ?? 0);
}

function rowToSubject(row: typeof subjects.$inferSelect): Subject {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    augmentationLevel: (row.augmentationLevel ?? 'standard') as Subject['augmentationLevel'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function setAugmentationLevel(id: string, level: Subject['augmentationLevel']): Subject {
  const subject = getById(id);
  if (!subject) {
    throw new SubjectError('not-found', `Subject ${id} not found`);
  }
  const updatedAt = new Date().toISOString();
  const db = getDb();
  db.update(subjects)
    .set({ augmentationLevel: level, updatedAt })
    .where(eq(subjects.id, id))
    .run();
  return { ...subject, augmentationLevel: level, updatedAt };
}

/**
 * 列出"其他 subject 指向本 subject"的去重 referencing subject（用于删除前的入站引用守卫）。
 * 仅计 subject_id ≠ id 的 wiki_links（排除本 subject 自指链接）。
 */
export function listInboundReferences(id: string): { id: string; slug: string }[] {
  const sqlite = getRawDb();
  return sqlite
    .prepare(
      `SELECT DISTINCT s.id AS id, s.slug AS slug
         FROM wiki_links wl
         JOIN subjects s ON s.id = wl.subject_id
        WHERE wl.target_subject_id = ? AND wl.subject_id != ?`
    )
    .all(id, id) as { id: string; slug: string }[];
}

export interface SubjectMaintenanceClaim {
  id: string;
  slug: string;
  mutationEpoch: number;
}

function assertNoActiveJobs(sqlite: ReturnType<typeof getRawDb>, id: string): void {
  const activeJob = sqlite.prepare(`
    SELECT id FROM jobs
    WHERE status IN ('pending', 'running')
      AND (subject_id = ? OR subject_id IS NULL)
    LIMIT 1
  `).get(id);
  if (activeJob) {
    throw new SubjectError(
      'active-jobs',
      'Subject or global jobs are still active; wait for them before deleting',
    );
  }
}

function assertNoInboundReferences(sqlite: ReturnType<typeof getRawDb>, id: string): void {
  const inbound = sqlite.prepare(`
    SELECT DISTINCT s.slug AS slug
    FROM wiki_links wl
    JOIN subjects s ON s.id = wl.subject_id
    WHERE wl.target_subject_id = ? AND wl.subject_id != ?
    ORDER BY s.slug
  `).all(id, id) as Array<{ slug: string }>;
  if (inbound.length === 0) return;

  const names = inbound.map((row) => row.slug);
  const shown = names.slice(0, 5).join(', ');
  const suffix = names.length > 5 ? ', …' : '';
  throw new SubjectError(
    'has-inbound-refs',
    `This subject is referenced by other subjects (${shown}${suffix}). Remove those cross-subject links first.`,
  );
}

/**
 * 在移动 vault 目录前领取删除维护权；active job 与入站引用均在同一 IMMEDIATE
 * 事务内检查。epoch 暂不提升，供崩溃恢复判断 DB 删除是否已经提交。
 */
export function beginDeleteMaintenance(id: string): SubjectMaintenanceClaim {
  const sqlite = getRawDb();
  const begin = sqlite.transaction(() => {
    const subject = sqlite.prepare(`
      SELECT id, slug, maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(id) as {
      id: string;
      slug: string;
      maintenance_state: string;
      mutation_epoch: number;
    } | undefined;
    if (!subject) {
      throw new SubjectError('not-found', `Subject ${id} not found`);
    }
    if (subject.slug === 'general') {
      throw new SubjectError('protected', `The general subject can't be deleted`);
    }
    if (subject.maintenance_state !== 'active') {
      throw new SubjectError('maintenance', 'Subject is currently under maintenance');
    }

    assertNoActiveJobs(sqlite, id);
    assertNoInboundReferences(sqlite, id);
    sqlite.prepare(`
      UPDATE subjects
      SET maintenance_state = 'resetting', updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), id);

    return {
      id: subject.id,
      slug: subject.slug,
      mutationEpoch: subject.mutation_epoch,
    };
  });
  return begin.immediate();
}

/** 取消未提交的删除维护，并提升 epoch 使领取维护前的同步写租约失效。 */
export function cancelDeleteMaintenance(id: string, expectedMutationEpoch: number): void {
  getRawDb().prepare(`
    UPDATE subjects
    SET maintenance_state = 'active',
        mutation_epoch = mutation_epoch + 1,
        updated_at = ?
    WHERE id = ?
      AND maintenance_state = 'resetting'
      AND mutation_epoch = ?
  `).run(new Date().toISOString(), id, expectedMutationEpoch);
}

/**
 * 级联删除 subject 及其全部关联数据（单事务，按子→父顺序原生删除）。
 * 守卫：subject 不存在→not-found；general→protected；有入站跨主题引用→has-inbound-refs。
 * 仅清理 DB 行；vault 目录与 git commit 由路由层负责。
 */
export function deleteWithContents(
  id: string,
  options: { expectedMutationEpoch?: number } = {},
): void {
  const sqlite = getRawDb();
  const purge = sqlite.transaction(() => {
    const subject = sqlite.prepare(`
      SELECT slug, maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(id) as {
      slug: string;
      maintenance_state: string;
      mutation_epoch: number;
    } | undefined;
    if (!subject) {
      throw new SubjectError('not-found', `Subject ${id} not found`);
    }
    if (subject.slug === 'general') {
      throw new SubjectError('protected', `The general subject can't be deleted`);
    }
    const expectedEpoch = options.expectedMutationEpoch;
    const expectedState = expectedEpoch === undefined ? 'active' : 'resetting';
    if (
      subject.maintenance_state !== expectedState
      || (expectedEpoch !== undefined && subject.mutation_epoch !== expectedEpoch)
    ) {
      throw new SubjectError('maintenance', 'Subject is currently under maintenance');
    }

    // 搬目录后、真正 purge 前再次检查，和 epoch 提升 + 删除共用一个事务。
    assertNoActiveJobs(sqlite, id);
    assertNoInboundReferences(sqlite, id);
    if (expectedEpoch !== undefined) {
      sqlite.prepare(`
        UPDATE subjects SET mutation_epoch = mutation_epoch + 1 WHERE id = ?
      `).run(id);
    }

    // Research provenance 保存历史快照；删除 Subject 的产品语义是同时删除整条历史。
    sqlite.prepare(`DELETE FROM research_candidate_ingests WHERE run_id IN (SELECT id FROM research_runs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM research_candidates WHERE run_id IN (SELECT id FROM research_runs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM research_approvals WHERE run_id IN (SELECT id FROM research_runs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM research_run_findings WHERE run_id IN (SELECT id FROM research_runs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM research_runs WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM conversations WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM page_rendition_assets WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM page_renditions WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM page_maturity WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM page_embeddings WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM page_sources WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM pages_fts WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM wiki_links WHERE subject_id = ? OR target_subject_id = ?`).run(id, id);
    sqlite.prepare(`DELETE FROM page_aliases WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM pages WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM sources WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM profile_signals WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM research_backlog WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM ingest_checkpoints WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM operations WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM jobs WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM subjects WHERE id = ?`).run(id);
  });
  purge.immediate();
}

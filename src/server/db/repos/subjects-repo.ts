import { randomUUID } from 'crypto';
import { eq, asc, sql } from 'drizzle-orm';
import { getDb, getRawDb } from '../client';
import { subjects, pages } from '../schema';
import type { Subject } from '@/lib/contracts';
import { SUBJECT_SLUG_RE } from '@/lib/slug';

export class SubjectError extends Error {
  constructor(public code: 'invalid-slug' | 'slug-conflict' | 'not-empty' | 'not-found' | 'protected' | 'has-inbound-refs', message: string) {
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

export function deleteIfEmpty(id: string): void {
  const subject = getById(id);
  if (!subject) {
    throw new SubjectError('not-found', `Subject ${id} not found`);
  }
  const pageCount = countPages(id);
  if (pageCount > 0) {
    throw new SubjectError(
      'not-empty',
      `Subject "${subject.slug}" still contains ${pageCount} page(s)`
    );
  }
  const db = getDb();
  db.delete(subjects).where(eq(subjects.id, id)).run();
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

/**
 * 级联删除 subject 及其全部关联数据（单事务，按子→父顺序原生删除）。
 * 守卫：subject 不存在→not-found；general→protected；有入站跨主题引用→has-inbound-refs。
 * 仅清理 DB 行；vault 目录与 git commit 由路由层负责。
 */
export function deleteWithContents(id: string): void {
  const subject = getById(id);
  if (!subject) {
    throw new SubjectError('not-found', `Subject ${id} not found`);
  }
  if (subject.slug === 'general') {
    throw new SubjectError('protected', `The general subject can't be deleted`);
  }
  const inbound = listInboundReferences(id);
  if (inbound.length > 0) {
    const names = inbound.map((s) => s.slug);
    const shown = names.slice(0, 5).join(', ');
    const suffix = names.length > 5 ? ', …' : '';
    throw new SubjectError(
      'has-inbound-refs',
      `This subject is referenced by other subjects (${shown}${suffix}). Remove those cross-subject links first.`
    );
  }

  const sqlite = getRawDb();
  const purge = sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM conversations WHERE subject_id = ?`).run(id);
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
    sqlite.prepare(`DELETE FROM ingest_checkpoints WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM operations WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM jobs WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM subjects WHERE id = ?`).run(id);
  });
  purge();
}

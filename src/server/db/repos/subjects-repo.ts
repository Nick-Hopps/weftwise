import { randomUUID } from 'crypto';
import { eq, asc, sql } from 'drizzle-orm';
import { getDb } from '../client';
import { subjects, pages } from '../schema';
import type { Subject } from '@/lib/contracts';
import { SUBJECT_SLUG_RE } from '@/lib/slug';

export class SubjectError extends Error {
  constructor(public code: 'invalid-slug' | 'slug-conflict' | 'not-empty' | 'not-found', message: string) {
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

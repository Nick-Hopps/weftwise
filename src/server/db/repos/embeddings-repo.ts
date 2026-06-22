import { getRawDb } from '../client';

interface RawRow {
  slug: string;
  content_hash: string;
  dim: number;
  vector: Buffer;
}

export function upsertEmbedding(row: {
  subjectId: string;
  slug: string;
  model: string;
  contentHash: string;
  dim: number;
  vector: Buffer;
}): void {
  getRawDb()
    .prepare(
      `INSERT INTO page_embeddings (subject_id, slug, model, content_hash, dim, vector, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_id, slug) DO UPDATE SET
         model = excluded.model,
         content_hash = excluded.content_hash,
         dim = excluded.dim,
         vector = excluded.vector,
         updated_at = excluded.updated_at`
    )
    .run(
      row.subjectId,
      row.slug,
      row.model,
      row.contentHash,
      row.dim,
      row.vector,
      new Date().toISOString()
    );
}

export function listForSubject(
  subjectId: string,
  model: string
): { slug: string; contentHash: string; dim: number; vector: Buffer }[] {
  const rows = getRawDb()
    .prepare(
      `SELECT slug, content_hash, dim, vector FROM page_embeddings
       WHERE subject_id = ? AND model = ?`
    )
    .all(subjectId, model) as RawRow[];
  return rows.map((r) => ({
    slug: r.slug,
    contentHash: r.content_hash,
    dim: r.dim,
    vector: r.vector,
  }));
}

export function deleteBySlug(subjectId: string, slug: string): void {
  getRawDb()
    .prepare(`DELETE FROM page_embeddings WHERE subject_id = ? AND slug = ?`)
    .run(subjectId, slug);
}

export function pruneOrphans(subjectId: string, liveSlugs: string[]): void {
  const db = getRawDb();
  const all = db
    .prepare(`SELECT slug FROM page_embeddings WHERE subject_id = ?`)
    .all(subjectId) as { slug: string }[];
  const live = new Set(liveSlugs);
  const del = db.prepare(`DELETE FROM page_embeddings WHERE subject_id = ? AND slug = ?`);
  for (const { slug } of all) {
    if (!live.has(slug)) del.run(subjectId, slug);
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'embeddings-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const { getRawDb } = await import('../../client');
  const db = getRawDb();
  db.prepare(`INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('s1', 'sub-a', 'Sub A', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  return import('../embeddings-repo');
}

const buf = (nums: number[]) => Buffer.from(Float32Array.from(nums).buffer);

describe('embeddings-repo', () => {
  it('upsert + listForSubject(model 过滤) + vector round-trip', async () => {
    const repo = await setup();
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h1', dim: 2, vector: buf([1, 0]) });
    repo.upsertEmbedding({ subjectId: 's1', slug: 'b', model: 'm2', contentHash: 'h2', dim: 2, vector: buf([0, 1]) });
    const rows = repo.listForSubject('s1', 'm1');
    expect(rows.map((r) => r.slug)).toEqual(['a']); // m2 被过滤
    expect(Array.from(new Float32Array(rows[0].vector.buffer, rows[0].vector.byteOffset, 2))).toEqual([1, 0]);
  });

  it('upsert 同 (subject,slug) 覆盖', async () => {
    const repo = await setup();
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h1', dim: 2, vector: buf([1, 0]) });
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h2', dim: 2, vector: buf([0, 1]) });
    const rows = repo.listForSubject('s1', 'm1');
    expect(rows).toHaveLength(1);
    expect(rows[0].contentHash).toBe('h2');
  });

  it('deleteBySlug', async () => {
    const repo = await setup();
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h1', dim: 2, vector: buf([1, 0]) });
    repo.deleteBySlug('s1', 'a');
    expect(repo.listForSubject('s1', 'm1')).toEqual([]);
  });

  it('pruneOrphans 删除 slug ∉ liveSlugs 的行', async () => {
    const repo = await setup();
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h1', dim: 2, vector: buf([1, 0]) });
    repo.upsertEmbedding({ subjectId: 's1', slug: 'b', model: 'm1', contentHash: 'h2', dim: 2, vector: buf([0, 1]) });
    repo.pruneOrphans('s1', ['a']);
    expect(repo.listForSubject('s1', 'm1').map((r) => r.slug)).toEqual(['a']);
  });
});

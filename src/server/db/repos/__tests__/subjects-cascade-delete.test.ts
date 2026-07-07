import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subjects-cascade-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

// 为某 subject 在所有关联表插入一行（pages_fts 由 pages 插入触发器自动写入，不手插）。
function seedSubjectData(sqlite: any, subjectId: string) {
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO pages (subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(subjectId, 'page-a', 'Page A', `wiki/${subjectId}/page-a.md`, '', 'h1', '[]', now, now);
  sqlite.prepare(`INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json) VALUES (?,?,?,?,?,?)`)
    .run(`src-${subjectId}`, subjectId, 'f.md', 'sh1', now, '{}');
  sqlite.prepare(`INSERT INTO page_sources (subject_id, page_slug, source_id) VALUES (?,?,?)`)
    .run(subjectId, 'page-a', `src-${subjectId}`);
  sqlite.prepare(`INSERT INTO page_aliases (subject_id, old_slug, new_slug, created_at) VALUES (?,?,?,?)`)
    .run(subjectId, 'old-a', 'page-a', now);
  sqlite.prepare(`INSERT INTO wiki_links (subject_id, source_slug, target_subject_id, target_slug, context) VALUES (?,?,?,?,?)`)
    .run(subjectId, 'page-a', subjectId, 'page-a', '');
  sqlite.prepare(`INSERT INTO page_embeddings (subject_id, slug, model, content_hash, dim, vector, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(subjectId, 'page-a', 'm', 'h', 1, Buffer.from([0]), now);
  sqlite.prepare(`INSERT INTO page_maturity (subject_id, slug, passes, last_enriched_at, interval_days, next_due_at, state, priority, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(subjectId, 'page-a', 0, null, 1, now, 'active', 0, now);
  sqlite.prepare(`INSERT INTO page_renditions (subject_id, slug, canonical_hash, profile_version, rendered_md, model, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(subjectId, 'page-a', 'ch', 1, 'md', null, now);
  sqlite.prepare(`INSERT INTO profile_signals (user_id, type, subject_id, slug, created_at) VALUES (?,?,?,?,?)`)
    .run('local', 'too-hard', subjectId, 'page-a', now);
  sqlite.prepare(`INSERT INTO conversations (id, subject_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(`conv-${subjectId}`, subjectId, 'C', now, now);
  sqlite.prepare(`INSERT INTO messages (id, conversation_id, role, content, citations_json, created_at) VALUES (?,?,?,?,?,?)`)
    .run(`msg-${subjectId}`, `conv-${subjectId}`, 'user', 'hi', null, now);
  sqlite.prepare(`INSERT INTO jobs (id, type, status, subject_id, params_json, created_at) VALUES (?,?,?,?,?,?)`)
    .run(`job-${subjectId}`, 'ingest', 'completed', subjectId, '{}', now);
  sqlite.prepare(`INSERT INTO job_events (id, job_id, type, message, data_json, created_at) VALUES (?,?,?,?,?,?)`)
    .run(`ev-${subjectId}`, `job-${subjectId}`, 'log', 'm', null, now);
  sqlite.prepare(`INSERT INTO ingest_checkpoints (job_id, kind, key, data_json, created_at) VALUES (?,?,?,?,?)`)
    .run(`job-${subjectId}`, 'plan', 'k', '{}', now);
  sqlite.prepare(`INSERT INTO operations (id, job_id, subject_id, pre_head, post_head, changeset_json, status) VALUES (?,?,?,?,?,?,?)`)
    .run(`op-${subjectId}`, `job-${subjectId}`, subjectId, 'pre', 'post', '{}', 'applied');
  sqlite.prepare(`INSERT INTO research_backlog (id, subject_id, question, source, status, research_job_id, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(`rb-${subjectId}`, subjectId, 'what is x?', 'ask-ai', 'open', null, now);
}

const SUBJECT_TABLES = [
  'pages', 'sources', 'page_sources', 'page_aliases', 'wiki_links',
  'page_embeddings', 'page_maturity', 'page_renditions', 'profile_signals',
  'conversations', 'operations', 'jobs', 'pages_fts', 'research_backlog',
];

function totalRowsForSubject(sqlite: any, subjectId: string): number {
  let total = 0;
  for (const t of SUBJECT_TABLES) {
    const r = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE subject_id = ?`).get(subjectId) as { c: number };
    total += Number(r.c);
  }
  return total;
}

describe('subjects-repo deleteWithContents', () => {
  it('purges every subject-scoped table + the subject row, leaving general/other intact', async () => {
    const { randomUUID } = await import('crypto');
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();

    const target = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'Target' });
    const other = subjectsRepo.create({ slug: `o-${randomUUID().slice(0, 8)}`, name: 'Other' });
    seedSubjectData(sqlite, target.id);
    seedSubjectData(sqlite, other.id);

    expect(totalRowsForSubject(sqlite, target.id)).toBeGreaterThan(0);

    subjectsRepo.deleteWithContents(target.id);

    // subject 行与全部关联行清零
    expect(subjectsRepo.getById(target.id)).toBeNull();
    expect(totalRowsForSubject(sqlite, target.id)).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?`).get(`conv-${target.id}`) as { c: number }).c).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM job_events WHERE job_id = ?`).get(`job-${target.id}`) as { c: number }).c).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM ingest_checkpoints WHERE job_id = ?`).get(`job-${target.id}`) as { c: number }).c).toBe(0);

    // 其他 subject 与 general 不受影响
    expect(subjectsRepo.getById(other.id)).not.toBeNull();
    expect(totalRowsForSubject(sqlite, other.id)).toBeGreaterThan(0);
    expect(subjectsRepo.getBySlug('general')).not.toBeNull();
  });

  it('refuses to delete the general subject', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const { SubjectError } = subjectsRepo;
    const general = subjectsRepo.getBySlug('general')!;
    expect(() => subjectsRepo.deleteWithContents(general.id)).toThrow(SubjectError);
    try {
      subjectsRepo.deleteWithContents(general.id);
    } catch (e: any) {
      expect(e.code).toBe('protected');
    }
    expect(subjectsRepo.getBySlug('general')).not.toBeNull();
  });

  it('refuses to delete a subject with inbound cross-subject references', async () => {
    const { randomUUID } = await import('crypto');
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();

    const target = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'Target' });
    const other = subjectsRepo.create({ slug: `o-${randomUUID().slice(0, 8)}`, name: 'Other' });
    // other 指向 target 的入站链接
    sqlite.prepare(`INSERT INTO wiki_links (subject_id, source_slug, target_subject_id, target_slug, context) VALUES (?,?,?,?,?)`)
      .run(other.id, 'o-page', target.id, 'page-a', '');

    expect(() => subjectsRepo.deleteWithContents(target.id)).toThrow(/referenced by other subjects/i);
    expect(subjectsRepo.getById(target.id)).not.toBeNull();
  });
});

describe('subjects-repo listInboundReferences', () => {
  it('returns distinct other-subject referrers, excluding intra-subject links', async () => {
    const { randomUUID } = await import('crypto');
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();

    const target = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'Target' });
    const other = subjectsRepo.create({ slug: `o-${randomUUID().slice(0, 8)}`, name: 'Other' });

    // 同一 other 两条入站（应去重为 1）+ 一条 target 自指（应排除）
    const ins = sqlite.prepare(`INSERT INTO wiki_links (subject_id, source_slug, target_subject_id, target_slug, context) VALUES (?,?,?,?,?)`);
    ins.run(other.id, 'p1', target.id, 'page-a', '');
    ins.run(other.id, 'p2', target.id, 'page-a', '');
    ins.run(target.id, 'page-a', target.id, 'page-a', '');

    const refs = subjectsRepo.listInboundReferences(target.id);
    expect(refs).toHaveLength(1);
    expect(refs[0].slug).toBe(other.slug);

    expect(subjectsRepo.listInboundReferences(other.id)).toHaveLength(0);
  });
});

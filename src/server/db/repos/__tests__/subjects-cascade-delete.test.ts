import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

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
function seedSubjectData(sqlite: BetterSqlite3.Database, subjectId: string) {
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
  sqlite.prepare(`INSERT INTO page_rendition_assets (id, subject_id, slug, media_type, data_base64, created_at) VALUES (?,?,?,?,?,?)`)
    .run(`rendition-asset-${subjectId}`, subjectId, 'page-a', 'image/png', 'AQ==', now);
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
  'page_embeddings', 'page_maturity', 'page_renditions', 'page_rendition_assets', 'profile_signals',
  'conversations', 'operations', 'jobs', 'pages_fts', 'research_backlog',
];

function totalRowsForSubject(sqlite: BetterSqlite3.Database, subjectId: string): number {
  let total = 0;
  for (const t of SUBJECT_TABLES) {
    const r = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE subject_id = ?`).get(subjectId) as { c: number };
    total += Number(r.c);
  }
  return total;
}

describe('subjects-repo deleteWithContents', () => {
  it('两阶段删除先领取维护权，再用同一 epoch 提交 DB 删除', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();
    const target = subjectsRepo.create({ slug: 'claimed-target', name: 'Claimed' });

    const claim = subjectsRepo.beginDeleteMaintenance(target.id);

    expect(claim).toMatchObject({ id: target.id, slug: target.slug, mutationEpoch: 0 });
    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(target.id)).toEqual({ maintenance_state: 'resetting', mutation_epoch: 0 });
    subjectsRepo.deleteWithContents(target.id, {
      expectedMutationEpoch: claim.mutationEpoch,
    });
    expect(subjectsRepo.getById(target.id)).toBeNull();
  });

  it('取消两阶段删除时恢复 active 并提升 epoch', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();
    const target = subjectsRepo.create({ slug: 'cancel-target', name: 'Cancel' });
    const claim = subjectsRepo.beginDeleteMaintenance(target.id);

    subjectsRepo.cancelDeleteMaintenance(target.id, claim.mutationEpoch);

    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(target.id)).toEqual({ maintenance_state: 'active', mutation_epoch: 1 });
  });

  it('领取维护权后出现 active job 时在 purge 事务内再次拒绝', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();
    const target = subjectsRepo.create({ slug: 'raced-target', name: 'Raced' });
    const claim = subjectsRepo.beginDeleteMaintenance(target.id);
    sqlite.prepare(`
      INSERT INTO jobs (id, type, status, subject_id, params_json, created_at)
      VALUES ('late-job', 'ingest', 'pending', ?, '{}', ?)
    `).run(target.id, new Date().toISOString());

    expect(() => subjectsRepo.deleteWithContents(target.id, {
      expectedMutationEpoch: claim.mutationEpoch,
    })).toThrow(/still active/i);

    expect(subjectsRepo.getById(target.id)).not.toBeNull();
    expect(sqlite.prepare(`SELECT mutation_epoch FROM subjects WHERE id = ?`).get(target.id))
      .toEqual({ mutation_epoch: 0 });
  });

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
    } catch (error) {
      expect((error as { code?: string }).code).toBe('protected');
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

  it('在同一事务内拒绝 subject 或全局 active job', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();
    const target = subjectsRepo.create({ slug: 'busy-target', name: 'Busy' });
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO jobs (id, type, status, subject_id, params_json, created_at) VALUES (?,?,?,?,?,?)`)
      .run('busy-job', 'ingest', 'pending', target.id, '{}', now);

    expect(() => subjectsRepo.deleteWithContents(target.id)).toThrow(/still active/i);
    expect(subjectsRepo.getById(target.id)).not.toBeNull();
    sqlite.prepare(`UPDATE jobs SET status = 'completed' WHERE id = 'busy-job'`).run();
    sqlite.prepare(`INSERT INTO jobs (id, type, status, subject_id, params_json, created_at) VALUES (?,?,?,?,?,?)`)
      .run('global-job', 'lint', 'running', null, '{}', now);
    expect(() => subjectsRepo.deleteWithContents(target.id)).toThrow(/global jobs/i);
  });

  it('删除 Subject 时同步清除全部 Research provenance', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();
    const target = subjectsRepo.create({ slug: 'provenance-target', name: 'Provenance' });
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO research_runs (
        id, subject_id, research_job_id, origin, candidate_set_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'topic', 'hash', 'awaiting-approval', ?, ?)
    `).run('run-delete', target.id, 'research-job-delete', now, now);
    sqlite.prepare(`
      INSERT INTO research_candidates (id, run_id, normalized_url, snapshot_json, rank)
      VALUES ('candidate-delete', 'run-delete', 'https://example.com', '{}', 0)
    `).run();

    subjectsRepo.deleteWithContents(target.id);

    expect((sqlite.prepare(`SELECT COUNT(*) AS count FROM research_runs WHERE id = 'run-delete'`).get() as { count: number }).count).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS count FROM research_candidates WHERE run_id = 'run-delete'`).get() as { count: number }).count).toBe(0);
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

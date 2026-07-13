import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let previousDatabasePath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'research-provenance-schema-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = '2026-07-13T00:00:00.000Z';

async function database() {
  const { getRawDb } = await import('../client');
  return getRawDb();
}

function insertSubject(
  db: Awaited<ReturnType<typeof database>>,
  id: string,
  slug: string,
) {
  db.prepare(`
    INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, ?)
  `).run(id, slug, slug, NOW, NOW);
}

function insertRun(
  db: Awaited<ReturnType<typeof database>>,
  id: string,
  subjectId: string,
  researchJobId: string,
) {
  db.prepare(`
    INSERT INTO research_runs (
      id, subject_id, research_job_id, origin, lint_job_id, topic,
      topics_json, queries_json, candidate_set_hash, status, version,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'topic', NULL, 'topic', '[]', '[]', ?, 'awaiting-approval', 1, ?, ?)
  `).run(id, subjectId, researchJobId, `hash-${id}`, NOW, NOW);
}

describe('Research provenance schema', () => {
  it('创建五张 provenance 表与 Subject maintenance 字段', async () => {
    const db = await database();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'research_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'research_runs',
      'research_run_findings',
      'research_candidates',
      'research_approvals',
      'research_candidate_ingests',
    ]));

    const subjectColumns = db.prepare(`PRAGMA table_info(subjects)`).all() as Array<{ name: string }>;
    expect(subjectColumns.map((row) => row.name)).toEqual(expect.arrayContaining([
      'maintenance_state',
      'mutation_epoch',
    ]));

    const findingColumns = db.prepare(`PRAGMA table_info(research_run_findings)`).all() as Array<{ name: string }>;
    expect(findingColumns.map((row) => row.name)).toEqual(expect.arrayContaining([
      'snapshot_json',
      'verification_status',
      'verified_at',
      'verification_snapshot_json',
    ]));
  });

  it('拒绝非法状态、decision 与 verification status', async () => {
    const db = await database();
    insertSubject(db, 's1', 'subject-one');

    expect(() => db.prepare(`
      INSERT INTO research_runs (
        id, subject_id, research_job_id, origin, topics_json, queries_json,
        candidate_set_hash, status, version, created_at, updated_at
      ) VALUES ('run-bad', 's1', 'job-bad', 'topic', '[]', '[]', 'h', 'unknown', 1, ?, ?)
    `).run(NOW, NOW)).toThrow();

    insertRun(db, 'run-1', 's1', 'job-1');
    expect(() => db.prepare(`
      INSERT INTO research_run_findings
        (run_id, finding_id, snapshot_json, verification_status)
      VALUES ('run-1', 'finding-1', '{}', 'unknown')
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO research_candidates
        (id, run_id, normalized_url, snapshot_json, rank, decision)
      VALUES ('candidate-1', 'run-1', 'https://example.com', '{}', 0, 'unknown')
    `).run()).toThrow();
  });

  it('source identity、researchJobId、run approval 与 ingestJobId 均唯一', async () => {
    const db = await database();
    insertSubject(db, 's1', 'subject-one');
    db.prepare(`
      INSERT INTO sources (id, subject_id, filename, content_hash, metadata_json)
      VALUES ('source-1', 's1', 'a.md', 'hash-a', '{}')
    `).run();
    expect(() => db.prepare(`
      INSERT INTO sources (id, subject_id, filename, content_hash, metadata_json)
      VALUES ('source-2', 's1', 'a.md', 'hash-a', '{}')
    `).run()).toThrow();

    insertRun(db, 'run-1', 's1', 'job-1');
    expect(() => insertRun(db, 'run-2', 's1', 'job-1')).toThrow();
    db.prepare(`
      INSERT INTO research_approvals (
        id, run_id, selected_candidate_ids_json, payload_hash,
        idempotency_key, coordinator_job_id, created_at
      ) VALUES ('approval-1', 'run-1', '[]', 'payload-1', 'key-1', 'coordinator-1', ?)
    `).run(NOW);
    expect(() => db.prepare(`
      INSERT INTO research_approvals (
        id, run_id, selected_candidate_ids_json, payload_hash,
        idempotency_key, coordinator_job_id, created_at
      ) VALUES ('approval-2', 'run-1', '[]', 'payload-2', 'key-2', 'coordinator-2', ?)
    `).run(NOW)).toThrow();

    db.prepare(`
      INSERT INTO research_candidates (
        id, run_id, normalized_url, snapshot_json, rank, decision, approval_id, decided_at
      ) VALUES ('candidate-1', 'run-1', 'https://example.com', '{}', 0, 'approved', 'approval-1', ?)
    `).run(NOW);
    db.prepare(`
      INSERT INTO research_candidate_ingests (
        approval_id, candidate_id, run_id, normalized_url, status,
        ingest_job_id, operation_ids_json, touched_pages_json,
        attempt_count, created_at, updated_at
      ) VALUES ('approval-1', 'candidate-1', 'run-1', 'https://example.com',
        'queued', 'ingest-1', '[]', '[]', 1, ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO research_candidates (
        id, run_id, normalized_url, snapshot_json, rank, decision, approval_id, decided_at
      ) VALUES ('candidate-2', 'run-1', 'https://example.com/two', '{}', 1, 'approved', 'approval-1', ?)
    `).run(NOW);
    expect(() => db.prepare(`
      INSERT INTO research_candidate_ingests (
        approval_id, candidate_id, run_id, normalized_url, status,
        ingest_job_id, operation_ids_json, touched_pages_json,
        attempt_count, created_at, updated_at
      ) VALUES ('approval-1', 'candidate-2', 'run-1', 'https://example.com/two',
        'queued', 'ingest-1', '[]', '[]', 1, ?, ?)
    `).run(NOW, NOW)).toThrow();
  });

  it('复合外键拒绝跨 run 的 candidate approval 与 delivery', async () => {
    const db = await database();
    insertSubject(db, 's1', 'subject-one');
    insertRun(db, 'run-1', 's1', 'job-1');
    insertRun(db, 'run-2', 's1', 'job-2');
    db.prepare(`
      INSERT INTO research_approvals (
        id, run_id, selected_candidate_ids_json, payload_hash,
        idempotency_key, coordinator_job_id, created_at
      ) VALUES ('approval-1', 'run-1', '[]', 'payload-1', 'key-1', 'coordinator-1', ?)
    `).run(NOW);

    expect(() => db.prepare(`
      INSERT INTO research_candidates (
        id, run_id, normalized_url, snapshot_json, rank, decision, approval_id, decided_at
      ) VALUES ('candidate-cross', 'run-2', 'https://example.com/cross', '{}', 0,
        'approved', 'approval-1', ?)
    `).run(NOW)).toThrow();

    db.prepare(`
      INSERT INTO research_candidates (
        id, run_id, normalized_url, snapshot_json, rank, decision
      ) VALUES ('candidate-2', 'run-2', 'https://example.com/two', '{}', 0, 'pending')
    `).run();
    expect(() => db.prepare(`
      INSERT INTO research_candidate_ingests (
        approval_id, candidate_id, run_id, normalized_url, status,
        operation_ids_json, touched_pages_json, attempt_count, created_at, updated_at
      ) VALUES ('approval-1', 'candidate-2', 'run-2', 'https://example.com/two',
        'pending', '[]', '[]', 0, ?, ?)
    `).run(NOW, NOW)).toThrow();
  });
});

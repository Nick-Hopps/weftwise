import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let previousDatabasePath: string | undefined;
let previousVaultPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-ingest-tx-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  previousVaultPath = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  process.env.VAULT_PATH = previousVaultPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('persistSourceAndEnqueueIngest', () => {
  it('在同一写事务中落地 source 与 pending ingest job', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const { getRawDb } = await import('../../db/client');
    const {
      acquireSubjectWriteLease,
      persistSourceAndEnqueueIngest,
    } = await import('../source-ingest-transaction');
    const subject = subjectsRepo.getBySlug('general')!;
    const result = persistSourceAndEnqueueIngest({
      subject,
      lease: acquireSubjectWriteLease(subject.id),
      filename: 'a.md',
      content: '# A',
    });

    const sqlite = getRawDb();
    expect(sqlite.prepare(`SELECT id FROM sources WHERE id = ?`).get(result.sourceId)).toBeTruthy();
    const job = sqlite.prepare(`SELECT * FROM jobs WHERE id = ?`).get(result.job.id) as {
      type: string;
      status: string;
      subject_id: string;
      params_json: string;
    };
    expect(job).toMatchObject({ type: 'ingest', status: 'pending', subject_id: subject.id });
    expect(JSON.parse(job.params_json)).toMatchObject({
      sourceId: result.sourceId,
      filename: 'a.md',
      subjectId: subject.id,
    });
  });

  it('重复 identity 复用 canonical source 且只保留一个 sidecar', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const { getRawDb } = await import('../../db/client');
    const tx = await import('../source-ingest-transaction');
    const subject = subjectsRepo.getBySlug('general')!;
    const lease = tx.acquireSubjectWriteLease(subject.id);
    const first = tx.persistSourceAndEnqueueIngest({
      subject,
      lease,
      filename: 'same.md',
      content: 'same',
    });
    const second = tx.persistSourceAndEnqueueIngest({
      subject,
      lease,
      filename: 'same.md',
      content: 'same',
    });

    expect(second.sourceId).toBe(first.sourceId);
    expect((getRawDb().prepare(`SELECT COUNT(*) AS count FROM sources`).get() as { count: number }).count).toBe(1);
    expect(readdirSync(join(dir, 'vault', '.llm-wiki', 'sources', 'general'))).toEqual([
      `${first.sourceId}.json`,
    ]);
  });

  it('reset 提升 epoch 后拒绝旧 lease，且不重建文件、source 或 job', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const { getRawDb } = await import('../../db/client');
    const tx = await import('../source-ingest-transaction');
    const subject = subjectsRepo.getBySlug('general')!;
    const lease = tx.acquireSubjectWriteLease(subject.id);
    getRawDb().prepare(`UPDATE subjects SET mutation_epoch = mutation_epoch + 1 WHERE id = ?`).run(subject.id);

    expect(() => tx.persistSourceAndEnqueueIngest({
      subject,
      lease,
      filename: 'late.md',
      content: 'late',
    })).toThrow(/抓取期间变更/);
    expect((getRawDb().prepare(`SELECT COUNT(*) AS count FROM sources`).get() as { count: number }).count).toBe(0);
    expect((getRawDb().prepare(`SELECT COUNT(*) AS count FROM jobs`).get() as { count: number }).count).toBe(0);
    expect(existsSync(join(dir, 'vault', 'raw', 'general', 'late.md'))).toBe(false);
  });

  it('Subject 被删除后旧 lease 失效', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const tx = await import('../source-ingest-transaction');
    const subject = subjectsRepo.create({ slug: 'doomed', name: 'Doomed' });
    const lease = tx.acquireSubjectWriteLease(subject.id);
    subjectsRepo.deleteWithContents(subject.id);

    expect(() => tx.persistSourceAndEnqueueIngest({
      subject,
      lease,
      filename: 'late.md',
      content: 'late',
    })).toThrow(/已不存在/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveSubject: vi.fn(),
  rebuild: vi.fn(),
  commit: vi.fn(),
}));

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: () => null,
  requireCsrf: () => null,
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => mocks.resolveSubject(...args),
}));
vi.mock('@/server/wiki/indexer', () => ({
  rebuildPageIndex: (...args: unknown[]) => mocks.rebuild(...args),
}));
vi.mock('@/server/git/git-service', () => ({
  commitVaultChanges: (...args: unknown[]) => mocks.commit(...args),
  ensureVaultRuntimeExcludes: vi.fn(),
}));

let dir: string;
let previousDatabasePath: string | undefined;
let previousVaultPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reset-route-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  previousVaultPath = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
  vi.clearAllMocks();
  mocks.rebuild.mockReset();
  mocks.commit.mockReset().mockResolvedValue('sha');
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  process.env.VAULT_PATH = previousVaultPath;
  rmSync(dir, { recursive: true, force: true });
});

function request(body: unknown) {
  return new NextRequest('http://localhost/api/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/reset', () => {
  it('有 subject active job 时返回 409，且不提升 epoch', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    getRawDb().prepare(`
      INSERT INTO jobs (id, type, status, subject_id, params_json, created_at)
      VALUES ('active-ingest', 'ingest', 'pending', ?, '{}', ?)
    `).run(subject.id, new Date().toISOString());
    const { POST } = await import('../route');

    const response = await POST(request({ subjectId: subject.id }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'active-jobs' });
    expect(getRawDb().prepare(`SELECT mutation_epoch FROM subjects WHERE id = ?`).get(subject.id))
      .toEqual({ mutation_epoch: 0 });
  });

  it('全局 active job 同样阻止单 Subject reset', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    getRawDb().prepare(`
      INSERT INTO jobs (id, type, status, subject_id, params_json, created_at)
      VALUES ('global-lint', 'lint', 'running', NULL, '{}', ?)
    `).run(new Date().toISOString());
    const { POST } = await import('../route');

    const response = await POST(request({ subjectId: subject.id }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'active-jobs' });
  });

  it('领取维护权后出现 active job 时返回 409 并恢复目录', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    const sqlite = getRawDb();
    const wikiDir = join(dir, 'vault', 'wiki', 'general');
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, 'old.md'), '# Old');
    const realWriteFileSync = fs.writeFileSync.bind(fs);
    let injected = false;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
      const result = realWriteFileSync(target, data, options);
      if (!injected && String(target).endsWith(join('wiki', 'general', 'index.md'))) {
        injected = true;
        sqlite.prepare(`
          INSERT INTO jobs (id, type, status, subject_id, params_json, created_at)
          VALUES ('late-ingest', 'ingest', 'pending', ?, '{}', ?)
        `).run(subject.id, new Date().toISOString());
      }
      return result;
    });
    const { POST } = await import('../route');

    const response = await POST(request({ subjectId: subject.id }));

    writeSpy.mockRestore();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'active-jobs' });
    expect(readFileSync(join(wikiDir, 'old.md'), 'utf-8')).toBe('# Old');
    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(subject.id)).toEqual({ maintenance_state: 'active', mutation_epoch: 1 });
  });

  it('无 active job 时清除 source/job/Research provenance 并恢复 active', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    const sqlite = getRawDb();
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO sources (id, subject_id, filename, content_hash, metadata_json) VALUES ('s1', ?, 'a.md', 'h1', '{}')`).run(subject.id);
    sqlite.prepare(`INSERT INTO jobs (id, type, status, subject_id, params_json, created_at) VALUES ('j1', 'ingest', 'completed', ?, '{}', ?)`).run(subject.id, now);
    sqlite.prepare(`
      INSERT INTO research_runs (
        id, subject_id, research_job_id, origin, candidate_set_hash, status, created_at, updated_at
      ) VALUES ('r1', ?, 'research-j1', 'topic', 'hash', 'awaiting-approval', ?, ?)
    `).run(subject.id, now, now);
    sqlite.prepare(`INSERT INTO research_candidates (id, run_id, normalized_url, snapshot_json, rank) VALUES ('c1', 'r1', 'https://example.com', '{}', 0)`).run();
    mocks.rebuild.mockImplementation(() => {
      expect(existsSync(join(dir, '.vault.lock'))).toBe(true);
    });
    const { POST } = await import('../route');

    const response = await POST(request({ subjectId: subject.id }));

    expect(response.status).toBe(200);
    expect(sqlite.prepare(`SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?`).get(subject.id))
      .toEqual({ maintenance_state: 'active', mutation_epoch: 1 });
    expect((sqlite.prepare(`SELECT COUNT(*) AS count FROM sources`).get() as { count: number }).count).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE subject_id = ?`).get(subject.id) as { count: number }).count).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS count FROM research_runs`).get() as { count: number }).count).toBe(0);
    expect(existsSync(join(dir, 'vault', 'wiki', 'general', 'index.md'))).toBe(true);
    expect(existsSync(join(dir, 'vault', 'wiki', 'general', 'log.md'))).toBe(true);
    expect(existsSync(join(dir, '.vault.lock'))).toBe(false);
  });

  it('维护步骤失败时仍恢复 active，但保留已提升的 epoch', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    const sqlite = getRawDb();
    sqlite.prepare(`INSERT INTO sources (id, subject_id, filename, content_hash, metadata_json) VALUES ('keep-source', ?, 'keep.md', 'keep-hash', '{}')`).run(subject.id);
    const wikiDir = join(dir, 'vault', 'wiki', 'general');
    const rawDir = join(dir, 'vault', 'raw', 'general');
    mkdirSync(wikiDir, { recursive: true });
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(wikiDir, 'old.md'), '# Old');
    writeFileSync(join(rawDir, 'keep.md'), 'keep');
    mocks.rebuild.mockImplementation(() => {
      throw new Error('rebuild failed');
    });
    const { POST } = await import('../route');

    await expect(POST(request({ subjectId: subject.id }))).rejects.toThrow('rebuild failed');
    expect(getRawDb().prepare(`SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?`).get(subject.id))
      .toEqual({ maintenance_state: 'active', mutation_epoch: 1 });
    expect(getRawDb().prepare(`SELECT id FROM sources WHERE id = 'keep-source'`).get())
      .toEqual({ id: 'keep-source' });
    expect(readFileSync(join(wikiDir, 'old.md'), 'utf-8')).toBe('# Old');
    expect(readFileSync(join(rawDir, 'keep.md'), 'utf-8')).toBe('keep');
  });

  it('目录补偿失败时保留 resetting 与旧 epoch，下次启动再恢复', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    const sqlite = getRawDb();
    const wikiDir = join(dir, 'vault', 'wiki', 'general');
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, 'old.md'), '# Old');
    mocks.rebuild.mockImplementation(() => {
      throw new Error('rebuild failed');
    });
    const realRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === wikiDir) throw new Error('restore failed');
      return realRmSync(target, options);
    });
    const { POST } = await import('../route');

    await expect(POST(request({ subjectId: subject.id }))).rejects.toThrow('restore failed');

    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(subject.id)).toEqual({ maintenance_state: 'resetting', mutation_epoch: 0 });
    expect(readFileSync(join(wikiDir, 'index.md'), 'utf-8')).toContain('has been reset');

    rmSpy.mockRestore();
    const { recoverInterruptedVaultMaintenance } = await import('@/server/wiki/maintenance-files');
    recoverInterruptedVaultMaintenance(sqlite);

    expect(readFileSync(join(wikiDir, 'old.md'), 'utf-8')).toBe('# Old');
    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(subject.id)).toEqual({ maintenance_state: 'active', mutation_epoch: 1 });
  });
});

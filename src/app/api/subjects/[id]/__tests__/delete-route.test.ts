import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
}));

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: () => null,
  requireCsrf: () => null,
}));
vi.mock('@/server/git/git-service', () => ({
  commitVaultChanges: (...args: unknown[]) => mocks.commit(...args),
  ensureVaultRuntimeExcludes: vi.fn(),
}));

let dir: string;
let previousDatabasePath: string | undefined;
let previousVaultPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subject-delete-route-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  previousVaultPath = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
  mocks.commit.mockReset().mockResolvedValue('sha');
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  process.env.VAULT_PATH = previousVaultPath;
  rmSync(dir, { recursive: true, force: true });
});

function request(id: string) {
  return new NextRequest(`http://localhost/api/subjects/${id}`, { method: 'DELETE' });
}

describe('DELETE /api/subjects/[id]', () => {
  it('active job 在移动目录前返回 409，并保留原 vault 内容', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const target = subjectsRepo.create({ slug: 'busy-delete', name: 'Busy Delete' });
    const wikiDir = join(dir, 'vault', 'wiki', target.slug);
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, 'keep.md'), '# Keep');
    getRawDb().prepare(`
      INSERT INTO jobs (id, type, status, subject_id, params_json, created_at)
      VALUES ('busy-delete-job', 'ingest', 'pending', ?, '{}', ?)
    `).run(target.id, new Date().toISOString());
    const { DELETE } = await import('../route');

    const response = await DELETE(request(target.id), {
      params: Promise.resolve({ id: target.id }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'active-jobs' });
    expect(readFileSync(join(wikiDir, 'keep.md'), 'utf-8')).toBe('# Keep');
    expect(subjectsRepo.getById(target.id)).not.toBeNull();
    expect(getRawDb().prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(target.id)).toEqual({ maintenance_state: 'active', mutation_epoch: 0 });
    expect(existsSync(join(dir, '.vault.lock'))).toBe(false);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('成功路径删除 DB 与 vault，并清理维护备份', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const target = subjectsRepo.create({ slug: 'delete-ok', name: 'Delete OK' });
    const wikiDir = join(dir, 'vault', 'wiki', target.slug);
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, 'old.md'), '# Old');
    const { DELETE } = await import('../route');

    const response = await DELETE(request(target.id), {
      params: Promise.resolve({ id: target.id }),
    });

    expect(response.status).toBe(200);
    expect(subjectsRepo.getById(target.id)).toBeNull();
    expect(existsSync(wikiDir)).toBe(false);
    expect(existsSync(join(dir, '.vault.lock'))).toBe(false);
    expect(mocks.commit).toHaveBeenCalledWith(
      expect.stringContaining('[subject:delete-ok]'),
      [
        'wiki/delete-ok',
        'raw/delete-ok',
        '.llm-wiki/sources/delete-ok',
      ],
    );
  });

  it('删除失败且目录补偿也失败时，保留维护态供启动恢复', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const sqlite = getRawDb();
    const target = subjectsRepo.create({ slug: 'delete-recover', name: 'Delete Recover' });
    const wikiDir = join(dir, 'vault', 'wiki', target.slug);
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, 'old.md'), '# Old');
    sqlite.exec(`
      CREATE TRIGGER reject_subject_delete
      BEFORE DELETE ON subjects
      WHEN OLD.id = '${target.id}'
      BEGIN
        SELECT RAISE(ABORT, 'delete failed');
      END
    `);
    const realRmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((pathToRemove, options) => {
      if (String(pathToRemove) === wikiDir) throw new Error('restore failed');
      return realRmSync(pathToRemove, options);
    });
    const { DELETE } = await import('../route');

    await expect(DELETE(request(target.id), {
      params: Promise.resolve({ id: target.id }),
    })).rejects.toThrow('restore failed');

    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(target.id)).toEqual({ maintenance_state: 'resetting', mutation_epoch: 0 });

    rmSpy.mockRestore();
    sqlite.exec('DROP TRIGGER reject_subject_delete');
    const { recoverInterruptedVaultMaintenance } = await import('@/server/wiki/maintenance-files');
    recoverInterruptedVaultMaintenance(sqlite);

    expect(readFileSync(join(wikiDir, 'old.md'), 'utf-8')).toBe('# Old');
    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = ?
    `).get(target.id)).toEqual({ maintenance_state: 'active', mutation_epoch: 1 });
  });
});

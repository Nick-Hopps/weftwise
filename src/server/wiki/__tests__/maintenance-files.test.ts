import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

let dir: string;
let previousVaultPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maintenance-files-'));
  previousVaultPath = process.env.VAULT_PATH;
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  process.env.VAULT_PATH = previousVaultPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('stageVaultPaths', () => {
  it('失败补偿时删除新目录并恢复原目录内容', async () => {
    const target = join(dir, 'vault', 'wiki', 'general');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'old.md'), '# Old');
    const { stageVaultPaths } = await import('../maintenance-files');
    const staged = stageVaultPaths([target], {
      markerSubjectId: 's1',
      expectedEpoch: 0,
      subjectIds: ['s1'],
    });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'new.md'), '# New');

    staged.restore();

    expect(readFileSync(join(target, 'old.md'), 'utf-8')).toBe('# Old');
    expect(existsSync(join(target, 'new.md'))).toBe(false);
  });

  it('备份位于 vault 挂载点内，成功后 discard 删除备份且不重建目标', async () => {
    const target = join(dir, 'vault', 'raw', 'general');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(dir, 'vault', '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, 'vault', '.git', 'info', 'exclude'), '# local\n');
    writeFileSync(join(target, 'old.md'), 'old');
    const { stageVaultPaths } = await import('../maintenance-files');
    const staged = stageVaultPaths([target], {
      markerSubjectId: 's1',
      expectedEpoch: 0,
      subjectIds: ['s1'],
    });

    expect(listMaintenanceBackups()).toHaveLength(1);
    expect(readFileSync(join(dir, 'vault', '.git', 'info', 'exclude'), 'utf-8'))
      .toContain('.llm-wiki/maintenance/');

    staged.discard();

    expect(existsSync(target)).toBe(false);
    expect(listMaintenanceBackups()).toHaveLength(0);
  });

  it('死进程未提交 DB 时按 manifest 恢复目录并解除维护态', async () => {
    const target = join(dir, 'vault', 'wiki', 'topic');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'old.md'), '# Old');
    const sqlite = createMaintenanceDb();
    const { recoverInterruptedVaultMaintenance, stageVaultPaths } = await import('../maintenance-files');
    stageVaultPaths([target], {
      markerSubjectId: 's1',
      expectedEpoch: 4,
      subjectIds: ['s1'],
    });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'new.md'), '# New');
    markManifestOwnerDead();

    recoverInterruptedVaultMaintenance(sqlite);

    expect(readFileSync(join(target, 'old.md'), 'utf-8')).toBe('# Old');
    expect(existsSync(join(target, 'new.md'))).toBe(false);
    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = 's1'
    `).get()).toEqual({ maintenance_state: 'active', mutation_epoch: 5 });
    sqlite.close();
  });

  it('死进程已提升 epoch 时丢弃备份并保留提交后的目录', async () => {
    const target = join(dir, 'vault', 'wiki', 'topic');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'old.md'), '# Old');
    const sqlite = createMaintenanceDb();
    const { recoverInterruptedVaultMaintenance, stageVaultPaths } = await import('../maintenance-files');
    stageVaultPaths([target], {
      markerSubjectId: 's1',
      expectedEpoch: 4,
      subjectIds: ['s1'],
    });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'new.md'), '# New');
    sqlite.prepare(`UPDATE subjects SET mutation_epoch = 5`).run();
    markManifestOwnerDead();

    recoverInterruptedVaultMaintenance(sqlite);

    expect(readFileSync(join(target, 'new.md'), 'utf-8')).toBe('# New');
    expect(existsSync(join(target, 'old.md'))).toBe(false);
    expect(listMaintenanceBackups()).toHaveLength(0);
    sqlite.close();
  });

  it('任何活跃 vault 锁都跳过恢复，锁释放后定时重试', async () => {
    vi.useFakeTimers();
    const target = join(dir, 'vault', 'wiki', 'topic');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'old.md'), '# Old');
    const sqlite = createMaintenanceDb();
    const { recoverInterruptedVaultMaintenance, stageVaultPaths } = await import('../maintenance-files');
    stageVaultPaths([target], {
      markerSubjectId: 's1',
      expectedEpoch: 4,
      subjectIds: ['s1'],
    });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'new.md'), '# New');
    // 使用不同 owner PID，证明恢复不依赖 PID namespace 匹配。
    writeFileSync(join(dir, '.vault.lock'), String(process.pid + 100_000));

    recoverInterruptedVaultMaintenance(sqlite);

    expect(readFileSync(join(target, 'new.md'), 'utf-8')).toBe('# New');
    expect(sqlite.prepare(`SELECT maintenance_state FROM subjects WHERE id = 's1'`).get())
      .toEqual({ maintenance_state: 'resetting' });

    unlinkSync(join(dir, '.vault.lock'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readFileSync(join(target, 'old.md'), 'utf-8')).toBe('# Old');
    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = 's1'
    `).get()).toEqual({ maintenance_state: 'active', mutation_epoch: 5 });
    sqlite.close();
  });

  it('claim 后、manifest 前崩溃时恢复孤儿维护态并提升 epoch', async () => {
    const sqlite = createMaintenanceDb();
    const { recoverInterruptedVaultMaintenance } = await import('../maintenance-files');

    recoverInterruptedVaultMaintenance(sqlite);

    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = 's1'
    `).get()).toEqual({ maintenance_state: 'active', mutation_epoch: 5 });
    sqlite.close();
  });

  it('manifest 损坏时 fail-closed，不恢复 active 也不消费备份', async () => {
    vi.useFakeTimers();
    const target = join(dir, 'vault', 'wiki', 'topic');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'old.md'), '# Old');
    const sqlite = createMaintenanceDb();
    const { recoverInterruptedVaultMaintenance, stageVaultPaths } = await import('../maintenance-files');
    stageVaultPaths([target], {
      markerSubjectId: 's1',
      expectedEpoch: 4,
      subjectIds: ['s1'],
    });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'new.md'), '# New');
    const backupRoot = listMaintenanceBackups()[0];
    if (!backupRoot) throw new Error('maintenance manifest not found');
    const manifestPath = join(backupRoot, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ version: 1 }), 'utf-8');

    expect(recoverInterruptedVaultMaintenance(sqlite)).toBe(false);

    expect(readFileSync(join(target, 'new.md'), 'utf-8')).toBe('# New');
    expect(listMaintenanceBackups()).toHaveLength(1);
    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = 's1'
    `).get()).toEqual({ maintenance_state: 'resetting', mutation_epoch: 4 });
    sqlite.close();
  });

  it('manifest 路径越界时 fail-closed，不删除备份', async () => {
    vi.useFakeTimers();
    const target = join(dir, 'vault', 'wiki', 'topic');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'old.md'), '# Old');
    const sqlite = createMaintenanceDb();
    const { recoverInterruptedVaultMaintenance, stageVaultPaths } = await import('../maintenance-files');
    stageVaultPaths([target], {
      markerSubjectId: 's1',
      expectedEpoch: 4,
      subjectIds: ['s1'],
    });
    const backupRoot = listMaintenanceBackups()[0];
    if (!backupRoot) throw new Error('maintenance manifest not found');
    const manifestPath = join(backupRoot, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      entries: Array<{ target: string }>;
    };
    manifest.entries[0].target = join(dir, 'outside-vault');
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

    expect(recoverInterruptedVaultMaintenance(sqlite)).toBe(false);

    expect(listMaintenanceBackups()).toHaveLength(1);
    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = 's1'
    `).get()).toEqual({ maintenance_state: 'resetting', mutation_epoch: 4 });
    sqlite.close();
  });

  it('维护根目录不可枚举时 fail-closed，只有 ENOENT 可视为无 manifest', async () => {
    vi.useFakeTimers();
    const sqlite = createMaintenanceDb();
    const root = join(dir, 'vault', '.llm-wiki', 'maintenance');
    mkdirSync(root, { recursive: true });
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((
      ((target: fs.PathLike) => {
        if (String(target) === root) {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return [];
      }) as typeof fs.readdirSync
    ));
    const { recoverInterruptedVaultMaintenance } = await import('../maintenance-files');

    expect(recoverInterruptedVaultMaintenance(sqlite)).toBe(false);
    readdirSpy.mockRestore();

    expect(sqlite.prepare(`
      SELECT maintenance_state, mutation_epoch FROM subjects WHERE id = 's1'
    `).get()).toEqual({ maintenance_state: 'resetting', mutation_epoch: 4 });
    sqlite.close();
  });
});

function createMaintenanceDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE subjects (
      id TEXT PRIMARY KEY,
      maintenance_state TEXT NOT NULL,
      mutation_epoch INTEGER NOT NULL
    );
    INSERT INTO subjects VALUES ('s1', 'resetting', 4);
  `);
  return sqlite;
}

function markManifestOwnerDead(): void {
  const backupRoot = listMaintenanceBackups()[0];
  if (!backupRoot) throw new Error('maintenance manifest not found');
  const manifestPath = join(backupRoot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  manifest.ownerPid = -1;
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
}

function listMaintenanceBackups(): string[] {
  const root = join(dir, 'vault', '.llm-wiki', 'maintenance');
  if (!existsSync(root)) return [];
  return readdirSync(root).map((name) => join(root, name));
}

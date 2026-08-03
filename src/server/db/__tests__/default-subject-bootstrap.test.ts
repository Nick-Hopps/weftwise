import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let dbPath: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'default-subject-boot-'));
  dbPath = join(dir, 'wiki.db');
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

/** 用当前 ensureTables 建好库，然后按 mutate 改数据、关连接，模拟「下次启动」。 */
async function bootThenMutate(mutate: (sqlite: Database.Database) => void) {
  const client = await import('../client');
  mutate(client.getRawDb());
  client.getRawDb().close();
  vi.resetModules();
}

function readSubjects(): Array<{ id: string; slug: string }> {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return sqlite.prepare(`SELECT id, slug FROM subjects ORDER BY slug`).all() as Array<{
      id: string;
      slug: string;
    }>;
  } finally {
    sqlite.close();
  }
}

describe('启动期默认 project 兜底', () => {
  it('空库首次启动补一个 general', async () => {
    const client = await import('../client');
    client.getDb();

    expect(readSubjects().map((row) => row.slug)).toEqual(['general']);
  });

  it('已有非 general project 且 general 已被删除时，重启不复活 general', async () => {
    await bootThenMutate((sqlite) => {
      const now = new Date().toISOString();
      sqlite
        .prepare(
          `INSERT INTO subjects (id, slug, name, description, augmentation_level, created_at, updated_at)
           VALUES ('phys', 'physics', 'Physics', '', 'standard', ?, ?)`,
        )
        .run(now, now);
      sqlite.prepare(`DELETE FROM subjects WHERE slug = 'general'`).run();
    });

    const client = await import('../client');
    client.getDb();

    expect(readSubjects().map((row) => row.slug)).toEqual(['physics']);
  });

  it('存量库里的 general 重启后 id 不变', async () => {
    let generalId = '';
    await bootThenMutate((sqlite) => {
      generalId = (
        sqlite.prepare(`SELECT id FROM subjects WHERE slug = 'general'`).get() as { id: string }
      ).id;
    });

    const client = await import('../client');
    client.getDb();

    expect(readSubjects()).toEqual([{ id: generalId, slug: 'general' }]);
  });
});

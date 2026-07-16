import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lens-tables-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => {
  process.env.DATABASE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

it('ensureTables 建出认知透镜表与持久化图片表', async () => {
  const { getRawDb } = await import('../client');
  const db = getRawDb();
  const names = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
  ).map((r) => r.name);
  expect(names).toContain('user_profiles');
  expect(names).toContain('page_renditions');
  expect(names).toContain('page_rendition_assets');
  expect(names).toContain('profile_signals');
});

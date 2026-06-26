import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'signals-repo-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => {
  process.env.DATABASE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

it('append + recent（DESC + limit + 按 user 隔离）', async () => {
  const repo = await import('../signals-repo');
  repo.appendSignal({ userId: 'u1', type: 'too_hard' });
  repo.appendSignal({ userId: 'u1', type: 'simplify_click', slug: 'a' });
  repo.appendSignal({ userId: 'u2', type: 'too_easy' });
  const r = repo.recentSignals('u1', 10);
  expect(r.map((x) => x.type)).toEqual(['simplify_click', 'too_hard']); // DESC
  expect(repo.recentSignals('u1', 1).map((x) => x.type)).toEqual(['simplify_click']);
});

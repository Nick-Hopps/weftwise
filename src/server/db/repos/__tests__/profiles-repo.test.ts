import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'profiles-repo-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => {
  process.env.DATABASE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('profiles-repo', () => {
  it('缺失时 getProfile=null、getProfileOrDefault 给默认 version=0', async () => {
    const repo = await import('../profiles-repo');
    expect(repo.getProfile('local')).toBeNull();
    const d = repo.getProfileOrDefault('local');
    expect(d.version).toBe(0);
    expect(d.stylePrefs.readingLevel).toBe('intermediate');
  });

  it('upsert 自增 version、round-trip stylePrefs、可标记 onboarded', async () => {
    const repo = await import('../profiles-repo');
    const p1 = repo.upsertProfile('local', {
      backgroundSummary: '我是后端工程师',
      stylePrefs: { readingLevel: 'advanced', verbosity: 'terse', exampleDensity: 'few', formality: 'formal' },
      markOnboarded: true,
    });
    expect(p1.version).toBe(1);
    expect(p1.onboardedAt).not.toBeNull();
    expect(p1.stylePrefs.readingLevel).toBe('advanced');

    const p2 = repo.upsertProfile('local', { backgroundSummary: '改了背景' });
    expect(p2.version).toBe(2);
    expect(p2.stylePrefs.readingLevel).toBe('advanced'); // 未传则保留
    expect(p2.backgroundSummary).toBe('改了背景');
    expect(repo.getProfile('local')!.version).toBe(2);
  });
});

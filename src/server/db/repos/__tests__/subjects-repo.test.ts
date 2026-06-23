import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subjects-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('subjects-repo augmentationLevel', () => {
  it('新建 subject 默认 augmentationLevel = standard', async () => {
    const { randomUUID } = await import('crypto');
    const subjectsRepo = await import('../subjects-repo');
    const s = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'T' });
    expect(s.augmentationLevel).toBe('standard');
  });

  it('setAugmentationLevel 持久化且 getById 可读回', async () => {
    const { randomUUID } = await import('crypto');
    const subjectsRepo = await import('../subjects-repo');
    const s = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'T' });
    const updated = subjectsRepo.setAugmentationLevel(s.id, 'deep');
    expect(updated.augmentationLevel).toBe('deep');
    expect(subjectsRepo.getById(s.id)?.augmentationLevel).toBe('deep');
  });
});

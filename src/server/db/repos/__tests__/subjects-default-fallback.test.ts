import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subjects-default-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

/** 清空 subjects 表，模拟「最后一个 project 刚被删掉」的瞬间。 */
async function emptySubjects() {
  const { getRawDb } = await import('../../client');
  getRawDb().prepare(`DELETE FROM subjects`).run();
}

describe('subjectsRepo.ensureDefaultSubject', () => {
  it('零 project 时新建一个 slug 为 general 的空 project', async () => {
    const subjectsRepo = await import('../subjects-repo');
    await emptySubjects();

    const result = subjectsRepo.ensureDefaultSubject();

    expect(result.created).toBe(true);
    expect(result.subject.slug).toBe('general');
    expect(result.subject.name).toBe('General');
    expect(result.subject.description).toBe('');
    expect(result.subject.augmentationLevel).toBe('standard');
    expect(subjectsRepo.listSubjects()).toHaveLength(1);
    expect(subjectsRepo.countPages(result.subject.id)).toBe(0);
  });

  it('general 已存在时原样返回，不新建', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const general = subjectsRepo.getBySlug('general')!;

    const result = subjectsRepo.ensureDefaultSubject();

    expect(result.created).toBe(false);
    expect(result.subject.id).toBe(general.id);
    expect(subjectsRepo.listSubjects()).toHaveLength(1);
  });

  it('只有非 general project 时返回它，不补 general', async () => {
    const subjectsRepo = await import('../subjects-repo');
    await emptySubjects();
    const only = subjectsRepo.create({ slug: 'physics', name: 'Physics' });

    const result = subjectsRepo.ensureDefaultSubject();

    expect(result.created).toBe(false);
    expect(result.subject.id).toBe(only.id);
    expect(subjectsRepo.getBySlug('general')).toBeNull();
  });

  it('与 ensureGeneralSubject 的分工：后者即使已有其他 project 也补建 general', async () => {
    const subjectsRepo = await import('../subjects-repo');
    await emptySubjects();
    subjectsRepo.create({ slug: 'physics', name: 'Physics' });

    expect(subjectsRepo.ensureDefaultSubject().created).toBe(false);
    expect(subjectsRepo.getBySlug('general')).toBeNull();

    const ensured = subjectsRepo.ensureGeneralSubject();

    expect(ensured.created).toBe(true);
    expect(ensured.subject.slug).toBe('general');
    expect(subjectsRepo.listSubjects().map((s) => s.slug)).toEqual(['general', 'physics']);
    expect(subjectsRepo.ensureGeneralSubject().created).toBe(false);
  });

  it('连续调用幂等：不会建出第二个 general', async () => {
    const subjectsRepo = await import('../subjects-repo');
    await emptySubjects();

    const first = subjectsRepo.ensureDefaultSubject();
    const second = subjectsRepo.ensureDefaultSubject();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.subject.id).toBe(first.subject.id);
    expect(subjectsRepo.listSubjects()).toHaveLength(1);
  });
});

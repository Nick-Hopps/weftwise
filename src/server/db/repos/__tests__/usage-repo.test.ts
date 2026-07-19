import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('usage-repo', () => {
  it('recordUsage 写入一行并可被 summarizeUsage 聚合', async () => {
    const repo = await import('../usage-repo');
    expect(repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 100, outputTokens: 20 })).toBe(true);
    expect(repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 50, outputTokens: 5 })).toBe(true);
    expect(repo.recordUsage({ task: 'lint', model: 'm2', inputTokens: 10, outputTokens: 1 })).toBe(true);
    const rows = repo.summarizeUsage();
    expect(rows).toEqual([
      { task: 'lint', model: 'm2', calls: 1, inputTokens: 10, outputTokens: 1 },
      { task: 'query', model: 'm1', calls: 2, inputTokens: 150, outputTokens: 25 },
    ]);
  });

  it('input/output 全缺失不写行；单侧缺失按 0；负数按 0', async () => {
    const repo = await import('../usage-repo');
    expect(repo.recordUsage({ task: 'query', model: 'm1' })).toBe(false);
    expect(repo.recordUsage({ task: 'query', model: 'm1', inputTokens: NaN, outputTokens: NaN })).toBe(false);
    expect(repo.recordUsage({ task: 'embedding', model: 'e1', inputTokens: 40 })).toBe(true);
    expect(repo.recordUsage({ task: 'query', model: 'm1', inputTokens: -5, outputTokens: 3 })).toBe(true);
    const rows = repo.summarizeUsage();
    expect(rows).toEqual([
      { task: 'embedding', model: 'e1', calls: 1, inputTokens: 40, outputTokens: 0 },
      { task: 'query', model: 'm1', calls: 1, inputTokens: 0, outputTokens: 3 },
    ]);
  });

  it('summarizeUsage(sinceMs) 只统计 created_at >= sinceMs 的行（含边界）', async () => {
    const repo = await import('../usage-repo');
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 1, outputTokens: 1 });
    vi.setSystemTime(2_000_000);
    repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 10, outputTokens: 10 });
    vi.useRealTimers();
    expect(repo.summarizeUsage({ sinceMs: 2_000_000 })).toEqual([
      { task: 'query', model: 'm1', calls: 1, inputTokens: 10, outputTokens: 10 },
    ]);
    expect(repo.summarizeUsage()).toEqual([
      { task: 'query', model: 'm1', calls: 2, inputTokens: 11, outputTokens: 11 },
    ]);
  });

  it('按 subjectId 过滤，并可与时间窗口组合', async () => {
    const repo = await import('../usage-repo');
    const subjectsRepo = await import('../subjects-repo');
    const general = subjectsRepo.getBySlug('general')!;
    const notes = subjectsRepo.create({ slug: 'notes', name: 'Notes' });

    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    repo.recordUsage({
      task: 'query', model: 'm1', inputTokens: 1, outputTokens: 1, subjectId: general.id,
    });
    vi.setSystemTime(2_000);
    repo.recordUsage({
      task: 'query', model: 'm1', inputTokens: 10, outputTokens: 5, subjectId: notes.id,
    });
    repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 100, outputTokens: 50 });
    vi.useRealTimers();

    expect(repo.summarizeUsage({ subjectId: notes.id })).toEqual([
      { task: 'query', model: 'm1', calls: 1, inputTokens: 10, outputTokens: 5 },
    ]);
    expect(repo.summarizeUsage({ sinceMs: 2_000, subjectId: notes.id })).toEqual([
      { task: 'query', model: 'm1', calls: 1, inputTokens: 10, outputTokens: 5 },
    ]);
    expect(repo.summarizeUsage()).toEqual([
      { task: 'query', model: 'm1', calls: 3, inputTokens: 111, outputTokens: 56 },
    ]);
  });

  it('删除项目时把历史用量归因置空而不是删除记录', async () => {
    const repo = await import('../usage-repo');
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const notes = subjectsRepo.create({ slug: 'notes', name: 'Notes' });
    repo.recordUsage({
      task: 'query', model: 'm1', inputTokens: 9, outputTokens: 2, subjectId: notes.id,
    });

    getRawDb().prepare('DELETE FROM subjects WHERE id = ?').run(notes.id);

    expect(repo.summarizeUsage({ subjectId: notes.id })).toEqual([]);
    expect(repo.summarizeUsage()).toEqual([
      { task: 'query', model: 'm1', calls: 1, inputTokens: 9, outputTokens: 2 },
    ]);
    expect(getRawDb().prepare('SELECT subject_id FROM llm_usage').get())
      .toEqual({ subject_id: null });
  });

  it('pruneOldUsage 删除 cutoff 之前的行并返回删除数', async () => {
    const repo = await import('../usage-repo');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 1, outputTokens: 1 });
    vi.setSystemTime(5_000);
    repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 2, outputTokens: 2 });
    vi.useRealTimers();
    expect(repo.pruneOldUsage(5_000)).toBe(1);
    expect(repo.summarizeUsage()[0].calls).toBe(1);
  });
});

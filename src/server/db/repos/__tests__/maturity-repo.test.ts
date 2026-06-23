import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maturity-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

const ISO = (d: Date) => d.toISOString();
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

describe('maturity-repo', () => {
  it('ensureRow 新建后 get 可读、再 ensureRow 不覆盖', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const maturityRepo = await import('../maturity-repo');

    const subjectId = subjectsRepo.create({ slug: `s-test-1`, name: 'S' }).id;

    const now = ISO(new Date());
    maturityRepo.ensureRow(subjectId, 'p', now, 1);
    const a = maturityRepo.get(subjectId, 'p');
    expect(a?.state).toBe('active');
    expect(a?.intervalDays).toBe(1);
    // 改动后再 ensureRow 不应回退
    maturityRepo.applyAfterEnrich(subjectId, 'p', { passes: 1, intervalDays: 7, state: 'active', nextDueAt: ISO(days(7)) }, now);
    maturityRepo.ensureRow(subjectId, 'p', now, 1);
    expect(maturityRepo.get(subjectId, 'p')?.intervalDays).toBe(7);
  });

  it('listDue 只返回到期且未毕业，按 priority 优先', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const maturityRepo = await import('../maturity-repo');

    const subjectId = subjectsRepo.create({ slug: `s-test-2`, name: 'S' }).id;

    const now = new Date();
    // 用 days(-5) + interval 1 → next_due ≈ days(-4)，明确早于 now（避免 days(-1)+1≈now 的边界竞态）
    maturityRepo.ensureRow(subjectId, 'due-low', ISO(days(-5)), 1); // 已到期，priority 0
    maturityRepo.ensureRow(subjectId, 'due-high', ISO(days(-5)), 1);
    maturityRepo.bumpNeighbor(subjectId, 'due-high', ISO(now)); // priority +1
    maturityRepo.ensureRow(subjectId, 'future', ISO(now), 30);   // 未到期（next_due = now+30d）
    maturityRepo.ensureRow(subjectId, 'grad', ISO(days(-5)), 1);
    maturityRepo.applyAfterEnrich(subjectId, 'grad', { passes: 3, intervalDays: 0, state: 'graduated', nextDueAt: ISO(days(3650)) }, ISO(now));

    const due = maturityRepo.listDue(ISO(now), 10);
    const slugs = due.map((d) => d.slug);
    expect(slugs).toContain('due-low');
    expect(slugs).toContain('due-high');
    expect(slugs).not.toContain('future');
    expect(slugs).not.toContain('grad');
    expect(slugs[0]).toBe('due-high'); // 高 priority 排前
  });

  it('bumpNeighbor 复活 dormant 并提前到期', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const maturityRepo = await import('../maturity-repo');

    const subjectId = subjectsRepo.create({ slug: `s-test-3`, name: 'S' }).id;

    const now = new Date();
    maturityRepo.ensureRow(subjectId, 'd', ISO(days(30)), 21);
    maturityRepo.applyAfterEnrich(subjectId, 'd', { passes: 5, intervalDays: 60, state: 'dormant', nextDueAt: ISO(days(60)) }, ISO(now));
    maturityRepo.bumpNeighbor(subjectId, 'd', ISO(now));
    const row = maturityRepo.get(subjectId, 'd');
    expect(row?.state).toBe('active');
    expect(new Date(row!.nextDueAt).getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

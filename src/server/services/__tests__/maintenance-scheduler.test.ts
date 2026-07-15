import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maintenance-scheduler-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('runMaintenanceSweep', () => {
  it('入队到期页，受 maxPages 上限约束，超出部分 log', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const maturityRepo = await import('../../db/repos/maturity-repo');
    const { runMaintenanceSweep } = await import('../maintenance-scheduler');

    const subjectId = subjectsRepo.create({ slug: `s-sweep-1`, name: 'S' }).id;

    const now = new Date();
    // 用过去 2 天作为 nowIso，interval=1 → next_due ≈ 1 天前，明确早于 now
    const past = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    for (const s of ['a', 'b', 'c']) maturityRepo.ensureRow(subjectId, s, past, 1);

    const enqueue = vi.fn();
    const log = vi.fn();
    const n = runMaintenanceSweep({ now, maxPages: 2, enqueue, log });

    expect(n).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled(); // 第 3 页被推迟 → log
  });

  it('无到期页 → 不入队、返回 0', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    // 创建 subject 确保 DB 存在；但不插入任何到期行
    subjectsRepo.create({ slug: `s-sweep-2`, name: 'S' });

    const { runMaintenanceSweep } = await import('../maintenance-scheduler');

    const enqueue = vi.fn();
    const n = runMaintenanceSweep({ now: new Date(), maxPages: 5, enqueue, log: vi.fn() });
    expect(n).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('只入队所选项目的到期页，并在过滤后应用页数上限', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const maturityRepo = await import('../../db/repos/maturity-repo');
    const { runMaintenanceSweep } = await import('../maintenance-scheduler');

    const selectedId = subjectsRepo.create({ slug: 'selected', name: 'Selected' }).id;
    const excludedId = subjectsRepo.create({ slug: 'excluded', name: 'Excluded' }).id;
    const now = new Date();
    const past = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    maturityRepo.ensureRow(excludedId, 'excluded-a', past, 1);
    maturityRepo.ensureRow(selectedId, 'selected-a', past, 1);
    maturityRepo.ensureRow(selectedId, 'selected-b', past, 1);

    const enqueue = vi.fn();
    const log = vi.fn();
    const n = runMaintenanceSweep({
      now,
      maxPages: 1,
      subjectIds: [selectedId],
      enqueue,
      log,
    });

    expect(n).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(expect.stringMatching(/^selected-/), selectedId);
    expect(enqueue).not.toHaveBeenCalledWith('excluded-a', excludedId);
    expect(log).toHaveBeenCalled();
    expect(maturityRepo.countDue(now.toISOString(), [selectedId])).toBe(2);
    expect(maturityRepo.countDue(now.toISOString())).toBe(3);
  });
});

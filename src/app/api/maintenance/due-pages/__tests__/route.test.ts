import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { MaintenanceDuePagesResult } from '@/lib/contracts';

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: () => null,
}));

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'due-pages-route-'));
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

async function seed() {
  const subjectsRepo = await import('@/server/db/repos/subjects-repo');
  const pagesRepo = await import('@/server/db/repos/pages-repo');
  const maturityRepo = await import('@/server/db/repos/maturity-repo');
  const now = new Date();
  const s1 = subjectsRepo.create({ slug: 's-due-1', name: 'Due One' });
  const s2 = subjectsRepo.create({ slug: 's-due-2', name: 'Due Two' });
  for (const [subject, slug, title] of [
    [s1, 'alpha', 'Alpha'],
    [s2, 'beta', 'Beta'],
  ] as const) {
    pagesRepo.upsertPage({
      subjectId: subject.id, slug, title,
      path: `wiki/${subject.slug}/${slug}.md`,
      summary: '', contentHash: `h-${slug}`, tags: [],
      createdAt: ISO(now), updatedAt: ISO(now),
    });
    maturityRepo.ensureRow(subject.id, slug, ISO(days(-5)), 1);
  }
  maturityRepo.ensureRow(s1.id, 'future', ISO(now), 30); // 未到期，不应出现
  return { s1, s2 };
}

async function get(): Promise<{ status: number; body: MaintenanceDuePagesResult }> {
  const { GET } = await import('../route');
  const res = await GET(new NextRequest('http://localhost/api/maintenance/due-pages'));
  return { status: res.status, body: (await res.json()) as MaintenanceDuePagesResult };
}

describe('GET /api/maintenance/due-pages', () => {
  it('scope=all 返回全部到期页明细，total 与 countDue 同口径', async () => {
    await seed();
    const maturityRepo = await import('@/server/db/repos/maturity-repo');

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.total).toBe(maturityRepo.countDue(new Date().toISOString()));
    expect(body.total).toBe(2);
    expect(body.limit).toBeGreaterThan(0);
    expect(body.entries.map((e) => e.slug).sort()).toEqual(['alpha', 'beta']);
    const alpha = body.entries.find((e) => e.slug === 'alpha')!;
    expect(alpha).toMatchObject({ subjectSlug: 's-due-1', subjectName: 'Due One', title: 'Alpha' });
  });

  it('scope=subjects 时明细与 total 只含所选 subject', async () => {
    const { s2 } = await seed();
    const settingsRepo = await import('@/server/db/repos/settings-repo');
    settingsRepo.setMaintenanceScope({ mode: 'subjects', subjectIds: [s2.id] });

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.entries.map((e) => e.slug)).toEqual(['beta']);
  });
});

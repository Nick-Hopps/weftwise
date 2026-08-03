import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subject-fallback-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

function request(cookieSlug?: string) {
  const headers: Record<string, string> = {};
  if (cookieSlug) headers.cookie = `wiki_subject=${cookieSlug}`;
  return new NextRequest('http://localhost/api/pages', { headers });
}

describe('resolveSubjectFromRequest 的 general 缺失兜底', () => {
  it('general 存在时优先 general', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    subjectsRepo.create({ slug: 'physics', name: 'Physics' });
    const { resolveSubjectFromRequest } = await import('../subject');

    const { subject, error } = resolveSubjectFromRequest(request());

    expect(error).toBeNull();
    expect(subject!.slug).toBe('general');
  });

  it('general 已被删除时兜底到剩下的 project', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const general = subjectsRepo.getBySlug('general')!;
    subjectsRepo.create({ slug: 'physics', name: 'Physics' });
    subjectsRepo.deleteWithContents(general.id);
    const { resolveSubjectFromRequest } = await import('../subject');

    const { subject, error } = resolveSubjectFromRequest(request());

    expect(error).toBeNull();
    expect(subject!.slug).toBe('physics');
  });

  it('cookie 指向已删 slug 且无 general 时兜底到剩下的 project', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const general = subjectsRepo.getBySlug('general')!;
    subjectsRepo.create({ slug: 'physics', name: 'Physics' });
    subjectsRepo.deleteWithContents(general.id);
    const { resolveSubjectFromRequest } = await import('../subject');

    const { subject, error } = resolveSubjectFromRequest(request('gone'));

    expect(error).toBeNull();
    expect(subject!.slug).toBe('physics');
  });

  it('零 project 时返回 500 并说明没有任何 project', async () => {
    const { getRawDb } = await import('@/server/db/client');
    getRawDb().prepare(`DELETE FROM subjects`).run();
    const { resolveSubjectFromRequest } = await import('../subject');

    const { subject, error } = resolveSubjectFromRequest(request());

    expect(subject).toBeNull();
    expect(error!.status).toBe(500);
    await expect(error!.json()).resolves.toMatchObject({
      error: expect.stringMatching(/no project/i),
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveSubject: vi.fn(),
  fetchUrl: vi.fn(),
}));

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: () => null,
  requireCsrf: () => null,
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => mocks.resolveSubject(...args),
}));
vi.mock('@/server/sources/url-fetcher', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/sources/url-fetcher')>();
  return {
    ...original,
    fetchUrlSource: (...args: unknown[]) => mocks.fetchUrl(...args),
  };
});
vi.mock('@/server/git/git-service', () => ({
  commitVaultChanges: vi.fn().mockResolvedValue('sha'),
}));

let dir: string;
let previousDatabasePath: string | undefined;
let previousVaultPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ingest-route-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  previousVaultPath = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  process.env.VAULT_PATH = previousVaultPath;
  rmSync(dir, { recursive: true, force: true });
});

function jsonRequest(body: unknown) {
  return new NextRequest('http://localhost/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/ingest', () => {
  it('text source 与 ingest job 原子落地，且忽略客户端伪造 provenance', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    const { POST } = await import('../route');

    const response = await POST(jsonRequest({
      text: '# Hello',
      filename: 'hello.md',
      subjectId: subject.id,
      researchProvenance: { runId: 'attacker-run' },
    }));

    expect(response.status).toBe(202);
    const body = await response.json() as { jobId: string; sourceId: string };
    const job = getRawDb().prepare(`SELECT params_json FROM jobs WHERE id = ?`).get(body.jobId) as {
      params_json: string;
    };
    expect(JSON.parse(job.params_json)).toEqual({
      sourceId: body.sourceId,
      filename: 'hello.md',
      subjectId: subject.id,
    });
  });

  it('URL 抓取等待期间真实 reset 完成后，旧请求不得重建 source/job/文件', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    let releaseFetch!: (value: { filename: string; content: string }) => void;
    mocks.fetchUrl.mockReturnValue(new Promise((resolve) => {
      releaseFetch = resolve;
    }));
    const { POST } = await import('../route');
    const { POST: reset } = await import('../../reset/route');

    const pending = POST(jsonRequest({
      urls: ['https://example.com/article'],
      subjectId: subject.id,
    }));
    await vi.waitFor(() => expect(mocks.fetchUrl).toHaveBeenCalledTimes(1));
    const resetResponse = await reset(new NextRequest('http://localhost/api/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectId: subject.id }),
    }));
    expect(resetResponse.status).toBe(200);
    releaseFetch({ filename: 'article.html', content: '<h1>Article</h1>' });
    const response = await pending;

    expect(response.status).toBe(422);
    expect((getRawDb().prepare(`SELECT COUNT(*) AS count FROM sources`).get() as { count: number }).count).toBe(0);
    expect((getRawDb().prepare(`SELECT COUNT(*) AS count FROM jobs`).get() as { count: number }).count).toBe(0);
    expect(existsSync(join(dir, 'vault', 'raw', 'general', 'article.html'))).toBe(false);
  });

  it('source+job 先原子落地后，真实 reset 被 active-job guard 阻止', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    const { POST } = await import('../route');
    const { POST: reset } = await import('../../reset/route');
    const ingestResponse = await POST(jsonRequest({
      text: '# Keep',
      filename: 'keep.md',
      subjectId: subject.id,
    }));
    expect(ingestResponse.status).toBe(202);

    const resetResponse = await reset(new NextRequest('http://localhost/api/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectId: subject.id }),
    }));

    expect(resetResponse.status).toBe(409);
    expect((getRawDb().prepare(`SELECT COUNT(*) AS count FROM sources`).get() as { count: number }).count).toBe(1);
    expect((getRawDb().prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending'`).get() as { count: number }).count).toBe(1);
    expect(existsSync(join(dir, 'vault', 'raw', 'general', 'keep.md'))).toBe(true);
  });

  it('URL 抓取等待期间真实 delete 完成后，旧 lease 因 Subject 不存在而失败', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.create({ slug: 'delete-race', name: 'Delete Race' });
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    let releaseFetch!: (value: { filename: string; content: string }) => void;
    mocks.fetchUrl.mockReturnValue(new Promise((resolve) => {
      releaseFetch = resolve;
    }));
    const { POST } = await import('../route');
    const { DELETE } = await import('../../subjects/[id]/route');

    const pending = POST(jsonRequest({
      urls: ['https://example.com/delete-race'],
      subjectId: subject.id,
    }));
    await vi.waitFor(() => expect(mocks.fetchUrl).toHaveBeenCalledTimes(1));
    const deleteResponse = await DELETE(
      new NextRequest(`http://localhost/api/subjects/${subject.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: subject.id }) },
    );
    expect(deleteResponse.status).toBe(200);
    releaseFetch({ filename: 'late.html', content: '<h1>Late</h1>' });
    const ingestResponse = await pending;

    expect(ingestResponse.status).toBe(422);
    expect(subjectsRepo.getById(subject.id)).toBeNull();
    expect((getRawDb().prepare(`SELECT COUNT(*) AS count FROM sources WHERE subject_id = ?`).get(subject.id) as { count: number }).count).toBe(0);
    expect(existsSync(join(dir, 'vault', 'raw', subject.slug, 'late.html'))).toBe(false);
  });
});

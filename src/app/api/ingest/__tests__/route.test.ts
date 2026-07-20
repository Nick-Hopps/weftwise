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

  it('URL Source 只保存链接并入队，不在 Route 抓取或写 raw HTML', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { getRawDb } = await import('@/server/db/client');
    const subject = subjectsRepo.getBySlug('general')!;
    mocks.resolveSubject.mockReturnValue({ subject, error: null });
    const { POST } = await import('../route');
    const response = await POST(jsonRequest({
      urls: ['https://example.com/article'],
      subjectId: subject.id,
    }));

    expect(response.status).toBe(202);
    expect(mocks.fetchUrl).not.toHaveBeenCalled();
    const body = await response.json() as {
      results: Array<{ sourceId: string; jobId: string }>;
    };
    const source = getRawDb().prepare(`SELECT filename, metadata_json FROM sources WHERE id = ?`)
      .get(body.results[0]!.sourceId) as { filename: string; metadata_json: string };
    expect(JSON.parse(source.metadata_json)).toMatchObject({
      kind: 'url',
      originUrl: 'https://example.com/article',
    });
    expect(existsSync(join(dir, 'vault', 'raw', 'general', source.filename))).toBe(false);
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

});

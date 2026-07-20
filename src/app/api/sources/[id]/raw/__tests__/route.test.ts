import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));

let dir: string;
let previousDatabasePath: string | undefined;
let previousVaultPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-raw-route-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  previousVaultPath = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  process.env.VAULT_PATH = previousVaultPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/sources/[id]/raw', () => {
  it('URL Source 临时重定向到持久化的 originUrl', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { saveUrlSource } = await import('@/server/sources/source-store');
    const subject = subjectsRepo.getBySlug('general')!;
    const source = saveUrlSource(subject, 'https://example.com/article');
    const { GET } = await import('../route');

    const response = await GET(
      new NextRequest(`http://localhost/api/sources/${source.id}/raw`),
      { params: Promise.resolve({ id: source.id }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/article');
  });

  it('上传 HTML 仍返回本地原文与既有 CSP', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const { saveRawSource } = await import('@/server/sources/source-store');
    const subject = subjectsRepo.getBySlug('general')!;
    const source = saveRawSource(subject, 'upload.html', '<h1>Local</h1>');
    const { GET } = await import('../route');

    const response = await GET(
      new NextRequest(`http://localhost/api/sources/${source.id}/raw`),
      { params: Promise.resolve({ id: source.id }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>Local</h1>');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
  });
});

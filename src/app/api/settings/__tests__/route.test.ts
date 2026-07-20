import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

let dir: string;
let prevDb: string | undefined;
let prevApiKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-route-'));
  prevDb = process.env.DATABASE_PATH;
  prevApiKey = process.env.WIKI_API_KEY;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  delete process.env.WIKI_API_KEY;
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  process.env.WIKI_API_KEY = prevApiKey;
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/settings bodyFontSize', () => {
  it('GET 缺省返回当前正文默认字号 16', async () => {
    const { GET } = await import('../route');
    const response = await GET(new NextRequest('http://localhost/api/settings'));

    expect(response.status).toBe(200);
    expect((await response.json()).bodyFontSize).toBe(16);
  });

  it('PUT 保存字号并返回完整设置', async () => {
    const { PUT } = await import('../route');
    const response = await PUT(new NextRequest('http://localhost/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ bodyFontSize: 20 }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).bodyFontSize).toBe(20);
  });

  it('PUT 拒绝越界字号', async () => {
    const { PUT } = await import('../route');
    const response = await PUT(new NextRequest('http://localhost/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ bodyFontSize: 23 }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(400);
  });
});

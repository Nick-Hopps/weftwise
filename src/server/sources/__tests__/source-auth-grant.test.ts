import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSourceAuthGrant,
  deleteSourceAuthGrant,
  normalizeSourceAuthHeaders,
  readSourceAuthGrant,
  SOURCE_AUTH_GRANT_TTL_MS,
} from '../source-auth-grant';

let dir: string;
let previousDatabasePath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-auth-grant-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  rmSync(dir, { recursive: true, force: true });
});

describe('normalizeSourceAuthHeaders', () => {
  it('接受可选 header 前缀并规范化空白', () => {
    expect(normalizeSourceAuthHeaders({
      cookie: ' Cookie: session=abc; theme=dark ',
      authorization: ' Authorization: Bearer token ',
    })).toEqual({
      cookie: 'session=abc; theme=dark',
      authorization: 'Bearer token',
    });
  });

  it('要求至少一个 header，拒绝换行注入与超长输入', () => {
    expect(() => normalizeSourceAuthHeaders({})).toThrow(/at least one/i);
    expect(() => normalizeSourceAuthHeaders({ cookie: 'a=b\r\nX-Evil: 1' })).toThrow(/invalid/i);
    expect(() => normalizeSourceAuthHeaders({ cookie: `a=${'x'.repeat(17 * 1024)}` })).toThrow(/16 KiB/i);
    expect(() => normalizeSourceAuthHeaders({ authorization: `Bearer ${'x'.repeat(9 * 1024)}` })).toThrow(/8 KiB/i);
  });
});

describe('source auth grant storage', () => {
  it('AES-GCM 密文落在数据库目录旁，磁盘不含凭证明文，并绑定 job/source', () => {
    const now = new Date('2026-07-20T00:00:00.000Z');
    const created = createSourceAuthGrant({
      jobId: 'job-1',
      sourceId: 'source-1',
      authOrigin: 'https://example.com',
      cookie: 'session=plain-secret',
      authorization: 'Bearer plain-token',
      now,
    });

    const grantDir = join(dir, 'source-auth');
    const grantFile = readdirSync(grantDir).find((name) => name.endsWith('.json'))!;
    const onDisk = readFileSync(join(grantDir, grantFile), 'utf8');
    expect(onDisk).not.toContain('plain-secret');
    expect(onDisk).not.toContain('plain-token');
    expect(JSON.parse(onDisk)).toEqual(expect.objectContaining({
      version: 1,
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    }));

    expect(readSourceAuthGrant(created.id, {
      jobId: 'job-1',
      sourceId: 'source-1',
      now: new Date(now.getTime() + 1),
    })).toMatchObject({
      authOrigin: 'https://example.com',
      cookie: 'session=plain-secret',
      authorization: 'Bearer plain-token',
    });
    expect(readSourceAuthGrant(created.id, {
      jobId: 'other-job',
      sourceId: 'source-1',
      now,
    })).toBeNull();
    expect(readSourceAuthGrant(created.id, {
      jobId: 'job-1',
      sourceId: 'other-source',
      now,
    })).toBeNull();
  });

  it('过期 grant fail closed 并删除密文', () => {
    const now = new Date('2026-07-20T00:00:00.000Z');
    const created = createSourceAuthGrant({
      jobId: 'job-1',
      sourceId: 'source-1',
      authOrigin: 'https://example.com',
      cookie: 'session=secret',
      now,
    });

    expect(readSourceAuthGrant(created.id, {
      jobId: 'job-1',
      sourceId: 'source-1',
      now: new Date(now.getTime() + SOURCE_AUTH_GRANT_TTL_MS + 1),
    })).toBeNull();
    expect(readdirSync(join(dir, 'source-auth')).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('密文被篡改时 fail closed，删除接口幂等', () => {
    const created = createSourceAuthGrant({
      jobId: 'job-1',
      sourceId: 'source-1',
      authOrigin: 'https://example.com',
      cookie: 'session=secret',
    });
    const grantDir = join(dir, 'source-auth');
    const grantPath = join(grantDir, `${created.id}.json`);
    const envelope = JSON.parse(readFileSync(grantPath, 'utf8')) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    writeFileSync(grantPath, JSON.stringify(envelope));

    expect(readSourceAuthGrant(created.id, {
      jobId: 'job-1',
      sourceId: 'source-1',
    })).toBeNull();
    expect(() => deleteSourceAuthGrant(created.id)).not.toThrow();
    expect(() => deleteSourceAuthGrant(created.id)).not.toThrow();
  });
});

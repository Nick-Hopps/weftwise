import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGetSource = vi.fn();
const mockListUnreferenced = vi.fn();
const mockFindJob = vi.fn();
const mockDeleteSource = vi.fn();
const mockDeleteFiles = vi.fn();
const mockCommit = vi.fn();
const mockRelease = vi.fn();
const mockAcquire = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...a: unknown[]) => mockResolve(...a),
}));
vi.mock('@/server/db/repos/sources-repo', () => ({
  getSource: (...a: unknown[]) => mockGetSource(...a),
  listUnreferencedSources: (...a: unknown[]) => mockListUnreferenced(...a),
  deleteSource: (...a: unknown[]) => mockDeleteSource(...a),
}));
vi.mock('@/server/db/repos/jobs-repo', () => ({
  findLatestIngestJobForSource: (...a: unknown[]) => mockFindJob(...a),
}));
vi.mock('@/server/sources/source-store', () => ({
  deleteRawSourceFiles: (...a: unknown[]) => mockDeleteFiles(...a),
}));
vi.mock('@/server/git/git-service', () => ({
  commitVaultChanges: (...a: unknown[]) => mockCommit(...a),
}));
vi.mock('@/server/wiki/vault-mutex', () => ({
  acquireVaultLock: (...a: unknown[]) => mockAcquire(...a),
}));

import { DELETE } from '../route';

const SUBJECT = { id: 's1', slug: 'general' };
const SOURCE = { id: 'src1', subjectId: 's1', filename: 'a.md', contentHash: 'h', parsedAt: null, metadataJson: '{}' };

function call(id: string) {
  const req = new NextRequest(`http://localhost/api/sources/${id}`, { method: 'DELETE' });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockReturnValue({ subject: SUBJECT, error: null });
  mockGetSource.mockReturnValue(SOURCE);
  mockListUnreferenced.mockReturnValue([SOURCE]);
  mockFindJob.mockReturnValue(null);
  mockAcquire.mockResolvedValue(mockRelease);
  mockCommit.mockResolvedValue('sha');
});

describe('DELETE /api/sources/[id]', () => {
  it('source 不存在 / 跨 subject → 404，不动锁', async () => {
    mockGetSource.mockReturnValue(null);
    expect((await call('missing')).status).toBe(404);
    mockGetSource.mockReturnValue({ ...SOURCE, subjectId: 'other' });
    expect((await call('src1')).status).toBe(404);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('已被页面引用 → 409 already-referenced', async () => {
    mockListUnreferenced.mockReturnValue([]);
    const res = await call('src1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already-referenced');
    expect(mockDeleteSource).not.toHaveBeenCalled();
  });

  it('同源 ingest job 在途（pending/running）→ 409 in-flight，不动锁', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'running' });
    const res = await call('src1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('in-flight');
    expect(mockFindJob).toHaveBeenCalledWith('s1', 'src1');
    expect(mockAcquire).not.toHaveBeenCalled();
    expect(mockDeleteSource).not.toHaveBeenCalled();
  });

  it('正常删除：锁内 fs → DB → git commit，最后释放锁', async () => {
    const res = await call('src1');
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(mockDeleteFiles).toHaveBeenCalledWith('general', 'a.md', 'src1');
    expect(mockDeleteSource).toHaveBeenCalledWith('src1');
    expect(mockCommit).toHaveBeenCalledWith('[subject:general] Delete orphan source a.md');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('commit 抛错时仍释放锁并返回 500', async () => {
    mockCommit.mockRejectedValue(new Error('git broke'));
    const res = await call('src1');
    expect(res.status).toBe(500);
    expect(mockRelease).toHaveBeenCalled();
  });
});

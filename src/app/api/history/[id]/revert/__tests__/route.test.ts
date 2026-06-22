import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGetById = vi.fn();
const mockMarkReverted = vi.fn();
const mockGetFileAtCommit = vi.fn();
const mockBuildRevertEntries = vi.fn();
const mockCreateChangeset = vi.fn();
const mockValidate = vi.fn();
const mockApply = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/operations-repo', () => ({
  getById: (id: unknown) => mockGetById(id),
  markReverted: (id: unknown) => mockMarkReverted(id),
}));
vi.mock('@/server/git/git-service', () => ({
  getFileAtCommit: (p: unknown, sha: unknown) => mockGetFileAtCommit(p, sha),
}));
vi.mock('@/server/wiki/revert', () => ({
  buildRevertEntries: (...a: unknown[]) => mockBuildRevertEntries(...a),
}));
vi.mock('@/server/wiki/wiki-transaction', () => ({
  createChangeset: (...a: unknown[]) => mockCreateChangeset(...a),
  validateChangeset: (cs: unknown) => mockValidate(cs),
  applyChangeset: (cs: unknown) => mockApply(cs),
}));
vi.mock('@/server/config/env', () => ({ vaultPath: (p: string) => `/vault/${p}` }));
vi.mock('node:fs', () => ({ existsSync: (p: unknown) => mockExistsSync(p) }));

import { POST } from '../route';

function call(id: string, body: unknown = { subjectId: 's1' }) {
  const req = new NextRequest(`http://localhost/api/history/${id}/revert`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

const appliedOp = {
  id: 'opA', jobId: 'j', subjectId: 's1', preHead: 'pre', postHead: 'sha',
  changesetJson: JSON.stringify([{ action: 'create', path: 'wiki/general/a.md', content: '# A' }]),
  status: 'applied', jobType: null,
};

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockGetById.mockReset();
  mockMarkReverted.mockReset();
  mockGetFileAtCommit.mockReset();
  mockGetFileAtCommit.mockResolvedValue('# A old');
  mockBuildRevertEntries.mockReset();
  mockBuildRevertEntries.mockReturnValue([{ action: 'delete', path: 'wiki/general/a.md', content: null }]);
  mockCreateChangeset.mockReset();
  mockCreateChangeset.mockImplementation((id, subject, entries) => ({ id, subject, entries }));
  mockValidate.mockReset();
  mockValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
  mockApply.mockReset();
  mockApply.mockResolvedValue({ postHead: 'newsha' });
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(true);
});

describe('POST /api/history/[id]/revert', () => {
  it('未知 op → 404，不写入', async () => {
    mockGetById.mockReturnValue(null);
    expect((await call('nope')).status).toBe(404);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('跨 subject 的 op → 404', async () => {
    mockGetById.mockReturnValue({ ...appliedOp, subjectId: 's2' });
    expect((await call('opA')).status).toBe(404);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('已 reverted 的 op → 409', async () => {
    mockGetById.mockReturnValue({ ...appliedOp, status: 'reverted' });
    expect((await call('opA')).status).toBe(409);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('inverse 校验失败 → 422 带 errors，不 apply/markReverted', async () => {
    mockGetById.mockReturnValue(appliedOp);
    mockValidate.mockReturnValue({ valid: false, errors: ['坏链'], warnings: [] });
    const res = await call('opA');
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual(['坏链']);
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockMarkReverted).not.toHaveBeenCalled();
  });

  it('合法 → 200，apply + markReverted 被调用，返回 newCommitSha/affectedSlugs', async () => {
    mockGetById.mockReturnValue(appliedOp);
    const res = await call('opA');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revertedOperationId).toBe('opA');
    expect(body.newCommitSha).toBe('newsha');
    expect(body.affectedSlugs).toEqual(['a']);
    expect(mockMarkReverted).toHaveBeenCalledWith('opA');
  });
});

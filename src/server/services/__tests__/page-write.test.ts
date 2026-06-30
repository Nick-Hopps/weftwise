import { describe, it, expect, beforeEach, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({ getPageBySlug: vi.fn() }));
vi.mock('@/server/db/repos/pages-repo', () => repoMocks);

const opsMocks = vi.hoisted(() => ({
  executePageDelete: vi.fn(async () => ({ deletedSlug: 'eigen', brokenBacklinks: 2 })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'foo' })),
}));
vi.mock('@/server/wiki/page-ops', () => opsMocks);

const embedMocks = vi.hoisted(() => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('../embedding-service', () => embedMocks);

import { validateDeleteTarget, deletePageInSubject, createPageInSubject } from '../page-write';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;

describe('validateDeleteTarget', () => {
  it('保护页 index/log → 错误', () => {
    expect(validateDeleteTarget('index', { tags: [] })).toMatch(/protected/);
    expect(validateDeleteTarget('log', { tags: [] })).toMatch(/protected/);
  });
  it('页不存在 → 错误', () => {
    expect(validateDeleteTarget('ghost', null)).toMatch(/not found/);
  });
  it('meta 标签页 → 错误', () => {
    expect(validateDeleteTarget('m', { tags: ['meta'] })).toMatch(/meta/);
  });
  it('正常页 → null', () => {
    expect(validateDeleteTarget('eigen', { tags: ['math'] })).toBeNull();
  });
});

describe('deletePageInSubject', () => {
  beforeEach(() => {
    repoMocks.getPageBySlug.mockReset();
    opsMocks.executePageDelete.mockClear();
    embedMocks.enqueueEmbedIndex.mockClear();
  });
  it('正常页 → 执行删除 + enqueue embed', async () => {
    repoMocks.getPageBySlug.mockReturnValue({ slug: 'eigen', tags: ['math'] });
    opsMocks.executePageDelete.mockResolvedValue({ deletedSlug: 'eigen', brokenBacklinks: 2 });
    const out = await deletePageInSubject(subject, 'eigen');
    expect(opsMocks.executePageDelete).toHaveBeenCalledOnce();
    expect(embedMocks.enqueueEmbedIndex).toHaveBeenCalledWith('s1');
    expect(out).toEqual({ deletedSlug: 'eigen', brokenBacklinks: 2 });
  });
  it('保护页 → 抛错，不执行', async () => {
    repoMocks.getPageBySlug.mockReturnValue({ slug: 'index', tags: ['meta'] });
    await expect(deletePageInSubject(subject, 'index')).rejects.toThrow(/protected/);
    expect(opsMocks.executePageDelete).not.toHaveBeenCalled();
  });
  it('缺页 → 抛错', async () => {
    repoMocks.getPageBySlug.mockReturnValue(null);
    await expect(deletePageInSubject(subject, 'ghost')).rejects.toThrow(/not found/);
  });
});

describe('createPageInSubject', () => {
  beforeEach(() => {
    opsMocks.executePageCreate.mockClear();
    embedMocks.enqueueEmbedIndex.mockClear();
  });
  it('正常 → 执行创建 + enqueue embed', async () => {
    opsMocks.executePageCreate.mockResolvedValue({ createdSlug: 'foo' });
    const out = await createPageInSubject(subject, { title: 'Foo', body: 'x' });
    expect(opsMocks.executePageCreate).toHaveBeenCalledOnce();
    expect(embedMocks.enqueueEmbedIndex).toHaveBeenCalledWith('s1');
    expect(out).toEqual({ createdSlug: 'foo' });
  });
  it('空标题 → 抛错，不执行', async () => {
    await expect(createPageInSubject(subject, { title: '  ', body: 'x' })).rejects.toThrow(/title/);
    expect(opsMocks.executePageCreate).not.toHaveBeenCalled();
  });
});

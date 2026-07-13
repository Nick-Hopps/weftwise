import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

const sourceRepoMocks = vi.hoisted(() => ({
  getSourceByIdentity: vi.fn(),
  upsertSource: vi.fn(),
  insertSourceOrGetWinner: vi.fn(),
  recordSourceSidecarCleanup: vi.fn(),
}));

vi.mock('../../config/env', () => ({
  vaultPath: (...segs: string[]) => path.join(tmpDir, ...segs),
}));

vi.mock('../../db/repos/sources-repo', () => ({
  getSourceByIdentity: (...args: unknown[]) => sourceRepoMocks.getSourceByIdentity(...args),
  upsertSource: (...args: unknown[]) => sourceRepoMocks.upsertSource(...args),
  insertSourceOrGetWinner: (...args: unknown[]) => sourceRepoMocks.insertSourceOrGetWinner(...args),
  recordSourceSidecarCleanup: (...args: unknown[]) => sourceRepoMocks.recordSourceSidecarCleanup(...args),
}));

describe('updateSourceChunks', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
    sourceRepoMocks.getSourceByIdentity.mockReset().mockReturnValue(null);
    sourceRepoMocks.upsertSource.mockReset();
    sourceRepoMocks.insertSourceOrGetWinner.mockReset().mockImplementation((source) => ({
      source,
      inserted: true,
    }));
    sourceRepoMocks.recordSourceSidecarCleanup.mockReset();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('把 chunks 写入既有 metadata sidecar', async () => {
    const { saveRawSource, updateSourceChunks, getSourceMetadata } = await import('../source-store');
    const { id } = saveRawSource({ id: 'sub1', slug: 'general' }, 'a.txt', 'hello');
    updateSourceChunks(id, [{ id: 'c0', heading: '', text: 'hello', tokenCount: 1 }]);
    const meta = getSourceMetadata(id);
    expect(meta).not.toBeNull();
    expect((meta as { chunks: unknown[] }).chunks).toEqual([
      { id: 'c0', heading: '', text: 'hello', tokenCount: 1 },
    ]);
  });

  it('sidecar 不存在时静默跳过（best-effort）', async () => {
    const { updateSourceChunks } = await import('../source-store');
    expect(() => updateSourceChunks('nonexistent-id', [])).not.toThrow();
  });

  it('组合唯一冲突的 loser 删除自己的 sidecar 并复用 winner ID', async () => {
    sourceRepoMocks.insertSourceOrGetWinner.mockImplementation((candidate) => ({
      source: { ...(candidate as Record<string, unknown>), id: 'winner-id' },
      inserted: false,
    }));
    const { saveRawSource } = await import('../source-store');

    const result = saveRawSource({ id: 'sub1', slug: 'general' }, 'a.txt', 'hello');

    expect(result).toMatchObject({ id: 'winner-id', created: false });
    expect(fs.readdirSync(path.join(tmpDir, '.llm-wiki', 'sources', 'general'))).toEqual([]);
    expect(fs.readFileSync(path.join(tmpDir, 'raw', 'general', 'a.txt'), 'utf-8')).toBe('hello');
  });

  it('DB 写入失败时删除候选 sidecar 并恢复原 raw 文件', async () => {
    const rawDir = path.join(tmpDir, 'raw', 'general');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'a.txt'), 'previous');
    sourceRepoMocks.insertSourceOrGetWinner.mockImplementation(() => {
      throw new Error('db failed');
    });
    const { saveRawSource } = await import('../source-store');

    expect(() => saveRawSource(
      { id: 'sub1', slug: 'general' },
      'a.txt',
      'replacement',
    )).toThrow('db failed');
    expect(fs.readFileSync(path.join(rawDir, 'a.txt'), 'utf-8')).toBe('previous');
    expect(fs.readdirSync(path.join(tmpDir, '.llm-wiki', 'sources', 'general'))).toEqual([]);
  });

  it('sidecar 写入失败时恢复原 raw 并删除半成品', async () => {
    const rawDir = path.join(tmpDir, 'raw', 'general');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'a.txt'), 'previous');
    const originalWrite = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).endsWith('.json')) {
        originalWrite(file, '{', options as never);
        throw new Error('disk full');
      }
      return originalWrite(file, data, options as never);
    });
    const { saveRawSource } = await import('../source-store');

    expect(() => saveRawSource(
      { id: 'sub1', slug: 'general' },
      'a.txt',
      'replacement',
    )).toThrow('disk full');
    writeSpy.mockRestore();
    expect(fs.readFileSync(path.join(rawDir, 'a.txt'), 'utf-8')).toBe('previous');
    expect(fs.readdirSync(path.join(tmpDir, '.llm-wiki', 'sources', 'general'))).toEqual([]);
  });

  it('raw 覆盖写入中途失败时恢复原文件', async () => {
    const rawDir = path.join(tmpDir, 'raw', 'general');
    const rawFile = path.join(rawDir, 'a.txt');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(rawFile, 'previous');
    const originalWrite = fs.writeFileSync;
    let failed = false;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file) === rawFile && !failed) {
        failed = true;
        originalWrite(file, 'partial');
        throw new Error('disk full during raw write');
      }
      return originalWrite(file, data, options as never);
    });
    const { saveRawSource } = await import('../source-store');

    expect(() => saveRawSource(
      { id: 'sub1', slug: 'general' },
      'a.txt',
      'replacement',
    )).toThrow('disk full during raw write');
    writeSpy.mockRestore();
    expect(fs.readFileSync(rawFile, 'utf-8')).toBe('previous');
  });

  it('并发 loser sidecar 删除失败时写入持久化补偿记录', async () => {
    sourceRepoMocks.insertSourceOrGetWinner.mockImplementation((candidate) => ({
      source: { ...(candidate as Record<string, unknown>), id: 'winner-id' },
      inserted: false,
    }));
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('permission denied');
    });
    const { saveRawSource } = await import('../source-store');

    const result = saveRawSource({ id: 'sub1', slug: 'general' }, 'a.txt', 'hello');

    rmSpy.mockRestore();
    expect(result.id).toBe('winner-id');
    expect(sourceRepoMocks.recordSourceSidecarCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ winnerId: 'winner-id', subjectSlug: 'general', filename: 'a.txt' }),
    );
  });
});

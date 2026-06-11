import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

vi.mock('../../config/env', () => ({
  vaultPath: (...segs: string[]) => path.join(tmpDir, ...segs),
}));

vi.mock('../../db/repos/sources-repo', () => ({
  getSourceByHash: () => null,
  upsertSource: vi.fn(),
}));

describe('updateSourceChunks', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
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
});

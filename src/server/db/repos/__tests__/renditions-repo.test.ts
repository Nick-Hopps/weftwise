import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'renditions-repo-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => {
  process.env.DATABASE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  subjectId: 's1',
  slug: 'a',
  canonicalHash: 'h1',
  profileVersion: 1,
  renderedMd: '重塑版',
  model: 'm',
};

describe('renditions-repo', () => {
  it('持久化最新成功版本，不因 canonical 或画像随后变化而隐藏', async () => {
    const repo = await import('../renditions-repo');
    repo.replaceRendition({ ...base, assets: [] });
    expect(repo.getLatestRendition('s1', 'a')).toMatchObject({
      renderedMd: '重塑版', canonicalHash: 'h1', profileVersion: 1,
    });
  });

  it('原子替换正文与图片，并删除上一版本图片', async () => {
    const repo = await import('../renditions-repo');
    repo.replaceRendition({
      ...base,
      renderedMd: '旧版 ![](/api/rendition-assets/old)',
      assets: [{ id: 'old', mediaType: 'image/png', dataBase64: 'b2xk' }],
    });
    repo.replaceRendition({
      ...base,
      canonicalHash: 'h9',
      profileVersion: 5,
      renderedMd: '新版 ![](/api/rendition-assets/new)',
      assets: [{ id: 'new', mediaType: 'image/webp', dataBase64: 'bmV3' }],
    });

    expect(repo.getLatestRendition('s1', 'a')?.renderedMd).toContain('新版');
    expect(repo.getRenditionAsset('old')).toBeNull();
    expect(repo.getRenditionAsset('new')).toEqual({ mediaType: 'image/webp', dataBase64: 'bmV3' });
  });

  it('deleteBySubject 清空该 subject 缓存', async () => {
    const repo = await import('../renditions-repo');
    repo.replaceRendition({ ...base, assets: [{ id: 's1-asset', mediaType: 'image/png', dataBase64: 'YQ==' }] });
    repo.replaceRendition({ ...base, subjectId: 's2', assets: [] });
    repo.deleteBySubject('s1');
    expect(repo.getLatestRendition('s1', 'a')).toBeNull();
    expect(repo.getRenditionAsset('s1-asset')).toBeNull();
    expect(repo.getLatestRendition('s2', 'a')?.renderedMd).toBe('重塑版');
  });
});

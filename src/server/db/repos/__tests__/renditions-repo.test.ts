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

  it('deleteByPage 原子清空指定页正文与图片，不影响同 Subject 其他页', async () => {
    const repo = await import('../renditions-repo');
    repo.replaceRendition({
      ...base,
      assets: [{ id: 'page-a-asset', mediaType: 'image/png', dataBase64: 'YQ==' }],
    });
    repo.replaceRendition({ ...base, slug: 'b', renderedMd: 'B 版', assets: [] });

    repo.deleteByPage('s1', 'a');

    expect(repo.getLatestRendition('s1', 'a')).toBeNull();
    expect(repo.getRenditionAsset('page-a-asset')).toBeNull();
    expect(repo.getLatestRendition('s1', 'b')?.renderedMd).toBe('B 版');
  });
});

describe('known_concepts_json（E4）', () => {
  it('replaceRendition 落列，getLatestRendition 读回', async () => {
    const repo = await import('../renditions-repo');
    const snapshot = JSON.stringify({ mastered: [{ slug: 'gd', title: 'GD', state: 'mastered' }] });

    repo.replaceRendition({
      subjectId: 's1', slug: 'a', canonicalHash: 'h', profileVersion: 1,
      renderedMd: 'md', model: null, assets: [], knownConceptsJson: snapshot,
    });

    expect(repo.getLatestRendition('s1', 'a')?.knownConceptsJson).toBe(snapshot);
  });

  it('不传时落 null（无地图 / 旧行语义）', async () => {
    const repo = await import('../renditions-repo');
    repo.replaceRendition({
      subjectId: 's1', slug: 'b', canonicalHash: 'h', profileVersion: 1,
      renderedMd: 'md', model: null, assets: [],
    });
    expect(repo.getLatestRendition('s1', 'b')?.knownConceptsJson).toBeNull();
  });

  it('重新生成时覆盖旧快照，不残留上一次的地图', async () => {
    const repo = await import('../renditions-repo');
    const first = JSON.stringify({ mastered: [{ slug: 'a', title: 'A', state: 'mastered' }] });
    const second = JSON.stringify({ mastered: [] });

    repo.replaceRendition({
      subjectId: 's1', slug: 'c', canonicalHash: 'h', profileVersion: 1,
      renderedMd: 'md', model: null, assets: [], knownConceptsJson: first,
    });
    repo.replaceRendition({
      subjectId: 's1', slug: 'c', canonicalHash: 'h2', profileVersion: 2,
      renderedMd: 'md2', model: null, assets: [], knownConceptsJson: second,
    });

    expect(repo.getLatestRendition('s1', 'c')?.knownConceptsJson).toBe(second);
  });
});

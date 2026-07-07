import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;
let prevVault: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-store-del-'));
  prevDb = process.env.DATABASE_PATH;
  prevVault = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  process.env.VAULT_PATH = prevVault;
  rmSync(dir, { recursive: true, force: true });
});

describe('deleteRawSourceFiles', () => {
  it('删除 subject-scoped raw 文件与 sidecar（含 legacy 平铺 sidecar），不删 legacy 平铺 raw', async () => {
    const vault = join(dir, 'vault');
    const rawDir = join(vault, 'raw', 'subj');
    const metaDir = join(vault, '.llm-wiki', 'sources', 'subj');
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(rawDir, 'a.md'), 'content');
    writeFileSync(join(metaDir, 'id-1.json'), '{}');
    // legacy 平铺 sidecar（UUID 命名，无歧义 → 可删）
    writeFileSync(join(vault, '.llm-wiki', 'sources', 'id-1.json'), '{}');
    // legacy 平铺 raw（按 filename 命名，可能属于其他 subject → 不删）
    writeFileSync(join(vault, 'raw', 'a.md'), 'legacy content');

    const { deleteRawSourceFiles } = await import('../source-store');
    deleteRawSourceFiles('subj', 'a.md', 'id-1');

    expect(existsSync(join(rawDir, 'a.md'))).toBe(false);
    expect(existsSync(join(metaDir, 'id-1.json'))).toBe(false);
    expect(existsSync(join(vault, '.llm-wiki', 'sources', 'id-1.json'))).toBe(false);
    expect(existsSync(join(vault, 'raw', 'a.md'))).toBe(true); // legacy raw 保留
  });

  it('文件不存在时静默返回（best-effort）', async () => {
    const { deleteRawSourceFiles } = await import('../source-store');
    expect(() => deleteRawSourceFiles('subj', 'ghost.md', 'no-such-id')).not.toThrow();
  });

  it('拒绝越权 filename（路径穿越防护）', async () => {
    const vault = join(dir, 'vault');
    mkdirSync(join(vault, 'raw', 'subj'), { recursive: true });
    writeFileSync(join(vault, 'escape.md'), 'outside');
    const { deleteRawSourceFiles } = await import('../source-store');
    deleteRawSourceFiles('subj', '../../escape.md', 'id-x');
    expect(existsSync(join(vault, 'escape.md'))).toBe(true); // basename 化后只会找 raw/subj/escape.md
  });
});

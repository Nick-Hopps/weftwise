import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let vaultDir: string;

vi.mock('../../config/env', () => ({
  vaultPath: (...parts: string[]) => join(vaultDir, ...parts),
}));

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'source-stale-'));
  vi.resetModules();
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

function writeRaw(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

describe('isSourceStale', () => {
  it('subject 文件匹配 hash 时不过期，内容变化时过期', async () => {
    const path = join(vaultDir, 'raw', 'general', 'a.md');
    const hash = writeRaw(path, 'alpha');
    const { isSourceStale } = await import('../source-staleness');

    expect(isSourceStale('general', { filename: 'a.md', contentHash: hash })).toBe(false);

    writeFileSync(path, 'changed');
    expect(isSourceStale('general', { filename: 'a.md', contentHash: hash })).toBe(true);
  });

  it('subject 与 legacy 文件都不存在时过期', async () => {
    const { isSourceStale } = await import('../source-staleness');

    expect(isSourceStale('general', { filename: 'missing.md', contentHash: 'hash' })).toBe(true);
  });

  it('subject 文件不存在时回落 legacy raw 文件', async () => {
    const hash = writeRaw(join(vaultDir, 'raw', 'legacy.md'), 'legacy');
    const { isSourceStale } = await import('../source-staleness');

    expect(isSourceStale('general', { filename: 'legacy.md', contentHash: hash })).toBe(false);
  });
});

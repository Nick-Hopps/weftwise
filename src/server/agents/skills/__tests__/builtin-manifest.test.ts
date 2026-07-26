import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_SKILLS, BUILTIN_UPGRADE_HASHES } from '../builtin-manifest';

const EXAMPLES_DIR = join(process.cwd(), 'examples', 'skills');

/** 与 registry.ts::fileSha256 同口径：整文件字节的 SHA-256。 */
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('BUILTIN_UPGRADE_HASHES', () => {
  it('ingest-enricher 白名单含 v6 原版哈希（否则既有 vault 卡在 v6 撞版本门）', () => {
    // v6 原版（`examples/skills/ingest-enricher.md` 在升 v7 之前的完整文件）的 SHA-256。
    // 自动升级只替换 hash 精确匹配历史原版的 vault 副本；漏掉这一条，所有未改过 skill
    // 的既有 vault 都会停在 v6，而流水线要求 v7+，启动即 fail-fast。
    const V6_HASH = '80b59ca6cac1379537030d577a4802f25cbed8b050ff48bb6e1f3e60550c9a2d';
    expect(BUILTIN_UPGRADE_HASHES['ingest-enricher']).toContain(V6_HASH);
  });

  it('当前模板自身的哈希不得出现在升级白名单里（否则每次启动都自我替换）', () => {
    for (const [skillId, filename] of Object.entries(BUILTIN_SKILLS)) {
      const current = fileSha256(join(EXAMPLES_DIR, filename));
      const whitelist = BUILTIN_UPGRADE_HASHES[skillId as keyof typeof BUILTIN_SKILLS] ?? [];
      expect(whitelist, `${skillId} 的当前版本哈希被误列为历史原版`).not.toContain(current);
    }
  });
});

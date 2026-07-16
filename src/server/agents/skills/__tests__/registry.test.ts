import { describe, expect, it, vi } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { retireBuiltinSkillFiles, upgradeBuiltinSkillFiles } from '../registry';
import { loadSkillsFromDir } from '../loader';
import { BUILTIN_UPGRADE_HASHES } from '../builtin-manifest';

const FIXTURE = join(__dirname, 'fixtures', 'ingest-indexer-v1.md');

function makeVault() {
  const vaultDir = mkdtempSync(join(tmpdir(), 'retired-skill-'));
  const skillsDir = join(vaultDir, '.llm-wiki', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  return { vaultDir, skillsDir };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('upgradeBuiltinSkillFiles', () => {
  it('允许把未修改的 ingest-enricher v5 自动升级到 v6', () => {
    expect(BUILTIN_UPGRADE_HASHES['ingest-enricher']).toContain(
      'f44633a47747a8628768182ea951d064906477f54445ace2dfb5488cf903f396',
    );
  });

  it('只升级 hash 精确匹配的历史内置原版', () => {
    const { vaultDir, skillsDir } = makeVault();
    const examplesDir = mkdtempSync(join(tmpdir(), 'builtin-skill-examples-'));
    const oldBuiltin = 'historical builtin\n';
    const currentBuiltin = 'current builtin\n';
    writeFileSync(join(skillsDir, 'ingest-enricher.md'), oldBuiltin);
    writeFileSync(join(examplesDir, 'ingest-enricher.md'), currentBuiltin);

    const result = upgradeBuiltinSkillFiles({
      vaultDir,
      examplesDir,
      upgradeHashes: { 'ingest-enricher': [sha256(oldBuiltin)] },
    });

    expect(result).toEqual({ upgraded: ['ingest-enricher'] });
    expect(readFileSync(join(skillsDir, 'ingest-enricher.md'), 'utf8')).toBe(currentBuiltin);
  });

  it('不覆盖 hash 未命中的用户改版', () => {
    const { vaultDir, skillsDir } = makeVault();
    const examplesDir = mkdtempSync(join(tmpdir(), 'builtin-skill-examples-'));
    const userEdited = 'historical builtin\n用户修改\n';
    writeFileSync(join(skillsDir, 'ingest-enricher.md'), userEdited);
    writeFileSync(join(examplesDir, 'ingest-enricher.md'), 'current builtin\n');

    const result = upgradeBuiltinSkillFiles({
      vaultDir,
      examplesDir,
      upgradeHashes: { 'ingest-enricher': [sha256('historical builtin\n')] },
    });

    expect(result).toEqual({ upgraded: [] });
    expect(readFileSync(join(skillsDir, 'ingest-enricher.md'), 'utf8')).toBe(userEdited);
  });
});

describe('retireBuiltinSkillFiles', () => {
  it('删除 hash 匹配历史模板的 retired 原版', () => {
    const { vaultDir, skillsDir } = makeVault();
    const retiredPath = join(skillsDir, 'ingest-indexer.md');
    copyFileSync(FIXTURE, retiredPath);

    const result = retireBuiltinSkillFiles({ vaultDir });

    expect(result).toEqual({ removed: ['ingest-indexer'], archived: [] });
    expect(existsSync(retiredPath)).toBe(false);
  });

  it('归档用户改版并发出告警', () => {
    const { vaultDir, skillsDir } = makeVault();
    const retiredPath = join(skillsDir, 'ingest-indexer.md');
    writeFileSync(retiredPath, `${readFileSync(FIXTURE, 'utf8')}\n用户修改\n`);
    const onWarning = vi.fn();

    const result = retireBuiltinSkillFiles({
      vaultDir,
      now: () => new Date('2026-07-10T12:34:56.000Z'),
      onWarning,
    });

    const archiveDir = join(vaultDir, '.llm-wiki', 'skills-retired');
    const archivedFiles = readdirSync(archiveDir);
    expect(result).toEqual({ removed: [], archived: ['ingest-indexer'] });
    expect(archivedFiles).toEqual(['ingest-indexer-2026-07-10T12-34-56-000Z.md']);
    expect(readFileSync(join(archiveDir, archivedFiles[0]), 'utf8')).toContain('用户修改');
    expect(onWarning).toHaveBeenCalledOnce();
  });
});

describe('loadSkillsFromDir retired tombstone', () => {
  it('即使 retired 文件合法也不注册或降级', async () => {
    const { skillsDir } = makeVault();
    copyFileSync(FIXTURE, join(skillsDir, 'ingest-indexer.md'));

    const result = await loadSkillsFromDir(skillsDir);

    expect(result.skills.some((skill) => skill.id === 'ingest-indexer')).toBe(false);
    expect(result.degraded).toEqual([]);
  });
});

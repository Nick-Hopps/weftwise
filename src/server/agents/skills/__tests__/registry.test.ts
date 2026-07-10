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
import { retireBuiltinSkillFiles } from '../registry';
import { loadSkillsFromDir } from '../loader';

const FIXTURE = join(__dirname, 'fixtures', 'ingest-indexer-v1.md');

function makeVault() {
  const vaultDir = mkdtempSync(join(tmpdir(), 'retired-skill-'));
  const skillsDir = join(vaultDir, '.llm-wiki', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  return { vaultDir, skillsDir };
}

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

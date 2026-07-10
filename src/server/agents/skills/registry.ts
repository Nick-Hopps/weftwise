import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { SkillRegistry, SkillTemplate } from '../types';
import { loadSkillsFromDir } from './loader';
import {
  BUILTIN_SKILLS,
  RETIRED_BUILTIN_HASHES,
  RETIRED_BUILTIN_SKILLS,
} from './builtin-manifest';

export interface SkillRegistryHandle extends SkillRegistry {
  readonly loadedAt: number;
}

export interface RetireBuiltinSkillOptions {
  vaultDir: string;
  now?: () => Date;
  onWarning?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface RetireBuiltinSkillResult {
  removed: string[];
  archived: string[];
}

/**
 * 处理已经退役的内置 skill：未修改的历史原版删除，用户改版移动到归档目录。
 * loader 另有 ID tombstone，因此即使清理中断，retired skill 也不会重新注册。
 */
export function retireBuiltinSkillFiles(
  options: RetireBuiltinSkillOptions,
): RetireBuiltinSkillResult {
  const skillsDir = join(options.vaultDir, '.llm-wiki', 'skills');
  const result: RetireBuiltinSkillResult = { removed: [], archived: [] };
  if (!existsSync(skillsDir)) return result;

  for (const id of RETIRED_BUILTIN_SKILLS) {
    const path = join(skillsDir, `${id}.md`);
    if (!existsSync(path)) continue;

    const content = readFileSync(path);
    const hash = createHash('sha256').update(content).digest('hex');
    if (RETIRED_BUILTIN_HASHES[id].includes(hash)) {
      unlinkSync(path);
      result.removed.push(id);
      continue;
    }

    const archiveDir = join(options.vaultDir, '.llm-wiki', 'skills-retired');
    mkdirSync(archiveDir, { recursive: true });
    const timestamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const archivePath = join(archiveDir, `${id}-${timestamp}.md`);
    renameSync(path, archivePath);
    result.archived.push(id);
    options.onWarning?.(
      `Retired builtin skill "${id}" had user changes and was archived instead of deleted.`,
      { id, hash, archivePath },
    );
  }

  return result;
}

export async function buildSkillRegistry(opts: {
  vaultDir: string;
  examplesDir: string;
  onWarning?: RetireBuiltinSkillOptions['onWarning'];
}): Promise<SkillRegistryHandle> {
  const skillsDir = join(opts.vaultDir, '.llm-wiki', 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }
  retireBuiltinSkillFiles({ vaultDir: opts.vaultDir, onWarning: opts.onWarning });

  // 只播种 manifest 中仍启用的内置 skill，且永不覆盖用户文件。
  if (existsSync(opts.examplesDir)) {
    for (const entry of Object.values(BUILTIN_SKILLS)) {
      const src = join(opts.examplesDir, entry);
      const dst = join(skillsDir, entry);
      if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst);
    }
  }

  const { skills, degraded } = await loadSkillsFromDir(skillsDir);
  const map = new Map<string, SkillTemplate>();
  for (const s of skills) map.set(s.id, s);

  return {
    loadedAt: Date.now(),
    get(id) { return map.get(id); },
    list() { return Array.from(map.values()); },
    degraded() { return degraded; },
  };
}

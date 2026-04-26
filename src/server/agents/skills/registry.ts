import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillRegistry, SkillTemplate } from '../types';
import { loadSkillsFromDir } from './loader';

export interface SkillRegistryHandle extends SkillRegistry {
  readonly loadedAt: number;
}

export async function buildSkillRegistry(opts: {
  vaultDir: string;
  examplesDir: string;
}): Promise<SkillRegistryHandle> {
  const skillsDir = join(opts.vaultDir, '.llm-wiki', 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }
  // Seed examples — never overwrite existing files.
  if (existsSync(opts.examplesDir)) {
    for (const entry of readdirSync(opts.examplesDir)) {
      if (!entry.endsWith('.md')) continue;
      const src = join(opts.examplesDir, entry);
      const dst = join(skillsDir, entry);
      if (!existsSync(dst)) copyFileSync(src, dst);
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

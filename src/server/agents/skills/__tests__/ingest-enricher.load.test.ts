import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSkillsFromDir } from '../loader';

const EXAMPLES_DIR = join(process.cwd(), 'examples', 'skills');

describe('ingest-enricher skill 载入', () => {
  it('合法载入：id/version/tools/outputSchema', async () => {
    const { skills, degraded } = await loadSkillsFromDir(EXAMPLES_DIR);
    expect(degraded.find((d) => d.skillId === 'ingest-enricher')).toBeUndefined();
    const s = skills.find((k) => k.id === 'ingest-enricher');
    expect(s).toBeDefined();
    expect(s!.version).toBeGreaterThanOrEqual(1);
    expect(s!.tools).toEqual(['image.generate']); // enrich 组合路径的真实图片工具
    expect(s!.outputSchema).toBeDefined();
    // 系统提示强约束：保留忠实层 + callout 承载增益
    expect(s!.systemPrompt).toContain('[!');
  });

  it('writer 升级到 v4（忠实化分工）', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const w = skills.find((k) => k.id === 'ingest-writer');
    expect(w!.version).toBeGreaterThanOrEqual(4);
  });
});

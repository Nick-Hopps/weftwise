import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSkillsFromDir } from '../loader';

const EXAMPLES_DIR = join(process.cwd(), 'examples', 'skills');

describe('reenrich-supplement skill 载入', () => {
  it('合法载入：id/version/tools/outputSchema', async () => {
    const { skills, degraded } = await loadSkillsFromDir(EXAMPLES_DIR);
    expect(degraded.find((d) => d.skillId === 'reenrich-supplement')).toBeUndefined();
    const s = skills.find((k) => k.id === 'reenrich-supplement');
    expect(s).toBeDefined();
    expect(s!.version).toBeGreaterThanOrEqual(1);
    expect(s!.tools).toEqual([]); // 结构化输出无工具
    expect(s!.outputSchema).toBeDefined();
    // 分层边界必须写进系统提示
    expect(s!.systemPrompt.toLowerCase()).toContain('neutral');
    expect(s!.systemPrompt).toContain('frontmatter');
  });
});

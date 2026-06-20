import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSkillsFromDir } from '../loader';

const EXAMPLES_DIR = join(process.cwd(), 'examples', 'skills');

describe('ingest-verifier skill 载入', () => {
  it('合法载入：id/tools 空/outputSchema', async () => {
    const { skills, degraded } = await loadSkillsFromDir(EXAMPLES_DIR);
    expect(degraded.find((d) => d.skillId === 'ingest-verifier')).toBeUndefined();
    const s = skills.find((k) => k.id === 'ingest-verifier');
    expect(s).toBeDefined();
    expect(s!.tools).toEqual([]); // P2 无工具（web 检索是 P3）
    expect(s!.outputSchema).toBeDefined();
    expect(s!.systemPrompt.toLowerCase()).toContain('callout');
  });
});

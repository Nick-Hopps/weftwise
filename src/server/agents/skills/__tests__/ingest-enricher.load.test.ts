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
    expect(s!.version).toBeGreaterThanOrEqual(7);
    expect(s!.tools).toEqual(['image.generate']); // enrich 组合路径的真实图片工具
    expect(s!.outputSchema).toBeDefined();
    // 系统提示强约束：保留忠实层 + callout 承载增益
    expect(s!.systemPrompt).toContain('[!');
  });

  it('v7 契约：quiz callout 必须用 `---` 分隔问题与答案', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const prompt = skills.find((k) => k.id === 'ingest-enricher')!.systemPrompt;

    // 分隔符本身：前端 `createRemarkQuiz()` 按 blockquote 内首个 thematicBreak 切分，
    // 选它是因为语言无关——不依赖「答案：」/「Answer:」这类会随 languageDirective 漂移的标记。
    expect(prompt).toContain('> ---');
    // 分隔符不得被当作自然语言翻译
    expect(prompt).toMatch(/---[^\n]*(never|not|不).*(translat|翻译)/i);
    // 答案不得引入正文没有的事实
    expect(prompt).toMatch(/answer/i);
  });

  it('writer 升级到 v4（忠实化分工）', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const w = skills.find((k) => k.id === 'ingest-writer');
    expect(w!.version).toBeGreaterThanOrEqual(4);
  });
});

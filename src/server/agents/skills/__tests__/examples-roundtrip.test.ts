// 真实 examples/skills/ 文件的 round-trip 测试
// 目标：examples 里的 frontmatter/outputSchema 损坏时测试即红
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadSkillsFromDir } from '../loader';

const EXAMPLES_DIR = join(__dirname, '../../../../..', 'examples/skills');

describe('examples/skills round-trip', () => {
  it('所有 ingest skill 均可成功加载（无 degraded）', async () => {
    const { skills, degraded } = await loadSkillsFromDir(EXAMPLES_DIR);
    expect(degraded).toEqual([]);
    expect(skills.length).toBeGreaterThanOrEqual(3);
  });

  it('ingest-planner version >= 2 且 outputSchema 含必填 sourceRefs', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const planner = skills.find((s) => s.id === 'ingest-planner');
    expect(planner).toBeDefined();
    expect(planner!.version).toBeGreaterThanOrEqual(2);
    expect(planner!.outputSchema).toBeDefined();

    // outputSchema 必须接受含 sourceRefs 的 plan 结构
    const valid = planner!.outputSchema!.safeParse({
      plan: {
        pages: [
          {
            slug: 'test-page',
            title: 'Test',
            summary: 'A test page',
            sourceRefs: [{ sourceId: 'src1', chunkIds: ['c0'] }],
          },
        ],
      },
    });
    expect(valid.success).toBe(true);

    // sourceRefs 必填：缺失时应解析失败
    const invalid = planner!.outputSchema!.safeParse({
      plan: {
        pages: [{ slug: 'test-page', title: 'Test', summary: 'A test page' }],
      },
    });
    expect(invalid.success).toBe(false);
  });

  it('ingest-writer version >= 2', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const writer = skills.find((s) => s.id === 'ingest-writer');
    expect(writer).toBeDefined();
    expect(writer!.version).toBeGreaterThanOrEqual(2);
  });

  it('ingest-chunk-summarizer 可加载、tools 为空、且不设 maxTokens 上限', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const summarizer = skills.find((s) => s.id === 'ingest-chunk-summarizer');
    expect(summarizer).toBeDefined();
    expect(summarizer!.tools).toEqual([]);
    // 不给 structured-output 的 map 步设输出上限：截断会产出残缺 JSON（finishReason:length →
    // "No object generated"），234 块里任一截断都会让整个 ingest 失败。简洁靠提示词约束，不靠硬截断。
    expect(summarizer!.model?.maxTokens).toBeUndefined();
  });
});

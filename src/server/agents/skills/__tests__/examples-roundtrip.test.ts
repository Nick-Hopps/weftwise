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

  it('ingest-writer version >= 3 且 outputSchema 为扁平 entry（无 entry 包装）', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const writer = skills.find((s) => s.id === 'ingest-writer');
    expect(writer).toBeDefined();
    expect(writer!.version).toBeGreaterThanOrEqual(3);
    expect(writer!.outputSchema).toBeDefined();

    // outputSchema 直接就是 changeset entry：DeepSeek 等会拍平单键 { entry } 包装（吐裸
    // {action,path,content}），故移除包装让 schema 对齐模型自然输出。
    const valid = writer!.outputSchema!.safeParse({
      action: 'create',
      path: 'wiki/general/a.md',
      content: '---\ntitle: A\n---\n# A',
    });
    expect(valid.success).toBe(true);

    // 旧的 { entry: {...} } 包装形状缺失顶层必填字段，不再被接受
    const wrapped = writer!.outputSchema!.safeParse({
      entry: { action: 'create', path: 'wiki/general/a.md', content: 'x' },
    });
    expect(wrapped.success).toBe(false);

    // required 缺失（无 content）时解析失败
    const missing = writer!.outputSchema!.safeParse({ action: 'create', path: 'wiki/general/a.md' });
    expect(missing.success).toBe(false);
  });

  it('ingest-reviewer 已移除（commit 上移到 service 层，不再有 tool-using 审校阶段）', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    expect(skills.find((s) => s.id === 'ingest-reviewer')).toBeUndefined();
  });

  it('ingest-indexer 已移除（T2.1：index/log 改确定性渲染，见 wiki/meta-pages.ts，不再走 LLM）', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    expect(skills.find((s) => s.id === 'ingest-indexer')).toBeUndefined();
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

describe('ingest-verifier-triage / -apply (⑨)', () => {
  it('both load with version >= 1 and outputSchema', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const triage = skills.find((s) => s.id === 'ingest-verifier-triage');
    const apply = skills.find((s) => s.id === 'ingest-verifier-apply');
    expect(triage).toBeDefined();
    expect(apply).toBeDefined();
    expect(triage!.version).toBeGreaterThanOrEqual(1);
    expect(apply!.version).toBeGreaterThanOrEqual(1);
    expect(triage!.outputSchema).toBeDefined();
    expect(apply!.outputSchema).toBeDefined();
  });

  it('triage outputSchema accepts doubtfulClaims, rejects missing query', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const triage = skills.find((s) => s.id === 'ingest-verifier-triage')!;
    expect(triage.outputSchema!.safeParse({ doubtfulClaims: [] }).success).toBe(true);
    expect(triage.outputSchema!.safeParse({
      doubtfulClaims: [{ excerpt: 'e', query: 'q', reason: 'r' }],
    }).success).toBe(true);
    expect(triage.outputSchema!.safeParse({
      doubtfulClaims: [{ excerpt: 'e', reason: 'r' }],
    }).success).toBe(false);
  });

  it('apply outputSchema accepts citedSources array', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const apply = skills.find((s) => s.id === 'ingest-verifier-apply')!;
    expect(apply.outputSchema!.safeParse({
      action: 'update',
      path: 'wiki/general/x.md',
      content: '...',
      citedSources: [{ url: 'https://a.com', title: 'T' }],
    }).success).toBe(true);
    expect(apply.outputSchema!.safeParse({
      action: 'update', path: 'p', content: 'c', citedSources: [{ url: 'u' }],
    }).success).toBe(false);
  });
});

// src/server/agents/runtime/__tests__/orchestrator.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runPipeline, WriterConflictError } from '../orchestrator';
import { BudgetExceededError } from '../budget';
import type { AgentContext, SkillTemplate, StoredChunk } from '../../types';

const mockRun = vi.fn();
vi.mock('../agent-loop', () => ({
  runAgentLoop: (opts: { skill: { id: string }; input: unknown }) => mockRun(opts),
  AgentCancelled: class extends Error {},
}));

function ctxStub(chunks: StoredChunk[] = []): AgentContext {
  const chunkStore = new Map<string, StoredChunk>();
  for (const c of chunks) chunkStore.set(`${c.sourceId}:${c.id}`, c);
  return {
    job: { id: 'j' } as AgentContext['job'],
    subject: { slug: 'general' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeTokens: vi.fn(), assertWithin: vi.fn(), tokensUsed: 0 },
    overlay: { snapshot: vi.fn(() => ({ snapshot: () => ({}), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() })), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() } as unknown as AgentContext['overlay'],
    toolRegistry: { register: vi.fn(), resolve: vi.fn(() => []), get: vi.fn() },
    skillRegistry: { get: vi.fn(), list: vi.fn(() => []), degraded: vi.fn(() => []) },
    rootRunId: 'r0',
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    chunkStore,
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 500_000, maxParallelSubAgents: 2 },
  } as AgentContext;
}

const stubSkill = (id: string): SkillTemplate => ({
  id, name: id, description: '', version: 1, tools: [], canDispatch: [], systemPrompt: '',
});

const chunk = (sourceId: string, id: string, text: string): StoredChunk =>
  ({ sourceId, id, heading: '', text });

describe('orchestrator.runPipeline: sequence', () => {
  it('顺序执行并传递输出', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: '1', output: { plan: { pages: [] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: '2', output: { final: 'ok' }, tokensUsed: 0, stepCount: 1 });
    const result = await runPipeline({
      steps: [{ kind: 'sequence', skillId: 'planner' }, { kind: 'sequence', skillId: 'reviewer' }],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: { sources: [] },
    });
    expect(result).toEqual({ final: 'ok' });
  });

  it('carryThrough 把指定 key 从前一 carry 透传到新 carry', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: '1', output: { plan: { pages: [] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: '2', output: { final: 'ok' }, tokensUsed: 0, stepCount: 1 });
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'chunkRefs'] },
        { kind: 'sequence', skillId: 'reviewer' },
      ],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: { subjectSlug: 'general', chunkRefs: [{ key: 'k' }], other: 'dropped' },
    });
    // reviewer 的输入 = carryThrough keys + planner 输出
    expect(mockRun.mock.calls[1][0].input).toEqual({
      subjectSlug: 'general',
      chunkRefs: [{ key: 'k' }],
      plan: { pages: [] },
    });
  });

  it('omitFromInput 从该步输入中剔除指定 key', async () => {
    mockRun.mockReset();
    mockRun.mockResolvedValueOnce({ runId: '1', output: { done: true }, tokensUsed: 0, stepCount: 1 });
    await runPipeline({
      steps: [{ kind: 'sequence', skillId: 'reviewer', omitFromInput: ['chunkRefs', 'outline'] }],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: { chunkRefs: [{ key: 'k' }], outline: '- x', plan: { pages: [] } },
    });
    expect(mockRun.mock.calls[0][0].input).toEqual({ plan: { pages: [] } });
  });
});

describe('orchestrator.runPipeline: map', () => {
  it('逐块只注入本块全文（不广播全文 outline，避免 O(N²) token），把 summary 写回 content', async () => {
    mockRun.mockReset();
    mockRun.mockImplementation(async (opts: { input: { id: string } }) => ({
      runId: `m-${opts.input.id}`,
      output: { summary: `摘要:${opts.input.id}` },
      tokensUsed: 0,
      stepCount: 1,
    }));
    const ctx = ctxStub([chunk('s1', 'c0', '全文零'), chunk('s1', 'c1', '全文一')]);
    const result = await runPipeline({
      steps: [{ kind: 'map', skillId: 'summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {
        outline: '- [s1:c0] x\n- [s1:c1] y',
        chunkRefs: [
          { key: 's1:c0', sourceId: 's1', id: 'c0', heading: '', content: '' },
          { key: 's1:c1', sourceId: 's1', id: 'c1', heading: '', content: '' },
        ],
      },
    });
    // summarizer 收到本块全文，但绝不携带整份 outline（O(N²) 根因）
    expect(mockRun.mock.calls[0][0].input).toMatchObject({ text: '全文零' });
    expect((mockRun.mock.calls[0][0].input as Record<string, unknown>).outline).toBeUndefined();
    const r = result as { chunkRefs: Array<{ content: string }> };
    expect(r.chunkRefs.map((c) => c.content)).toEqual(['摘要:c0', '摘要:c1']);
  });

  it('chunkStore 缺失的块跳过并 emit warn，原 item 保留', async () => {
    mockRun.mockReset();
    const ctx = ctxStub([]); // 空 chunkStore
    const result = await runPipeline({
      steps: [{ kind: 'map', skillId: 'summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { chunkRefs: [{ key: 's1:c9', sourceId: 's1', id: 'c9', heading: '', content: '' }] },
    });
    expect(mockRun).not.toHaveBeenCalled();
    expect(ctx.emit).toHaveBeenCalledWith('ingest:warn', expect.stringContaining('s1:c9'), expect.anything());
    const r = result as { chunkRefs: Array<{ key: string }> };
    expect(r.chunkRefs[0].key).toBe('s1:c9');
  });

  it('summarizer 输出缺 summary 时原 item 保留并 emit warn', async () => {
    mockRun.mockReset();
    mockRun.mockResolvedValueOnce({ runId: 'm-c0', output: '纯文本', tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([chunk('s1', 'c0', '全文零')]);
    const result = await runPipeline({
      steps: [{ kind: 'map', skillId: 'summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { chunkRefs: [{ key: 's1:c0', sourceId: 's1', id: 'c0', heading: '', content: '' }] },
    });
    expect(ctx.emit).toHaveBeenCalledWith('ingest:warn', expect.stringContaining('s1:c0'), expect.objectContaining({ skillId: 'summarizer' }));
    const r = result as { chunkRefs: Array<{ content: string }> };
    expect(r.chunkRefs[0].content).toBe('');
  });

  it('某块 summarizer 抛错时降级为空摘要、不中断全程、其余块照常处理', async () => {
    // map 是逐块独立摘要：单块失败不应拖垮整本书的 ingest（writer 用 chunkStore 全文，不依赖摘要）。
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'm-c0', output: { summary: '摘要:c0' }, tokensUsed: 0, stepCount: 1 })
      .mockRejectedValueOnce(new Error('LLM exploded'))
      .mockResolvedValueOnce({ runId: 'm-c2', output: { summary: '摘要:c2' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([chunk('s1', 'c0', '全文零'), chunk('s1', 'c1', '全文一'), chunk('s1', 'c2', '全文二')]);
    ctx.budgetSnapshot.maxParallelSubAgents = 1; // 串行使断言确定
    const result = await runPipeline({
      steps: [{ kind: 'map', skillId: 'summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {
        chunkRefs: [
          { key: 's1:c0', sourceId: 's1', id: 'c0', heading: '', content: '' },
          { key: 's1:c1', sourceId: 's1', id: 'c1', heading: '', content: '' },
          { key: 's1:c2', sourceId: 's1', id: 'c2', heading: '', content: '' },
        ],
      },
    });
    expect(mockRun).toHaveBeenCalledTimes(3); // 失败块不阻止后续派发
    const r = result as { chunkRefs: Array<{ content: string }> };
    expect(r.chunkRefs.map((c) => c.content)).toEqual(['摘要:c0', '', '摘要:c2']); // 失败块降级为空
    expect(ctx.emit).toHaveBeenCalledWith('ingest:warn', expect.stringContaining('s1:c1'), expect.objectContaining({ skillId: 'summarizer' }));
  });

  it('summarizer 抛 BudgetExceededError 时仍中断全程（控制流异常不被吞）', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'm-c0', output: { summary: '摘要:c0' }, tokensUsed: 0, stepCount: 1 })
      .mockRejectedValueOnce(new BudgetExceededError('maxTokensPerJob', 600000, 500000));
    const ctx = ctxStub([chunk('s1', 'c0', '全文零'), chunk('s1', 'c1', '全文一')]);
    ctx.budgetSnapshot.maxParallelSubAgents = 1;
    await expect(runPipeline({
      steps: [{ kind: 'map', skillId: 'summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {
        chunkRefs: [
          { key: 's1:c0', sourceId: 's1', id: 'c0', heading: '', content: '' },
          { key: 's1:c1', sourceId: 's1', id: 'c1', heading: '', content: '' },
        ],
      },
    })).rejects.toThrow(BudgetExceededError);
  });
});

describe('orchestrator.runPipeline: fanout', () => {
  it('按 sourceRefs 从 chunkStore 注入 relevantChunks（不透传 chunkRefs）', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({
        runId: 'p',
        output: { plan: { pages: [{ slug: 'a', sourceRefs: [{ sourceId: 's1', chunkIds: ['c0', 'c2'] }] }] } },
        tokensUsed: 0, stepCount: 1,
      })
      .mockResolvedValueOnce({ runId: 'w1', output: { action: 'create', path: 'wiki/general/a.md', content: '' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([chunk('s1', 'c0', '块零全文'), chunk('s1', 'c2', '块二全文')]);
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages', 'chunkRefs'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [], chunkRefs: [{ key: 's1:c0' }] },
    });
    const writerInput = mockRun.mock.calls[1][0].input as Record<string, unknown>;
    expect(writerInput.relevantChunks).toEqual([
      { id: 'c0', heading: '', text: '块零全文' },
      { id: 'c2', heading: '', text: '块二全文' },
    ]);
    expect(writerInput.subjectSlug).toBe('general');
    expect(writerInput.chunkRefs).toBeUndefined();
    expect(writerInput.sources).toBeUndefined();
  });

  it('sourceRefs 引用缺失块时跳过 + emit warn', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({
        runId: 'p',
        output: { plan: { pages: [{ slug: 'a', sourceRefs: [{ sourceId: 's1', chunkIds: ['c404'] }] }] } },
        tokensUsed: 0, stepCount: 1,
      })
      .mockResolvedValueOnce({ runId: 'w1', output: { action: 'create', path: 'wiki/general/a.md', content: '' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {},
    });
    expect(ctx.emit).toHaveBeenCalledWith('ingest:warn', expect.stringContaining('c404'), expect.anything());
    const writerInput = mockRun.mock.calls[1][0].input as Record<string, unknown>;
    expect(writerInput.relevantChunks).toEqual([]);
  });

  it('sourceRefs 零匹配时 emit zero-chunks warn', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({
        runId: 'p',
        output: { plan: { pages: [{ slug: 'a', sourceRefs: [{ sourceId: 's1', chunkIds: ['c404'] }] }] } },
        tokensUsed: 0, stepCount: 1,
      })
      .mockResolvedValueOnce({ runId: 'w1', output: { action: 'create', path: 'wiki/general/a.md', content: '' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {},
    });
    expect(ctx.emit).toHaveBeenCalledWith(
      'ingest:warn',
      expect.stringContaining('zero relevant chunks'),
      expect.objectContaining({ slug: 'a' }),
    );
  });

  it('languageDirective 从 initialInput 透传到 writer input', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({
        runId: 'p',
        output: { plan: { pages: [{ slug: 'a', sourceRefs: [] }] } },
        tokensUsed: 0, stepCount: 1,
      })
      .mockResolvedValueOnce({ runId: 'w1', output: { action: 'create', path: 'wiki/general/a.md', content: '' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages', 'languageDirective'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [], languageDirective: 'LANG_DIRECTIVE' },
    });
    const writerInput = mockRun.mock.calls[1][0].input as Record<string, unknown>;
    expect(writerInput.languageDirective).toBe('LANG_DIRECTIVE');
  });

  it('languageDirective 透传到 summarizer (map) input', async () => {
    mockRun.mockReset();
    mockRun.mockImplementation(async (opts: { input: { id: string } }) => ({
      runId: `m-${opts.input.id}`,
      output: { summary: `摘要:${opts.input.id}` },
      tokensUsed: 0,
      stepCount: 1,
    }));
    const ctx = ctxStub([chunk('s1', 'c0', '全文零')]);
    await runPipeline({
      steps: [{ kind: 'map', skillId: 'summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {
        outline: '',
        languageDirective: 'LANG_DIRECTIVE',
        chunkRefs: [{ key: 's1:c0', sourceId: 's1', id: 'c0', heading: '', content: '' }],
      },
    });
    expect(mockRun.mock.calls[0][0].input).toMatchObject({ languageDirective: 'LANG_DIRECTIVE' });
  });

  it('writer fanout 把共享上下文(plan/existingPages)排在 page 专属内容之前，构成可缓存公共前缀', async () => {
    // DeepSeek 自动前缀缓存仅在「从第 0 token 起完全一致」时命中。
    // 共享上下文须落在各 writer 序列化输入的公共前缀内，否则 fanout 无法复用缓存。
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({
        runId: 'p',
        output: { plan: { pages: [{ slug: 'page-a', sourceRefs: [] }, { slug: 'page-b', sourceRefs: [] }] } },
        tokensUsed: 0, stepCount: 1,
      })
      .mockResolvedValueOnce({ runId: 'wa', output: { action: 'create', path: 'wiki/general/page-a.md', content: '' }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'wb', output: { action: 'create', path: 'wiki/general/page-b.md', content: '' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    ctx.budgetSnapshot.maxParallelSubAgents = 1; // 串行确保 call 顺序确定
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [{ slug: 'existing-a', title: 'A', summary: 's' }] },
    });
    const inA = JSON.stringify(mockRun.mock.calls[1][0].input);
    const inB = JSON.stringify(mockRun.mock.calls[2][0].input);
    let i = 0;
    while (i < inA.length && inA[i] === inB[i]) i++;
    const sharedPrefix = inA.slice(0, i); // 两个 writer 输入的公共前缀（DeepSeek 可缓存部分）
    expect(sharedPrefix).toContain('existingPages');
    expect(sharedPrefix).toContain('"plan"');
  });

  it('writer 扁平输出（无 entry 包装）合并到父 overlay 且暴露给 reviewer', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a', sourceRefs: [] }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w1', output: { action: 'create', path: 'wiki/general/a.md', content: '# A' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    const result = await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [] },
    });
    // 父 overlay 收到的就是扁平 ChangesetEntry（无 .entry 包装）
    expect(ctx.overlay.putEntries).toHaveBeenCalledWith([
      { action: 'create', path: 'wiki/general/a.md', content: '# A' },
    ]);
    // writerOutputs（传给 reviewer）也是扁平形状
    expect((result as { writerOutputs: unknown[] }).writerOutputs).toEqual([
      { action: 'create', path: 'wiki/general/a.md', content: '# A' },
    ]);
  });

  it('writer 扁平 entry 累积进 ctx.pending（供 commit 自动提交，reviewer 无需重发）', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a', sourceRefs: [] }, { slug: 'b', sourceRefs: [] }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w1', output: { action: 'create', path: 'wiki/general/a.md', content: '# A' }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w2', output: { action: 'create', path: 'wiki/general/b.md', content: '# B' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    ctx.budgetSnapshot.maxParallelSubAgents = 1; // 串行确保累积顺序确定
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [] },
    });
    expect(ctx.pending.entries).toEqual([
      { action: 'create', path: 'wiki/general/a.md', content: '# A' },
      { action: 'create', path: 'wiki/general/b.md', content: '# B' },
    ]);
  });

  it('writer 路径冲突仍抛 WriterConflictError', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a' }, { slug: 'a' }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w1', output: { action: 'create', path: 'wiki/general/a.md', content: '' }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w2', output: { action: 'create', path: 'wiki/general/a.md', content: '' }, tokensUsed: 0, stepCount: 1 });
    await expect(runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: {},
    })).rejects.toThrow(WriterConflictError);
  });
});

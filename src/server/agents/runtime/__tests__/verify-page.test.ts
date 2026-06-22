import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runAgentLoop = vi.fn();
const isWebSearchConfigured = vi.fn();
const webSearch = vi.fn();

vi.mock('../agent-loop', () => ({ runAgentLoop: (o: unknown) => runAgentLoop(o) }));
vi.mock('../../../search/web-search', () => ({
  isWebSearchConfigured: () => isWebSearchConfigured(),
  webSearch: (q: string) => webSearch(q),
}));

import { runPageVerification } from '../verify-page';
import type { AgentContext, CitedSource } from '../../types';

const PAGE_MD = `---\ntitle: Quicksort\ncreated: '2026-01-01'\nupdated: '2026-01-01'\ntags: []\nsources: []\n---\n\nBody prose.\n\n> [!example] 例题\n> Quicksort was invented in 1959.\n`;

function baseInput(overrides: object = {}) {
  return {
    slug: 'quicksort',
    subjectSlug: 'general',
    content: PAGE_MD,
    existingPages: [{ slug: 'quicksort' }],
    relevantChunks: [],
    languageDirective: '',
    ...overrides,
  };
}

function makeCtx() {
  return {
    emit: vi.fn(),
    citedSources: new Map<string, CitedSource>(),
  } as unknown as AgentContext;
}

const resolveSkill = (id: string) => ({ id, name: id }) as never;

beforeEach(() => {
  runAgentLoop.mockReset();
  isWebSearchConfigured.mockReset();
  webSearch.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('runPageVerification', () => {
  it('not configured → runs self-check skill (ingest-verifier)', async () => {
    isWebSearchConfigured.mockReturnValue(false);
    runAgentLoop.mockResolvedValue({ runId: 'r', output: { action: 'update', path: 'p', content: 'self' }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 });
    const ctx = makeCtx();
    await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    expect(runAgentLoop.mock.calls[0][0].skill.id).toBe('ingest-verifier');
  });

  it('triage empty → passthrough, no search/apply', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    runAgentLoop.mockResolvedValueOnce({ runId: 'r', output: { doubtfulClaims: [] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 });
    const ctx = makeCtx();
    const r = await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(runAgentLoop).toHaveBeenCalledTimes(1); // triage only
    expect(webSearch).not.toHaveBeenCalled();
    const out = r.output as { action: string; path: string; content: string };
    expect(out.action).toBe('update'); // slug in existingPages
    expect(out.content).toBe(PAGE_MD); // passthrough
  });

  it('has evidence → apply, cited urls appended to frontmatter + recorded in ctx', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { doubtfulClaims: [{ excerpt: 'invented in 1959', query: 'quicksort invented year', reason: 'date' }] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { action: 'update', path: 'wiki/general/quicksort.md', content: PAGE_MD.replace('1959', '1959 (Hoare)'), citedSources: [{ url: 'https://en.wikipedia.org/wiki/Quicksort', title: 'Quicksort - Wikipedia' }] }, tokensUsed: 2, stepCount: 1, cacheHitTokens: 0 });
    webSearch.mockResolvedValue([{ title: 'Quicksort - Wikipedia', url: 'https://en.wikipedia.org/wiki/Quicksort', snippet: 'developed by Tony Hoare in 1959' }]);
    const ctx = makeCtx();
    const r = await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(runAgentLoop).toHaveBeenCalledTimes(2); // triage + apply
    expect(webSearch).toHaveBeenCalledTimes(1);
    const out = r.output as { content: string };
    expect(out.content).toContain('https://en.wikipedia.org/wiki/Quicksort'); // in frontmatter sources
    expect(ctx.citedSources!.get('https://en.wikipedia.org/wiki/Quicksort')).toMatchObject({
      title: 'Quicksort - Wikipedia',
      citedBy: ['quicksort'],
      fallbackContent: 'developed by Tony Hoare in 1959',
    });
  });

  it('has evidence → persists ctx.citedSources to checkpoint (⑨ 续传补源)', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { doubtfulClaims: [{ excerpt: 'e', query: 'quicksort year', reason: 'date' }] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { action: 'update', path: 'wiki/general/quicksort.md', content: PAGE_MD, citedSources: [{ url: 'https://en.wikipedia.org/wiki/Quicksort', title: 'Quicksort - Wikipedia' }] }, tokensUsed: 2, stepCount: 1, cacheHitTokens: 0 });
    webSearch.mockResolvedValue([{ title: 'Quicksort - Wikipedia', url: 'https://en.wikipedia.org/wiki/Quicksort', snippet: 'Tony Hoare 1959' }]);
    const putCitedSources = vi.fn();
    const ctx = {
      emit: vi.fn(),
      citedSources: new Map<string, CitedSource>(),
      checkpoint: { putCitedSources, getCitedSources: () => [] },
    } as unknown as AgentContext;
    await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(putCitedSources).toHaveBeenCalledTimes(1);
    const persisted = putCitedSources.mock.calls[0][0] as CitedSource[];
    expect(persisted).toEqual([...ctx.citedSources!.values()]);
    expect(persisted[0]).toMatchObject({ url: 'https://en.wikipedia.org/wiki/Quicksort', citedBy: ['quicksort'] });
  });

  it('triage empty → does NOT persist citedSources (no checkpoint write)', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    runAgentLoop.mockResolvedValueOnce({ runId: 'r', output: { doubtfulClaims: [] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 });
    const putCitedSources = vi.fn();
    const ctx = {
      emit: vi.fn(),
      citedSources: new Map<string, CitedSource>(),
      checkpoint: { putCitedSources, getCitedSources: () => [] },
    } as unknown as AgentContext;
    await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(putCitedSources).not.toHaveBeenCalled();
  });

  it('has doubtful but zero evidence → self-check', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { doubtfulClaims: [{ excerpt: 'x', query: 'q', reason: 'r' }] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { action: 'update', path: 'p', content: 'self' }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 });
    webSearch.mockResolvedValue([]); // zero results
    const ctx = makeCtx();
    await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    expect(runAgentLoop.mock.calls[1][0].skill.id).toBe('ingest-verifier'); // fell back to self-check
  });

  it('dedups queries and caps at 3 searches', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    const claims = [
      { excerpt: 'a', query: 'dup', reason: 'r' },
      { excerpt: 'b', query: 'dup', reason: 'r' },
      { excerpt: 'c', query: 'q2', reason: 'r' },
      { excerpt: 'd', query: 'q3', reason: 'r' },
      { excerpt: 'e', query: 'q4', reason: 'r' },
    ];
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { doubtfulClaims: claims }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { action: 'update', path: 'p', content: PAGE_MD, citedSources: [] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 });
    webSearch.mockResolvedValue([{ title: 't', url: 'https://x.com', snippet: 's' }]);
    const ctx = makeCtx();
    await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    // unique queries: dup,q2,q3,q4 → capped to 3
    expect(webSearch).toHaveBeenCalledTimes(3);
  });
});

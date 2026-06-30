import { describe, expect, it } from 'vitest';
import { expandScopeWithNeighbors, createCurateGuard } from '../curate-plan';

const meta = new Set(['index', 'log']);

describe('expandScopeWithNeighbors', () => {
  const links = [
    { sourceSlug: 'x', targetSlug: 'seed', targetSubjectId: 's1' }, // x -> seed (backlink)
    { sourceSlug: 'seed', targetSlug: 'y', targetSubjectId: 's1' }, // seed -> y (outlink)
    { sourceSlug: 'seed', targetSlug: 'log', targetSubjectId: 's1' }, // meta excluded
    { sourceSlug: 'q', targetSlug: 'seed', targetSubjectId: 's2' },  // other subject excluded
  ];

  it('加入本-subject 的反链源与正链目标，排除 meta 与跨主题', () => {
    const out = expandScopeWithNeighbors(['seed'], links, 's1', meta).sort();
    expect(out).toEqual(['seed', 'x', 'y']);
  });

  it('seed 去重且不含 meta', () => {
    const out = expandScopeWithNeighbors(['seed', 'index'], links, 's1', meta);
    expect(out).not.toContain('index');
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('createCurateGuard', () => {
  const caps = { merge: 2, split: 2, delete: 2, create: 2 };
  it('manual（seedSet=null）放行，达 cap 后拒', () => {
    const g = createCurateGuard({ seedSet: null, caps });
    expect(g.canMerge('a', 'b').ok).toBe(true);
    g.record('merge'); g.record('merge');
    const d = g.canMerge('a', 'b');
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/limit of 2 merges/);
  });
  it('self-merge 与保护页被拒', () => {
    const g = createCurateGuard({ seedSet: null, caps });
    expect(g.canMerge('a', 'a').ok).toBe(false);
    expect(g.canMerge('index', 'b').ok).toBe(false);
    expect(g.canSplit('log').ok).toBe(false);
    expect(g.canDelete('index').ok).toBe(false);
  });
  it('auto（seedSet 非空）：写必须涉及 seed', () => {
    const g = createCurateGuard({ seedSet: new Set(['x']), caps });
    expect(g.canMerge('x', 'y').ok).toBe(true);   // x 在 seed
    expect(g.canMerge('y', 'z').ok).toBe(false);  // 都不在 seed
    expect(g.canMerge('y', 'z').reason).toMatch(/changed page/);
    expect(g.canSplit('y').ok).toBe(false);
    expect(g.canDelete('x').ok).toBe(true);
  });
  it('auto 禁 create；manual 允许且受 cap', () => {
    expect(createCurateGuard({ seedSet: new Set(['x']), caps }).canCreate().ok).toBe(false);
    const g = createCurateGuard({ seedSet: null, caps });
    expect(g.canCreate().ok).toBe(true);
    g.record('create'); g.record('create');
    expect(g.canCreate().ok).toBe(false);
  });
  it('totals 累加准确', () => {
    const g = createCurateGuard({ seedSet: null, caps });
    g.record('merge'); g.record('split'); g.record('delete');
    expect(g.totals()).toEqual({ merge: 1, split: 1, delete: 1, create: 0, writes: 3 });
  });
});

import { describe, expect, it } from 'vitest';
import { expandScopeWithNeighbors, applyDecisionCaps } from '../curate-plan';

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

describe('applyDecisionCaps', () => {
  it('超过上限时截断并报告丢弃数', () => {
    const triage = {
      merges: [
        { aSlug: 'a', bSlug: 'b', reason: 'r' },
        { aSlug: 'c', bSlug: 'd', reason: 'r' },
      ],
      splits: [
        { slug: 'e', reason: 'r' },
        { slug: 'f', reason: 'r' },
        { slug: 'g', reason: 'r' },
      ],
    };
    const { kept, droppedMerges, droppedSplits } = applyDecisionCaps(triage, { maxMerges: 1, maxSplits: 2 });
    expect(kept.merges).toHaveLength(1);
    expect(kept.splits).toHaveLength(2);
    expect(droppedMerges).toBe(1);
    expect(droppedSplits).toBe(1);
  });

  it('未超限时不丢弃', () => {
    const triage = { merges: [], splits: [{ slug: 'e', reason: 'r' }] };
    const { droppedMerges, droppedSplits } = applyDecisionCaps(triage, { maxMerges: 5, maxSplits: 5 });
    expect(droppedMerges).toBe(0);
    expect(droppedSplits).toBe(0);
  });
});

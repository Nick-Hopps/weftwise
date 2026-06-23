import { describe, expect, it } from 'vitest';
import { expandScopeWithNeighbors, applyDecisionCaps, restrictToSeed } from '../curate-plan';

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

describe('restrictToSeed', () => {
  const triage = {
    merges: [
      { aSlug: 'seed-a', bSlug: 'other-b', reason: 'r' }, // aSlug ∈ seed → 保留
      { aSlug: 'no-a', bSlug: 'no-b', reason: 'r' },       // 两者均不在 seed → 丢弃
    ],
    splits: [
      { slug: 'seed-c', reason: 'r' }, // slug ∈ seed → 保留
      { slug: 'no-d', reason: 'r' },   // slug 不在 seed → 丢弃
    ],
  };

  it('seedSet 为 null 时原样放行，不丢弃任何候选', () => {
    const { kept, droppedMerges, droppedSplits } = restrictToSeed(triage, null);
    expect(kept.merges).toHaveLength(2);
    expect(kept.splits).toHaveLength(2);
    expect(droppedMerges).toHaveLength(0);
    expect(droppedSplits).toHaveLength(0);
  });

  it('merge 仅当 aSlug 或 bSlug ∈ seed 时保留', () => {
    const seed = new Set(['seed-a']);
    const { kept, droppedMerges } = restrictToSeed(triage, seed);
    expect(kept.merges).toHaveLength(1);
    expect(kept.merges[0].aSlug).toBe('seed-a');
    expect(droppedMerges).toHaveLength(1);
    expect(droppedMerges[0].aSlug).toBe('no-a');
  });

  it('merge 通过 bSlug ∈ seed 也能保留', () => {
    const seed = new Set(['other-b']);
    const { kept, droppedMerges } = restrictToSeed(triage, seed);
    expect(kept.merges).toHaveLength(1);
    expect(kept.merges[0].bSlug).toBe('other-b');
    expect(droppedMerges).toHaveLength(1);
  });

  it('split 仅当 slug ∈ seed 时保留', () => {
    const seed = new Set(['seed-c']);
    const { kept, droppedSplits } = restrictToSeed(triage, seed);
    expect(kept.splits).toHaveLength(1);
    expect(kept.splits[0].slug).toBe('seed-c');
    expect(droppedSplits).toHaveLength(1);
    expect(droppedSplits[0].slug).toBe('no-d');
  });

  it('seed 为空集时丢弃全部候选', () => {
    const seed = new Set<string>();
    const { kept, droppedMerges, droppedSplits } = restrictToSeed(triage, seed);
    expect(kept.merges).toHaveLength(0);
    expect(kept.splits).toHaveLength(0);
    expect(droppedMerges).toHaveLength(2);
    expect(droppedSplits).toHaveLength(2);
  });
});

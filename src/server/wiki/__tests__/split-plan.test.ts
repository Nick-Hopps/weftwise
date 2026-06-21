import { describe, expect, it } from 'vitest';
import { planSplitPages, type LlmSplitPage } from '../split-plan';

function page(title: string, isPrimary = false): LlmSplitPage {
  return { title, body: `body of ${title}`, summary: `sum ${title}`, isPrimary };
}

describe('planSplitPages', () => {
  it('正常：各页得 normalizeSlug(title) 的 slug，透传 body/summary', () => {
    const out = planSplitPages([page('Alpha', true), page('Beta')], new Set(), 'src');
    expect(out.map((p) => p.slug)).toEqual(['alpha', 'beta']);
    expect(out[0].body).toBe('body of Alpha');
    expect(out[1].summary).toBe('sum Beta');
  });

  it('与现有 slug 冲突 → 加后缀 -2', () => {
    const out = planSplitPages([page('Alpha', true), page('Beta')], new Set(['alpha']), 'src');
    expect(out[0].slug).toBe('alpha-2');
    expect(out[1].slug).toBe('beta');
  });

  it('两新页同标题 → 第二个加 -2', () => {
    const out = planSplitPages([page('Dup', true), page('Dup')], new Set(), 'src');
    expect(out.map((p) => p.slug)).toEqual(['dup', 'dup-2']);
  });

  it('派生 slug == sourceSlug → 加后缀（不复用 A 的 slug）', () => {
    const out = planSplitPages([page('Source', true), page('Beta')], new Set(), 'source');
    expect(out[0].slug).toBe('source-2');
  });

  it('空标题 → 兜底 page', () => {
    const out = planSplitPages([page('', true), page('Beta')], new Set(), 'src');
    expect(out[0].slug).toBe('page');
  });

  it('LLM 给 0 个 primary → 第一个置 primary', () => {
    const out = planSplitPages([page('A'), page('B')], new Set(), 'src');
    expect(out[0].isPrimary).toBe(true);
    expect(out[1].isPrimary).toBe(false);
  });

  it('LLM 给多个 primary → 仅第一个保留', () => {
    const out = planSplitPages([page('A', true), page('B', true)], new Set(), 'src');
    expect(out[0].isPrimary).toBe(true);
    expect(out[1].isPrimary).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { checkSupplementFidelity } from '../supplement-guard';

const FM = `---\ntitle: 快速排序\nsummary: 一种分治排序\ntags: [算法]\n---\n`;
const ORIG = `${FM}\n## 思想\n分治。\n\n## 复杂度\n平均 O(n log n)。\n`;
const ORIG_LINKED = `${FM}\n## 思想\n分治，见 [[归并排序]]。\n\n## 复杂度\n平均 O(n log n)。\n`;

describe('checkSupplementFidelity（薄转发 rewrite-fidelity FIDELITY_PROFILES.supplement）', () => {
  it('纯插入（净增长、无新链接、结构全在、fm 不变）→ ok', () => {
    const cand = `${FM}\n## 思想\n分治：把数组按基准分成两半。这样每半可独立求解。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²)。\n`;
    const r = checkSupplementFidelity(ORIG, cand);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('正文缩到 90%（< 0.95 floor）→ 不 ok 且报 shrink', () => {
    const cand = `${FM}\n## 思想\n分。\n\n## 复杂度\nO(n log n)。\n`;
    const r = checkSupplementFidelity(ORIG, cand);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('shrank'))).toBe(true);
  });

  it('新增 wikilink（不丢原有）→ ok（linkRule 改为 preserve：允许新增，只禁止丢失）', () => {
    const cand = `${FM}\n## 思想\n分治，见 [[归并排序]]。这里再多写点内容凑够长度不缩水不缩水不缩水。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²) 视基准而定。\n`;
    const r = checkSupplementFidelity(ORIG, cand);
    expect(r.ok).toBe(true);
  });

  it('丢失原有 wikilink 目标 → 不 ok 且报 link', () => {
    const cand = `${FM}\n## 思想\n分治，展开讲讲基准怎么选，凑够长度不缩水不缩水不缩水不缩水。\n\n## 复杂度\n平均 O(n log n)。\n`;
    const r = checkSupplementFidelity(ORIG_LINKED, cand);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.toLowerCase().includes('link'))).toBe(true);
  });

  it('删掉一个标题 → 不 ok 且报 heading', () => {
    const cand = `${FM}\n## 思想\n分治，展开一下讲讲基准怎么选，这里凑够长度不缩水不缩水不缩水不缩水。\n`;
    const r = checkSupplementFidelity(ORIG, cand);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('heading'))).toBe(true);
  });

  it('改了 frontmatter title → 不 ok 且报 frontmatter', () => {
    const cand = `---\ntitle: 快排\nsummary: 一种分治排序\ntags: [算法]\n---\n\n## 思想\n分治，展开讲讲，凑够长度不缩水不缩水不缩水不缩水。\n\n## 复杂度\n平均 O(n log n)。\n`;
    const r = checkSupplementFidelity(ORIG, cand);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('frontmatter'))).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import {
  headingsPreserved,
  frontmatterUnchanged,
  checkSupplementFidelity,
} from '../supplement-guard';

const FM = `---\ntitle: 快速排序\nsummary: 一种分治排序\ntags: [算法]\n---\n`;
const ORIG = `${FM}\n## 思想\n分治。\n\n## 复杂度\n平均 O(n log n)。\n`;

describe('headingsPreserved', () => {
  it('原文所有标题仍在 → true', () => {
    const cand = `## 思想\n分治，选一个基准。\n\n### 补充\n直觉如下。\n\n## 复杂度\n平均 O(n log n)。`;
    expect(headingsPreserved('## 思想\n分治。\n\n## 复杂度\n平均。', cand)).toBe(true);
  });
  it('删掉一个标题 → false', () => {
    const cand = `## 思想\n分治。`;
    expect(headingsPreserved('## 思想\n分治。\n\n## 复杂度\n平均。', cand)).toBe(false);
  });
});

describe('frontmatterUnchanged', () => {
  it('frontmatter 不变（正文变）→ true', () => {
    const cand = `${FM}\n## 思想\n分治，展开讲。\n\n## 复杂度\n平均 O(n log n)。\n`;
    expect(frontmatterUnchanged(ORIG, cand)).toBe(true);
  });
  it('改了 title → false', () => {
    const cand = `---\ntitle: 快排\nsummary: 一种分治排序\ntags: [算法]\n---\n\n## 思想\n分治。\n`;
    expect(frontmatterUnchanged(ORIG, cand)).toBe(false);
  });
});

describe('checkSupplementFidelity', () => {
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
  it('臆造新 wikilink 目标 → 不 ok 且报 link', () => {
    const cand = `${FM}\n## 思想\n分治，见 [[归并排序]]。这里再多写点内容凑够长度不缩水不缩水不缩水。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²) 视基准而定。\n`;
    const r = checkSupplementFidelity(ORIG, cand);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.toLowerCase().includes('link'))).toBe(true);
  });
});

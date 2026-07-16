import { describe, it, expect } from 'vitest';
import { checkRewriteFidelity, FIDELITY_PROFILES } from '../rewrite-fidelity';

const FM = `---\ntitle: 快速排序\nsummary: 一种分治排序\ntags: [算法]\n---\n`;
const ORIG_BODY = `## 思想\n分治，选一个基准，见 [[归并排序]] 与 [[other-subject:堆排序]]。\n\n## 复杂度\n平均 O(n log n)。\n`;
const ORIG = `${FM}${ORIG_BODY}`;

describe('FIDELITY_PROFILES', () => {
  it('三档 canonical 写回阈值符合设计文档，读侧 Reshape 不在护栏内', () => {
    expect(FIDELITY_PROFILES.supplement).toEqual({
      minLengthRatio: 0.95, linkRule: 'preserve', preserveHeadings: true, preserveFrontmatter: true,
    });
    expect(FIDELITY_PROFILES['merge-update']).toEqual({
      minLengthRatio: 0.85, linkRule: 'preserve', preserveHeadings: true, preserveFrontmatter: false,
    });
    expect(FIDELITY_PROFILES.fix).toEqual({
      minLengthRatio: 0.8, linkRule: 'preserve', preserveHeadings: false, preserveFrontmatter: false,
    });
    expect(FIDELITY_PROFILES).not.toHaveProperty('reshape');
  });
});

describe('checkRewriteFidelity — 长度', () => {
  it('净增长 → ok', () => {
    const revised = `${FM}## 思想\n分治，选一个基准，展开讲讲，见 [[归并排序]] 与 [[other-subject:堆排序]]。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²)。\n`;
    expect(checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES['merge-update']).ok).toBe(true);
  });

  it('缩水低于 floor → 不 ok 且报告 shrink', () => {
    const revised = `${FM}## 思想\n分。\n`;
    const r = checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES.fix);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('shrank'))).toBe(true);
  });

  it('fix floor=0.8：缩到 79% → 不 ok（收紧于旧 0.5 floor）', () => {
    const orig = `${FM}${'字'.repeat(100)}`;
    const revised = `${FM}${'字'.repeat(79)}`;
    expect(checkRewriteFidelity(orig, revised, FIDELITY_PROFILES.fix).ok).toBe(false);
  });

  it('fix floor=0.8：缩到 81% → ok', () => {
    const orig = `${FM}${'字'.repeat(100)}`;
    const revised = `${FM}${'字'.repeat(81)}`;
    expect(checkRewriteFidelity(orig, revised, FIDELITY_PROFILES.fix).ok).toBe(true);
  });

  it('原文为空正文 → 长度检查不触发', () => {
    expect(checkRewriteFidelity(FM, `${FM}任何内容`, FIDELITY_PROFILES.fix).ok).toBe(true);
  });
});

describe('checkRewriteFidelity — linkRule preserve（merge-update / fix / supplement）', () => {
  it('保留全部原链接（含中文 wikilink 与 subject 前缀链接）→ ok', () => {
    const revised = `${FM}## 思想\n分治，见 [[归并排序]] 和 [[other-subject:堆排序]]，再补一句凑够长度不缩水。\n\n## 复杂度\n平均 O(n log n)。\n`;
    expect(checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES['merge-update']).ok).toBe(true);
  });

  it('新增链接（不丢旧的）→ ok', () => {
    const revised = `${FM}## 思想\n分治，见 [[归并排序]]、[[other-subject:堆排序]] 与新提到的 [[快速选择]]，再多写点内容凑够长度。\n\n## 复杂度\n平均 O(n log n)。\n`;
    expect(checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES['merge-update']).ok).toBe(true);
  });

  it('丢失原有链接目标 → 不 ok 且报告 dropped', () => {
    const revised = `${FM}## 思想\n分治，选一个基准，再多写点内容凑够长度不缩水不缩水。\n\n## 复杂度\n平均 O(n log n)。\n`;
    const r = checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES['merge-update']);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('dropped') && v.includes('归并排序'))).toBe(true);
  });

  it('别名/锚点变化但目标不变 → 仍视为保留', () => {
    const revised = `${FM}## 思想\n分治，见 [[归并排序#复杂度|归并]] 和 [[other-subject:堆排序|堆排序]]，再多写点内容凑够长度。\n\n## 复杂度\n平均 O(n log n)。\n`;
    expect(checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES['merge-update']).ok).toBe(true);
  });
});

describe('checkRewriteFidelity — preserveHeadings', () => {
  it('原文所有标题仍在（允许新增）→ ok', () => {
    const revised = `${FM}## 思想\n分治，选一个基准，见 [[归并排序]] 与 [[other-subject:堆排序]]，展开讲讲。\n\n### 补充\n直觉如下。\n\n## 复杂度\n平均 O(n log n)。\n`;
    expect(checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES.supplement).ok).toBe(true);
  });

  it('删掉一个标题 → 不 ok 且报告 removed', () => {
    const revised = `${FM}## 思想\n分治，见 [[归并排序]] 与 [[other-subject:堆排序]]，再多写点内容凑够长度不缩水不缩水。\n`;
    const r = checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES.supplement);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('removed'))).toBe(true);
  });

  it('preserveHeadings=false 的 profile（fix）不检查标题增删', () => {
    const revised = `${FM}分治，选一个基准，见 [[归并排序]] 与 [[other-subject:堆排序]]，平均 O(n log n)，再多写点内容凑够长度不缩水不缩水不缩水。\n`;
    expect(checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES.fix).ok).toBe(true);
  });
});

describe('checkRewriteFidelity — preserveFrontmatter', () => {
  it('supplement 改了 title → 不 ok 且报告 frontmatter changed', () => {
    const badFm = `---\ntitle: 快排\nsummary: 一种分治排序\ntags: [算法]\n---\n`;
    const revised = `${badFm}${ORIG_BODY}`;
    const r = checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES.supplement);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('frontmatter'))).toBe(true);
  });

  it('preserveFrontmatter=false 的 profile（merge-update）不检查 frontmatter', () => {
    const badFm = `---\ntitle: 快排\nsummary: 一种分治排序\ntags: [算法]\n---\n`;
    const revised = `${badFm}${ORIG_BODY}`;
    expect(checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES['merge-update']).ok).toBe(true);
  });
});

describe('checkRewriteFidelity — 多项违规同时报告', () => {
  it('缩水 + 丢链接 + 丢标题同时命中 → violations 含三类', () => {
    const revised = `${FM}分。`;
    const r = checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES.supplement);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe('checkRewriteFidelity — allowedDroppedTargets（断链豁免）', () => {
  const orig = `见 [[normal-mapping]] 与 [[shader-programming]]。`;

  it('豁免集内的目标允许被丢弃', () => {
    const r = checkRewriteFidelity(orig, `见法线贴图（该页暂缺，链接已解除）与 [[shader-programming]]。`, FIDELITY_PROFILES.fix, {
      allowedDroppedTargets: new Set([':normal-mapping']),
    });
    expect(r.ok).toBe(true);
  });

  it('豁免集外的活链仍不许丢', () => {
    const r = checkRewriteFidelity(orig, `见法线贴图（该页暂缺，链接已解除）与 shader 编程（这条链接是活的，不该被丢弃）。`, FIDELITY_PROFILES.fix, {
      allowedDroppedTargets: new Set([':normal-mapping']),
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toContain(':shader-programming');
    expect(r.violations[0]).not.toContain(':normal-mapping');
  });

  it('跨主题目标同样按 key 豁免', () => {
    const o = `见 [[other:dead-page]]。`;
    const r = checkRewriteFidelity(o, `见别的主题里那一页（已确认不存在，链接解除）。`, FIDELITY_PROFILES.fix, {
      allowedDroppedTargets: new Set(['other:dead-page']),
    });
    expect(r.ok).toBe(true);
  });
});

describe('collectMissingLinkTargets', () => {
  it('按注入的存在性判定收集断链 targetKey', async () => {
    const { collectMissingLinkTargets } = await import('../rewrite-fidelity');
    const body = `见 [[alive]] 与 [[dead-one]]，跨主题 [[other:dead-two]]。`;
    const missing = collectMissingLinkTargets(body, (subjectSlug, slug) => slug === 'alive');
    expect(missing).toEqual(new Set([':dead-one', 'other:dead-two']));
  });
});

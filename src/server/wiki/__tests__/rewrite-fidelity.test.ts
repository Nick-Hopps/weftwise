import { describe, it, expect } from 'vitest';
import { checkRewriteFidelity, FIDELITY_PROFILES } from '../rewrite-fidelity';

const FM = `---\ntitle: 快速排序\nsummary: 一种分治排序\ntags: [算法]\n---\n`;
const ORIG_BODY = `## 思想\n分治，选一个基准，见 [[归并排序]] 与 [[other-subject:堆排序]]。\n\n## 复杂度\n平均 O(n log n)。\n`;
const ORIG = `${FM}${ORIG_BODY}`;

describe('FIDELITY_PROFILES', () => {
  it('四档阈值符合设计文档', () => {
    expect(FIDELITY_PROFILES.supplement).toEqual({
      minLengthRatio: 0.95, linkRule: 'preserve', preserveHeadings: true, preserveFrontmatter: true,
    });
    expect(FIDELITY_PROFILES['merge-update']).toEqual({
      minLengthRatio: 0.85, linkRule: 'preserve', preserveHeadings: true, preserveFrontmatter: false,
    });
    expect(FIDELITY_PROFILES.fix).toEqual({
      minLengthRatio: 0.8, linkRule: 'preserve', preserveHeadings: false, preserveFrontmatter: false,
    });
    expect(FIDELITY_PROFILES.reshape).toEqual({
      minLengthRatio: 0.8, linkRule: 'subset', preserveHeadings: false, preserveFrontmatter: true,
    });
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

/** 补齐到至少 minLen 字符（追加填充字，不含链接/标题，不影响其余检查）。 */
function pad(s: string, minLen: number): string {
  if (s.length >= minLen) return s;
  return s + '填'.repeat(minLen - s.length);
}

describe('checkRewriteFidelity — linkRule subset（reshape）', () => {
  const canonBody = '见 [[Alpha]] 和 [[Beta|别名]]，以及 [[other-subject:Gamma]]。';
  const canon = `${FM}${canonBody}`;

  it('重塑省略部分链接（长度仍达标）→ ok', () => {
    const revised = `${FM}${pad('只保留 [[Alpha]]。', canonBody.length)}`;
    expect(checkRewriteFidelity(canon, revised, FIDELITY_PROFILES.reshape).ok).toBe(true);
  });

  it('重塑保留全部链接 → ok', () => {
    const revised = `${FM}${pad('[[Alpha]] [[Beta]] [[other-subject:Gamma]]', canonBody.length)}`;
    expect(checkRewriteFidelity(canon, revised, FIDELITY_PROFILES.reshape).ok).toBe(true);
  });

  it('重塑臆造不存在的链接 → 不 ok 且报告 invented', () => {
    const revised = `${FM}${pad('[[Alpha]] 还有 [[Delta]]', canonBody.length)}`;
    const r = checkRewriteFidelity(canon, revised, FIDELITY_PROFILES.reshape);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('invented') && v.toLowerCase().includes('delta'))).toBe(true);
  });

  it('无链接正文 → ok', () => {
    expect(checkRewriteFidelity(`${FM}纯文本`, `${FM}依然纯文本`, FIDELITY_PROFILES.reshape).ok).toBe(true);
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
  it('frontmatter 不变（正文变）→ ok', () => {
    const revised = `${FM}## 思想\n分治，展开讲讲，见 [[归并排序]] 与 [[other-subject:堆排序]]。\n\n## 复杂度\n平均 O(n log n)。\n`;
    expect(checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES.reshape).ok).toBe(true);
  });

  it('改了 title → 不 ok 且报告 frontmatter changed', () => {
    const badFm = `---\ntitle: 快排\nsummary: 一种分治排序\ntags: [算法]\n---\n`;
    const revised = `${badFm}${ORIG_BODY}`;
    const r = checkRewriteFidelity(ORIG, revised, FIDELITY_PROFILES.reshape);
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

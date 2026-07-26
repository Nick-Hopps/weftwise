import { describe, it, expect } from 'vitest';
import {
  selectNeighborhood,
  groupByMastery,
  renderKnownConcepts,
  MAX_NEIGHBORHOOD,
  type KnownConcepts,
} from '../concept-map';
import type { MasteryVerdict } from '@/lib/contracts';

const SUBJECT = 'ml';

function neighborhood(body: string, opts: Partial<Parameters<typeof selectNeighborhood>[1]> = {}) {
  return selectNeighborhood(body, {
    currentSubjectSlug: SUBJECT,
    selfSlug: 'backprop',
    titleResolver: () => undefined,
    ...opts,
  }).slugs;
}

function neighborhoodFull(body: string) {
  return selectNeighborhood(body, {
    currentSubjectSlug: SUBJECT,
    selfSlug: 'backprop',
    titleResolver: () => undefined,
  });
}

function verdict(over: Partial<MasteryVerdict> = {}): MasteryVerdict {
  return {
    state: 'mastered',
    confidence: 'high',
    evidenceCount: 1,
    lastEvidenceAt: '2026-07-26T00:00:00.000Z',
    expiresAt: null,
    recent: [],
    ...over,
  };
}

describe('selectNeighborhood', () => {
  it('从正文抽 1 跳 wikilink 目标，按首次出现顺序去重', () => {
    expect(neighborhood('见 [[chain-rule]] 与 [[gradient-descent]]，再看 [[chain-rule]]。'))
      .toEqual(['chain-rule', 'gradient-descent']);
  });

  it('排除自身 slug（自引用不是邻域）', () => {
    expect(neighborhood('自引用 [[backprop]] 与 [[chain-rule]]。')).toEqual(['chain-rule']);
  });

  it('排除 meta 页（index / log 是确定性渲染的系统页，谈不上掌握）', () => {
    expect(neighborhood('见 [[index]]、[[log]] 与 [[chain-rule]]。')).toEqual(['chain-rule']);
  });

  it('跨 subject 目标不计（同 slug 在不同 subject 语义不同）', () => {
    expect(neighborhood('见 [[math:chain-rule]] 与 [[gradient-descent]]。'))
      .toEqual(['gradient-descent']);
  });

  it('无 wikilink 返回空', () => {
    expect(neighborhood('一段没有任何链接的正文。')).toEqual([]);
  });

  it('`[[某某标题]]` 经 titleResolver 解析到真实 slug', () => {
    // 没有 resolver 时 extractWikiLinks 只能回落 normalizeSlug(title)，
    // 对中文标题会塌成空或错 slug——邻域静默漏掉概念且不报错。
    const titleResolver = (title: string) =>
      title === '链式法则' ? 'chain-rule' : undefined;
    expect(neighborhood('见 [[链式法则]]。', { titleResolver })).toEqual(['chain-rule']);
  });

  it('回归：不传 resolver 时中文标题解析不到真实 slug —— 锁死 resolver 必传', () => {
    // 这条断言存在的意义是「记录错误行为」：一旦 IO 层忘了供给 resolver，
    // 邻域就会静默变空，而不是报错。
    expect(neighborhood('见 [[链式法则]]。')).not.toContain('chain-rule');
  });

  it(`超过 MAX_NEIGHBORHOOD=${MAX_NEIGHBORHOOD} 按首次出现顺序截断`, () => {
    // 综述性质的页面链出上百个概念完全可能，那就是上百行注入。
    // 项目在 T2.1 正是因为「prompt 随规模单调膨胀」才把 index/log 改成确定性渲染。
    const body = Array.from({ length: MAX_NEIGHBORHOOD + 25 }, (_, i) => `[[c-${i}]]`).join(' ');
    const { slugs, omitted } = neighborhoodFull(body);
    expect(slugs).toHaveLength(MAX_NEIGHBORHOOD);
    expect(slugs[0]).toBe('c-0');
    expect(slugs[MAX_NEIGHBORHOOD - 1]).toBe(`c-${MAX_NEIGHBORHOOD - 1}`);
    // 截断数量必须回传：调用方无法从截断后的列表反推丢了多少，
    // 而注入段末尾要明说「还有 N 个未列出」。
    expect(omitted).toBe(25);
  });

  it('未截断时 omitted 为 0', () => {
    expect(neighborhoodFull('见 [[chain-rule]]。').omitted).toBe(0);
  });
});

describe('groupByMastery', () => {
  const entry = (slug: string, v: Partial<MasteryVerdict>) => ({
    slug,
    title: slug.toUpperCase(),
    verdict: verdict(v),
  });

  it('四态映射到三段，unknown 完全不出现', () => {
    const k = groupByMastery([
      entry('a', { state: 'mastered', confidence: 'high' }),
      entry('b', { state: 'exposed', confidence: 'low' }),
      entry('c', { state: 'struggling', confidence: 'low' }),
      entry('d', { state: 'unknown', confidence: 'none' }),
    ]);
    expect(k.mastered.map((e) => e.slug)).toEqual(['a']);
    expect(k.exposed.map((e) => e.slug)).toEqual(['b']);
    expect(k.struggling.map((e) => e.slug)).toEqual(['c']);
    expect(JSON.stringify(k)).not.toContain('"d"');
  });

  it('低置信度的 mastered 降级进 exposed 段', () => {
    // 保守原则：低置信度的「已掌握」不足以支撑「完全不讲」。
    const k = groupByMastery([entry('a', { state: 'mastered', confidence: 'low' })]);
    expect(k.mastered).toEqual([]);
    expect(k.exposed.map((e) => e.slug)).toEqual(['a']);
  });

  it('保持输入顺序（= 邻域首次出现顺序），供 E5 的确定性序列化', () => {
    const k = groupByMastery([
      entry('z', { state: 'mastered' }),
      entry('a', { state: 'mastered' }),
      entry('m', { state: 'mastered' }),
    ]);
    expect(k.mastered.map((e) => e.slug)).toEqual(['z', 'a', 'm']);
  });

  it('空输入返回三段全空', () => {
    expect(groupByMastery([])).toEqual({ mastered: [], exposed: [], struggling: [] });
  });
});

describe('renderKnownConcepts', () => {
  const c = (slug: string, state: 'mastered' | 'exposed' | 'struggling') =>
    ({ slug, title: slug.toUpperCase(), state } as const);

  const full: KnownConcepts = {
    mastered: [c('gradient-descent', 'mastered')],
    exposed: [c('chain-rule', 'exposed')],
    struggling: [c('backprop', 'struggling')],
  };

  it('三段齐全时都渲染，且带兜底句', () => {
    const out = renderKnownConcepts(full)!;
    expect(out).toContain('[[gradient-descent]]');
    expect(out).toContain('[[chain-rule]]');
    expect(out).toContain('[[backprop]]');
    // 兜底护栏：未列出等同今天的行为，冷启动零回归
    expect(out).toMatch(/not listed[\s\S]*assume unfamiliar/i);
  });

  it('必含 `[[slug]]` 书写纪律那句 —— 缺了 E3 就没锚点可挂', () => {
    // RESHAPE_PAGE_SYSTEM_PROMPT 通篇没提 wikilink，且 reshape 已被移出保真护栏，
    // 模型完全可能写成纯文本「如你已知的梯度下降」，纠错入口就无处挂载。
    const out = renderKnownConcepts(full)!;
    expect(out).toMatch(/\[\[slug\]\]/);
    expect(out).toMatch(/EXACTLY the slug/i);
  });

  it('某段为空时不渲染该段标题', () => {
    const out = renderKnownConcepts({ mastered: full.mastered, exposed: [], struggling: [] })!;
    expect(out).toContain('[[gradient-descent]]');
    expect(out).not.toMatch(/Seen before/i);
    expect(out).not.toMatch(/trouble spot/i);
  });

  it('三段全空返回 null（整段不注入，保证零证据时 prompt 逐字节不变）', () => {
    expect(renderKnownConcepts({ mastered: [], exposed: [], struggling: [] })).toBeNull();
  });

  it('截断时段末明说还有 N 个未列出，不静默', () => {
    // 静默截断会让模型把「未列出」误读成「读者不懂」，反而多讲一堆。
    const out = renderKnownConcepts(full, { omittedCount: 7 })!;
    expect(out).toMatch(/7 (more )?related concepts/i);
  });

  it('未截断时不出现「未列出」那句', () => {
    expect(renderKnownConcepts(full, { omittedCount: 0 })!).not.toMatch(/more related concepts/i);
  });

  it('相同输入渲染逐字节相同（E5 的比对建立在确定性之上）', () => {
    expect(renderKnownConcepts(full)).toBe(renderKnownConcepts(full));
  });
});

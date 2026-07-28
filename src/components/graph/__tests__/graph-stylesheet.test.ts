import { describe, it, expect } from 'vitest';
import { buildStylesheet } from '../graph-stylesheet';
import type { ThemeSnapshot } from '@/lib/theme/read-theme-vars';

const THEME: ThemeSnapshot = {
  canvas: 'rgb(1,1,1)',
  node: 'rgb(2,2,2)',
  nodeBorder: 'rgb(3,3,3)',
  orphan: 'rgb(4,4,4)',
  edge: 'rgb(5,5,5)',
  label: 'rgb(6,6,6)',
  active: 'rgb(7,7,7)',
  accent: 'rgb(8,8,8)',
  border: 'rgb(9,9,9)',
  masteryExposed: 'rgb(10,10,10)',
  masteryMastered: 'rgb(11,11,11)',
  masteryStruggling: 'rgb(12,12,12)',
};

const selectors = (mode?: 'structure' | 'mastery') =>
  buildStylesheet(THEME, mode).map((s) => s.selector);

const styleFor = (selector: string, mode?: 'structure' | 'mastery') =>
  buildStylesheet(THEME, mode).find((s) => s.selector === selector)?.style as
    | Record<string, unknown>
    | undefined;

describe('buildStylesheet —— 结构模式零回归', () => {
  it('缺省即 structure，且与显式传 structure 完全一致', () => {
    expect(buildStylesheet(THEME)).toEqual(buildStylesheet(THEME, 'structure'));
  });

  it('structure 模式不含任何掌握度选择器', () => {
    expect(selectors('structure').filter((s) => String(s).includes('mastery'))).toEqual([]);
  });

  it('structure 下 orphan 填充与 focused 填充保持原样', () => {
    expect(styleFor('node[orphan = 1]', 'structure')).toMatchObject({
      'background-color': THEME.orphan,
      'border-color': THEME.orphan,
    });
    expect(styleFor('node.focused', 'structure')).toMatchObject({
      'background-color': THEME.active,
      'background-opacity': 1,
    });
  });
});

describe('buildStylesheet —— 掌握度模式', () => {
  it('三态各自的填充色（有序 ramp 用同色相明度阶梯）', () => {
    expect(styleFor('node[mastery = "exposed"]', 'mastery')).toMatchObject({
      'background-color': THEME.masteryExposed,
    });
    expect(styleFor('node[mastery = "mastered"]', 'mastery')).toMatchObject({
      'background-color': THEME.masteryMastered,
    });
  });

  it('struggling 走 danger 描边，不进 ramp', () => {
    // 它的语义是「试过并卡住了」，不是「更不懂」；塞进明度梯子会误导。
    const style = styleFor('node[mastery = "struggling"]', 'mastery')!;
    expect(style['border-color']).toBe(THEME.masteryStruggling);
    expect(style['background-color']).not.toBe(THEME.masteryStruggling);
  });

  it('没有 mastery data 的节点按 unknown 压暗着色', () => {
    // `/api/mastery` 只返回**有证据**的 slug，绝大多数节点根本没有这个字段。
    // 没有兜底会渲染成默认蓝色，看起来像「全都掌握了」。
    const style = styleFor('node[!mastery]', 'mastery')!;
    expect(style['background-color']).toBe(THEME.orphan);
    expect(Number(style['background-opacity'])).toBeLessThan(0.5);
  });

  it('orphan 填充让位 —— 孤儿是结构属性，归结构模式', () => {
    expect(selectors('mastery')).not.toContain('node[orphan = 1]');
  });

  it('focus 层级降级为仅描边加粗，不抢填充色', () => {
    const focused = styleFor('node.focused', 'mastery')!;
    expect(focused['background-color']).toBeUndefined();
    expect(Number(focused['border-width'])).toBeGreaterThanOrEqual(3);
  });

  it('基础 node / edge 样式仍在（布局与标签不受模式影响）', () => {
    expect(selectors('mastery')).toContain('node');
    expect(selectors('mastery')).toContain('edge');
  });
});

describe('buildStylesheet —— 选择器合法性', () => {
  // cytoscape 没有 `:hover` 伪类，整条规则会被判非法**整体丢弃**（控制台
  // "The selector ... is invalid"），连同一条里的 `.labelled` 一起失效——
  // 于是 `use-wiki-graph` 的 mouseover 加了 class 也点不亮标签。
  // hover 本来就由 `labelled` class 承载，这里锁死不许再出现 CSS 伪类。
  for (const mode of ['structure', 'mastery'] as const) {
    it(`${mode} 模式不含 cytoscape 不支持的 :hover 伪类`, () => {
      expect(selectors(mode).filter((s) => String(s).includes(':hover'))).toEqual([]);
    });

    it(`${mode} 模式下 labelled / neighbor / focused 都点亮标签`, () => {
      const style = styleFor('node.labelled, node.neighbor, node.focused', mode);
      expect(style).toMatchObject({ 'text-opacity': 1 });
    });
  }
});

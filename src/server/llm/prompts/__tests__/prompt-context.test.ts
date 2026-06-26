import { describe, it, expect } from 'vitest';
import { renderLanguageDirective, renderExpositionDirective } from '../prompt-context';

describe('renderLanguageDirective', () => {
  it('puts the language name in the MUST instruction line', () => {
    const out = renderLanguageDirective('Chinese');
    expect(out).toMatch(/MUST be written in \*\*Chinese\*\*/);
  });

  it('explicitly forbids translating slugs / wikilinks / frontmatter keys / code', () => {
    const out = renderLanguageDirective('Japanese');
    expect(out).toMatch(/slug/i);
    expect(out).toMatch(/wikilink|\[\[/i);
    expect(out).toMatch(/frontmatter/i);
    expect(out).toMatch(/code/i);
  });

  it('starts with a clear OUTPUT LANGUAGE marker', () => {
    const out = renderLanguageDirective('English');
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
  });

  it('renders deterministically for the same input', () => {
    expect(renderLanguageDirective('English')).toBe(renderLanguageDirective('English'));
  });
});

describe('renderExpositionDirective', () => {
  it('off 档退回纯忠实渲染（禁止来源外知识与 callout）', () => {
    const out = renderExpositionDirective('off');
    expect(out).toMatch(/FAITHFUL MODE/);
    expect(out).toMatch(/Do NOT add/i);
    expect(out).toMatch(/[Nn]o callouts/);
  });

  it('standard 档要求自洽教学文章并允许引入自有知识', () => {
    const out = renderExpositionDirective('standard');
    expect(out).toMatch(/teaching article/i);
    expect(out).toMatch(/your own knowledge/i);
  });

  it('deep 比 light 讲解更充分（含 multiple/several 例子指令）', () => {
    expect(renderExpositionDirective('deep')).toMatch(/several worked examples|multiple/i);
    expect(renderExpositionDirective('light')).toMatch(/concise/i);
  });

  it('非 off 档声明 verifier 会核查正文', () => {
    expect(renderExpositionDirective('standard')).toMatch(/verifier/i);
  });

  it('以 EXPOSITION DEPTH 标记开头', () => {
    expect(renderExpositionDirective('light')).toMatch(/^=== EXPOSITION DEPTH ===/);
  });

  it('同输入确定性输出', () => {
    expect(renderExpositionDirective('deep')).toBe(renderExpositionDirective('deep'));
  });
});

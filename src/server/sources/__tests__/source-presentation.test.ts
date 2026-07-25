import { describe, expect, it } from 'vitest';
import {
  SOURCE_DESCRIPTION_MAX_LENGTH,
  SOURCE_TITLE_MAX_LENGTH,
  firstMeaningfulParagraph,
  normalizeSourcePresentation,
  readSourcePresentation,
} from '../source-presentation';

describe('normalizeSourcePresentation', () => {
  it('折叠空白并保留可读文本', () => {
    expect(
      normalizeSourcePresentation({ title: '  从"国家"概念\n 到全球史 ', description: 'a\t\tb' }),
    ).toEqual({ title: '从"国家"概念 到全球史', description: 'a b' });
  });

  it('超长字段按上限截断', () => {
    const presentation = normalizeSourcePresentation({
      title: 'x'.repeat(SOURCE_TITLE_MAX_LENGTH + 50),
      description: 'y'.repeat(SOURCE_DESCRIPTION_MAX_LENGTH + 50),
    });
    expect(presentation.title).toHaveLength(SOURCE_TITLE_MAX_LENGTH);
    expect(presentation.description).toHaveLength(SOURCE_DESCRIPTION_MAX_LENGTH);
  });

  it('空串、纯空白与非字符串一律视为缺省', () => {
    expect(normalizeSourcePresentation({ title: '   ', description: '' })).toEqual({
      title: undefined,
      description: undefined,
    });
    expect(normalizeSourcePresentation({ title: 42, description: { a: 1 } })).toEqual({
      title: undefined,
      description: undefined,
    });
  });
});

describe('firstMeaningfulParagraph', () => {
  it('跳过图片、纯链接与导航噪声，取到第一段正文', () => {
    const markdown = [
      '![](/static/images/icons/enwiki-25.svg)',
      '',
      '[Skip to content](#main)',
      '',
      'From Wikipedia, the free encyclopedia. 这是正文首段。',
    ].join('\n');
    expect(firstMeaningfulParagraph(markdown)).toBe(
      'From Wikipedia, the free encyclopedia. 这是正文首段。',
    );
  });

  it('短句只要有句末标点即可作为描述', () => {
    expect(firstMeaningfulParagraph('# 标题\n\n第一段正文。\n\n第二段。')).toBe('第一段正文。');
  });

  it('全是噪声时返回 undefined', () => {
    expect(firstMeaningfulParagraph('![](a.png)\n\n[Home](/)\n\n- 列表项')).toBeUndefined();
    expect(firstMeaningfulParagraph('')).toBeUndefined();
  });
});

describe('readSourcePresentation', () => {
  it('从 metadataJson 读取归一化后的展示字段', () => {
    expect(
      readSourcePresentation({
        metadataJson: JSON.stringify({ title: '  网页标题 ', description: '一句话描述' }),
      }),
    ).toEqual({ title: '网页标题', description: '一句话描述' });
  });

  it('非法 JSON 或非对象元数据返回空展示，不抛错', () => {
    expect(readSourcePresentation({ metadataJson: 'not json' })).toEqual({
      title: undefined,
      description: undefined,
    });
    expect(readSourcePresentation({ metadataJson: '[]' })).toEqual({
      title: undefined,
      description: undefined,
    });
  });
});

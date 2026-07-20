import { describe, expect, it } from 'vitest';
import { parseHtml } from '../parsers/html-parser';

describe('parseHtml 网页展示元数据', () => {
  it('提取 title 与标准 description，并解码 entity/折叠空白', () => {
    const parsed = parseHtml('fallback.html', `
      <html>
        <head>
          <title> Weftwise &amp; Knowledge </title>
          <meta content="  A focused &quot;knowledge&quot; workspace.  " name="description">
        </head>
        <body><h1>Ignored heading</h1></body>
      </html>
    `);

    expect(parsed.title).toBe('Weftwise & Knowledge');
    expect(parsed.metadata.description).toBe('A focused "knowledge" workspace.');
  });

  it('缺少 title/标准 description 时回退 OG 与 Twitter metadata', () => {
    const parsed = parseHtml('fallback.html', `
      <meta property='og:title' content='Open Graph title'>
      <meta name='twitter:description' content='Social description'>
      <h1>Heading fallback</h1>
    `);

    expect(parsed.title).toBe('Open Graph title');
    expect(parsed.metadata.description).toBe('Social description');
  });

  it('非法超范围数值 entity 保持原文，不让恶意 metadata 中断解析', () => {
    expect(() => parseHtml(
      'fallback.html',
      '<title>Bad &#99999999; entity</title><p>正文</p>',
    )).not.toThrow();
    expect(parseHtml('fallback.html', '<title>Bad &#99999999; entity</title>').title)
      .toBe('Bad &#99999999; entity');
  });

  it('清洗正文时去除脚本、样式和非正文模板内容', () => {
    const parsed = parseHtml('article.html', `
      <style>.article { color: red; }</style>
      <script>window.tracker = "do-not-render";</script>
      <noscript>请启用脚本</noscript>
      <template>隐藏模板内容</template>
      <article><h1>文章标题</h1><p>可阅读正文。</p></article>
    `);

    expect(parsed.cleanText).toContain('# 文章标题');
    expect(parsed.cleanText).toContain('可阅读正文。');
    expect(parsed.cleanText).not.toContain('do-not-render');
    expect(parsed.cleanText).not.toContain('color: red');
    expect(parsed.cleanText).not.toContain('请启用脚本');
    expect(parsed.cleanText).not.toContain('隐藏模板内容');
  });
});

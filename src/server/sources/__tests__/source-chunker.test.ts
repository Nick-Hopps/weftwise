import { describe, expect, it } from 'vitest';
import { chunkText, countTokens, sourceKindFor } from '../source-chunker';

describe('sourceKindFor', () => {
  it('md/html 归为 markdown，其余归为 plain', () => {
    expect(sourceKindFor('a.md')).toBe('markdown');
    expect(sourceKindFor('a.htm')).toBe('markdown');
    expect(sourceKindFor('a.pdf')).toBe('plain');
    expect(sourceKindFor('a.txt')).toBe('plain');
  });

  it('.mdx 归为 markdown', () => {
    expect(sourceKindFor('a.mdx')).toBe('markdown');
  });
});

describe('chunkText: 基础行为', () => {
  it('空源返回空数组', () => {
    expect(chunkText('', 'plain')).toEqual([]);
    expect(chunkText('   \n  ', 'plain')).toEqual([]);
  });

  it('小文本只产一个块，id 为 c0', () => {
    const chunks = chunkText('短文本。', 'plain');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('c0');
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it('chunk id 顺序稳定：c0, c1, c2...', () => {
    const text = Array.from({ length: 30 }, (_, i) => `第${i}段。这一段需要有足够长度来撑起一个独立块的体积，${'内容'.repeat(60)}。`).join('\n\n');
    const chunks = chunkText(text, 'plain', { target: 200, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.id).toBe(`c${i}`));
  });
});

describe('chunkText: markdown 阶梯', () => {
  it('按 H2 边界切分并捕获 heading', () => {
    const section = (t: string) => `\n## ${t}\n\n${`关于${t}的内容句。`.repeat(80)}`;
    const text = `# Doc${section('Alpha')}${section('Beta')}`;
    const chunks = chunkText(text, 'markdown', { target: 300, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('Alpha');
    expect(headings).toContain('Beta');
  });

  it('小代码块不被拦腰切断', () => {
    const code = '```js\nconst answer = 42;\n```';
    const text = `## A\n\n${'前文内容。'.repeat(50)}\n${code}\n\n${'后文内容。'.repeat(50)}`;
    const chunks = chunkText(text, 'markdown', { target: 400, overlap: 0 });
    const holder = chunks.filter((c) => c.text.includes('const answer = 42;'));
    expect(holder).toHaveLength(1); // 代码体只完整出现在一个块里
  });

  it('H3 标题也被捕获为 heading', () => {
    const text = `## A\n\n${'内容句。'.repeat(60)}\n\n### Sub\n\n${'子节内容句。'.repeat(60)}`;
    const chunks = chunkText(text, 'markdown', { target: 150, overlap: 0 });
    expect(chunks.map((c) => c.heading)).toContain('Sub');
  });

  it('HR 边界不丢失换行（空白片附着前片）', () => {
    const doc = '段落甲。'.repeat(400) + '\n\n---\n\n' + '段落乙。'.repeat(10);
    const chunks = chunkText(doc, 'markdown', { target: 1000, overlap: 0 });
    const rejoined = chunks.map((c) => c.text).join('');
    expect(rejoined).toContain('。\n\n---\n\n段落乙');
  });
});

describe('chunkText: plain 阶梯（CJK）', () => {
  it('无空行长中文按句末标点切，不从句子中间切断', () => {
    const text = Array.from({ length: 40 }, (_, i) => `这是第${i}个完整的中文句子其中没有任何换行${'字'.repeat(30)}。`).join('');
    const chunks = chunkText(text, 'plain', { target: 150, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) {
      expect(c.text.trimEnd()).toMatch(/[。！？]$/);
    }
  });

  it('plain 源 heading 为空字符串', () => {
    const chunks = chunkText('纯文本内容。', 'plain');
    expect(chunks[0].heading).toBe('');
  });
});

describe('chunkText: 尺寸与 overlap', () => {
  it('块 tokenCount 不超过 target + overlap 余量', () => {
    const text = `${'word '.repeat(3000)}`;
    const chunks = chunkText(text, 'plain', { target: 200, overlap: 30 });
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(200 + 30 + 20); // 20 为合并误差余量
    }
  });

  it('相邻块带 overlap：后块开头含前块结尾内容', () => {
    const text = Array.from({ length: 40 }, (_, i) => `sentence number ${i} ends here.`).join('\n\n');
    const chunks = chunkText(text, 'plain', { target: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // overlap=20 token ≈ 数十字符；前块末尾 30 字符应完整出现在后块中
    const prevTail = chunks[0].text.slice(-30);
    expect(chunks[1].text).toContain(prevTail);
    // 且 overlap 不应雪球：后块去掉 overlap 部分后仍以自己的内容为主
    expect(chunks[1].text.length).toBeLessThan(chunks[0].text.length * 2);
  });
});

describe('chunkText: Unicode 安全', () => {
  it('无任何分隔符的 emoji 长串硬切不产生残缺代理对', () => {
    const text = '😀'.repeat(2000); // 每个 emoji 是一个代理对
    const chunks = chunkText(text, 'plain', { target: 100, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // 不以孤立低位代理开头（块首不是被切断的 emoji 后半）
      const first = c.text.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      // 不以孤立高位代理结尾（块尾不是被切断的 emoji 前半；
      // 完整 emoji 以低位代理 0xDC00-0xDFFF 结尾，属正常）
      const last = c.text.charCodeAt(c.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});

describe('countTokens', () => {
  it('中文 token 数显著高于等长英文比例', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('hello world')).toBeGreaterThan(0);
    expect(countTokens('中文内容测试')).toBeGreaterThan(2);
  });
});

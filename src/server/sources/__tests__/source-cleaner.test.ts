import { describe, expect, it } from 'vitest';
import { cleanSourceText, cleanerKindFor } from '../source-cleaner';

describe('cleanerKindFor', () => {
  it('按扩展名分流', () => {
    expect(cleanerKindFor('a.md')).toBe('markdown');
    expect(cleanerKindFor('a.mdx')).toBe('markdown');
    expect(cleanerKindFor('a.HTML')).toBe('markdown');
    expect(cleanerKindFor('a.pdf')).toBe('pdf');
    expect(cleanerKindFor('a.txt')).toBe('text');
    expect(cleanerKindFor('a.unknown')).toBe('text');
  });
});

describe('cleanSourceText: markdown（最小清洗）', () => {
  it('保留标题/代码块结构，仅归一化行尾与过量空行', () => {
    const raw = '# Title\r\n\r\n```js\nconst  a = 1;\n```\n\n\n\n\nTail';
    const out = cleanSourceText(raw, 'markdown');
    expect(out).toContain('# Title');
    expect(out).toContain('const  a = 1;'); // 代码块内空格不动
    expect(out).not.toContain('\r');
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe('cleanSourceText: text', () => {
  it('NFKC 归一化 + 空白归一化', () => {
    // 全角 Ａ → A；连续空格折叠
    const out = cleanSourceText('Ａbc   def', 'text');
    expect(out).toBe('Abc def');
  });

  it('text 分流保留全角标点但归一化全角字母', () => {
    expect(cleanSourceText('Ａbc（注）', 'text')).toBe('Abc（注）');
  });

  it('text 分支归一化 CRLF', () => {
    const out = cleanSourceText('hello\r\nworld', 'text');
    expect(out).not.toContain('\r');
    // text 分支保留行结构（软换行合并是 pdf 链的职责），故换行保留为 \n
    expect(out).toBe('hello\nworld');
  });
});

describe('cleanSourceText: pdf 完整清洗链', () => {
  it('剥软连字符 U+00AD', () => {
    expect(cleanSourceText('soft\u00ADhyphen', 'pdf')).toBe('softhyphen');
  });

  it('合并行尾连字符断词', () => {
    expect(cleanSourceText('inter-\nnational', 'pdf')).toBe('international');
  });

  it('合并软换行：行尾非句末标点则并入上一行', () => {
    const out = cleanSourceText('first line\nsecond line', 'pdf');
    expect(out).toBe('first line second line');
  });

  it('CJK 行合并不插入空格', () => {
    const out = cleanSourceText('这是第一行\n这是第二行', 'pdf');
    expect(out).toBe('这是第一行这是第二行');
  });

  it('行尾全角括号与下一行汉字合并不插空格', () => {
    expect(cleanSourceText('（注释内容）\n继续正文', 'pdf')).toBe('（注释内容）继续正文');
  });

  it('假名行合并不插空格', () => {
    expect(cleanSourceText('カタカナの行\nひらがなの行', 'pdf')).toBe('カタカナの行ひらがなの行');
  });

  it('行尾是句末标点则保留换行（段落边界）', () => {
    const out = cleanSourceText('第一句。\n第二段开头', 'pdf');
    expect(out).toContain('第一句。\n');
  });

  it('空行保留为段落边界', () => {
    const out = cleanSourceText('para one\n\npara two', 'pdf');
    expect(out).toBe('para one\n\npara two');
  });

  it('剥除控制字符但保留换行', () => {
    const out = cleanSourceText('a\u0000b\u0007c\n\nnext para.', 'pdf');
    expect(out).toContain('abc');
    expect(out).toContain('\n\n');
  });

  it('剥纯页码行与高频重复短行（页眉页脚）', () => {
    const page = (n: number) => `Running Header\n正文内容第${n}页，足够长的一行正文。\n${n}`;
    const out = cleanSourceText([page(1), page(2), page(3)].join('\n'), 'pdf');
    expect(out).not.toContain('Running Header');
    expect(out).not.toMatch(/^\d$/m);
    expect(out).toContain('正文内容第1页');
    expect(out).toContain('正文内容第3页');
  });
});

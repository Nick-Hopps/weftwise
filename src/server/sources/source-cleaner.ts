import path from 'path';

/**
 * 切分前的按来源预清洗。
 * - markdown（md/html→turndown 产物）：已结构化，仅做最小归一化，避免破坏标题/代码块。
 * - text（txt 等）：NFKC（保留全角标点）+ 空白归一化。
 * - pdf（pdf-parse 产物）：完整清洗链——假换行/连字符断词/页眉页脚会破坏
 *   「按 \n\n 切段落」的前提，必须先修复。
 */
export type CleanerKind = 'markdown' | 'text' | 'pdf';

export function cleanerKindFor(filename: string): CleanerKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.md' || ext === '.mdx' || ext === '.html' || ext === '.htm') return 'markdown';
  if (ext === '.pdf') return 'pdf';
  return 'text';
}

export function cleanSourceText(raw: string, kind: CleanerKind): string {
  if (kind === 'markdown') {
    // 最小清洗：不折叠行内空格（保护代码块/表格），只归一化行尾与过量空行
    // 空行收缩与其它分支统一为 \n\n：三连换行在 markdown 渲染无语义，留着会让 chunker 产生空段
    return raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  if (kind === 'text') {
    // 与 pdf 一致：CRLF 归一化 + 保留全角标点（中文排版），仅归一化全角字母数字等
    return normalizeWhitespace(nfkcPreservingFullwidthPunct(raw.replace(/\r\n?/g, '\n')));
  }
  // pdf 完整清洗链（顺序敏感）
  let text = nfkcPreservingFullwidthPunct(raw.replace(/\r\n?/g, '\n'));
  text = text.replace(/\u00AD/g, ''); // 软连字符（不可见，必须用转义写法）
  text = text.replace(/([A-Za-z])-\n([a-z])/g, '$1$2'); // 行尾连字符断词
  text = stripRepeatedShortLines(text); // 页眉页脚 / 页码
  text = mergeSoftNewlines(text); // 软换行合并
  return normalizeWhitespace(text);
}

/**
 * NFKC 归一化，但保留全角标点段（！（）：；？｛｝等）。
 * 直接 NFKC 会把全角标点折叠成半角，破坏中文排版，
 * 也使行尾全角括号失去 CJK 身份、行合并时被误插空格。
 * 全角字母数字（Ａ→A）与半角片假名（ｱ→ア）仍正常归一化。
 * 保留段：U+FF01-FF0F / U+FF1A-FF20 / U+FF3B-FF40 / U+FF5B-FF60。
 */
function nfkcPreservingFullwidthPunct(text: string): string {
  return text.replace(/[^\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF60]+/g, (seg) => seg.normalize('NFKC'));
}

/** 行尾出现这些字符视为「句子/段落收尾」，换行保留 */
const SENTENCE_END = /[。！？．.!?:：;；]$/;

/**
 * CJK 字符范围（用于判断 CJK 行合并时不插入空格），端点全部用 \u 转义避免字面量歧义：
 * - U+3000-303F CJK 标点（含全角空格、「」。等）
 * - U+3040-30FF 平假名 + 片假名
 * - U+3400-4DBF CJK 扩展 A
 * - U+4E00-9FFF CJK 基本汉字
 * - U+F900-FAFF CJK 兼容表意文字
 * - U+FF00-FFEF 全角形式（有意包含：行尾全角括号/标点与下一行汉字合并不应插空格）
 */
const CJK_CHAR = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

function joinSoftLines(a: string, b: string): string {
  const last = a[a.length - 1] ?? '';
  const first = b[0] ?? '';
  return CJK_CHAR.test(last) && CJK_CHAR.test(first) ? a + b : `${a} ${b}`;
}

function mergeSoftNewlines(text: string): string {
  const lines = text.split('\n');
  const paragraphs: string[] = [];
  let buf = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (buf) {
        paragraphs.push(buf);
        buf = '';
      }
      continue;
    }
    if (!buf) {
      buf = trimmed;
    } else if (SENTENCE_END.test(buf)) {
      paragraphs.push(buf);
      buf = trimmed;
    } else {
      buf = joinSoftLines(buf, trimmed);
    }
  }
  if (buf) paragraphs.push(buf);
  return paragraphs.join('\n\n');
}

function stripRepeatedShortLines(text: string): string {
  const lines = text.split('\n');
  const counts = new Map<string, number>();
  for (const line of lines) {
    const t = line.trim();
    if (t && t.length <= 40) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return lines
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^\d{1,4}$/.test(t)) return false; // 纯页码
      // 跨页高频重复短行（页眉页脚）。≥3 次才剥除：宁可放过 1-2 页短文档的页眉，
      // 也不误删恰好重复两次的正文短行（内容丢失比噪声更糟）
      return (counts.get(t) ?? 0) < 3;
    })
    .join('\n');
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // 控制字符（不含 \t \n \r）
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

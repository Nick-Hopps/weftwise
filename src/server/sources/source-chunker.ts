import path from 'path';
import { encode, decode } from 'gpt-tokenizer';

/**
 * 结构感知递归切分器。
 *
 * 设计要点（见 spec A.2）：
 * - 按来源分流分隔符阶梯：markdown（md/html）从 H2 起按标题切；
 *   plain（pdf/txt）按段落→中英句末标点切（修复通用阶梯无句界、空格对中文失效）。
 * - 按 token 计长（gpt-tokenizer 近似），不按字符——中文 1 字 ≈ 2–3 token。
 * - 逐级回退：当前层切不动则降级，最后 code-point 级硬切（代理对安全）。
 */
export type SourceKind = 'markdown' | 'plain';

export interface SourceChunk {
  id: string;         // 'c0' / 'c1' ...，源内顺序稳定
  heading: string;    // 最近 markdown 标题，无则 ''（best-effort）
  text: string;
  tokenCount: number;
}

export const CHUNK_TARGET = 1000;  // token
export const CHUNK_OVERLAP = 120;  // token（~12%）

const MARKDOWN_SEPARATORS = [
  '\n## ', '\n### ', '\n#### ', '\n##### ', '\n###### ',
  '\n```',
  // HR 作为边界附着在后块开头；不改为 '---\n' 后缀模式——
  // 那会让行尾恰为 --- 的普通文本被误切（失去两侧行边界保护）
  '\n---\n',
  '\n\n', '\n',
  '。', '！', '？', '. ', '! ', '? ', '；', '，',
  ' ', '',
];

const PLAIN_SEPARATORS = [
  '\n\n', '\n',
  '。', '！', '？', '. ', '! ', '? ', '；', '，',
  ' ', '',
];

export function sourceKindFor(filename: string): SourceKind {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.md' || ext === '.mdx' || ext === '.html' || ext === '.htm'
    ? 'markdown'
    : 'plain';
}

export function countTokens(text: string): number {
  return text ? encode(text).length : 0;
}

export function chunkText(
  cleanText: string,
  kind: SourceKind,
  opts?: { target?: number; overlap?: number },
): SourceChunk[] {
  const target = opts?.target ?? CHUNK_TARGET;
  const overlap = opts?.overlap ?? CHUNK_OVERLAP;
  const text = cleanText.trim();
  if (!text) return [];

  const separators = kind === 'markdown' ? MARKDOWN_SEPARATORS : PLAIN_SEPARATORS;
  const pieces = recursiveSplit(text, separators, target);
  const merged = mergePieces(pieces, target);

  const chunks: SourceChunk[] = [];
  let currentHeading = '';
  for (let i = 0; i < merged.length; i += 1) {
    const raw = merged[i];
    // heading 基于未加 overlap 的 raw 判定；overlap 极少跨 H2 边界
    // （H2 是最高优先切点），已知取舍
    const heading = findLeadingHeading(raw) ?? currentHeading;
    const withOverlap =
      i > 0 && overlap > 0 ? takeLastTokens(merged[i - 1], overlap) + raw : raw;
    chunks.push({
      id: `c${i}`,
      heading: kind === 'plain' ? '' : heading,
      text: withOverlap,
      tokenCount: countTokens(withOverlap),
    });
    const lastHeading = findLastHeading(raw);
    if (lastHeading) currentHeading = lastHeading;
  }
  return chunks;
}

/** 用当前最高层分隔符切；单片仍超限则降一级；阶梯耗尽则硬切。 */
function recursiveSplit(text: string, separators: string[], target: number): string[] {
  if (countTokens(text) <= target) return [text];

  const [sep, ...rest] = separators;
  if (sep === undefined || sep === '') return hardSplit(text, target);

  const parts = splitKeepingSeparator(text, sep);
  if (parts.length === 1) return recursiveSplit(text, rest, target);

  const out: string[] = [];
  for (const part of parts) {
    if (countTokens(part) <= target) out.push(part);
    else out.push(...recursiveSplit(part, rest, target));
  }
  return out;
}

/**
 * 切分但保留分隔符：
 * - 以 \n 开头的分隔符（标题/段落/代码栅栏）属于「下一片的开头」；
 * - 标点类分隔符属于「上一片的结尾」（句子在标点处收尾）。
 */
function splitKeepingSeparator(text: string, sep: string): string[] {
  const parts = text.split(sep);
  if (parts.length === 1) return [text];
  const isPrefix = sep.startsWith('\n');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    let piece = parts[i];
    if (isPrefix && i > 0) piece = sep + piece;
    if (!isPrefix && i < parts.length - 1) piece = piece + sep;
    // 纯空白片附着前片保全内容（如 '\n---\n' 等消费换行后残留的 '\n'，
    // 丢弃会让 rejoin 丢失换行、甚至诱发 setext 标题语义变异）；
    // 仅前导空白片（out 为空时）被丢弃，无内容损失
    if (piece.trim().length > 0) out.push(piece);
    else if (piece && out.length > 0) out[out.length - 1] += piece;
  }
  return out.length > 0 ? out : [text];
}

/** 最后手段：按 code point 硬切（Array.from 迭代代理对安全）。 */
function hardSplit(text: string, target: number): string[] {
  const points = Array.from(text);
  const totalTokens = countTokens(text) || 1;
  const charsPerToken = Math.max(1, points.length / totalTokens);
  const stride = Math.max(1, Math.floor(target * charsPerToken));
  const out: string[] = [];
  for (let i = 0; i < points.length; i += stride) {
    out.push(points.slice(i, i + stride).join(''));
  }
  return out;
}

/** 贪心合并相邻小片直到逼近 target。 */
function mergePieces(pieces: string[], target: number): string[] {
  const out: string[] = [];
  let buf = '';
  let bufTokens = 0;
  for (const piece of pieces) {
    const t = countTokens(piece);
    if (buf && bufTokens + t > target) {
      out.push(buf);
      buf = '';
      bufTokens = 0;
    }
    buf += piece;
    // 各片 token 之和 ≥ 拼接串实际 token（BPE 边界合并），估算偏保守、不会超限
    bufTokens += t;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** 取文本末尾约 n 个 token（用于 overlap）；剔除解码边界可能产生的残缺替换符。 */
function takeLastTokens(text: string, n: number): string {
  const tokens = encode(text);
  if (tokens.length <= n) return text;
  return decode(tokens.slice(-n)).replace(/^\u{FFFD}+/u, '').replace(/\u{FFFD}+$/u, '');
}

function findLeadingHeading(text: string): string | null {
  const m = text.trimStart().match(/^#{1,6}\s+(.+)/);
  return m ? m[1].trim() : null;
}

function findLastHeading(text: string): string | null {
  const matches = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)];
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
}

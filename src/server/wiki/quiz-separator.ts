/**
 * `[!quiz]` 答案分隔符的确定性判定与修复。
 *
 * 阅读页的 quiz 折叠只认 blockquote 内的 `thematicBreak`（`markdown-client.ts::splitQuizCallout`）。
 * enricher 有概率漏写那行 `---`，答案就直接摊在问题旁边剧透；实测存量 308 个 quiz 里 73 个如此。
 *
 * 本模块是**摄入侧**的兜底，渲染侧刻意保持纯结构判定（不认「答：/Answer:」这类语言标记，
 * 它会随 wikiLanguage 漂移）。语言标记的脆弱性只在这里出现一次：修复结果固化进 vault，
 * 可 git diff 审阅、可回滚，而不是每次渲染都去猜。
 * 设计稿见 `docs/specs/2026-07-28-quiz-answer-separator-guard.md`。
 *
 * 判定与渲染必须用**同一套解析**，否则护栏与渲染各说各话——故这里镜像
 * `markdown-client.ts` 的 remark 插件集（parse + frontmatter + gfm + math）。
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Node as MdastNode, Parent as MdastParent, Root as MdastRoot } from 'mdast';

export type QuizSeparatorReason = 'setext-separator' | 'missing-separator';

export interface QuizSeparatorViolation {
  /** blockquote 起始行（1-based），供报告与日志定位 */
  line: number;
  /** callout 标题行文本，便于人读 */
  head: string;
  /**
   * `setext-separator`：写了 `---` 但前面缺空 `>` 行，被 CommonMark 解析成 setext 标题；
   * `missing-separator`：根本没写分隔符，只能靠答案标签行定位。
   */
  reason: QuizSeparatorReason;
}

/**
 * 答案标签行。允许 `**`/`*`/`_` 强调包裹（实测 enricher 会写 `**答：**`）。
 * 只匹配行首——正文中间出现「答：」不算。
 */
const ANSWER_LABEL_RE = /^\s*(?:[*_]{1,2})?\s*(?:参考答案|答案|答|Answer|A)\s*(?:[*_]{1,2})?\s*[:：]/i;

/** 独占一行的 thematicBreak 写法（CommonMark 允许 `-`/`*`/`_` 三种，可含空格）。 */
const BREAK_LINE_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

interface QuizBlock {
  /** blockquote 起始行（1-based） */
  startLine: number;
  /** blockquote 结束行（1-based，含） */
  endLine: number;
  head: string;
  hasThematicBreak: boolean;
}

interface LocatedViolation extends QuizSeparatorViolation {
  startLine: number;
  /** setext-separator：分隔符行的绝对行号；missing-separator：答案标签行的绝对行号 */
  anchorLine: number;
}

function isParent(node: MdastNode): node is MdastParent {
  return Array.isArray((node as MdastParent).children);
}

function plainText(node: MdastNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
    return (node as unknown as { value: string }).value;
  }
  if (isParent(node)) return node.children.map(plainText).join('');
  return '';
}

function parse(markdown: string): MdastRoot {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm)
    .use(remarkMath)
    .parse(markdown) as MdastRoot;
}

/** 收集全部 `[!quiz]` blockquote（含嵌套位置），按文档顺序。 */
function quizBlocks(markdown: string): QuizBlock[] {
  const blocks: QuizBlock[] = [];
  const walk = (node: MdastNode): void => {
    if (!isParent(node)) return;
    for (const child of node.children) {
      if (child.type === 'blockquote') {
        const head = child.children[0] ? plainText(child.children[0]) : '';
        const startLine = child.position?.start.line;
        const endLine = child.position?.end.line;
        if (/^\s*\[!quiz\]/i.test(head) && startLine !== undefined && endLine !== undefined) {
          blocks.push({
            startLine,
            endLine,
            head: head.split('\n')[0],
            hasThematicBreak: child.children.some((c) => c.type === 'thematicBreak'),
          });
        }
      }
      walk(child);
    }
  };
  walk(parse(markdown));
  return blocks;
}

/** blockquote 行的 `>` 标记前缀（如 `>` 或 `  >`）；取不到时回退 `>`。 */
function markerOf(line: string | undefined): string {
  const m = line ? /^(\s*>)/.exec(line) : null;
  return m ? m[1] : '>';
}

/** 剥掉一行的 `>` 标记，返回引用内部内容。 */
function stripMarker(line: string): string {
  return line.replace(/^\s*>[ \t]?/, '');
}

function isBlankQuoteLine(line: string | undefined): boolean {
  return line !== undefined && /^\s*>?\s*$/.test(line);
}

/**
 * 判定单个无 `thematicBreak` 的 quiz 块。
 *
 * 口径刻意保守：**只有问题、没有答案标签**的 quiz 不算违规——存量 205 处正是这个形态，
 * 是 `2026-07-26-mastery-evidence-model` 保留的兼容路径。也刻意不把「子节点数 > 2」
 * 当作信号：问题 + 提示段是合法形态，会误判。
 */
function locate(block: QuizBlock, lines: string[]): LocatedViolation | null {
  const base = { line: block.startLine, head: block.head, startLine: block.startLine };
  // 首行是 `[!quiz]` 标题行，不参与扫描
  for (let i = block.startLine; i < block.endLine; i += 1) {
    // 有 `---` 字面量却没解析成 thematicBreak → 只可能是被上一行段落吃成了 setext 标题
    if (BREAK_LINE_RE.test(stripMarker(lines[i]).trim())) {
      return { ...base, reason: 'setext-separator', anchorLine: i + 1 };
    }
  }
  for (let i = block.startLine; i < block.endLine; i += 1) {
    if (ANSWER_LABEL_RE.test(stripMarker(lines[i]))) {
      return { ...base, reason: 'missing-separator', anchorLine: i + 1 };
    }
  }
  return null;
}

function locateAll(markdown: string): LocatedViolation[] {
  const lines = markdown.split('\n');
  const found: LocatedViolation[] = [];
  for (const block of quizBlocks(markdown)) {
    if (block.hasThematicBreak) continue;
    const located = locate(block, lines);
    if (located) found.push(located);
  }
  return found;
}

/** 判定：返回所有「带答案却无法折叠」的 quiz 块。守约形态与纯问题形态都返回空。 */
export function findQuizSeparatorViolations(markdown: string): QuizSeparatorViolation[] {
  return locateAll(markdown).map(({ line, head, reason }) => ({ line, head, reason }));
}

export interface QuizSeparatorRepair {
  content: string;
  repaired: QuizSeparatorViolation[];
}

/**
 * 确定性修复。两条规则按优先级：
 *
 * 1. `setext-separator` → 给已有的 `---` 行前后各补一个空 `>` 行。**零猜测、与语言无关**。
 * 2. `missing-separator` → 在答案标签行前插入 `>` / `> ---` / `>`；标签行与问题同段时
 *    该插入天然完成拆段。
 *
 * 判定的两个 reason 各自都自带可编辑的锚点，所以被判为违规的块必然可修——不存在
 * 「报了但修不了」的第三态，故无需返回 unrepaired。
 *
 * 在**原始文本行**上编辑（不做 mdast → markdown 序列化），因此正文其余部分逐字节保留。
 * 多块时按逆序编辑，避免前面的插入让后面的行号失效。
 */
export function repairQuizSeparator(markdown: string): QuizSeparatorRepair {
  const violations = locateAll(markdown);
  if (violations.length === 0) return { content: markdown, repaired: [] };

  const lines = markdown.split('\n');
  for (const v of [...violations].reverse()) {
    const idx = v.anchorLine - 1;
    const marker = markerOf(lines[v.startLine - 1]);
    if (v.reason === 'setext-separator') {
      // 分隔符行本身逐字保留，只补它缺的空行
      if (!isBlankQuoteLine(lines[idx + 1])) lines.splice(idx + 1, 0, marker);
      if (!isBlankQuoteLine(lines[idx - 1])) lines.splice(idx, 0, marker);
    } else {
      const insert = isBlankQuoteLine(lines[idx - 1])
        ? [`${marker} ---`, marker]
        : [marker, `${marker} ---`, marker];
      lines.splice(idx, 0, ...insert);
    }
  }

  return {
    content: lines.join('\n'),
    repaired: violations.map(({ line, head, reason }) => ({ line, head, reason })),
  };
}

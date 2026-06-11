# Ingest 大文件分片读取 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ingest 流水线支持任意大小的源文件——确定性预清洗 + 结构感知切块 + 自适应（inline / map-reduce）流水线 + 确定性块路由，移除 30k 截断。

**Architecture:** 解析期纯函数完成清洗与切块（零 token）；全文只存 `ctx.chunkStore`（绝不进 carry/prompt）；carry 里流转轻量 `chunkRefs`；大文件先经 map 步逐块生成「定位性摘要」再交 planner；writer 由 orchestrator 按 planner 标注的 `sourceRefs.chunkIds` 确定性注入相关块全文；步数预算改为单 agent 实例作用域，token 预算在流水线启动前预检。

**Tech Stack:** TypeScript / Next.js 15 worker 进程 / Vercel AI SDK 4 / vitest / 新依赖 `gpt-tokenizer`（纯 TS token 计数）。

**Spec:** `docs/superpowers/specs/2026-06-05-ingest-large-file-chunking-design.md`

---

## 前置须知（执行者必读）

1. **工作区有未提交改动**（`agent-loop.ts` / `commit-changeset.ts` / `frontmatter.ts` / `src/server/wiki/__tests__/` 等）。这些是用户的既有工作，**不属于本计划**。每个 Task 的 commit 步骤只 `git add` 该 Task 明确列出的文件，绝不 `git add -A`。
2. **测试命令**：`npm test`（= `vitest run`）；单文件：`npx vitest run <path>`。测试文件放在被测模块同级的 `__tests__/` 目录，命名 `*.test.ts`（vitest.config.ts 的 include 是 `src/**/__tests__/**/*.test.ts`）。
3. **路径别名**：`@/*` → `src/*`。
4. **git commit message 用中文一句话**，不加 AI 署名。
5. `data/vault/` 已被 gitignore——里面的 skill 种子副本（`data/vault/.llm-wiki/skills/*.md`）是本地开发产物，worker 启动时从 `examples/skills/` 播种且**不覆盖已存在文件**。修改 examples 后需删除本地副本让其重新播种（Task 9 有此步骤）。
6. **现状已知怪癖**（Task 5 会修复）：orchestrator 的 sequence 步 `carry = r.output` 整体替换 carry，而 planner 的 outputSchema 只含 `plan`，所以现在 writer 实际收到的 `sources` 是 `undefined`（`orchestrator.test.ts` 第 69 行断言了这一点）。本计划用 `carryThrough` 机制修复。

---

## 文件结构总览

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/server/sources/source-cleaner.ts` | 新增 | 按来源预清洗纯函数（PDF 完整清洗链） |
| `src/server/sources/__tests__/source-cleaner.test.ts` | 新增 | 清洗链测试 |
| `src/server/sources/source-chunker.ts` | 新增 | 结构感知递归切分器（分流阶梯 + token 计长） |
| `src/server/sources/__tests__/source-chunker.test.ts` | 新增 | 切分器测试 |
| `src/server/sources/source-store.ts` | 修改 | 新增 `updateSourceChunks`（chunk 持久化到 sidecar JSON） |
| `src/server/agents/types.ts` | 修改 | `BudgetTracker` 拆分、新增 `RunStepTracker` / `StoredChunk` / `ChunkRef`、`AgentContext.chunkStore` |
| `src/server/agents/runtime/budget.ts` | 修改 | token 留 job 级、step 改 per-run（`createRunStepTracker`） |
| `src/server/agents/runtime/agent-loop.ts` | 修改 | 使用 per-run step 计数器 |
| `src/server/agents/runtime/orchestrator.ts` | 修改 | `map` step kind、`carryThrough`/`omitFromInput`、`relevantChunks` 注入 |
| `src/server/services/ingest-prep.ts` | 新增 | 纯函数：prepareIngest / 预算预检 / 路径选择 |
| `src/server/services/__tests__/ingest-prep.test.ts` | 新增 | prep 测试 |
| `src/server/services/ingest-service.ts` | 修改 | 移除截断、接入 prep、预检、自适应 steps、existingPages 实读 |
| `examples/skills/ingest-planner.md` | 修改 | 输入 chunkRefs、输出加 sourceRefs |
| `examples/skills/ingest-writer.md` | 修改 | 输入 relevantChunks |
| `examples/skills/ingest-chunk-summarizer.md` | 新增 | map 步摘要 skill（含 outline 上下文） |
| `package.json` | 修改 | 新依赖 `gpt-tokenizer` |
| 各模块 `CLAUDE.md` | 修改 | 文档同步 |

---

### Task 1: 安装 gpt-tokenizer 依赖

**Files:**
- Modify: `package.json` / `package-lock.json`

- [ ] **Step 1: 安装依赖**

```bash
npm install gpt-tokenizer
```

- [ ] **Step 2: 验证可导入**

```bash
node -e "const { encode, decode } = require('gpt-tokenizer'); console.log(encode('你好 world').length)"
```

Expected: 输出一个正整数（如 `3`），无报错。

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "依赖：新增 gpt-tokenizer 用于切块 token 计数"
```

---

### Task 2: source-cleaner.ts —— 按来源预清洗

**Files:**
- Create: `src/server/sources/source-cleaner.ts`
- Test: `src/server/sources/__tests__/source-cleaner.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/server/sources/__tests__/source-cleaner.test.ts
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
    expect(out).not.toMatch(/\n{4,}/);
  });
});

describe('cleanSourceText: text', () => {
  it('NFKC 归一化 + 空白归一化', () => {
    // 全角 Ａ → A；连续空格折叠
    const out = cleanSourceText('Ａbc   def', 'text');
    expect(out).toBe('Abc def');
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

  it('行尾是句末标点则保留换行（段落边界）', () => {
    const out = cleanSourceText('第一句。\n第二段开头', 'pdf');
    expect(out).toContain('第一句。\n');
  });

  it('空行保留为段落边界', () => {
    const out = cleanSourceText('para one\n\npara two', 'pdf');
    expect(out).toBe('para one\n\npara two');
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
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/server/sources/__tests__/source-cleaner.test.ts
```

Expected: FAIL，报 `Cannot find module '../source-cleaner'`。

- [ ] **Step 3: 实现**

```ts
// src/server/sources/source-cleaner.ts
import path from 'path';

/**
 * 切分前的按来源预清洗。
 * - markdown（md/html→turndown 产物）：已结构化，仅做最小归一化，避免破坏标题/代码块。
 * - text（txt 等）：NFKC + 空白归一化。
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
    return raw.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }
  if (kind === 'text') {
    return normalizeWhitespace(raw.normalize('NFKC'));
  }
  // pdf 完整清洗链（顺序敏感）
  let text = raw.replace(/\r\n?/g, '\n').normalize('NFKC');
  text = text.replace(/\u00AD/g, ''); // 软连字符（不可见，必须用转义写法）
  text = text.replace(/([A-Za-z])-\n([a-z])/g, '$1$2'); // 行尾连字符断词
  text = stripRepeatedShortLines(text); // 页眉页脚 / 页码
  text = mergeSoftNewlines(text); // 软换行合并
  return normalizeWhitespace(text);
}

/** 行尾出现这些字符视为「句子/段落收尾」，换行保留 */
const SENTENCE_END = /[。！？．.!?:：;；]$/;

const CJK_CHAR = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

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
      return (counts.get(t) ?? 0) < 3; // 跨页高频重复短行
    })
    .join('\n');
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // 控制字符
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

> 注意：`mergeSoftNewlines` 把段落重组为 `\n\n` 分隔——「行尾是句末标点保留换行」测试断言的是 `第一句。\n`，`\n\n` 包含 `\n`，能通过。

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/server/sources/__tests__/source-cleaner.test.ts
```

Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add src/server/sources/source-cleaner.ts src/server/sources/__tests__/source-cleaner.test.ts
git commit -m "新增源文本预清洗：PDF 清洗链+按来源分流"
```

---

### Task 3: source-chunker.ts —— 结构感知递归切分器

**Files:**
- Create: `src/server/sources/source-chunker.ts`
- Test: `src/server/sources/__tests__/source-chunker.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/server/sources/__tests__/source-chunker.test.ts
import { describe, expect, it } from 'vitest';
import { chunkText, countTokens, sourceKindFor } from '../source-chunker';

describe('sourceKindFor', () => {
  it('md/html 归为 markdown，其余归为 plain', () => {
    expect(sourceKindFor('a.md')).toBe('markdown');
    expect(sourceKindFor('a.htm')).toBe('markdown');
    expect(sourceKindFor('a.pdf')).toBe('plain');
    expect(sourceKindFor('a.txt')).toBe('plain');
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
    const prevTail = chunks[0].text.slice(-12);
    expect(chunks[1].text).toContain(prevTail.trim().slice(0, 6));
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
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/server/sources/__tests__/source-chunker.test.ts
```

Expected: FAIL，`Cannot find module '../source-chunker'`。

- [ ] **Step 3: 实现**

```ts
// src/server/sources/source-chunker.ts
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
  id: string; // 'c0' / 'c1' ...，源内顺序稳定
  heading: string; // 最近 markdown 标题，无则 ''（best-effort）
  text: string;
  tokenCount: number;
}

export const CHUNK_TARGET = 1000; // token
export const CHUNK_OVERLAP = 120; // token（~12%）

const MARKDOWN_SEPARATORS = [
  '\n## ', '\n### ', '\n#### ', '\n##### ', '\n###### ',
  '\n```',
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
    const heading = findLeadingHeading(raw) ?? currentHeading;
    const withOverlap =
      i > 0 && overlap > 0 ? takeLastTokens(merged[i - 1], overlap) + raw : raw;
    chunks.push({
      id: `c${i}`,
      heading,
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
    if (piece.trim().length > 0) out.push(piece);
  }
  return out.length > 0 ? out : [text];
}

/** 最后手段：按 code point 硬切（for..of / Array.from 迭代代理对安全）。 */
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
    bufTokens += t;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** 取文本末尾约 n 个 token（用于 overlap）；剔除解码边界可能产生的残缺替换符。 */
function takeLastTokens(text: string, n: number): string {
  const tokens = encode(text);
  if (tokens.length <= n) return text;
  return decode(tokens.slice(-n)).replace(/^�+/, '');
}

function findLeadingHeading(text: string): string | null {
  const m = text.trimStart().match(/^#{1,6}\s+(.+)/);
  return m ? m[1].trim() : null;
}

function findLastHeading(text: string): string | null {
  const matches = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)];
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : null;
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/server/sources/__tests__/source-chunker.test.ts
```

Expected: PASS。若「不从句子中间切断」用例失败，检查 `splitKeepingSeparator` 的标点后缀分支是否把 `。` 留在上一片结尾。

- [ ] **Step 5: Commit**

```bash
git add src/server/sources/source-chunker.ts src/server/sources/__tests__/source-chunker.test.ts
git commit -m "新增结构感知递归切分器：分流阶梯+token计长+CJK句界"
```

---

### Task 4: 预算改造（E.1）—— step 作用域 job 级 → 单 agent 实例

**Files:**
- Modify: `src/server/agents/types.ts`
- Modify: `src/server/agents/runtime/budget.ts`
- Modify: `src/server/agents/runtime/agent-loop.ts`
- Modify: `src/server/agents/runtime/__tests__/budget.test.ts`
- Modify: `src/server/agents/runtime/__tests__/orchestrator.test.ts`（仅 ctxStub）
- Modify: `src/server/agents/runtime/__tests__/agent-loop.test.ts`（仅 budget stub 形状）

- [ ] **Step 1: 改写 budget.test.ts 为新语义（失败测试）**

整文件替换为：

```ts
// src/server/agents/runtime/__tests__/budget.test.ts
import { describe, expect, it } from 'vitest';
import { createBudgetTracker, createRunStepTracker, BudgetExceededError } from '../budget';

describe('BudgetTracker（job 级，仅 token）', () => {
  it('累加 token', () => {
    const b = createBudgetTracker({ maxSteps: 3, maxTokensPerJob: 1000, maxParallelSubAgents: 2 });
    b.chargeTokens(100);
    b.chargeTokens(50);
    expect(b.tokensUsed).toBe(150);
  });

  it('超过 maxTokensPerJob 时 assertWithin 抛错', () => {
    const b = createBudgetTracker({ maxSteps: 100, maxTokensPerJob: 500, maxParallelSubAgents: 1 });
    b.chargeTokens(300);
    b.chargeTokens(300);
    expect(() => b.assertWithin()).toThrow(BudgetExceededError);
    try {
      b.assertWithin();
    } catch (e) {
      expect((e as BudgetExceededError).limit).toBe('maxTokensPerJob');
    }
  });
});

describe('RunStepTracker（单 agent 实例级）', () => {
  it('计步独立：两个 tracker 互不影响', () => {
    const a = createRunStepTracker(5);
    const b = createRunStepTracker(5);
    a.chargeStep();
    a.chargeStep();
    b.chargeStep();
    expect(a.stepCount).toBe(2);
    expect(b.stepCount).toBe(1);
  });

  it('单实例超过 maxSteps 抛 BudgetExceededError', () => {
    const t = createRunStepTracker(2);
    t.chargeStep();
    t.chargeStep();
    expect(() => t.chargeStep()).toThrow(BudgetExceededError);
    try {
      createRunStepTracker(0).chargeStep();
    } catch (e) {
      expect((e as BudgetExceededError).limit).toBe('maxSteps');
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/server/agents/runtime/__tests__/budget.test.ts
```

Expected: FAIL，`createRunStepTracker` 不存在。

- [ ] **Step 3: 改 types.ts**

`BudgetTracker` 接口替换为（移除 `chargeStep`/`stepCount`），并新增 `RunStepTracker`：

```ts
// types.ts 中替换原 BudgetTracker 接口
export interface BudgetTracker {
  chargeTokens(n: number): void;
  assertWithin(): void;
  readonly tokensUsed: number;
}

/** 单 agent 实例内的 step 计数器（防单实例失控循环；job 级总量防线是 token）。 */
export interface RunStepTracker {
  chargeStep(): void;
  readonly stepCount: number;
}
```

- [ ] **Step 4: 改 budget.ts**

整文件替换为：

```ts
// src/server/agents/runtime/budget.ts
import type { AgentBudget, BudgetTracker, RunStepTracker } from '../types';

export class BudgetExceededError extends Error {
  constructor(
    public readonly limit: 'maxSteps' | 'maxTokensPerJob',
    public readonly actual: number,
    public readonly cap: number,
  ) {
    super(`Agent budget exceeded: ${limit}=${actual}/${cap}`);
    this.name = 'BudgetExceededError';
  }
}

/** job 级预算：只管 token 总量（step 防护见 createRunStepTracker，作用域是单 agent 实例）。 */
export function createBudgetTracker(budget: AgentBudget): BudgetTracker {
  let tokensUsed = 0;
  return {
    chargeTokens(n) { tokensUsed += Math.max(0, n | 0); },
    assertWithin() {
      if (tokensUsed > budget.maxTokensPerJob) {
        throw new BudgetExceededError('maxTokensPerJob', tokensUsed, budget.maxTokensPerJob);
      }
    },
    get tokensUsed() { return tokensUsed; },
  };
}

/** 单 agent 实例的 step 计数器；map/fanout 实例数量是确定性的，不受此限制。 */
export function createRunStepTracker(maxSteps: number): RunStepTracker {
  let stepCount = 0;
  return {
    chargeStep() {
      stepCount += 1;
      if (stepCount > maxSteps) {
        throw new BudgetExceededError('maxSteps', stepCount, maxSteps);
      }
    },
    get stepCount() { return stepCount; },
  };
}
```

- [ ] **Step 5: 改 agent-loop.ts**

四处修改：

1. import 行加入 run tracker：

```ts
import { createRunStepTracker } from './budget';
```

2. `const startedAt = Date.now();` 之后加：

```ts
const runSteps = createRunStepTracker(ctx.budgetSnapshot.maxSteps);
```

3. 全文件把 `ctx.budget.stepCount`（共 6 处：tool execute 成功/失败 emit、structured-output-recovery emit、final emit、run-completed emit、return）替换为 `runSteps.stepCount`；tool execute 回调内、`try` 之前加一行 `runSteps.chargeStep();`：

```ts
      execute: async (args: unknown) => {
        const stepStart = Date.now();
        runSteps.chargeStep();
        try {
```

4. 把 `ctx.budget.chargeStep();`（约 145 行）删除，保留其后的 `ctx.budget.chargeTokens(...)`，并在其前补 final 计步：

```ts
  runSteps.chargeStep(); // final 输出本身计 1 步
  ctx.budget.chargeTokens(inputTokens + outputTokens);
```

- [ ] **Step 6: 更新 orchestrator.test.ts 的 ctxStub**

`budget` 一行替换为：

```ts
    budget: { chargeTokens: vi.fn(), assertWithin: vi.fn(), tokensUsed: 0 },
```

- [ ] **Step 7: 更新 agent-loop.test.ts 的 budget stub**

该文件当前有未提交改动；只把其中所有 `budget` stub 对象改为新形状 `{ chargeTokens: vi.fn(), assertWithin: vi.fn(), tokensUsed: 0 }`，若有对 `chargeStep` 被调用的断言，改为断言返回值的 `stepCount`（`runAgentLoop` 结果的 `stepCount` 现在是单实例计数，纯 generateObject 路径应为 `1`）。

- [ ] **Step 8: 全量跑 agents 测试**

```bash
npx vitest run src/server/agents
```

Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add src/server/agents/types.ts src/server/agents/runtime/budget.ts src/server/agents/runtime/agent-loop.ts src/server/agents/runtime/__tests__/budget.test.ts src/server/agents/runtime/__tests__/orchestrator.test.ts src/server/agents/runtime/__tests__/agent-loop.test.ts
git commit -m "预算改造：maxSteps 改单 agent 实例作用域，token 仍 job 级"
```

---

### Task 5: orchestrator —— map step + carryThrough/omitFromInput + relevantChunks 注入

**Files:**
- Modify: `src/server/agents/types.ts`（StoredChunk / ChunkRef / AgentContext.chunkStore）
- Modify: `src/server/agents/runtime/orchestrator.ts`
- Modify: `src/server/agents/runtime/__tests__/orchestrator.test.ts`

- [ ] **Step 1: types.ts 增加块类型与 chunkStore**

在 `PendingChangeset` 接口之后加：

```ts
/** chunkStore 中的块全文（全文唯一存放处，绝不进 carry/prompt）。 */
export interface StoredChunk {
  sourceId: string;
  id: string;
  heading: string;
  text: string;
}

/** carry 中流转的轻量块引用；content 在小路径=全文、大路径=摘要。 */
export interface ChunkRef {
  key: string; // `${sourceId}:${id}`
  sourceId: string;
  id: string;
  heading: string;
  content: string;
}
```

`AgentContext` 接口在 `pending` 字段后加：

```ts
  /** 块全文存放处；key = `${sourceId}:${chunkId}`。 */
  chunkStore: Map<string, StoredChunk>;
```

- [ ] **Step 2: 改写 orchestrator.test.ts（失败测试）**

整文件替换为：

```ts
// src/server/agents/runtime/__tests__/orchestrator.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runPipeline, WriterConflictError } from '../orchestrator';
import type { AgentContext, SkillTemplate, StoredChunk } from '../../types';

const mockRun = vi.fn();
vi.mock('../agent-loop', () => ({
  runAgentLoop: (opts: { skill: { id: string }; input: unknown }) => mockRun(opts),
  AgentCancelled: class extends Error {},
}));

function ctxStub(chunks: StoredChunk[] = []): AgentContext {
  const chunkStore = new Map<string, StoredChunk>();
  for (const c of chunks) chunkStore.set(`${c.sourceId}:${c.id}`, c);
  return {
    job: { id: 'j' } as AgentContext['job'],
    subject: { slug: 'general' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeTokens: vi.fn(), assertWithin: vi.fn(), tokensUsed: 0 },
    overlay: { snapshot: vi.fn(() => ({ snapshot: () => ({}), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() })), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() } as unknown as AgentContext['overlay'],
    toolRegistry: { register: vi.fn(), resolve: vi.fn(() => []), get: vi.fn() },
    skillRegistry: { get: vi.fn(), list: vi.fn(() => []), degraded: vi.fn(() => []) },
    rootRunId: 'r0',
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    chunkStore,
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 500_000, maxParallelSubAgents: 2 },
  } as AgentContext;
}

const stubSkill = (id: string): SkillTemplate => ({
  id, name: id, description: '', version: 1, tools: [], canDispatch: [], systemPrompt: '',
});

const chunk = (sourceId: string, id: string, text: string): StoredChunk =>
  ({ sourceId, id, heading: '', text });

describe('orchestrator.runPipeline: sequence', () => {
  it('顺序执行并传递输出', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: '1', output: { plan: { pages: [] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: '2', output: { final: 'ok' }, tokensUsed: 0, stepCount: 1 });
    const result = await runPipeline({
      steps: [{ kind: 'sequence', skillId: 'planner' }, { kind: 'sequence', skillId: 'reviewer' }],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: { sources: [] },
    });
    expect(result).toEqual({ final: 'ok' });
  });

  it('carryThrough 把指定 key 从前一 carry 透传到新 carry', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: '1', output: { plan: { pages: [] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: '2', output: { final: 'ok' }, tokensUsed: 0, stepCount: 1 });
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'chunkRefs'] },
        { kind: 'sequence', skillId: 'reviewer' },
      ],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: { subjectSlug: 'general', chunkRefs: [{ key: 'k' }], other: 'dropped' },
    });
    // reviewer 的输入 = carryThrough keys + planner 输出
    expect(mockRun.mock.calls[1][0].input).toEqual({
      subjectSlug: 'general',
      chunkRefs: [{ key: 'k' }],
      plan: { pages: [] },
    });
  });

  it('omitFromInput 从该步输入中剔除指定 key', async () => {
    mockRun.mockReset();
    mockRun.mockResolvedValueOnce({ runId: '1', output: { done: true }, tokensUsed: 0, stepCount: 1 });
    await runPipeline({
      steps: [{ kind: 'sequence', skillId: 'reviewer', omitFromInput: ['chunkRefs', 'outline'] }],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: { chunkRefs: [{ key: 'k' }], outline: '- x', plan: { pages: [] } },
    });
    expect(mockRun.mock.calls[0][0].input).toEqual({ plan: { pages: [] } });
  });
});

describe('orchestrator.runPipeline: map', () => {
  it('逐块注入 chunkStore 全文+outline，把 summary 写回 content', async () => {
    mockRun.mockReset();
    mockRun.mockImplementation(async (opts: { input: { id: string } }) => ({
      runId: `m-${opts.input.id}`,
      output: { summary: `摘要:${opts.input.id}` },
      tokensUsed: 0,
      stepCount: 1,
    }));
    const ctx = ctxStub([chunk('s1', 'c0', '全文零'), chunk('s1', 'c1', '全文一')]);
    const result = await runPipeline({
      steps: [{ kind: 'map', skillId: 'summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {
        outline: '- [s1:c0] x\n- [s1:c1] y',
        chunkRefs: [
          { key: 's1:c0', sourceId: 's1', id: 'c0', heading: '', content: '' },
          { key: 's1:c1', sourceId: 's1', id: 'c1', heading: '', content: '' },
        ],
      },
    });
    // summarizer 收到全文与 outline
    expect(mockRun.mock.calls[0][0].input).toMatchObject({ text: '全文零', outline: expect.stringContaining('s1:c0') });
    const r = result as { chunkRefs: Array<{ content: string }> };
    expect(r.chunkRefs.map((c) => c.content)).toEqual(['摘要:c0', '摘要:c1']);
  });

  it('chunkStore 缺失的块跳过并 emit warn，原 item 保留', async () => {
    mockRun.mockReset();
    const ctx = ctxStub([]); // 空 chunkStore
    const result = await runPipeline({
      steps: [{ kind: 'map', skillId: 'summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { chunkRefs: [{ key: 's1:c9', sourceId: 's1', id: 'c9', heading: '', content: '' }] },
    });
    expect(mockRun).not.toHaveBeenCalled();
    expect(ctx.emit).toHaveBeenCalledWith('ingest:warn', expect.stringContaining('s1:c9'), expect.anything());
    const r = result as { chunkRefs: Array<{ key: string }> };
    expect(r.chunkRefs[0].key).toBe('s1:c9');
  });
});

describe('orchestrator.runPipeline: fanout', () => {
  it('按 sourceRefs 从 chunkStore 注入 relevantChunks（不透传 chunkRefs）', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({
        runId: 'p',
        output: { plan: { pages: [{ slug: 'a', sourceRefs: [{ sourceId: 's1', chunkIds: ['c0', 'c2'] }] }] } },
        tokensUsed: 0, stepCount: 1,
      })
      .mockResolvedValueOnce({ runId: 'w1', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([chunk('s1', 'c0', '块零全文'), chunk('s1', 'c2', '块二全文')]);
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages', 'chunkRefs'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [], chunkRefs: [{ key: 's1:c0' }] },
    });
    const writerInput = mockRun.mock.calls[1][0].input as Record<string, unknown>;
    expect(writerInput.relevantChunks).toEqual([
      { id: 'c0', heading: '', text: '块零全文' },
      { id: 'c2', heading: '', text: '块二全文' },
    ]);
    expect(writerInput.subjectSlug).toBe('general');
    expect(writerInput.chunkRefs).toBeUndefined();
    expect(writerInput.sources).toBeUndefined();
  });

  it('sourceRefs 引用缺失块时跳过 + emit warn', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({
        runId: 'p',
        output: { plan: { pages: [{ slug: 'a', sourceRefs: [{ sourceId: 's1', chunkIds: ['c404'] }] }] } },
        tokensUsed: 0, stepCount: 1,
      })
      .mockResolvedValueOnce({ runId: 'w1', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {},
    });
    expect(ctx.emit).toHaveBeenCalledWith('ingest:warn', expect.stringContaining('c404'), expect.anything());
    const writerInput = mockRun.mock.calls[1][0].input as Record<string, unknown>;
    expect(writerInput.relevantChunks).toEqual([]);
  });

  it('writer 路径冲突仍抛 WriterConflictError', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a' }, { slug: 'a' }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w1', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w2', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 });
    await expect(runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: {},
    })).rejects.toThrow(WriterConflictError);
  });
});
```

- [ ] **Step 3: 运行确认失败**

```bash
npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts
```

Expected: FAIL（map kind 不存在 / carryThrough 不生效 / relevantChunks 缺失）。

- [ ] **Step 4: 实现 orchestrator 改造**

`PipelineStep` 替换为：

```ts
export type PipelineStep =
  | { kind: 'sequence'; skillId: string; carryThrough?: string[]; omitFromInput?: string[] }
  | { kind: 'fanout'; skillId: string; fromOutput: string }
  | { kind: 'map'; skillId: string; fromOutput: string; intoOutput: string };
```

`runPipeline` 主循环替换为：

```ts
export async function runPipeline(opts: {
  steps: PipelineStep[];
  resolveSkill: (id: string) => SkillTemplate;
  ctx: AgentContext;
  initialInput: unknown;
}): Promise<unknown> {
  let carry: unknown = opts.initialInput;
  for (const step of opts.steps) {
    if (step.kind === 'sequence') {
      const skill = opts.resolveSkill(step.skillId);
      const input = step.omitFromInput && isPlainObject(carry)
        ? omitKeys(carry, step.omitFromInput)
        : carry;
      const r = await runAgentLoop({ skill, ctx: opts.ctx, input });
      carry = step.carryThrough && isPlainObject(carry) && isPlainObject(r.output)
        ? { ...pickKeys(carry, step.carryThrough), ...r.output }
        : r.output;
    } else if (step.kind === 'map') {
      const skill = opts.resolveSkill(step.skillId);
      const items = readPath(carry, step.fromOutput);
      if (!Array.isArray(items)) {
        throw new Error(`Map source at "${step.fromOutput}" is not an array (got ${typeof items})`);
      }
      const outline = isPlainObject(carry) ? carry.outline : undefined;
      const limit = opts.ctx.budgetSnapshot.maxParallelSubAgents;
      const results = await runWithSemaphore(items, limit, async (item) => {
        if (!isPlainObject(item) || typeof item.key !== 'string') return item;
        const stored = opts.ctx.chunkStore.get(item.key);
        if (!stored) {
          opts.ctx.emit('ingest:warn', `Chunk not found in chunkStore: ${item.key}`, { key: item.key });
          return item;
        }
        const childCtx: AgentContext = { ...opts.ctx, parentRunId: opts.ctx.rootRunId };
        const r = await runAgentLoop({
          skill,
          ctx: childCtx,
          input: { sourceId: stored.sourceId, id: stored.id, heading: stored.heading, text: stored.text, outline },
        });
        const out = r.output as { summary?: string } | undefined;
        return typeof out?.summary === 'string' ? { ...item, content: out.summary } : item;
      });
      carry = { ...((carry as object) ?? {}), [step.intoOutput]: results };
    } else {
      const skill = opts.resolveSkill(step.skillId);
      const items = readPath(carry, step.fromOutput);
      if (!Array.isArray(items)) {
        throw new Error(`Fanout source at "${step.fromOutput}" is not an array (got ${typeof items})`);
      }
      const baseOverlay = opts.ctx.overlay.snapshot();
      const limit = opts.ctx.budgetSnapshot.maxParallelSubAgents;
      const results = await runWithSemaphore(items, limit, async (item) => {
        const childCtx: AgentContext = {
          ...opts.ctx,
          overlay: baseOverlay.snapshot(),
          parentRunId: opts.ctx.rootRunId,
        };
        return runAgentLoop({ skill, ctx: childCtx, input: buildFanoutInput(carry, item, opts.ctx) });
      });
      const seenSlugs = new Set<string>();
      const merged: unknown[] = [];
      for (const r of results) {
        const out = r.output as { entry?: { path?: string } } | undefined;
        const path = out?.entry?.path;
        if (path) {
          if (seenSlugs.has(path)) {
            throw new WriterConflictError(path);
          }
          seenSlugs.add(path);
        }
        merged.push(r.output);
      }
      for (const r of results) {
        const out = r.output as { entry?: { action: 'create' | 'update' | 'delete'; path: string; content: string } } | undefined;
        if (out?.entry) opts.ctx.overlay.putEntries([out.entry]);
      }
      carry = { ...((carry as object) ?? {}), writerOutputs: merged };
    }
  }
  return carry;
}
```

`buildFanoutInput` 与新增 helper 替换/追加：

```ts
function buildFanoutInput(carry: unknown, item: unknown, ctx: AgentContext): unknown {
  if (!isPlainObject(carry) || !isPlainObject(item)) return item;

  return {
    ...item,
    relevantChunks: resolveRelevantChunks(item, ctx),
    subjectSlug: carry.subjectSlug,
    existingPages: carry.existingPages,
    plan: carry.plan,
  };
}

/** 按 planner 标注的 sourceRefs 从 chunkStore 解析出相关块全文；缺失块跳过并告警。 */
function resolveRelevantChunks(
  item: Record<string, unknown>,
  ctx: AgentContext,
): Array<{ id: string; heading: string; text: string }> {
  const refs = item.sourceRefs;
  if (!Array.isArray(refs)) return [];
  const out: Array<{ id: string; heading: string; text: string }> = [];
  for (const ref of refs) {
    if (!isPlainObject(ref) || typeof ref.sourceId !== 'string' || !Array.isArray(ref.chunkIds)) continue;
    for (const chunkId of ref.chunkIds) {
      if (typeof chunkId !== 'string') continue;
      const stored = ctx.chunkStore.get(`${ref.sourceId}:${chunkId}`);
      if (!stored) {
        ctx.emit('ingest:warn', `Planner referenced missing chunk: ${ref.sourceId}:${chunkId}`, {
          sourceId: ref.sourceId,
          chunkId,
        });
        continue;
      }
      out.push({ id: stored.id, heading: stored.heading, text: stored.text });
    }
  }
  return out;
}

function pickKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in obj) out[k] = obj[k];
  }
  return out;
}

function omitKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}
```

- [ ] **Step 5: 运行确认通过**

```bash
npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts
```

Expected: PASS。

- [ ] **Step 6: 跑全量 agents 测试确认无回归**

```bash
npx vitest run src/server/agents
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/server/agents/types.ts src/server/agents/runtime/orchestrator.ts src/server/agents/runtime/__tests__/orchestrator.test.ts
git commit -m "orchestrator 新增 map step 与 chunkStore 确定性块路由"
```

---

### Task 6: source-store —— chunk 持久化到 sidecar JSON

**Files:**
- Modify: `src/server/sources/source-store.ts`
- Test: `src/server/sources/__tests__/source-store.test.ts`（新增）

- [ ] **Step 1: 写失败测试**

```ts
// src/server/sources/__tests__/source-store.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

vi.mock('../../config/env', () => ({
  vaultPath: (...segs: string[]) => path.join(tmpDir, ...segs),
}));

vi.mock('../../db/repos/sources-repo', () => ({
  getSourceByHash: () => null,
  upsertSource: vi.fn(),
}));

describe('updateSourceChunks', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('把 chunks 写入既有 metadata sidecar', async () => {
    const { saveRawSource, updateSourceChunks, getSourceMetadata } = await import('../source-store');
    const { id } = saveRawSource({ id: 'sub1', slug: 'general' }, 'a.txt', 'hello');
    updateSourceChunks(id, [{ id: 'c0', heading: '', text: 'hello', tokenCount: 1 }]);
    const meta = getSourceMetadata(id);
    expect(meta).not.toBeNull();
    expect((meta as { chunks: unknown[] }).chunks).toEqual([
      { id: 'c0', heading: '', text: 'hello', tokenCount: 1 },
    ]);
  });

  it('sidecar 不存在时静默跳过（best-effort）', async () => {
    const { updateSourceChunks } = await import('../source-store');
    expect(() => updateSourceChunks('nonexistent-id', [])).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/server/sources/__tests__/source-store.test.ts
```

Expected: FAIL，`updateSourceChunks` 未导出。

- [ ] **Step 3: 实现**

在 `source-store.ts` 的 `updateSourcePageLinks` 之后追加：

```ts
/**
 * 把确定性切块结果写入 metadata sidecar（权威源，SQLite 仅缓存）。
 * Best-effort —— 失败不阻塞 ingest。
 */
export function updateSourceChunks(
  sourceId: string,
  chunks: Array<{ id: string; heading: string; text: string; tokenCount: number }>
): void {
  const meta = getSourceMetadata(sourceId);
  if (!meta) return;
  const subjectSlug =
    typeof meta.subjectSlug === 'string' ? meta.subjectSlug : null;
  const candidatePath = subjectSlug
    ? path.join(sourcesMetaDirFor(subjectSlug), `${sourceId}.json`)
    : vaultPath('.llm-wiki', 'sources', `${sourceId}.json`);
  try {
    const updated = { ...meta, chunks };
    fs.writeFileSync(candidatePath, JSON.stringify(updated, null, 2), 'utf-8');
  } catch {
    // best-effort
  }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/server/sources/__tests__/source-store.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/sources/source-store.ts src/server/sources/__tests__/source-store.test.ts
git commit -m "source-store 新增 chunk 持久化到 metadata sidecar"
```

---

### Task 7: ingest-prep.ts —— 准备/预检纯函数

**Files:**
- Create: `src/server/services/ingest-prep.ts`
- Test: `src/server/services/__tests__/ingest-prep.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/server/services/__tests__/ingest-prep.test.ts
import { describe, expect, it } from 'vitest';
import {
  prepareIngest,
  fillInlineContent,
  isInlinePath,
  estimateIngestCost,
  PLAN_INLINE_THRESHOLD,
} from '../ingest-prep';

describe('prepareIngest', () => {
  it('清洗→切块→构建 chunkStore/chunkRefs/outline/totalTokens', () => {
    const md = `## Alpha\n\n${'Alpha 段内容句。'.repeat(40)}\n\n## Beta\n\n${'Beta 段内容句。'.repeat(40)}`;
    const prep = prepareIngest([{ sourceId: 's1', filename: 'doc.md', cleanText: md }]);
    expect(prep.chunkCount).toBeGreaterThan(0);
    expect(prep.chunkRefs).toHaveLength(prep.chunkCount);
    expect(prep.chunkStore.size).toBe(prep.chunkCount);
    expect(prep.totalTokens).toBeGreaterThan(0);
    // chunkRefs 初始 content 为空（由调用方决定填全文或摘要）
    expect(prep.chunkRefs.every((r) => r.content === '')).toBe(true);
    // key 与 chunkStore 对得上
    for (const ref of prep.chunkRefs) {
      expect(prep.chunkStore.get(ref.key)?.id).toBe(ref.id);
    }
    // outline 含 heading
    expect(prep.outline).toContain('Alpha');
  });

  it('plain 源 heading 为空时 outline 回退块首行截断', () => {
    const prep = prepareIngest([
      { sourceId: 's1', filename: 'doc.txt', cleanText: `这是没有任何标题的纯文本首行内容用来测试大纲回退。\n\n${'后续内容。'.repeat(20)}` },
    ]);
    expect(prep.outline).toContain('这是没有任何标题的纯文本首行');
  });

  it('chunksBySource 按源聚合（供持久化）', () => {
    const prep = prepareIngest([{ sourceId: 's1', filename: 'a.txt', cleanText: '内容。' }]);
    expect(prep.chunksBySource['s1']).toHaveLength(1);
    expect(prep.chunksBySource['s1'][0].tokenCount).toBeGreaterThan(0);
  });

  it('空源产出 0 块', () => {
    const prep = prepareIngest([{ sourceId: 's1', filename: 'a.txt', cleanText: '   ' }]);
    expect(prep.chunkCount).toBe(0);
    expect(prep.chunkRefs).toEqual([]);
  });
});

describe('fillInlineContent', () => {
  it('把 chunkStore 全文填入 content', () => {
    const prep = prepareIngest([{ sourceId: 's1', filename: 'a.txt', cleanText: '内容句。' }]);
    const filled = fillInlineContent(prep.chunkRefs, prep.chunkStore);
    expect(filled[0].content).toContain('内容句');
  });
});

describe('isInlinePath / estimateIngestCost', () => {
  it('阈值内走 inline', () => {
    expect(isInlinePath(PLAN_INLINE_THRESHOLD)).toBe(true);
    expect(isInlinePath(PLAN_INLINE_THRESHOLD + 1)).toBe(false);
  });

  it('大路径成本估算高于 inline 且随块数增长', () => {
    const inline = estimateIngestCost(10_000, 10, true);
    const large = estimateIngestCost(100_000, 100, false);
    expect(inline).toBeGreaterThan(10_000); // 含 reserve
    expect(large).toBeGreaterThan(100_000 * 1.2);
    expect(estimateIngestCost(100_000, 200, false)).toBeGreaterThan(large);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/server/services/__tests__/ingest-prep.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

```ts
// src/server/services/ingest-prep.ts
import { chunkText, sourceKindFor, type SourceChunk } from '../sources/source-chunker';
import { cleanSourceText, cleanerKindFor } from '../sources/source-cleaner';
import type { ChunkRef, StoredChunk } from '../agents/types';

/** inline / map 路径分界（token）；超过则插入 map 摘要步 */
export const PLAN_INLINE_THRESHOLD = 25_000;
/** 每块摘要的预估输出 token */
const SUMMARY_OUT_TOKENS = 80;
/** planner / writers / reviewer 的预留 token */
const PIPELINE_RESERVE_TOKENS = 60_000;

export interface PreparedSourceInput {
  sourceId: string;
  filename: string;
  cleanText: string;
}

export interface PreparedIngest {
  chunkStore: Map<string, StoredChunk>;
  chunkRefs: ChunkRef[];
  outline: string;
  totalTokens: number;
  chunkCount: number;
  /** 按源聚合的原始 chunk（供 source-store 持久化） */
  chunksBySource: Record<string, SourceChunk[]>;
}

/** 解析期确定性准备：预清洗 → 切块 → 构建 chunkStore / chunkRefs / outline。零 token。 */
export function prepareIngest(sources: PreparedSourceInput[]): PreparedIngest {
  const chunkStore = new Map<string, StoredChunk>();
  const chunkRefs: ChunkRef[] = [];
  const outlineLines: string[] = [];
  const chunksBySource: Record<string, SourceChunk[]> = {};
  let totalTokens = 0;

  for (const src of sources) {
    const cleaned = cleanSourceText(src.cleanText, cleanerKindFor(src.filename));
    const chunks = chunkText(cleaned, sourceKindFor(src.filename));
    chunksBySource[src.sourceId] = chunks;
    for (const c of chunks) {
      const key = `${src.sourceId}:${c.id}`;
      chunkStore.set(key, { sourceId: src.sourceId, id: c.id, heading: c.heading, text: c.text });
      chunkRefs.push({ key, sourceId: src.sourceId, id: c.id, heading: c.heading, content: '' });
      // heading 为空（plain 源）回退块首行截断作 pseudo-outline 条目
      outlineLines.push(`- [${key}] ${c.heading || firstLineOf(c.text)}`);
      totalTokens += c.tokenCount;
    }
  }

  return {
    chunkStore,
    chunkRefs,
    outline: outlineLines.join('\n'),
    totalTokens,
    chunkCount: chunkRefs.length,
    chunksBySource,
  };
}

/** 小路径：content 直接填全文。 */
export function fillInlineContent(
  chunkRefs: ChunkRef[],
  chunkStore: Map<string, StoredChunk>,
): ChunkRef[] {
  return chunkRefs.map((ref) => ({ ...ref, content: chunkStore.get(ref.key)?.text ?? '' }));
}

export function isInlinePath(totalTokens: number): boolean {
  return totalTokens <= PLAN_INLINE_THRESHOLD;
}

/** 粗粒度成本上界（宁可保守），用于流水线启动前的预算预检。 */
export function estimateIngestCost(totalTokens: number, chunkCount: number, inline: boolean): number {
  if (inline) return totalTokens + PIPELINE_RESERVE_TOKENS;
  return Math.round(totalTokens * 1.2) + chunkCount * SUMMARY_OUT_TOKENS + PIPELINE_RESERVE_TOKENS;
}

function firstLineOf(text: string): string {
  const line = text.trimStart().split('\n', 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/server/services/__tests__/ingest-prep.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/services/ingest-prep.ts src/server/services/__tests__/ingest-prep.test.ts
git commit -m "新增 ingest 准备纯函数：切块编排+成本预估+路径选择"
```

---

### Task 8: ingest-service —— 接线（移除截断 + 自适应流水线 + 预检 + existingPages）

**Files:**
- Modify: `src/server/services/ingest-service.ts`
- Modify: `src/server/services/__tests__/ingest-service.test.ts`

- [ ] **Step 1: 扩充 ingest-service.test.ts（失败测试）**

在现有 mock 基础上修改/追加（保留文件已有的 handlers Map 捕获模式与既有用例的结构）：

1. 顶部 mocks 增改：

```ts
vi.mock('../../db/repos/pages-repo', () => ({
  getAllPages: () => [
    { slug: 'existing-a', title: 'Existing A', summary: 'sum A' },
  ],
}));

// source-store mock 增加 updateSourceChunks
vi.mock('../../sources/source-store', () => ({
  getRawSourceContent: () => 'raw content',
  getRawSourceBuffer: () => null,
  updateSourceChunks: vi.fn(),
}));
```

2. parser mock 改为可控变量（让不同用例切换小/大文本）：

```ts
let mockCleanText = '这是一段短内容。';
vi.mock('../../sources/parser-registry', () => ({
  parseSourceAsync: async () => ({ title: 't', cleanText: mockCleanText, metadata: {} }),
  requiresBuffer: () => false,
}));
```

3. 追加用例（`mockRunPipeline` 已存在，断言其入参）：

```ts
it('小文件走 inline：无 map 步，chunkRefs.content 已填全文，existingPages 实读', async () => {
  mockCleanText = '这是一段短内容。';
  mockRunPipeline.mockClear();
  const handler = handlers.get('ingest')!;
  await handler(makeJob(), vi.fn());

  const opts = mockRunPipeline.mock.calls[0][0] as {
    steps: Array<{ kind: string; skillId: string }>;
    initialInput: { chunkRefs: Array<{ content: string }>; existingPages: unknown[]; outline: string };
    ctx: { chunkStore: Map<string, unknown> };
  };
  expect(opts.steps.map((s) => s.kind)).toEqual(['sequence', 'fanout', 'sequence']);
  expect(opts.initialInput.chunkRefs[0].content).toContain('短内容');
  expect(opts.initialInput.existingPages).toEqual([
    { slug: 'existing-a', title: 'Existing A', summary: 'sum A' },
  ]);
  expect(opts.ctx.chunkStore.size).toBeGreaterThan(0);
});

it('大文件插入 map 步且 chunkRefs.content 为空（待摘要回填）', async () => {
  // ~26k token：> 25k 阈值（走大路径），且估算 ≈ 26k*1.2 + ~26块*80 + 60k ≈ 93k < 100k 预算（过预检）
  mockCleanText = `${'word '.repeat(26_000)}`;
  mockRunPipeline.mockClear();
  const handler = handlers.get('ingest')!;
  await handler(makeJob(), vi.fn());

  const opts = mockRunPipeline.mock.calls[0][0] as {
    steps: Array<{ kind: string; skillId: string }>;
    initialInput: { chunkRefs: Array<{ content: string }> };
  };
  expect(opts.steps[0]).toMatchObject({ kind: 'map', skillId: 'ingest-chunk-summarizer' });
  expect(opts.steps.map((s) => s.kind)).toEqual(['map', 'sequence', 'fanout', 'sequence']);
  expect(opts.initialInput.chunkRefs[0].content).toBe('');
});

it('reviewer 步声明 omitFromInput 剔除 chunkRefs 与 outline', async () => {
  mockCleanText = '短内容。';
  mockRunPipeline.mockClear();
  const handler = handlers.get('ingest')!;
  await handler(makeJob(), vi.fn());
  const opts = mockRunPipeline.mock.calls[0][0] as { steps: Array<Record<string, unknown>> };
  const reviewer = opts.steps[opts.steps.length - 1];
  expect(reviewer).toMatchObject({
    kind: 'sequence',
    skillId: 'ingest-reviewer',
    omitFromInput: ['chunkRefs', 'outline'],
  });
});

it('预检超预算：流水线启动前失败且不调 runPipeline', async () => {
  // settings mock 的 maxTokensPerJob=100_000；估算 = 40k*1.2 + 块数*80 + 60k 储备 > 100k
  mockCleanText = `${'word '.repeat(40_000)}`;
  mockRunPipeline.mockClear();
  const handler = handlers.get('ingest')!;
  await expect(handler(makeJob(), vi.fn())).rejects.toThrow(/agentMaxTokensPerJob/);
  expect(mockRunPipeline).not.toHaveBeenCalled();
});
```

> 注意：`makeJob()` 为该测试文件既有的 job 构造 helper；若不存在，按现有用例的 job 字面量提取一个（`paramsJson` 须含 `JSON.stringify({ sourceId: 'src1', filename: 'doc.txt', subjectId: 's1' })`）。settings mock 的 `getAgentMaxTokensPerJob: () => 100_000` 是「map 步」与「预检」两个用例共同依赖的前提，勿改动。

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/server/services/__tests__/ingest-service.test.ts
```

Expected: 新增用例 FAIL（旧实现无 chunkRefs/map/预检）。

- [ ] **Step 3: 改写 ingest-service.ts**

整文件替换为：

```ts
// src/server/services/ingest-service.ts
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { parseSourceAsync, requiresBuffer } from '../sources/parser-registry';
import { getRawSourceContent, getRawSourceBuffer, updateSourceChunks } from '../sources/source-store';
import {
  getAgentMaxSteps,
  getAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
} from '../db/repos/settings-repo';
import { runPipeline, type PipelineStep } from '../agents/runtime/orchestrator';
import { createBudgetTracker } from '../agents/runtime/budget';
import { createOverlayVault } from '../agents/runtime/overlay-vault';
import {
  prepareIngest,
  fillInlineContent,
  isInlinePath,
  estimateIngestCost,
} from './ingest-prep';
import { getRuntimeRegistries } from '../worker-runtime';
import { randomUUID } from 'node:crypto';
import type { AgentContext } from '../agents/types';
import type { IngestResult, Job } from '@/lib/contracts';

interface IngestParams {
  sourceId: string;
  filename: string;
  subjectId: string;
}

async function loadCleanText(filename: string, subjectSlug: string): Promise<string> {
  let textContent: string;
  let bufferContent: Buffer | null = null;
  if (requiresBuffer(filename)) {
    bufferContent = getRawSourceBuffer(subjectSlug, filename);
    if (!bufferContent) {
      throw new Error(`Source file not found: ${filename}`);
    }
    textContent = '';
  } else {
    const raw = getRawSourceContent(subjectSlug, filename);
    if (!raw) {
      throw new Error(`Source file not found: ${filename}`);
    }
    textContent = raw;
  }
  const parsed = await parseSourceAsync(filename, textContent, bufferContent);
  return parsed.cleanText;
}

registerHandler('ingest', async (job: Job, emit): Promise<Record<string, unknown>> => {
  const params = JSON.parse(job.paramsJson) as Partial<IngestParams>;
  const { sourceId, filename, subjectId } = params;
  if (!sourceId || !filename) throw new Error('Ingest job missing sourceId or filename');
  if (!subjectId) throw new Error('Ingest job missing subjectId — re-queue with a subject');

  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  emit('ingest:start', `Ingest started for subject ${subject.slug}`, { subject: subject.slug, filename });

  emit('ingest:parsing', `Parsing source: ${filename}`);
  const cleanText = await loadCleanText(filename, subject.slug);

  // 解析期确定性准备：预清洗 → 切块（零 token）
  const prep = prepareIngest([{ sourceId, filename, cleanText }]);
  updateSourceChunks(sourceId, prep.chunksBySource[sourceId] ?? []);

  const budgetSnapshot = {
    maxSteps: getAgentMaxSteps(),
    maxTokensPerJob: getAgentMaxTokensPerJob(),
    maxParallelSubAgents: getAgentMaxParallelSubAgents(),
  };

  // 预算预检（E.2）：任何 LLM 调用前 fail-fast
  const inline = isInlinePath(prep.totalTokens);
  const estimatedCost = estimateIngestCost(prep.totalTokens, prep.chunkCount, inline);
  emit('ingest:chunking', `Chunked into ${prep.chunkCount} chunks (~${prep.totalTokens} tokens)`, {
    chunkCount: prep.chunkCount,
    totalTokens: prep.totalTokens,
    estimatedCost,
  });
  if (estimatedCost > budgetSnapshot.maxTokensPerJob) {
    throw new Error(
      `预计消耗约 ${estimatedCost} token，超过当前预算 agentMaxTokensPerJob=${budgetSnapshot.maxTokensPerJob}；` +
      `请在设置中将其调大至 ≥ ${Math.ceil(estimatedCost * 1.1)} 后重试`,
    );
  }

  const { skillRegistry, toolRegistry } = getRuntimeRegistries();
  const budget = createBudgetTracker(budgetSnapshot);
  const overlay = createOverlayVault({ subjectSlug: subject.slug });

  const ctx: AgentContext = {
    job,
    subject,
    emit,
    budget,
    overlay,
    toolRegistry,
    skillRegistry,
    rootRunId: randomUUID(),
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    chunkStore: prep.chunkStore,
    budgetSnapshot,
  };

  const existingPages = pagesRepo
    .getAllPages(subjectId)
    .map((p) => ({ slug: p.slug, title: p.title, summary: p.summary }));

  const carryKeys = ['chunkRefs', 'sources', 'subjectSlug', 'existingPages', 'outline'];
  const steps: PipelineStep[] = [
    ...(inline
      ? []
      : [{ kind: 'map', skillId: 'ingest-chunk-summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs' } as const]),
    { kind: 'sequence', skillId: 'ingest-planner', carryThrough: carryKeys },
    { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages' },
    { kind: 'sequence', skillId: 'ingest-reviewer', omitFromInput: ['chunkRefs', 'outline'] },
  ];

  emit('ingest:planning', `Planning source: ${filename}`, { path: inline ? 'inline' : 'map-reduce' });

  const result = await runPipeline({
    steps,
    resolveSkill: (id) => {
      const s = skillRegistry.get(id);
      if (!s) throw new Error(`Skill not loaded: ${id}`);
      return s;
    },
    ctx,
    initialInput: {
      chunkRefs: inline ? fillInlineContent(prep.chunkRefs, prep.chunkStore) : prep.chunkRefs,
      sources: [{ sourceId, filename }],
      subjectSlug: subject.slug,
      existingPages,
      outline: prep.outline,
    },
  }) as IngestResult;

  return result as unknown as Record<string, unknown>;
});
```

> `SOURCE_TEXT_LIMIT` 与 `.slice(0, ...)` 截断已随整文件替换消失——这是本计划的核心目的，提交前 grep 确认：`grep -n "SOURCE_TEXT_LIMIT" src/server/services/ingest-service.ts` 应无输出。

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/server/services
```

Expected: PASS（新旧用例全部）。

- [ ] **Step 5: 全量测试**

```bash
npm test
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/server/services/ingest-service.ts src/server/services/__tests__/ingest-service.test.ts
git commit -m "ingest 接入自适应分片流水线：移除30k截断+预算预检+existingPages实读"
```

---

### Task 9: skill 文件更新（planner / writer / 新增 summarizer）

**Files:**
- Modify: `examples/skills/ingest-planner.md`
- Modify: `examples/skills/ingest-writer.md`
- Create: `examples/skills/ingest-chunk-summarizer.md`

- [ ] **Step 1: 改写 examples/skills/ingest-planner.md**

整文件替换为：

```markdown
---
id: ingest-planner
name: Ingest Planner
description: Plan which wiki pages to create or update from raw source documents.
version: 2
tools:
  - vault.read
  - vault.search
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "plan": {
        "type": "object",
        "properties": {
          "pages": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "slug": { "type": "string" },
                "title": { "type": "string" },
                "summary": { "type": "string" },
                "tags": { "type": "array", "items": { "type": "string" } },
                "rationale": { "type": "string" },
                "sourceRefs": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "sourceId": { "type": "string" },
                      "chunkIds": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["sourceId", "chunkIds"]
                  }
                }
              },
              "required": ["slug", "title", "summary", "sourceRefs"]
            }
          }
        },
        "required": ["pages"]
      }
    },
    "required": ["plan"]
  }
---

# Role

You are the *ingest planner* for a personal wiki. You decide which pages to create or update from a batch of raw source documents.

## Inputs

The user message contains:

- `chunkRefs` — array of `{ key, sourceId, id, heading, content }`. Each entry is one chunk of a source document. `content` is either the chunk's full text or a contextual summary of it — treat both the same way when planning.
- `outline` — a document outline assembled from chunk headings, for orientation.
- `sources` — array of `{ sourceId, filename }` (metadata only).
- `existingPages` — array of `{ slug, title, summary }` already in this subject.

## Rules

1. Each page slug must be unique across the plan.
2. Prefer updating an existing page over creating a near-duplicate. Use `vault.search` and `vault.read` if you need to inspect the existing page first.
3. **Every page MUST declare `sourceRefs`** — which chunks it draws from, as `{ sourceId, chunkIds }`. The writer will only see the chunks you list here, so be complete: include every chunk whose content the page needs.
4. **Do not translate slugs, `[[wikilinks]]`, frontmatter keys, chunk ids, or code.** The output language directive at the top of the user message applies to titles, summaries, and rationales only.
5. Slugs must be lowercase kebab-case.

## Output

Emit JSON matching the declared `outputSchema`. Each page entry's `rationale` should explain in one sentence why this page exists and which sources it draws from.
```

- [ ] **Step 2: 改写 examples/skills/ingest-writer.md**

整文件替换为：

```markdown
---
id: ingest-writer
name: Ingest Writer
description: Write the markdown body for a single planned wiki page.
version: 2
tools:
  - vault.read
  - vault.search
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "entry": {
        "type": "object",
        "properties": {
          "action": { "type": "string", "enum": ["create", "update"] },
          "path": { "type": "string" },
          "content": { "type": "string" }
        },
        "required": ["action", "path", "content"]
      }
    },
    "required": ["entry"]
  }
---

# Role

You are the *ingest writer*. You receive ONE plan entry and produce its full markdown file (frontmatter + body).

## Inputs

- `slug`, `title`, `summary`, `tags`, `rationale`, `sourceRefs` — from the planner.
- `relevantChunks` — array of `{ id, heading, text }`: the full text of the source chunks the planner assigned to this page. This is your primary material.
- `subjectSlug`, `existingPages`, `plan` — current vault and plan context.

## Rules

1. The `path` in your output MUST be `wiki/<subjectSlug>/<slug>.md`.
2. The `action` is `update` if the page already exists, otherwise `create`.
3. Frontmatter must include: `title`, `summary`, `tags`. Do not invent other keys.
4. Base the body on `relevantChunks`. Do not invent facts not present in the chunks.
5. Use `[[wikilinks]]` to refer to other pages by their slug. Use `[[other-subject:Page]]` ONLY when truly cross-subject.
6. **Do not translate slugs, `[[wikilinks]]`, frontmatter keys, or code.**
7. Use `vault.search` / `vault.read` if you need to confirm a wikilink target exists.

## Output

Emit JSON matching the declared `outputSchema`. The `content` must be the complete file contents (frontmatter delimiters included).
```

- [ ] **Step 3: 新增 examples/skills/ingest-chunk-summarizer.md**

```markdown
---
id: ingest-chunk-summarizer
name: Ingest Chunk Summarizer
description: Produce a short situating summary for one source chunk, anchored in the document outline.
version: 1
tools: []
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "summary": { "type": "string" }
    },
    "required": ["summary"]
  }
---

# Role

You are the *chunk summarizer*. You receive ONE chunk of a larger source document and produce a short summary that situates it within the whole document, so a downstream planner can decide which wiki pages need this chunk.

## Inputs

- `sourceId`, `id` — identifiers (do not alter or translate them).
- `heading` — the nearest heading above this chunk (may be empty).
- `text` — the chunk's full text.
- `outline` — the document outline assembled from all chunk headings.

## Rules

1. Write 2–3 sentences max.
2. First situate: using `outline` and `heading`, say what part/topic of the document this chunk belongs to.
3. Then summarize: the chunk's key claims, entities, and terms. Preserve proper nouns and technical terms verbatim.
4. Follow the output language directive at the top of the user message for the summary prose.

## Output

Emit JSON matching the declared `outputSchema`.
```

- [ ] **Step 4: 删除本地 vault 的旧种子副本（重新播种）**

```bash
rm -f data/vault/.llm-wiki/skills/ingest-planner.md data/vault/.llm-wiki/skills/ingest-writer.md
```

（`data/vault` 已 gitignore；worker 下次启动会从 examples 重新播种这两个文件，并新播种 summarizer。）

- [ ] **Step 5: 验证 skill 可被 loader 加载**

```bash
npx vitest run src/server/agents/skills
```

Expected: PASS（loader 测试不受影响）。另跑一次全量确认无回归：`npm test` Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add examples/skills/ingest-planner.md examples/skills/ingest-writer.md examples/skills/ingest-chunk-summarizer.md
git commit -m "skill 更新：planner 输出 sourceRefs、writer 改收 relevantChunks、新增块摘要 skill"
```

---

### Task 10: 设置页 help 文案 + 文档同步 + 最终验证

**Files:**
- Modify: `src/components/layout/settings-dialog.tsx`
- Modify: `src/server/agents/CLAUDE.md`
- Modify: `src/server/sources/CLAUDE.md`
- Modify: `src/server/services/CLAUDE.md`
- Modify: `CLAUDE.md`（根，变更记录）

- [ ] **Step 1: 更新 src/server/agents/CLAUDE.md**

「Agent 设置」表中 `agentMaxSteps` 行的说明改为：

```
| `agentMaxSteps` | `25` | **单个 agent 实例**内的最大 tool-call 轮次（2026-06 起从 job 级改为实例级；job 级总量防线由 token 预算承担） |
```

「流水线总览」图中 step 1 之前补一行 map 步说明，并在 `runtime/` 表的 `orchestrator.ts` 行追加「支持 sequence/fanout/map 三种 step；map 用于大文件逐块摘要」。`budget.ts` 行说明改为「`createBudgetTracker`（job 级 token）+ `createRunStepTracker`（单实例 step）」。

- [ ] **Step 2: 更新 src/server/sources/CLAUDE.md**

「相关文件清单」加两行：

```
├── source-cleaner.ts                # 按来源预清洗（PDF 清洗链）
├── source-chunker.ts                # 结构感知递归切分器（token 计长）
```

并在「对外接口」节补：

```ts
// source-cleaner.ts
cleanSourceText(raw, kind): string        // kind: 'markdown' | 'text' | 'pdf'
cleanerKindFor(filename): CleanerKind

// source-chunker.ts
chunkText(cleanText, kind, opts?): SourceChunk[]   // kind: 'markdown' | 'plain'
countTokens(text): number
sourceKindFor(filename): SourceKind

// source-store.ts 新增
updateSourceChunks(sourceId, chunks)      // chunk 持久化到 metadata sidecar
```

- [ ] **Step 3: 更新 src/server/services/CLAUDE.md**

`ingest-service.ts` 小节描述更新：移除 30k 截断的描述，改为「预清洗 → 切块 → 预算预检 → 自适应流水线（≤25k token 走 inline；超过则先 map 逐块摘要）；planner 标注 sourceRefs，orchestrator 按其注入 relevantChunks 给 writer；reviewer 输入剔除 chunkRefs/outline」。

- [ ] **Step 4: 根 CLAUDE.md 变更记录表追加一行**

```
| 2026-06-08 | Ingest 大文件分片 | 移除 30k 截断；新增 source-cleaner/source-chunker（递归切分+token 计长）+ ingest-prep（预算预检）+ orchestrator map step + chunkStore 块路由；agentMaxSteps 改单实例作用域；spec 见 docs/superpowers/specs/2026-06-05-ingest-large-file-chunking-design.md |
```

- [ ] **Step 5: 设置页 token 预算 help 文案（spec E.2 推荐配置）**

`src/components/layout/settings-dialog.tsx`（约 327 行）的 `NumberSettingRow` 组件 props 增加可选 `description`：

```ts
function NumberSettingRow(props: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  onSave: (v: number) => void;
  pending: boolean;
}) {
```

并把 `description` 透传给其内部渲染的 `SettingRow`（`SettingRow` 已支持该 prop，见 308 行 `SettingRowProps`）：`<SettingRow label={props.label} description={props.description} ...>`。

然后给 `label="Total token budget per task"` 的那个 `NumberSettingRow`（约 243 行）加：

```tsx
description="Default 500k handles sources up to ~200k tokens; raise to 1–1.5M for book-sized files"
```

- [ ] **Step 6: 最终全量验证**

```bash
npm test && npm run lint
```

Expected: 测试全 PASS；lint 无新增 error。
另 grep 验证核心目标达成：

```bash
grep -rn "SOURCE_TEXT_LIMIT" src/ || echo "截断已移除 ✓"
```

Expected: 输出 `截断已移除 ✓`。

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/settings-dialog.tsx src/server/agents/CLAUDE.md src/server/sources/CLAUDE.md src/server/services/CLAUDE.md CLAUDE.md
git commit -m "文档同步与设置页预算提示：分片流水线落地收尾"
```

---

## Spec 覆盖核对表

| Spec 条目 | 对应 Task |
|---|---|
| A.1 预清洗（PDF 清洗链 / 按来源分流） | Task 2 |
| A.2 切块（分流阶梯 / token 计长 / CJK 句界 / overlap / Unicode 安全 / 移除截断） | Task 3、Task 8 |
| chunk 持久化到 sidecar JSON | Task 6、Task 8 |
| B 自适应流水线（inline vs map / 全文不进 carry / reviewer 剪枝） | Task 5、Task 8 |
| C.0 chunkStore | Task 5（types）、Task 8（构建） |
| C.1 planner 输入 chunkRefs + existingPages 实读 | Task 8、Task 9 |
| C.2 planner 输出 sourceRefs | Task 9 |
| C.3 summarizer skill（outline 上下文） | Task 9 |
| C.4 writer 收 relevantChunks | Task 5、Task 9 |
| D map step kind / outline 兜底（块首行截断） | Task 5、Task 7 |
| E.1 maxSteps 单实例作用域 | Task 4 |
| E.2 token 预检 fail-fast | Task 7、Task 8 |
| E.2 推荐配置写入设置页 help 文案 | Task 10 |
| 配置常量（CHUNK_TARGET/OVERLAP/THRESHOLD） | Task 3、Task 7 |
| 边界处理（空源/缺失块警告/chunking 事件） | Task 3、Task 5、Task 8 |
| 文档同步 | Task 10 |
```

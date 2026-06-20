# 正文 KaTeX 公式渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 wiki 正文 markdown 支持 LaTeX 数学公式渲染（行内 `$…$` / 块级 `$$…$$`），聊天与 `/ask` 回答保持纯文本。

**Architecture:** 在共享的同步客户端渲染函数 `renderMarkdown()` 上加一个 `options.math` 开关；开启时在 `remark-math`（mdast 阶段，先于 wikilink 扫描）+ `rehype-katex`（hast 阶段）两处插入插件。只有 wiki 正文 (`page-renderer.tsx`) 传 `{ math: true }`。

**Tech Stack:** unified 11 / remark / rehype、`remark-math@^6`、`rehype-katex@^7`、`katex@^0.16`、vitest（node 环境）+ `react-dom/server`。

## Global Constraints

- **同步管线**：所有插件必须同步，沿用现有 `processSync`，**禁止引入异步插件**（这是 `rehype-pretty-code` 被弃用的原因）。
- **`rehype-katex` 选项固定 `{ throwOnError: false }`**（必须）：否则非法 LaTeX 会让 `processSync` 抛错、整页渲染崩溃。
- **保持 KaTeX 默认 `trust: false`**（禁止开启）：正文是 LLM 生成内容，防 HTML 注入。
- **公式仅在 `options.math === true` 时启用**；`message-list.tsx` / `command-palette.tsx` 不传该参数 → 保持纯文本。
- **依赖版本**：`katex@^0.16`、`remark-math@^6`、`rehype-katex@^7`（匹配 unified 11 的 micromark 体系）。
- **commit message 用中文**，一句话总结，**禁止 AI 署名**（无 Co-Authored-By / Generated with）。
- **路径别名** `@/*` → `src/*`。

---

### Task 1: `renderMarkdown` 加 `math` 选项 + 单测

**Files:**
- Modify: `src/lib/markdown-client.ts`
- Test: `src/lib/__tests__/markdown-client.test.ts`（Create）
- Modify: `package.json` / `package-lock.json`（新增依赖）

**Interfaces:**
- Produces: `renderMarkdown(content: string, titleSlugMap?: Record<string, string>, options?: { math?: boolean }): React.ReactElement` —— 第三参数 `options.math` 默认 `false`；为 `true` 时启用公式渲染。Task 2 依赖此签名。

- [ ] **Step 1: 安装依赖**

```bash
npm install katex@^0.16 remark-math@^6 rehype-katex@^7
```

- [ ] **Step 2: 写失败测试**

Create `src/lib/__tests__/markdown-client.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// markdown-client 顶层 import 了 WikiLink（它又依赖 next/link、ui-store 等
// 浏览器/路由上下文）。这里把它替换成纯 <a>，让"公式+wikilink 共存"用例能在
// node 环境下渲染，并彻底避开真实组件的浏览器依赖链。
vi.mock('@/components/wiki/wiki-link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href?: string; children?: unknown }) =>
      React.createElement('a', { href }, children as React.ReactNode),
  };
});

import { renderMarkdown } from '../markdown-client';

const toHtml = (el: ReactElement) => renderToStaticMarkup(el);

describe('renderMarkdown — KaTeX 公式渲染', () => {
  it('math:true 时行内 $…$ 渲染为 KaTeX', () => {
    const html = toHtml(renderMarkdown('$E=mc^2$', undefined, { math: true }));
    expect(html).toContain('katex');
  });

  it('math:true 时块级 $$…$$ 渲染为 katex-display', () => {
    const html = toHtml(renderMarkdown('$$E=mc^2$$', undefined, { math: true }));
    expect(html).toContain('katex-display');
  });

  it('默认（math 关闭）时 $…$ 原样保留为文本，不出现 katex', () => {
    const html = toHtml(renderMarkdown('$E=mc^2$'));
    expect(html).toContain('$E=mc^2$');
    expect(html).not.toContain('katex');
  });

  it('math:true 时非法 LaTeX 不抛错（throwOnError:false 安全保证）', () => {
    expect(() =>
      toHtml(renderMarkdown('$\\frac{$', undefined, { math: true })),
    ).not.toThrow();
  });

  it('公式与 wikilink 共存：两者都正确渲染（验证插件顺序无冲突）', () => {
    const html = toHtml(
      renderMarkdown('[[Page]] 与 $x^2$', undefined, { math: true }),
    );
    expect(html).toContain('katex');
    expect(html).toContain('Page');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/lib/__tests__/markdown-client.test.ts`
Expected: 第 1/2/5 条 FAIL（输出不含 `katex`，因为当前 `renderMarkdown` 只有两个参数、忽略第三参数）；第 3/4 条 PASS（默认本就是纯文本、也不会抛错）。

- [ ] **Step 4: 实现——加 imports**

在 `src/lib/markdown-client.ts` 顶部 import 区，把：

```ts
import remarkRehype from 'remark-rehype';
import rehypeReact from 'rehype-react';
```

改为：

```ts
import remarkRehype from 'remark-rehype';
import remarkMath from 'remark-math';
import rehypeReact from 'rehype-react';
import rehypeKatex from 'rehype-katex';
```

- [ ] **Step 5: 实现——改签名 + 加 `enableMath`**

把函数签名与 resolver 起始处：

```ts
export function renderMarkdown(
  content: string,
  titleSlugMap?: Record<string, string>,
): React.ReactElement {
  const resolver: SlugResolver | undefined = titleSlugMap
    ? (title: string) => titleSlugMap[title] ?? titleSlugMap[title.toLowerCase()]
    : undefined;
```

改为：

```ts
export function renderMarkdown(
  content: string,
  titleSlugMap?: Record<string, string>,
  options?: { math?: boolean },
): React.ReactElement {
  const enableMath = options?.math ?? false;
  const resolver: SlugResolver | undefined = titleSlugMap
    ? (title: string) => titleSlugMap[title] ?? titleSlugMap[title.toLowerCase()]
    : undefined;
```

- [ ] **Step 6: 实现——分阶段构建管线（条件插入公式插件）**

把现有的 fluent 链开头：

```ts
  const file = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(createRemarkWikiLinks(resolver))
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeReact, {
```

改为（注意：`.use(rehypeReact, {` 之后的 `Fragment / jsx / jsxs / components / .processSync(content)` 全部**保持不变**）：

```ts
  // mdast 阶段：remark-math（可选）必须先于 wikilink 扫描，
  // 这样 $…$ 先被切成 math 节点，wikilink 扫描器（只处理 [[…]] 文本）碰不到公式内部。
  let remark = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']);
  if (enableMath) remark = remark.use(remarkMath);
  remark = remark.use(createRemarkWikiLinks(resolver));

  // 桥接到 hast 后进入 rehype 阶段：rehype-katex（可选）渲染 math 节点；
  // throwOnError:false 保证非法 LaTeX 不会让同步 processSync 抛错、整页崩溃。
  let rehype = remark.use(remarkRehype, { allowDangerousHtml: false });
  if (enableMath) rehype = rehype.use(rehypeKatex, { throwOnError: false });

  const file = rehype
    .use(rehypeReact, {
```

> 说明：`remark-math` 与 `createRemarkWikiLinks` 都是 mdast→mdast（树类型不变），`rehype-katex` 是 hast→hast，因此 `let remark` / `let rehype` 的重新赋值都保持各自阶段的处理器类型，TS 类型可正确流转。

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run src/lib/__tests__/markdown-client.test.ts`
Expected: 5 条全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add src/lib/markdown-client.ts src/lib/__tests__/markdown-client.test.ts package.json package-lock.json
git commit -m "feat: 正文渲染管线支持 KaTeX 公式（renderMarkdown 加 math 选项 + 单测）"
```

---

### Task 2: 接线 wiki 正文 + KaTeX 样式 + 宽公式横向滚动

**Files:**
- Modify: `src/components/wiki/page-renderer.tsx`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: `renderMarkdown(content, titleSlugMap, { math: true })`（Task 1 的签名）。

- [ ] **Step 1: 正文调用开启公式**

在 `src/components/wiki/page-renderer.tsx`，把：

```tsx
  const rendered = useMemo(() => renderMarkdown(content, titleSlugMap), [content, titleSlugMap]);
```

改为：

```tsx
  const rendered = useMemo(() => renderMarkdown(content, titleSlugMap, { math: true }), [content, titleSlugMap]);
```

- [ ] **Step 2: 正文加宽公式横向滚动样式**

在同文件 `proseClassName` 模板字符串里，把：

```
  [&_em]:italic
```

改为：

```
  [&_em]:italic
  [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden
```

> 块级公式 (`.katex-display`) 过宽时横向滚动而非撑破页面；`overflow-y-hidden` 防止因横向滚动条挤出的多余纵向滚动条。KaTeX 默认 `color: inherit`，自动跟随 `text-prose-body`，暗色模式无需额外处理。

- [ ] **Step 3: 全局引入 KaTeX 样式**

在 `src/app/layout.tsx`，把：

```ts
import '@uiw/react-markdown-preview/markdown.css';
```

改为：

```ts
import '@uiw/react-markdown-preview/markdown.css';
import 'katex/dist/katex.min.css';
```

- [ ] **Step 4: 类型检查 + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 均无错误（确认 `{ math: true }` 调用签名匹配、无类型回归）。

- [ ] **Step 5: 手动冒烟验证**

```bash
npm run dev:all
```

在某 wiki 页源文件里放入下列内容并打开该页（或临时新建一个含公式的页面）：

```
行内公式 $E = mc^2$ 应内联渲染。

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

一个超宽公式 $$ a_1 + a_2 + a_3 + \cdots + a_{100} + b_1 + b_2 + \cdots + b_{100} = \sum_{i=1}^{100}(a_i + b_i) $$

含 wikilink 与公式：[[Some Page]] 与 $\alpha + \beta$。
```

确认：
1. 行内/块级公式正确渲染为数学排版（非原始 `$…$` 文本）；
2. 切换暗色模式，公式颜色跟随正文、清晰可读；
3. 超宽块级公式出现**横向滚动**，页面本身不被撑出横向滚动条；
4. wikilink 仍可点击、hover 预览正常，公式同页共存无异常；
5. 打开一条**聊天消息**或 **`/ask` 回答**中含 `$…$` 的内容，确认其**仍为纯文本**（未被渲染成公式）。

- [ ] **Step 6: 提交**

```bash
git add src/components/wiki/page-renderer.tsx src/app/layout.tsx
git commit -m "feat: wiki 正文接入公式渲染 + KaTeX 样式与宽公式横向滚动"
```

---

## Self-Review

**Spec coverage（逐节核对）：**
- 第三节 管线改造（`options.math` + 条件插件 + remark-math 先于 wikilinks）→ Task 1 Step 4–6 ✓
- 第四节 只改 page-renderer 一处调用 → Task 2 Step 1 ✓
- 第五节 依赖 + layout CSS 导入 → Task 1 Step 1 / Task 2 Step 3 ✓
- 第六节 `throwOnError:false`、`trust:false` 默认、排版 overflow、主题继承 → Task 1 Step 6（katex 选项）+ Task 2 Step 2 ✓
- 第七节 非目标（不改 LLM / 不动聊天）→ 计划未触碰 ingest/query/message-list/command-palette ✓
- 第八节 测试 5 项 → Task 1 Step 2 全部覆盖（行内/块级/默认关闭/非法不抛错/wikilink 共存）✓
- 第九节 改动文件清单 5 个 → 全部出现在 Task 1/2 的 Files 中 ✓

**Placeholder scan：** 无 TBD/TODO；每个代码步骤均给出完整 old→new 代码与确切命令、预期输出。✓

**Type consistency：** `renderMarkdown` 第三参数 `options?: { math?: boolean }` 在 Task 1 定义、Task 2 以 `{ math: true }` 消费，签名一致；`enableMath`、`remark`、`rehype` 变量命名前后一致。✓

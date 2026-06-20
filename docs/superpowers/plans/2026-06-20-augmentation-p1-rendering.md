# 增益渲染层（P1）实现计划 — Callout + Mermaid

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `renderMarkdown` 支持 Obsidian 风格 `[!type]` callout（增益层的载体）与 ```mermaid 图示渲染，使后续 P2 产出的双层页面能被肉眼验收。

**Architecture:** 复用现有 `src/lib/markdown-client.ts` 的"mdast 手写遍历 + rehype-react components 映射"范式（与 `remarkWikiLinks` 同构）。callout = 把首行匹配 `[!type]` 的 blockquote 重标为 `<div data-callout=type>` 并用 Tailwind 变体着色；mermaid = 把 `lang==='mermaid'` 的 code 节点重标为自定义元素，映射到一个仅在 `useEffect` 内动态 `import('mermaid')` 的 client 组件（保证 node 测试与 SSR 不加载浏览器库）。两者**始终开启**（语法无歧义，不像 `$` 需要 `math` 开关）。

**Tech Stack:** TypeScript 5 + React 19 + unified/remark/rehype-react（已装）+ 新增 `mermaid`；vitest（`environment: 'node'`，`renderToStaticMarkup` 断言 HTML 子串）。

## Global Constraints

- TS 路径别名 `@/*` → `src/*`；强 TypeScript。
- `src/lib/markdown-client.ts` **必须保持 node 测试可加载**：任何浏览器专属库（mermaid）只能在组件 `useEffect` 内**动态 import**，不得在模块顶层求值。
- 样式走 `page-renderer.tsx` 的 `proseClassName`（Tailwind arbitrary variants）+ 既有 CSS 变量 token（`bg-subtle`/`border-*`/`text-prose-*`）；组件类名用 `cn()`（`@/lib/cn`）。
- callout / mermaid 处理**无需新增 `renderMarkdown` 参数**，始终生效；不得破坏既有 `renderMarkdown — KaTeX 公式渲染` 测试（`src/lib/__tests__/markdown-client.test.ts`）。
- 测试命令：`npx vitest run <file>`。
- git commit message 用**中文**、一句话总结、**不加任何 AI 署名/Co-Authored-By/Generated-with 脚注**。

---

### Task 1: Callout 渲染（`[!type]` blockquote → 着色容器）

**Files:**
- Modify: `src/lib/markdown-client.ts`（新增 `createRemarkCallouts` 插件并接入管线）
- Modify: `src/components/wiki/page-renderer.tsx:23-45`（`proseClassName` 增加 `.callout` 样式）
- Test: `src/lib/__tests__/markdown-client.test.ts`（新增 callout describe 块）

**Interfaces:**
- Consumes: 现有 `renderMarkdown(content, titleSlugMap?, options?)`、`isParent`、`MdastRoot/MdastNode/MdastText/MdastParent`、`Plugin` 类型（均已在 `markdown-client.ts` 内）。
- Produces: callout blockquote 在 HTML 中渲染为 `<div class="callout callout-<type>" data-callout="<type>">`，且首行 `[!type]` 标记被剥离（emoji+标题文字保留为容器首行）。

- [ ] **Step 1: 写失败测试**

在 `src/lib/__tests__/markdown-client.test.ts` 末尾追加：

```ts
describe('renderMarkdown — Callout 渲染', () => {
  it('[!type] blockquote 渲染为 data-callout 容器并剥离标记', () => {
    const md = '> [!intuition] 💡 直觉\n> 把 T 想成一次搅动。';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('data-callout="intuition"');
    expect(html).toContain('callout-intuition');
    expect(html).toContain('💡 直觉');
    expect(html).not.toContain('[!intuition]');
  });

  it('type 大小写归一化为小写', () => {
    const html = toHtml(renderMarkdown('> [!Quiz] ❓ 自测\n> 为什么？'));
    expect(html).toContain('data-callout="quiz"');
  });

  it('普通 blockquote 不被误判为 callout', () => {
    const html = toHtml(renderMarkdown('> 这是一句普通引用。'));
    expect(html).toContain('<blockquote');
    expect(html).not.toContain('data-callout');
  });

  it('callout 内的 [[wikilink]] 仍渲染', () => {
    const html = toHtml(renderMarkdown('> [!background] 🔗 背景\n> 见 [[Vectors]]'));
    expect(html).toContain('data-callout="background"');
    expect(html).toContain('Vectors');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/__tests__/markdown-client.test.ts`
Expected: FAIL —— 上述 4 个用例失败（输出仍是普通 `<blockquote>`，含 `[!intuition]` 文本、无 `data-callout`）。

- [ ] **Step 3: 实现 `createRemarkCallouts` 插件**

在 `src/lib/markdown-client.ts` 中，紧接 `createRemarkWikiLinks` 定义之后加入：

```ts
// ---------------------------------------------------------------------------
// remarkCallouts plugin
// ---------------------------------------------------------------------------
// 把首段首行匹配 `[!type]` 的 blockquote 重标为 <div data-callout=type>，
// 并剥离 `[!type]` 标记（保留紧随其后的 emoji/标题文字作为容器首行）。
// 仅改 hast 提示（hName/hProperties），不改 mdast 结构，故 wikilink/math 子节点照常处理。

const CALLOUT_RE = /^\[!([\w-]+)\]\s*/;

function createRemarkCallouts(): Plugin<[], MdastRoot> {
  return function () {
    return function transformer(tree: MdastRoot) {
      visitCallouts(tree);
    };
  };
}

function visitCallouts(node: MdastNode): void {
  if (!isParent(node)) return;
  for (const child of node.children) {
    if (child.type === 'blockquote') {
      tagCalloutBlockquote(child as MdastParent);
    }
    visitCallouts(child);
  }
}

function tagCalloutBlockquote(bq: MdastParent): void {
  const firstPara = bq.children[0];
  if (!firstPara || firstPara.type !== 'paragraph' || !isParent(firstPara)) return;
  const firstText = firstPara.children[0];
  if (!firstText || firstText.type !== 'text') return;
  const value = (firstText as MdastText).value;
  const m = CALLOUT_RE.exec(value);
  if (!m) return;

  const type = m[1].toLowerCase();
  (firstText as MdastText).value = value.slice(m[0].length);
  const node = bq as MdastNode & { data?: Record<string, unknown> };
  node.data = {
    ...node.data,
    hName: 'div',
    hProperties: {
      className: ['callout', `callout-${type}`],
      'data-callout': type,
    },
  };
}
```

- [ ] **Step 4: 接入渲染管线**

在 `renderMarkdown` 内（`src/lib/markdown-client.ts`），把 callout 插件加在 wikilink 之前（`remark-math` 仍须最先，保持现状）。将：

```ts
  remark = remark.use(createRemarkWikiLinks(resolver));
```

改为：

```ts
  remark = remark.use(createRemarkCallouts()).use(createRemarkWikiLinks(resolver));
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/lib/__tests__/markdown-client.test.ts`
Expected: PASS —— callout 4 个用例 + 既有 KaTeX 5 个用例全绿。

- [ ] **Step 6: 加 callout 样式**

在 `src/components/wiki/page-renderer.tsx` 的 `proseClassName` 模板字符串内（`[&>blockquote]...` 行之后）追加（callout 渲染为 `div`，故用后代选择器 `[&_.callout]`）：

```
  [&_.callout]:my-4 [&_.callout]:rounded-md [&_.callout]:border-l-4 [&_.callout]:pl-4 [&_.callout]:pr-3 [&_.callout]:py-2.5 [&_.callout]:bg-subtle
  [&_.callout>p]:mb-2 [&_.callout>p:last-child]:mb-0 [&_.callout>ul]:mb-2 [&_.callout>ul]:pl-5 [&_.callout>ul]:list-disc
  [&_.callout-intuition]:border-amber-400 [&_.callout-example]:border-sky-400 [&_.callout-quiz]:border-violet-400
  [&_.callout-background]:border-slate-400 [&_.callout-diagram]:border-teal-400 [&_.callout-pitfall]:border-rose-400
```

- [ ] **Step 7: 提交**

```bash
git add src/lib/markdown-client.ts src/lib/__tests__/markdown-client.test.ts src/components/wiki/page-renderer.tsx
git commit -m "feat: 正文渲染支持 Obsidian 风格 callout（增益层载体）"
```

---

### Task 2: Mermaid 图示渲染

**Files:**
- Create: `src/components/wiki/mermaid-diagram.tsx`（client 组件，动态 import mermaid）
- Modify: `src/lib/markdown-client.ts`（新增 `remarkMermaid` 插件 + `components.mermaiddiagram` 映射）
- Modify: `package.json`（新增 `mermaid` 依赖）
- Test: `src/lib/__tests__/markdown-client.test.ts`（新增 mermaid describe 块）

**Interfaces:**
- Consumes: Task 1 后的 `markdown-client.ts`（`isParent`、rehype-react `components` 对象、`createElement`）。
- Produces:
  - `MermaidDiagram(props: { code: string }): ReactElement` —— 默认导出，同步渲染 `<div class="mermaid-diagram" data-mermaid-src={code}>` 占位，`useEffect` 内动态渲染 SVG。
  - ```mermaid 代码块在 HTML 中渲染为带 `data-mermaid-src` 的容器（而非 `<pre><code class="language-mermaid">`）。

- [ ] **Step 1: 写失败测试**

在 `src/lib/__tests__/markdown-client.test.ts` 末尾追加：

```ts
describe('renderMarkdown — Mermaid 渲染', () => {
  it('```mermaid 代码块渲染为 mermaid 容器并保留源码', () => {
    const md = '```mermaid\ngraph TD; A-->B\n```';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('mermaid-diagram');
    expect(html).toContain('data-mermaid-src');
    expect(html).toContain('graph TD');
    expect(html).not.toContain('language-mermaid');
  });

  it('普通代码块不受影响', () => {
    const md = '```js\nconst a = 1;\n```';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('<code');
    expect(html).not.toContain('mermaid-diagram');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/__tests__/markdown-client.test.ts`
Expected: FAIL —— mermaid 2 个新用例失败（mermaid 块仍渲染为 `<pre><code class="language-mermaid">`）。

- [ ] **Step 3: 安装 mermaid 依赖**

Run: `npm install mermaid`
Expected: `package.json` 的 `dependencies` 出现 `mermaid`，无安装错误。

- [ ] **Step 4: 创建 MermaidDiagram 组件**

Create `src/components/wiki/mermaid-diagram.tsx`：

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * 渲染单个 mermaid 图。mermaid 仅在浏览器可用，故：
 * - 模块顶层不 import mermaid（保证 markdown-client 在 node 测试/SSR 可加载）；
 * - 同步先渲染占位容器（带 data-mermaid-src 便于测试/降级）；
 * - useEffect 内动态 import 并渲染 SVG；失败则回退展示源码。
 */
export default function MermaidDiagram({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (failed) {
    return (
      <pre className="bg-prose-code-bg text-prose-code rounded-md p-4 overflow-x-auto my-4 text-sm font-mono">
        {code}
      </pre>
    );
  }

  return (
    <div
      ref={ref}
      data-mermaid-src={code}
      className={cn('mermaid-diagram my-4 flex justify-center overflow-x-auto')}
    />
  );
}
```

- [ ] **Step 5: 实现 `remarkMermaid` 插件 + 映射组件**

在 `src/lib/markdown-client.ts` 顶部 import 区加：

```ts
import MermaidDiagram from '@/components/wiki/mermaid-diagram';
import type { Code as MdastCode } from 'mdast';
```

在 `createRemarkCallouts` 之后加插件：

```ts
// ---------------------------------------------------------------------------
// remarkMermaid plugin
// ---------------------------------------------------------------------------
// 把 lang==='mermaid' 的 code 节点重标为自定义元素 <mermaiddiagram code="...">，
// 由 rehype-react 映射到 MermaidDiagram 组件（client 端 useEffect 渲染 SVG）。

function createRemarkMermaid(): Plugin<[], MdastRoot> {
  return function () {
    return function transformer(tree: MdastRoot) {
      visitMermaid(tree);
    };
  };
}

function visitMermaid(node: MdastNode): void {
  if (!isParent(node)) return;
  for (const child of node.children) {
    if (child.type === 'code' && (child as MdastCode).lang === 'mermaid') {
      const codeNode = child as MdastNode & { data?: Record<string, unknown> };
      codeNode.data = {
        ...codeNode.data,
        hName: 'mermaiddiagram',
        hProperties: { code: (child as MdastCode).value },
        hChildren: [],
      };
    }
    visitMermaid(child);
  }
}
```

在 `renderMarkdown` 内接入（紧接 callout 之后）：

```ts
  remark = remark.use(createRemarkCallouts()).use(createRemarkMermaid()).use(createRemarkWikiLinks(resolver));
```

在 rehype-react 的 `components` 对象里（与 `a:` 同级）新增：

```ts
        mermaiddiagram: function MermaidRenderer(props: { code?: string }) {
          return createElement(MermaidDiagram, { code: props.code ?? '' });
        },
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/lib/__tests__/markdown-client.test.ts`
Expected: PASS —— mermaid 2 个用例 + callout 4 个 + KaTeX 5 个全绿。

> 注：node 环境下 `renderToStaticMarkup` 不执行 `useEffect`，故输出为占位容器 `<div class="mermaid-diagram ..." data-mermaid-src="graph TD; A--&gt;B">`，断言命中；mermaid 库不会在 node 被加载（动态 import 在 effect 内）。

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json src/components/wiki/mermaid-diagram.tsx src/lib/markdown-client.ts src/lib/__tests__/markdown-client.test.ts
git commit -m "feat: 正文渲染支持 mermaid 图示（增益图示层）"
```

---

### Task 3: 端到端肉眼验收

**Files:**
- Create: `data/vault/wiki/general/_p1-render-check.md`（临时验收用样例页，验收后删除）

**Interfaces:**
- Consumes: Task 1/2 的 callout + mermaid + 既有 KaTeX/wikilink 渲染。
- Produces: 无代码产物；确认四类内容（callout / mermaid / KaTeX / wikilink）在真实页面共存渲染正确。

- [ ] **Step 1: 写验收样例页**

Create `data/vault/wiki/general/_p1-render-check.md`：

```markdown
---
title: P1 渲染自检
tags: [render-check]
summary: 临时页，验收 callout/mermaid/KaTeX/wikilink 共存渲染。
---

## 双层渲染自检

若 $Tv=\lambda v$，则 $\lambda$ 是特征值。参考 [[Eigenvalues and Eigenvectors]]。

> [!intuition] 💡 直觉
> 特征向量是方向不变、只被拉伸 $\lambda$ 倍的"骨架轴"。

> [!example] 📝 例题
> $T(x,y)=(2x,3y)$ 的特征值为 $\lambda_1=2,\ \lambda_2=3$。

> [!diagram] 📊 图示
>
> ```mermaid
> graph LR
>   v[向量 v] -->|T| Tv[Tv = λv]
> ```

> [!pitfall] ⚠ 常见误区
> 零向量不是特征向量（按定义须非零）。
```

- [ ] **Step 2: 启动开发服务器**

Run: `npm run dev`
Expected: Next.js 启动，无编译错误（mermaid 动态 import 不报模块缺失）。

- [ ] **Step 3: 浏览器肉眼验收**

打开 `http://localhost:3000/wiki/_p1-render-check`（subject=general），确认：
- callout 显示为左边框着色容器（直觉=amber / 例题=sky / 图示=teal / 误区=rose），首行 emoji+标题在位，无残留 `[!type]` 文本；
- mermaid 块渲染为 SVG 流程图（v →|T| Tv），非源码文本；
- 行内/块级 KaTeX 公式正常；`[[Eigenvalues and Eigenvectors]]` 渲染为 wiki 链接。

- [ ] **Step 4: 删除验收页并提交**

```bash
rm data/vault/wiki/general/_p1-render-check.md
git add -A
git commit -m "chore: 移除 P1 渲染自检临时页"
```

> 若验收发现样式/渲染问题，回到 Task 1/2 修正后重跑本任务。

---

## Self-Review

**1. Spec coverage（对照 spec §10 渲染工作）：**
- §10.1 mermaid 渲染 → Task 2 ✓（依赖 + 组件 + transform + 映射）。
- §10.2 callout 样式化 → Task 1 ✓（transform + proseClassName 着色，降级为 blockquote 的语义保留——非 callout 的 blockquote 不受影响）。
- §10.3 折叠自测题 → spec 标注"可选后续"，本计划**不含**（YAGNI），Q&A 平铺渲染即可。
- 覆盖完整，无遗漏。

**2. Placeholder 扫描：** 无 TBD/TODO；每个 code step 均含完整可运行代码与确切命令/预期。✓

**3. Type 一致性：**
- `MermaidDiagram({ code: string })` 在 Task 2 Step 4 定义、Step 5 `components.mermaiddiagram` 以 `{ code }` 调用 —— 一致。✓
- callout 产出 `data-callout` / `callout-<type>` 类名（Task 1 Step 3）与样式选择器 `[&_.callout-intuition]` 等（Step 6）一致。✓
- mermaid 产出 `data-mermaid-src` / `mermaid-diagram`（组件）与测试断言（Step 1）一致。✓

无遗留问题。

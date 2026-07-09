# Ask AI 表格渲染 + 引用列表折叠 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Ask AI 聊天回答（及连带的 Wiki 阅读页正文）正确渲染 Markdown 表格，并让每条消息的引用/来源列表支持展开折叠——超过 3 条时默认折叠。

**Architecture:** 两个独立的纯前端改动，互不依赖：① 在共享渲染函数 `renderMarkdown()`（`src/lib/markdown-client.ts`）的 remark 管线中接入 `remark-gfm`；② 在 `src/components/chat/message-list.tsx` 里把内联的 citations 渲染块抽成一个自带本地折叠状态的 `MessageCitations` 组件，交互模式抄 `src/components/layout/sidebar.tsx` 现有的 "Sources" 分组折叠。

**Tech Stack:** Next.js 15 / React 19 / TypeScript，unified + remark + rehype（`unified@^11`），vitest（`renderToStaticMarkup` 断言 HTML 字符串）。

## Global Constraints

- 表格渲染采用**完整** `remark-gfm`（不做特性拆分），连带打开删除线 `~~text~~`、任务列表 `- [ ]`、自动链接——已与用户确认此范围可接受。
- `renderMarkdown()` 被 chat 与 Wiki 阅读页正文共用，这次改动**会同时**影响两处渲染，属于预期范围。
- 引用列表折叠交互仿 `src/components/layout/sidebar.tsx` 的 "Sources" 分组折叠模式：标题栏 `Sources (N)` + `ChevronDown` 图标 + `aria-expanded`，可反复切换。
- 每条消息的折叠状态互相独立（本地组件状态，不做全局/跨消息共享）。
- 初始折叠态：`citations.length > 3` → 折叠；`<= 3` → 展开。折叠能力对所有条数始终可用（≤3 条也能手动收起再展开）。
- 数据结构不变：`Citation` / `QueryResult.citations` / `ConversationMessage.citations` 三处 `{ pageSlug, excerpt }` 形状均不需要改动。
- 项目当前**无组件测试基建**（`src/components/CLAUDE.md` 明确写"目前无组件测试"），引用列表折叠遵循既有约定不新增组件测试基础设施，改为手动浏览器验证（Task 3）。

---

### Task 1: GFM 表格渲染管线接入

**Files:**
- Modify: `package.json:50-53`
- Modify: `src/lib/markdown-client.ts:5-16`（imports）、`:297-299`（remark 管线）
- Test: `src/lib/__tests__/markdown-client.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown(content, titleSlugMap?, options?)` 现有签名不变。
- Produces: 无新增导出，`renderMarkdown()` 行为变化对 chat 和 wiki 阅读页两处调用方透明生效。

- [ ] **Step 1: 加显式依赖并安装**

`package.json` 第 47-53 行当前内容：

```json
    "rehype-katex": "^7.0.1",
    "rehype-pretty-code": "^0.14.0",
    "rehype-react": "^8.0.0",
    "remark-frontmatter": "^5.0.0",
    "remark-math": "^6.0.0",
    "remark-parse": "^11.0.0",
    "remark-rehype": "^11.0.0",
```

改为（在 `remark-frontmatter` 与 `remark-math` 之间插入一行，保持字母序）：

```json
    "rehype-katex": "^7.0.1",
    "rehype-pretty-code": "^0.14.0",
    "rehype-react": "^8.0.0",
    "remark-frontmatter": "^5.0.0",
    "remark-gfm": "^4.0.1",
    "remark-math": "^6.0.0",
    "remark-parse": "^11.0.0",
    "remark-rehype": "^11.0.0",
```

运行：`npm install`

预期：`node_modules/remark-gfm` 存在（该 worktree 当前没有 `node_modules`，此步会触发一次完整安装，正常耗时较长）；`package-lock.json` 里出现 `remark-gfm` 的直接依赖记录。

- [ ] **Step 2: 写失败测试**

在 `src/lib/__tests__/markdown-client.test.ts` 末尾（第 96 行 `});` 之后）新增：

```ts
describe('renderMarkdown — GFM 表格渲染', () => {
  it('管道语法表格渲染为 table/th/td 结构', () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
  });

  it('表格单元格内的 [[wikilink]] 仍正确渲染（验证插件顺序无冲突）', () => {
    const md = '| Name | Ref |\n| --- | --- |\n| foo | [[Page]] |';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('<table');
    expect(html).toContain('Page');
  });

  it('删除线语法随 remark-gfm 一起生效', () => {
    const html = toHtml(renderMarkdown('~~deleted~~'));
    expect(html).toContain('<del');
  });

  it('未启用表格语法前的普通竖线文本不受影响（非表格场景不误判）', () => {
    const html = toHtml(renderMarkdown('a | b | c'));
    expect(html).not.toContain('<table');
    expect(html).toContain('a | b | c');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

运行：`npx vitest run src/lib/__tests__/markdown-client.test.ts`

预期：新增的前三个用例 FAIL（表格/删除线未被解析，`<table>`/`<del` 不存在，`| a | b |` 语法原样保留为文本）；第四个用例（普通竖线文本不受影响）此时应该 PASS（因为还没接入 GFM，行为等同现状）。

- [ ] **Step 4: 接入 remarkGfm**

`src/lib/markdown-client.ts` 第 5-8 行当前内容：

```ts
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import remarkMath from 'remark-math';
```

改为：

```ts
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import remarkMath from 'remark-math';
```

第 297 行当前内容：

```ts
  let remark = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']);
```

改为：

```ts
  let remark = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm);
```

（`remarkGfm` 放在 `remarkFrontmatter` 之后、`remarkMath`/`createRemarkCallouts`/`createRemarkMermaid`/`createRemarkWikiLinks` 之前——确保 GFM 先把 table/delete/list 等语法解析成 mdast 节点，再让自定义插件处理文本节点，避免顺序颠倒导致互相干扰。)

- [ ] **Step 5: 运行测试确认通过**

运行：`npx vitest run src/lib/__tests__/markdown-client.test.ts`

预期：全部用例 PASS（含 Step 2 新增的 4 个用例与既有的数学公式/callout/mermaid 用例）。

- [ ] **Step 6: 跑全量测试确认无回归**

运行：`npm test`

预期：全部测试套件 PASS（重点关注是否有其他测试因为 GFM 打开后对纯文本竖线/波浪号处理方式变化而意外失败）。

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lib/markdown-client.ts src/lib/__tests__/markdown-client.test.ts
git commit -m "feat: renderMarkdown 接入 remark-gfm，支持表格/删除线/任务列表"
```

---

### Task 2: 引用列表整体折叠

**Files:**
- Modify: `src/components/chat/message-list.tsx`

**Interfaces:**
- Consumes: 既有 `Citation { pageSlug: string; excerpt: string }` 类型（本文件内定义，不改动）。
- Produces: 新增模块内组件 `MessageCitations({ citations: Citation[] })`，仅本文件内部使用，不导出。

- [ ] **Step 1: 更新顶部 imports**

第 3-4 行当前内容：

```tsx
import { useEffect, useRef, memo, useMemo } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
```

改为：

```tsx
import { useEffect, useRef, useState, memo, useMemo } from 'react';
import { ChevronDown, MessageCircleQuestion } from 'lucide-react';
```

- [ ] **Step 2: 新增 `MessageCitations` 组件**

在 `MarkdownText` 组件定义结束（第 51 行 `});`）之后、`StreamingIndicator` 函数（第 53 行）之前，插入：

```tsx
// Collapsible "Sources" block for a single message's citations.
// citations.length > 3 → collapsed by default; <= 3 → expanded by default.
// Each message keeps its own independent local state, mirrored after the
// existing "Sources" group collapse pattern in layout/sidebar.tsx.
const MessageCitations = memo(function MessageCitations({ citations }: { citations: Citation[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(citations.length <= 3);

  return (
    <div className="mt-3 pt-2 border-t border-border">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between h-6 rounded-md text-[10px] font-medium uppercase tracking-wider text-foreground-tertiary hover:text-foreground transition-colors focus-ring"
      >
        <span className="flex items-center gap-1.5">
          <ChevronDown className={cn('h-3 w-3 transition-transform', !expanded && '-rotate-90')} />
          Sources
        </span>
        <span className="tabular-nums text-xs font-normal normal-case tracking-normal">
          {citations.length}
        </span>
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {citations.map((cite, cIdx) => (
            <button
              key={cIdx}
              onClick={() => router.push(`/wiki/${cite.pageSlug}`)}
              className="block w-full text-left rounded-sm px-2 py-1.5 bg-subtle hover:bg-accent-subtle transition-colors focus-ring"
            >
              <p className="text-xs font-medium text-accent-strong">{cite.pageSlug}</p>
              {cite.excerpt && (
                <p className="text-xs text-foreground-secondary mt-0.5 line-clamp-2">
                  {cite.excerpt}
                </p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
```

- [ ] **Step 3: 替换 `MessageList` 内的内联 citations 渲染块**

在更新前的文件里，`MessageList` 函数体第 74 行有：

```tsx
  const router = useRouter();
```

删除这一行——`useRouter()` 的调用已经移入 `MessageCitations` 内部，`MessageList` 本身不再直接需要 `router`（顶部 `import { useRouter } from 'next/navigation';` 保留不变，因为同文件的 `MessageCitations` 组件仍要用它）。

原第 150-170 行（citations 渲染块）：

```tsx
              {msg.citations && msg.citations.length > 0 && (
                <div className="mt-3 pt-2 border-t border-border space-y-1.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-foreground-tertiary">
                    Sources
                  </p>
                  {msg.citations.map((cite, cIdx) => (
                    <button
                      key={cIdx}
                      onClick={() => router.push(`/wiki/${cite.pageSlug}`)}
                      className="block w-full text-left rounded-sm px-2 py-1.5 bg-subtle hover:bg-accent-subtle transition-colors focus-ring"
                    >
                      <p className="text-xs font-medium text-accent-strong">{cite.pageSlug}</p>
                      {cite.excerpt && (
                        <p className="text-xs text-foreground-secondary mt-0.5 line-clamp-2">
                          {cite.excerpt}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
```

改为：

```tsx
              {msg.citations && msg.citations.length > 0 && (
                <MessageCitations citations={msg.citations} />
              )}
```

- [ ] **Step 4: 类型检查**

运行：`npx tsc --noEmit`

预期：无新增类型错误（尤其确认 `MessageList` 里删掉 `router` 变量后没有残留的未使用引用报错，以及 `MessageCitations` 的 props 类型正确推断）。

- [ ] **Step 5: 跑全量测试确认无回归**

运行：`npm test`

预期：全部测试套件 PASS（本任务不改动任何被现有测试覆盖的模块，属于纯 UI 交互层改动，预期无测试受影响）。

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/message-list.tsx
git commit -m "feat: Ask AI 引用列表支持折叠，超过 3 条默认收起"
```

---

### Task 3: 手动端到端验证

**Files:** 无代码改动，仅验证。

- [ ] **Step 1: 启动开发环境**

运行：`npm run dev:all`

预期：Next.js（默认 `http://localhost:3000`）与 worker 进程均正常启动，无报错。

- [ ] **Step 2: 验证表格渲染**

在浏览器打开任意 subject 页面，展开右侧 "对话" Tab（Ask AI），发一条提示模型输出 Markdown 表格的问题，例如：

> 请用一个 markdown 表格列出 3 个示例数据（列名任意）。

预期：回答区域出现真实 `<table>` 渲染（带边框的表格网格），而不是原样显示 `| ... | ... |` 竖线文本。

（如果模型不配合输出表格语法，可以改问一个明确要求"用表格对比 A 和 B"的问题，或直接在浏览器 DevTools 里检查 `MarkdownText` 渲染出的 DOM 结构是否包含 `<table>`。）

- [ ] **Step 3: 验证引用列表折叠 — 超过 3 条**

问一个预期会命中较多页面、返回 4 条以上引用的问题（若当前 subject 内容页数较少不足以触发 4 条引用，可以先切换到一个页面较多的 subject，或者临时忽略此项，改为在 Step 4 之后用浏览器 DevTools 直接编辑 React DevTools 里 `MessageList` 的 `messages` prop 来构造一条带 5 个 citations 的 mock 消息进行验证）。

预期：
- 回答下方 "Sources (N)" 标题栏默认为折叠态（`ChevronDown` 图标旋转 -90°，看不到具体引用条目）。
- 点击标题栏后完整展开全部 N 条引用，图标恢复朝下。
- 再次点击可收起回到只显示标题栏的状态。

- [ ] **Step 4: 验证引用列表折叠 — 不超过 3 条**

问一个预期只命中 1-3 个页面的具体问题。

预期："Sources (N)" 标题栏默认为**展开**态，直接看到全部引用条目；点击标题栏仍可手动收起、再点击展开（折叠能力始终可用，只是初始态不同）。

- [ ] **Step 5: 检查控制台无报错**

预期：浏览器 DevTools Console 在上述交互过程中无新增 React/Next.js 报错或警告。

（本任务无 commit——如发现问题回到 Task 1/2 修复后再重新验证。）

# 统一阅读页功能菜单 + 阅读页英文化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 wiki 阅读页的 Edit / Sources / Reshape 三个控件统一为标题行右侧的并排动作条，并把阅读页所有中文用户可见标签改为英文。

**Architecture:** 新增纯展示组件 `PageActions`（动作条）+ `ReshapeStatus`（正文上方状态行）。`FrontmatterDisplay`/`PageRenderer` 增加 `actions`/`headerExtra` 插槽，`WikiReadingView` 作为状态容器构建这两个节点并下传，删除旧的顶部 Sources toolbar 与 LensBar。reshape 状态机逻辑不变，仅更换呈现容器。

**Tech Stack:** React 19 + TypeScript + Tailwind + lucide-react + `@/components/ui/button`。

## Global Constraints

- 代码注释、commit message、本计划文案使用**中文**（项目约定）。
- 用户可见标签使用**英文**（本需求目标）。
- 不得添加 AI 署名 / Co-Authored-By。
- 无 DB / 路由 / 后端改动；纯前端。
- 验证以 `npx tsc --noEmit` 为权威（`npm run lint` 在本项目不可用）；组件无单测基础设施，故任务用 tsc + CJK grep + 可选 Playwright 手测代替单测。
- 与后端通信沿用现有 `useApiFetch` / `useLens`，本需求不新增请求。

---

### Task 1: 新增 `PageActions` + `ReshapeStatus` 组件

**Files:**
- Create: `src/components/wiki/page-actions.tsx`

**Interfaces:**
- Produces:
  - `type ReshapeState = 'idle' | 'loading' | 'reshaped' | 'unavailable'`
  - `PageActions(props: { editHref: string; sourceCount: number; splitOn: boolean; onToggleSplit: () => void; reshapeState: ReshapeState; onRequestReshape: () => void })`
  - `ReshapeStatus(props: { state: ReshapeState; showOriginal: boolean; onToggle: () => void })`

- [ ] **Step 1: 创建组件文件**

创建 `src/components/wiki/page-actions.tsx`，内容如下：

```tsx
'use client';

import Link from 'next/link';
import { FileStack, Loader2, Pencil, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type ReshapeState = 'idle' | 'loading' | 'reshaped' | 'unavailable';

interface PageActionsProps {
  editHref: string;
  sourceCount: number;
  splitOn: boolean;
  onToggleSplit: () => void;
  reshapeState: ReshapeState;
  onRequestReshape: () => void;
}

/**
 * 阅读页标题行右侧的统一功能动作条：Edit / Sources / Reshape 并排。
 * Reshape 仅负责触发；触发后的状态与切换交给 <ReshapeStatus> 在正文上方呈现。
 */
export function PageActions({
  editHref,
  sourceCount,
  splitOn,
  onToggleSplit,
  reshapeState,
  onRequestReshape,
}: PageActionsProps) {
  // Reshape 触发按钮仅在「未触发」或「不可用（允许重试）」时出现；
  // 加载中 / 已重塑时由状态行接管，避免动作条与状态行重复。
  const showReshapeTrigger = reshapeState === 'idle' || reshapeState === 'unavailable';

  return (
    <div className="flex items-center gap-2 shrink-0">
      <Link
        href={editHref}
        data-tip="Edit this page"
        className="tip tip-b inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
      >
        <Pencil className="h-3.5 w-3.5" />
        Edit
      </Link>

      {sourceCount > 0 && (
        <Button
          intent={splitOn ? 'primary' : 'outline'}
          size="base"
          onClick={onToggleSplit}
          data-tip="Show the documents this page was written from"
          className="tip tip-b"
        >
          <FileStack className="h-3.5 w-3.5" />
          {splitOn ? 'Hide sources' : `Sources (${sourceCount})`}
        </Button>
      )}

      {showReshapeTrigger && (
        <Button
          intent="outline"
          size="base"
          onClick={onRequestReshape}
          data-tip="Rewrite this page to fit your profile"
          className="tip tip-b"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Reshape
        </Button>
      )}
    </div>
  );
}

interface ReshapeStatusProps {
  /** 调用方保证传入时 state !== 'idle'。 */
  state: ReshapeState;
  showOriginal: boolean;
  onToggle: () => void;
}

/** 正文上方的细状态行：加载中 / 已重塑（可切原文）/ 不可用。 */
export function ReshapeStatus({ state, showOriginal, onToggle }: ReshapeStatusProps) {
  return (
    <div className="mb-6 flex items-center gap-2 text-xs text-foreground-tertiary">
      {state === 'loading' ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" /> Reshaping…
        </span>
      ) : state === 'reshaped' ? (
        <>
          {showOriginal ? (
            <span>Viewing original</span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-accent" /> Adapted for you
            </span>
          )}
          <Button intent="outline" size="sm" className="ml-auto" onClick={onToggle}>
            {showOriginal ? 'Show reshaped' : 'Show original'}
          </Button>
        </>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 opacity-50" /> Couldn&apos;t reshape — showing original
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 类型校验**

Run: `npx tsc --noEmit`
Expected: 通过（新文件暂未被引用，不应引入新错误）。

- [ ] **Step 3: 提交**

```bash
git add src/components/wiki/page-actions.tsx
git commit -m "feat(page-actions): 新增统一动作条 PageActions + 状态行 ReshapeStatus 组件"
```

---

### Task 2: 接入插槽并重写 WikiReadingView

把 `actions`/`headerExtra` 插槽接到 `FrontmatterDisplay` 与 `PageRenderer`，移除 `editHref`，并改写 `WikiReadingView` 使用新组件、删除旧 toolbar/LensBar。这三处强耦合（移除 `editHref` 必须与停止传参同步），合为一个任务，构建在任务末尾保持绿色。

**Files:**
- Modify: `src/components/wiki/frontmatter-display.tsx`
- Modify: `src/components/wiki/page-renderer.tsx`
- Modify: `src/components/wiki/wiki-reading-view.tsx`

**Interfaces:**
- Consumes: `PageActions` / `ReshapeStatus` / `ReshapeState`（Task 1）。
- Produces: `FrontmatterDisplay` 新 prop `actions?: ReactNode`（不再有 `editHref`）；`PageRenderer` 新 prop `actions?: ReactNode` + `headerExtra?: ReactNode`（不再有 `editHref`）。

- [ ] **Step 1: 改 `frontmatter-display.tsx`**

把顶部 import 改为（移除 `Link` 与 `Pencil`，加 `ReactNode` 类型）：

```tsx
'use client';

import type { ReactNode } from 'react';
import { Tag } from '@/components/ui/tag';
import { TagLink } from '@/components/wiki/tag-link';
```

把 `FrontmatterDisplayProps` 中的 `editHref?: string;` 整行删除，替换为 `actions?: ReactNode;`。结果应为：

```tsx
interface FrontmatterDisplayProps {
  title: string;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
  actions?: ReactNode;
  subjectSlug?: string;
}
```

把函数签名解构里的 `editHref,` 改为 `actions,`：

```tsx
export default function FrontmatterDisplay({
  title,
  tags,
  sources,
  created,
  updated,
  actions,
  subjectSlug,
}: FrontmatterDisplayProps) {
```

把标题行（当前的 `<div className="flex items-start justify-between gap-3 mb-5">…</div>`）整块替换为：

```tsx
      <div className="flex items-start justify-between gap-3 mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-prose-heading leading-tight">
          {title}
        </h1>
        {actions}
      </div>
```

（即删掉原来内部 `<div className="flex items-center gap-2 shrink-0">{editHref && <Link…>Edit</Link>}</div>` 整块，直接渲染 `{actions}`——`PageActions` 自带 `flex items-center gap-2 shrink-0` 容器。）

- [ ] **Step 2: 改 `page-renderer.tsx`**

顶部加 `ReactNode` 类型 import（与现有 `useMemo` 同源）：

```tsx
import { useMemo, type ReactNode } from 'react';
```

`PageRendererProps` 中把 `editHref?: string;` 整行删除，新增两行：

```tsx
  /** 标题行右侧动作条节点（透传给 FrontmatterDisplay）。 */
  actions?: ReactNode;
  /** 渲染在 FrontmatterDisplay 之后、正文之前（复用 article 的 reading 宽度）。 */
  headerExtra?: ReactNode;
```

函数解构里把 `editHref,` 删除，加入 `actions,` 与 `headerExtra,`：

```tsx
export default function PageRenderer({
  content,
  slug,
  title,
  tags = [],
  sources = [],
  created = '',
  updated = '',
  titleSlugMap,
  actions,
  headerExtra,
  subjectSlug,
}: PageRendererProps) {
```

把 `<article>` 内部从 `{title && (<FrontmatterDisplay … />)}` 到 `<div className={proseClassName}>{rendered}</div>` 之间替换为：

```tsx
      {title && (
        <FrontmatterDisplay
          title={title}
          tags={tags}
          sources={sources}
          created={created}
          updated={updated}
          actions={actions}
          subjectSlug={subjectSlug}
        />
      )}
      {headerExtra}
      <div className={proseClassName}>{rendered}</div>
```

（即 FrontmatterDisplay 去掉 `editHref={editHref}` 改为 `actions={actions}`，并在其后插入 `{headerExtra}`。）

- [ ] **Step 3: 重写 `wiki-reading-view.tsx`**

(a) 顶部 import 调整：从 lucide 移除 `FileStack` 与 `GitCompareArrows`；移除 `Button` 与 `cn` 之外不再用的项（保留 `FileCode2/FileText/Globe/Link2/Loader2/NotebookPen/Sparkles`）；移除 `Button` import；新增 `PageActions`/`ReshapeStatus`/`ReshapeState` import。改写后 import 区为：

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  FileCode2,
  FileText,
  Globe,
  Link2,
  Loader2,
  NotebookPen,
  Sparkles,
} from 'lucide-react';
import PageRenderer from './page-renderer';
import { HtmlSourceFrame } from './html-source-frame';
import { LensFeedback } from './lens-feedback';
import { PageActions, ReshapeStatus, type ReshapeState } from './page-actions';
import { SectionLabel } from '@/components/ui/panel';
import { useApiFetch } from '@/lib/api-fetch';
import { useLens } from '@/hooks/use-lens';
import { renderMarkdown } from '@/lib/markdown-client';
import { cn } from '@/lib/cn';
import type { PageSourceDoc, PageSourceFormat } from '@/lib/contracts';
```

（注意：`Button` import 删除；`cn` 仍被 `SourcesPane`/`SourceBody` 使用，保留。）

(b) 把组件顶部解构从 `const { backlinks, sourceCount, ...rendererProps } = props;` 改为额外取出 `editHref`：

```tsx
  const { backlinks, sourceCount, editHref, ...rendererProps } = props;
```

(c) 在 `displayContent` 计算之后、`const article = (…)` 之前，新增 reshape 状态派生与节点构建（替换原 `const article = (…)` 直到 `const toolbar = …;` 之间的内容）。具体：删除原 `article` 中的 `<LensBar … />`、删除整个 `const toolbar = canSplit ? (…) : null;` 块、删除文件后面的 `function LensBar(...) {...}` 定义。新的片段：

```tsx
  // reshape 四态：未触发 / 加载中 / 已重塑可用 / 已触发但不可用（canonical|fallback|error）。
  const reshapeState: ReshapeState = !lensRequested
    ? 'idle'
    : lens.isLoading
      ? 'loading'
      : reshapeUsable
        ? 'reshaped'
        : 'unavailable';

  const actions = (
    <PageActions
      editHref={editHref}
      sourceCount={sourceCount}
      splitOn={showSplit}
      onToggleSplit={() => setSplit((s) => !s)}
      reshapeState={reshapeState}
      onRequestReshape={() => {
        setShowOriginal(false);
        setLensRequested(true);
      }}
    />
  );

  const headerExtra =
    reshapeState === 'idle' ? null : (
      <ReshapeStatus
        state={reshapeState}
        showOriginal={showOriginal}
        onToggle={() => setShowOriginal((v) => !v)}
      />
    );

  const article = (
    <>
      <PageRenderer
        {...rendererProps}
        content={displayContent}
        actions={actions}
        headerExtra={headerExtra}
      />
      <Backlinks backlinks={backlinks} />
      <LensFeedback slug={slug} />
    </>
  );
```

(d) 把两处 return 中的顶部 `{toolbar}` 删除。分屏分支改为：

```tsx
  if (showSplit) {
    return (
      <div className="flex flex-col lg:h-[calc(100vh-var(--header-height))]">
        <div className="grid grid-cols-1 lg:grid-cols-2 lg:flex-1 lg:min-h-0">
          <div className="min-w-0 lg:overflow-y-auto">{article}</div>
          <div className="min-w-0 border-t border-border bg-canvas lg:border-l lg:border-t-0 lg:min-h-0 lg:overflow-hidden">
            <SourcesPane docs={docs} loading={loading} error={error} />
          </div>
        </div>
      </div>
    );
  }

  return <div className="flex min-h-full flex-col">{article}</div>;
```

(e) 删除文件中整个 `function LensBar({ … }) { … }` 定义（约原 197–247 行）。

- [ ] **Step 4: 类型校验**

Run: `npx tsc --noEmit`
Expected: 通过，无 `editHref`/`LensBar`/未用 import 相关错误。

- [ ] **Step 5: 提交**

```bash
git add src/components/wiki/frontmatter-display.tsx src/components/wiki/page-renderer.tsx src/components/wiki/wiki-reading-view.tsx
git commit -m "feat(page-actions): 阅读页三控件统一为标题行动作条，删除旧 toolbar/LensBar"
```

---

### Task 3: 阅读页剩余中文标签英文化

**Files:**
- Modify: `src/components/wiki/lens-feedback.tsx`
- Modify: `src/components/wiki/html-source-frame.tsx`
- Modify: `src/components/wiki/page-editor.tsx`

**Interfaces:** 无对外接口变更，仅替换可见文案字符串。

- [ ] **Step 1: 改 `lens-feedback.tsx`**

把 `fire` 中 `setSent` 一行改为英文：

```tsx
    setSent(type === 'too_hard' ? 'too hard' : 'too easy');
```

把三处 JSX 文案改为英文：

```tsx
        <span>Is this explanation a good fit?</span>
        <Button intent="outline" size="sm" onClick={() => fire('too_hard')} disabled={send.isPending}>
          <ThumbsDown className="h-3.5 w-3.5" /> Too hard
        </Button>
        <Button intent="outline" size="sm" onClick={() => fire('too_easy')} disabled={send.isPending}>
          <ThumbsUp className="h-3.5 w-3.5" /> Too easy
        </Button>
        {sent && <span className="text-accent-strong">Logged “{sent}” — we&apos;ll tune future pages</span>}
```

- [ ] **Step 2: 改 `html-source-frame.tsx`**

把第 40 行 `检测到潜在危险脚本，已禁用页面交互` 改为：

```tsx
            Potentially unsafe scripts detected — interactivity disabled
```

把第 54 行按钮文案 `我了解风险，仍然运行脚本` 改为：

```tsx
            I understand the risk — run scripts anyway
```

- [ ] **Step 3: 改 `page-editor.tsx`**

把 `onSuccess` 内写入 sessionStorage 的字符串（当前第 73 行）改为英文：

```tsx
        sessionStorage.setItem('wiki:retitle-notice', `Updated ${referencesUpdated} reference(s) to the new title`);
```

- [ ] **Step 4: 类型校验 + CJK 标签复查**

Run: `npx tsc --noEmit`
Expected: 通过。

Run: `rg -n "[\x{4e00}-\x{9fff}]" src/components/wiki/lens-feedback.tsx src/components/wiki/html-source-frame.tsx src/components/wiki/page-actions.tsx src/components/wiki/wiki-reading-view.tsx`
Expected: 仅命中**注释**行（`//`、`/* */`、`/** */`），无 JSX 文本 / 字符串字面量中的中文。

- [ ] **Step 5: 提交**

```bash
git add src/components/wiki/lens-feedback.tsx src/components/wiki/html-source-frame.tsx src/components/wiki/page-editor.tsx
git commit -m "feat(i18n): 阅读页反馈/HTML 安全提示/改标题联动提示文案英文化"
```

---

### Task 4: 更新文档变更记录

**Files:**
- Modify: `src/components/CLAUDE.md`
- Modify: `CLAUDE.md`

**Interfaces:** 无代码接口。

- [ ] **Step 1: 改 `src/components/CLAUDE.md`**

在 `wiki/` 关键组件表中，`page-renderer.tsx` 一项补「支持 `actions`（标题行动作条）+ `headerExtra`（正文上方状态行）插槽，移除 `editHref`」；`frontmatter-display.tsx` 一项把「标题行支持可选 `editHref` 渲染 Edit 按钮」改为「标题行 `actions` 插槽渲染统一动作条（Edit 已移入 PageActions）」；在文件清单 `wiki/{…}` 中加入 `page-actions`。在变更记录表追加一行：

```markdown
| 2026-06-28 | 统一阅读页功能菜单 + 英文化：新增 `wiki/page-actions.tsx`（`PageActions` 动作条 + `ReshapeStatus` 状态行）；`frontmatter-display`/`page-renderer` 改用 `actions`/`headerExtra` 插槽并移除 `editHref`；`wiki-reading-view` 删除旧顶部 Sources toolbar 与 LensBar，三控件（Edit/Sources/Reshape）并排进标题行；`lens-feedback`/`html-source-frame`/`page-editor`(retitle banner) 文案英文化。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-28-unify-page-actions-i18n* |
```

- [ ] **Step 2: 改根 `CLAUDE.md`**

在第九节变更记录表末尾追加一行：

```markdown
| 2026-06-28 | 统一阅读页功能菜单 + 英文化 | Edit/Sources/Reshape 三控件并排进标题行动作条（新 `components/wiki/page-actions.tsx`：`PageActions`+`ReshapeStatus`；`frontmatter-display`/`page-renderer` 加 `actions`/`headerExtra` 插槽、去 `editHref`；`wiki-reading-view` 删旧 toolbar/LensBar）；阅读页中文标签全部英文化（reshape 三态 / 反馈 / HTML 安全提示 / 改标题联动提示）。纯前端，无 DB/路由改动。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-28-unify-page-actions-i18n* |
```

- [ ] **Step 3: 提交**

```bash
git add src/components/CLAUDE.md CLAUDE.md
git commit -m "docs(page-actions): 根与 components CLAUDE.md 补统一动作条+英文化变更记录"
```

---

## 验证清单（全部任务完成后）

- [ ] `npx tsc --noEmit` 全绿。
- [ ] CJK 复查：阅读页相关组件无中文 JSX/字符串标签（注释除外）。
- [ ] 可选 Playwright 手测：
  1. 普通页：标题行动作条三按钮就位；Edit 跳转编辑页；Sources 进分屏；Reshape → loading → 状态行出现，可 Show original/reshaped 切换。
  2. 分屏：Sources 变 `Hide sources`，正文/来源两栏正常；再点回到单栏。
  3. 无来源页：动作条仅 Edit + Reshape（无 Sources）。
  4. 编辑改标题保存后：阅读页 banner 显示英文 `Updated N reference(s) to the new title`。
```

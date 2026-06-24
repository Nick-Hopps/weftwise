# 在线 Markdown 编辑器重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把在线 Markdown 编辑器改成全宽全高分屏、预览正文与阅读页一致、工具栏增大。

**Architecture:** 复用阅读页的 `PageRenderer` 接管 `@uiw/react-md-editor` 的 `components.preview` 预览面板（仅渲染正文，不渲染 frontmatter 卡片）；`page-editor` 根容器改全高 flex 布局；工具栏与编辑区字号通过 `globals.css` 作用域 CSS 放大。

**Tech Stack:** Next.js 15 + React 19 + TypeScript 5 + Tailwind 3.4 + `@uiw/react-md-editor` 4 + TanStack React Query + vitest。

## Global Constraints

- 强 TypeScript：领域类型从 `src/lib/contracts.ts` 取（如 `WikiPage`）。
- 客户端组件顶部 `'use client'`；样式走 Tailwind + `cn()`，颜色用 CSS 变量 token（`bg-subtle`/`border-border`/`text-foreground-*` 等）。
- 客户端 HTTP 一律走 `useApiFetch()`（自动带 subject），禁止手写 `fetch('/api/...')`。
- 代码注释用中文；git commit message 用中文、一句话总结；**禁止** AI 署名（无 `Co-Authored-By`/`Generated with` 等）。
- 校验命令：`npx tsc --noEmit`（类型）+ `npm test`（vitest）。**不要**用 `npm run lint`（`next lint` 已弃用且会卡住）。
- IDE 诊断可能是幻影/陈旧；以 `tsc --noEmit` 退出码 + vitest 为权威。

---

### Task 1: `buildTitleSlugMap` 纯函数

把"页面列表 → wikilink 解析用 title→slug 映射"抽成可测纯函数（与阅读页 `src/app/(app)/wiki/[...slug]/page.tsx:80-84` 服务端逻辑一致）。

**Files:**
- Create: `src/lib/title-slug-map.ts`
- Test: `src/lib/title-slug-map.test.ts`

**Interfaces:**
- Produces: `buildTitleSlugMap(pages: TitleSluggable[]): Record<string, string>`，其中 `TitleSluggable = { title: string; slug: string }`。映射同时写入 `title` 与 `title.toLowerCase()` 两个 key；重复 title 时后者覆盖前者。

- [ ] **Step 1: 写失败测试**

`src/lib/title-slug-map.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildTitleSlugMap } from './title-slug-map';

describe('buildTitleSlugMap', () => {
  it('同时映射原标题与小写标题到 slug', () => {
    const map = buildTitleSlugMap([{ title: 'Linear Algebra', slug: 'linear-algebra' }]);
    expect(map['Linear Algebra']).toBe('linear-algebra');
    expect(map['linear algebra']).toBe('linear-algebra');
  });

  it('空输入返回空对象', () => {
    expect(buildTitleSlugMap([])).toEqual({});
  });

  it('同名标题后者覆盖前者', () => {
    const map = buildTitleSlugMap([
      { title: 'Dup', slug: 'dup-1' },
      { title: 'Dup', slug: 'dup-2' },
    ]);
    expect(map['Dup']).toBe('dup-2');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/lib/title-slug-map.test.ts`
Expected: FAIL（`Cannot find module './title-slug-map'` 或 `buildTitleSlugMap is not a function`）

- [ ] **Step 3: 写最小实现**

`src/lib/title-slug-map.ts`：

```ts
export interface TitleSluggable {
  title: string;
  slug: string;
}

/**
 * 构建 wikilink 解析用的 title→slug 映射，与阅读页服务端逻辑一致：
 * 同时写入原标题与小写标题两个 key（renderMarkdown 的 resolver 两者都查）。
 */
export function buildTitleSlugMap(pages: TitleSluggable[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of pages) {
    map[p.title] = p.slug;
    map[p.title.toLowerCase()] = p.slug;
  }
  return map;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- src/lib/title-slug-map.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: 提交**

```bash
git add src/lib/title-slug-map.ts src/lib/title-slug-map.test.ts
git commit -m "feat(editor): 抽出 buildTitleSlugMap 纯函数供编辑器预览解析 wikilink"
```

---

### Task 2: `EditorPreview` 预览组件

新增预览组件，复用阅读页 `PageRenderer` 渲染正文。**不传 `title`** → `PageRenderer`（`src/components/wiki/page-renderer.tsx:74` 的 `{title && <FrontmatterDisplay .../>}`）跳过 frontmatter 卡片，符合"仅正文一致"。`renderMarkdown` 的 `remarkFrontmatter` 会自动剥离 `---` 块。

**Files:**
- Create: `src/components/wiki/editor-preview.tsx`

**Interfaces:**
- Consumes: `PageRenderer`（default export，`src/components/wiki/page-renderer.tsx`）。
- Produces: `<EditorPreview source={string} titleSlugMap?={Record<string,string>} slug={string} />`。

- [ ] **Step 1: 创建组件**

`src/components/wiki/editor-preview.tsx`：

```tsx
'use client';

import PageRenderer from './page-renderer';

interface EditorPreviewProps {
  source: string;
  titleSlugMap?: Record<string, string>;
  slug: string;
}

/**
 * 编辑器预览面板：复用阅读页 PageRenderer 渲染正文，确保 wikilink / callout /
 * mermaid / 数学公式 / 排版与阅读页逐项一致。
 * 不传 title → PageRenderer 跳过 FrontmatterDisplay（仅正文一致）；
 * renderMarkdown 的 remarkFrontmatter 会自动剥离 `---` frontmatter 块。
 */
export function EditorPreview({ source, titleSlugMap, slug }: EditorPreviewProps) {
  return <PageRenderer content={source} slug={slug} titleSlugMap={titleSlugMap} />;
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误（exit 0）

- [ ] **Step 3: 提交**

```bash
git add src/components/wiki/editor-preview.tsx
git commit -m "feat(editor): 新增 EditorPreview 复用 PageRenderer 渲染预览正文"
```

---

### Task 3: `md-editor.tsx` 接自定义预览 + 全高 + 工具栏类名

让 `MdEditor` 支持自定义预览渲染器、撑满父高、并加作用域类名供 CSS 增强。

**Files:**
- Modify: `src/components/wiki/md-editor.tsx`（整文件替换）

**Interfaces:**
- Consumes: 无（保持对 `useUIStore.darkMode` 的依赖）。
- Produces: `MdEditor` 新增可选 prop `previewRenderer?: (source: string) => ReactNode`；传入时替换 MDEditor 自带预览。移除原 `height?: number` prop（改为内部固定 `"100%"`）。

- [ ] **Step 1: 整文件替换**

`src/components/wiki/md-editor.tsx`：

```tsx
'use client';

import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useUIStore } from '@/stores/ui-store';

// @uiw/react-md-editor 触碰 window，必须 ssr:false 且只在 client 组件内动态加载。
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

interface MdEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** 自定义预览渲染器：传入则替换 MDEditor 自带预览，保证与阅读页一致。 */
  previewRenderer?: (source: string) => ReactNode;
}

export function MdEditor({ value, onChange, previewRenderer }: MdEditorProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  return (
    <div className="wiki-md-editor h-full" data-color-mode={darkMode ? 'dark' : 'light'}>
      <MDEditor
        value={value}
        onChange={(v) => onChange(v ?? '')}
        height="100%"
        preview="live"
        components={
          previewRenderer
            ? { preview: (source) => <>{previewRenderer(source)}</> }
            : undefined
        }
      />
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 出现 `page-editor.tsx` 调用处的类型错误（旧调用仍传 `height` 或缺 `previewRenderer`），属预期——Task 4 修复。`md-editor.tsx` 本身无错。

> 说明：因 Task 4 会改调用方，此处 `tsc` 可能因调用方暂时报错；只需确认 `md-editor.tsx` 自身语法/类型正确。若想单独干净通过，可在 Task 4 之后再统一跑全量 `tsc`。

- [ ] **Step 3: 提交**

```bash
git add src/components/wiki/md-editor.tsx
git commit -m "feat(editor): MdEditor 支持自定义预览渲染器并撑满父高"
```

---

### Task 4: `page-editor.tsx` 全高布局 + 拉取 titleSlugMap + 接线预览

根容器改全高 flex；新增 `['pages', subjectId]` 查询构建 `titleSlugMap`；把 `EditorPreview` 作为 `previewRenderer` 传入 `MdEditor`；loading/error 骨架改全高版。

**Files:**
- Modify: `src/components/wiki/page-editor.tsx`（整文件替换）

**Interfaces:**
- Consumes: `buildTitleSlugMap`（Task 1）、`EditorPreview`（Task 2）、`MdEditor.previewRenderer`（Task 3）、`WikiPage`（`@/lib/contracts`）。

- [ ] **Step 1: 整文件替换**

`src/components/wiki/page-editor.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { buildTitleSlugMap } from '@/lib/title-slug-map';
import type { WikiPage } from '@/lib/contracts';
import { Button } from '@/components/ui/button';
import { MdEditor } from './md-editor';
import { EditorPreview } from './editor-preview';

const INVALIDATE_KEYS = ['pages', 'page-detail', 'graph', 'search', 'jobs', 'backlinks', 'context', 'frontmatter'];

export function PageEditor({ slug }: { slug: string }) {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const readHref = `/wiki/${slug}?s=${encodeURIComponent(subjectSlug)}`;

  const [value, setValue] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['page-detail', subjectId, slug],
    queryFn: async () => {
      const res = await apiFetch(`/api/pages/${slug}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { raw: string; title: string };
    },
    enabled: !!subjectId,
  });

  // 拉取本 subject 所有页，构建 wikilink 解析用 titleSlugMap（与阅读页一致）。
  const { data: titleSlugMap } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const pages = (await res.json()) as WikiPage[];
      return buildTitleSlugMap(pages);
    },
    enabled: !!subjectId,
  });

  // 受控编辑器：value 为 null 表示尚未编辑，回落到首次加载的 raw。
  const initialRaw = data?.raw ?? '';
  const current = value ?? initialRaw;
  const dirty = value !== null && value !== initialRaw;

  const save = useMutation({
    mutationFn: async (): Promise<number> => {
      const res = await apiFetch(`/api/pages/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: current, subjectId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
        const detail = body.details ? `\n${JSON.stringify(body.details, null, 2)}` : '';
        throw new Error((body.error ?? `HTTP ${res.status}`) + detail);
      }
      const body = (await res.json().catch(() => ({}))) as { referencesUpdated?: number };
      return body.referencesUpdated ?? 0;
    },
    onSuccess: async (referencesUpdated: number) => {
      await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      if (referencesUpdated > 0) {
        // 跳转前用 sessionStorage 把提示带到阅读页（push 后本组件即卸载）。
        sessionStorage.setItem('wiki:retitle-notice', `已同步更新 ${referencesUpdated} 处引用到新标题`);
      }
      router.push(readHref);
      router.refresh();
    },
    onError: (e: Error) => setErrorText(e.message),
  });

  function cancel() {
    if (dirty && typeof window !== 'undefined' && !window.confirm('Discard unsaved changes?')) return;
    router.push(readHref);
  }

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 border-b border-border px-6 py-3">
          <div className="h-8 w-40 rounded bg-subtle animate-pulse" />
        </div>
        <div className="flex-1 m-4 rounded bg-subtle animate-pulse" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col h-full items-start gap-3 px-6 py-8">
        <p className="text-sm text-danger">Failed to load page for editing.</p>
        <Button intent="outline" onClick={() => router.push(readHref)}>Back to page</Button>
      </div>
    );
  }

  const canSave = current.trim() !== '' && dirty && !save.isPending;

  return (
    <div className="flex flex-col h-full">
      <header className="shrink-0 flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="min-w-0">
          <p className="text-xs text-foreground-tertiary">Editing</p>
          <h1 className="text-base font-semibold text-foreground truncate">{data?.title ?? slug}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button intent="ghost" onClick={cancel} disabled={save.isPending}>Cancel</Button>
          <Button
            intent="primary"
            onClick={() => { setErrorText(null); save.mutate(); }}
            loading={save.isPending}
            disabled={!canSave}
          >
            Save
          </Button>
        </div>
      </header>

      {errorText && (
        <div className="shrink-0 border-b border-danger/40 bg-danger-bg px-6 py-2 text-sm text-danger whitespace-pre-wrap">
          {errorText}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <MdEditor
          value={current}
          onChange={setValue}
          previewRenderer={(source) => (
            <EditorPreview source={source} titleSlugMap={titleSlugMap} slug={slug} />
          )}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 全量类型检查**

Run: `npx tsc --noEmit`
Expected: exit 0（无错误；Task 3 引入的调用方错误此时已消除）

- [ ] **Step 3: 提交**

```bash
git add src/components/wiki/page-editor.tsx
git commit -m "feat(editor): 编辑页全高布局 + 预览复用阅读页渲染管线"
```

---

### Task 5: `globals.css` 工具栏与编辑区样式增强

在 `.wiki-md-editor` 作用域内放大工具栏按钮/图标、调大编辑区字号（textarea 与高亮覆盖层同步以保证光标对齐），避免影响其他用到该库的场景。

**Files:**
- Modify: `src/app/globals.css`（文件末尾追加）

- [ ] **Step 1: 追加 CSS**

在 `src/app/globals.css` 末尾追加：

```css
/* ---------------------------------------------------------------------------
   在线 Markdown 编辑器（@uiw/react-md-editor）样式增强
   作用域限定 .wiki-md-editor，避免影响 hover peek 等其他用到该库的场景。
   --------------------------------------------------------------------------- */
.wiki-md-editor .w-md-editor-toolbar {
  padding: 8px 10px;
}

.wiki-md-editor .w-md-editor-toolbar ul > li > button {
  height: 32px;
  min-width: 32px;
  padding: 0 6px;
  border-radius: 6px;
}

.wiki-md-editor .w-md-editor-toolbar ul > li > button svg {
  width: 18px;
  height: 18px;
}

/* 编辑区字号：textarea（输入层）与 pre（高亮覆盖层）必须同步，否则光标错位 */
.wiki-md-editor .w-md-editor-text-input,
.wiki-md-editor .w-md-editor-text-pre,
.wiki-md-editor .w-md-editor-text-pre > code,
.wiki-md-editor .w-md-editor-text {
  font-size: 15px !important;
  line-height: 1.7 !important;
}
```

- [ ] **Step 2: 类型检查（确保未破坏构建）**

Run: `npx tsc --noEmit`
Expected: exit 0（CSS 改动不影响类型，仅确认无误触）

- [ ] **Step 3: 提交**

```bash
git add src/app/globals.css
git commit -m "style(editor): 放大 Markdown 编辑器工具栏与编辑区字号"
```

---

### Task 6: 手动验证 + 文档更新

跑全量自动校验，启动应用做视觉核对，更新模块文档与根 changelog。

**Files:**
- Modify: `CLAUDE.md`（第九节 changelog 追加一行）
- Modify: `src/components/CLAUDE.md`（`wiki/` 表 md-editor/page-editor 条目 + 新增 editor-preview 条目 + changelog 一行）

- [ ] **Step 1: 全量自动校验**

Run: `npx tsc --noEmit && npm test`
Expected: tsc exit 0；vitest 全绿（含 Task 1 的 `buildTitleSlugMap` 3 用例）。

- [ ] **Step 2: 启动应用做视觉核对**

Run: `npm run dev:all`（另开终端）。浏览器打开任一页的编辑入口（`/wiki/edit/<slug>?s=<subject>`），逐项确认：
1. 编辑器横向铺满主内容区、纵向撑满视口（无大块留白、无整页滚动条）；
2. 预览正文与该页阅读页逐项一致：frontmatter `---` 块**不出现**在预览中；wikilink 可点且指向正确 slug；callout 配色正确；mermaid 出图；数学公式（`$...$`）正确排版；标题/列表/代码块/表格样式一致；
3. 工具栏按钮/图标明显增大、可正常点击，编辑区字号舒适且光标与字符对齐；
4. 切换明/暗主题，编辑器与预览均正确（`data-color-mode` 跟随 `darkMode`）。

> 若 CSS 像素值（按钮 32px / 图标 18px / 字号 15px）观感需微调，直接在 `globals.css` 调整并补一次提交。

- [ ] **Step 3: 更新模块文档**

在 `src/components/CLAUDE.md` 的 `wiki/` 列表中：
- 把 `md-editor.tsx` 条目改为：`@uiw/react-md-editor` 封装；`height="100%"` 撑满父高，`components.preview` 接 `previewRenderer` 自定义预览，wrapper 类名 `wiki-md-editor` 供 CSS 增强，`data-color-mode` 跟随 darkMode；
- 把 `page-editor.tsx` 条目补充：根容器全高 flex 布局，额外拉 `['pages',subjectId]` 构建 titleSlugMap 传入预览；
- 新增 `editor-preview.tsx` 条目：复用 `PageRenderer`（不传 title → 仅正文）作为编辑器实时预览，与阅读页一致。
- 在该文件 changelog 表追加一行（日期 2026-06-24）：编辑器全高分屏 + 预览正文一致 + 工具栏增大。

在根 `CLAUDE.md` 第九节 changelog 表追加一行：

```
| 2026-06-24 | 在线 Markdown 编辑器重做 | 编辑页全高分屏（去居中收窄、MDEditor height=100%）；预览接 components.preview 复用 PageRenderer（不传 title→仅正文，remarkFrontmatter 自动剥离 frontmatter，wikilink/callout/mermaid/数学公式与阅读页一致）；新增 buildTitleSlugMap 纯函数 + EditorPreview 组件；globals.css 放大工具栏/编辑区字号。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-24-markdown-editor-rework* |
```

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md src/components/CLAUDE.md
git commit -m "docs(editor): 记录在线 Markdown 编辑器重做（全高/预览一致/工具栏）"
```

---

## Self-Review

**Spec coverage（对照 spec 各节）：**
- spec ①（全宽全高分屏）→ Task 4（page-editor 全高布局）+ Task 3（MDEditor height=100%）。✓
- spec ②（预览仅正文一致）→ Task 2（EditorPreview 不传 title）+ Task 3（components.preview 接线）+ Task 4（titleSlugMap 拉取与传入）+ Task 1（buildTitleSlugMap）。✓
- spec ③（工具栏增大）→ Task 5（globals.css）+ Task 3（wrapper 类名 wiki-md-editor）。✓
- spec 六（已知取舍：滚动联动/防抖/不渲染 frontmatter 头部）→ 设计已接受，无需任务；不渲染 frontmatter 头部由 Task 2「不传 title」落实。✓
- spec 七（验证）→ Task 6（tsc + vitest + 手动 4 项核对）。✓

**Placeholder scan：** 无 TBD/TODO；每个改码步骤均给出完整代码与确切命令。CSS 像素值为具体值，Task 6 Step 2 允许观感微调（非占位）。✓

**Type consistency：**
- `buildTitleSlugMap(pages): Record<string,string>`（Task 1 定义）↔ Task 4 调用 `buildTitleSlugMap(pages)` 传 `WikiPage[]`（`WikiPage` 含 `title`/`slug`，满足 `TitleSluggable`）。✓
- `MdEditor.previewRenderer?: (source: string) => ReactNode`（Task 3 定义）↔ Task 4 传 `(source) => <EditorPreview .../>`（返回 JSX 元素，属 ReactNode）。✓
- `EditorPreview` props `{source, titleSlugMap?, slug}`（Task 2 定义）↔ Task 4 调用一致。✓
- `components.preview` 返回 `JSX.Element`（库签名）↔ Task 3 用 `<>{previewRenderer(source)}</>` 包裹满足。✓

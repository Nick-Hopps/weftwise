# 页面在线编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给只读的 wiki 阅读页补一个 human-in-the-loop 全文编辑入口：独立 `/edit` 路由用 markdown 编辑器改整文件 markdown，经现成 PUT 链路落盘并重索引。

**Architecture:** 复用现成 `PUT /api/pages/[...slug]`（已走全套 Saga，不改）；`GET` 增一个 `raw` 字段（`serializeWikiDocument(doc)`）供编辑器加载整文件。新增独立客户端编辑页 `(app)/wiki/[...slug]/edit`（`@uiw/react-md-editor`，`dynamic ssr:false` 封装），阅读页 FrontmatterDisplay 标题行加「Edit」按钮跳转。保存后失效相关 React Query 缓存 + `router.refresh()` + 跳回读页。

**Tech Stack:** Next.js 15 App Router、React 19 + TanStack Query、`@uiw/react-md-editor`（已是依赖，CSS 主题已接）、Tailwind + 设计系统原语、vitest（node env，无 RTL）。

## Global Constraints

- 编辑内容 = **整文件原始 markdown**（frontmatter + 正文）；PUT 的 `content` 是整文件，编辑器输出原样作为 `content`。
- `GET /api/pages/[...slug]` 响应新增 `raw: serializeWikiDocument(doc)`；`PUT`/`DELETE` 行为与 Saga 顺序**不改**。
- 客户端 HTTP **只用 `@/lib/api-fetch`**：GET 用 `useApiFetch()`（自动注入 `?subjectId`），PUT 在 body 显式带 `subjectId`，禁止手写 `fetch('/api/...')`。
- `@uiw/react-md-editor` 必须 `next/dynamic` + `{ ssr: false }` 且只在 `'use client'` 组件内（Next 15 约束）。
- 复用 `serializeWikiDocument`（单一 round-trip 真相），不另写序列化。
- 保存成功后失效的 queryKey 列表（沿用 chat-interface 既有范式）：`['pages','page-detail','graph','search','jobs','backlinks','context','frontmatter']` + `router.refresh()`。
- 跳转/深链固定 `/wiki/<slug>?s=<subjectSlug>`。
- 复用 `components/ui/*` 原语（Button 等），颜色用 CSS 变量类。
- **门禁** = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏（预存），**不作门禁**。
- commit message 中文、一句话总结；**禁止**任何 AI 署名 trailer / "Generated with" 脚注 / Co-Authored-By。

---

### Task 1: `GET /api/pages/[...slug]` 增 `raw` 字段

**Files:**
- Modify: `src/app/api/pages/[...slug]/route.ts`（GET 响应 + import）
- Test: `src/app/api/pages/[...slug]/__tests__/route.test.ts`

**Interfaces:**
- Produces: `GET` 响应新增 `raw: string`（= `serializeWikiDocument(doc)`，page 存在时；否则保持 404 不变）。
- Consumes: `serializeWikiDocument(doc: WikiDocument): string`（`@/server/wiki/markdown`）；`readPageInSubject(subjectSlug, slug): WikiDocument | null`（`@/server/wiki/wiki-store`）。

- [ ] **Step 1: 写失败测试**

创建 `src/app/api/pages/[...slug]/__tests__/route.test.ts`（vi.mock 模式，参考 `src/app/api/lint/latest/__tests__/route.test.ts`）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { serializeWikiDocument } from '@/server/wiki/markdown';
import type { WikiDocument } from '@/lib/contracts';

const mockGetPage = vi.fn();
const mockBacklinks = vi.fn(() => []);
const mockReadPage = vi.fn();
const mockResolve = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...a: unknown[]) => mockResolve(...a),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: (...a: unknown[]) => mockGetPage(...a),
  getBacklinks: (...a: unknown[]) => mockBacklinks(...a),
  findPageBySlugAcrossSubjects: () => [],
}));
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: (...a: unknown[]) => mockReadPage(...a),
}));

import { GET } from '../route';

function call(slug: string[]) {
  const req = new NextRequest(`http://localhost/api/pages/${slug.join('/')}`);
  return GET(req, { params: Promise.resolve({ slug }) });
}

const DOC: WikiDocument = {
  frontmatter: {
    title: 'Vector Spaces',
    created: '2026-01-01',
    updated: '2026-01-02',
    tags: ['math'],
    sources: [],
  },
  body: 'A **vector space** is a set with vectors.',
  links: [],
};

beforeEach(() => {
  mockGetPage.mockReset();
  mockBacklinks.mockReset().mockReturnValue([]);
  mockReadPage.mockReset();
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
});

describe('GET /api/pages/[...slug]', () => {
  it('页面存在时响应含 raw = serializeWikiDocument(doc)', async () => {
    mockGetPage.mockReturnValue({ slug: 'vector-spaces', title: 'Vector Spaces', tags: ['math'], createdAt: '2026-01-01', updatedAt: '2026-01-02' });
    mockReadPage.mockReturnValue(DOC);
    const res = await call(['vector-spaces']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toBe(serializeWikiDocument(DOC));
    expect(body.content).toBe(DOC.body);
  });

  it('页面不存在时仍返回 404（行为不变）', async () => {
    mockGetPage.mockReturnValue(null);
    const res = await call(['missing']);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run "src/app/api/pages/[...slug]/__tests__/route.test.ts"`
Expected: 第一个用例 FAIL（`body.raw` 为 undefined，因 GET 尚未返回 raw）。

- [ ] **Step 3: 实现 raw 字段**

修改 `src/app/api/pages/[...slug]/route.ts`：

a) 顶部 import 区追加：
```ts
import { serializeWikiDocument } from '@/server/wiki/markdown';
```

b) 把 GET 末尾的返回（现 `:64-74`）改为：
```ts
  const doc = readPageInSubject(subject.slug, slug);
  const backlinks = pagesRepo.getBacklinks(subject.id, slug);

  return NextResponse.json({
    ...page,
    content: doc?.body ?? '',
    raw: doc ? serializeWikiDocument(doc) : '',
    frontmatter: doc?.frontmatter ?? null,
    links: doc?.links ?? [],
    backlinks: backlinks.map((b) => ({
      slug: b.slug,
      title: b.title,
      subjectId: b.subjectId,
    })),
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run "src/app/api/pages/[...slug]/__tests__/route.test.ts"`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 6: 提交**

```bash
git add "src/app/api/pages/[...slug]/route.ts" "src/app/api/pages/[...slug]/__tests__/route.test.ts"
git commit -m "feat: GET /api/pages 增 raw 字段（整文件 markdown，供编辑器加载）"
```

---

### Task 2: 编辑器客户端（md-editor 封装 + page-editor + /edit 路由）

**Files:**
- Create: `src/components/wiki/md-editor.tsx`
- Create: `src/components/wiki/page-editor.tsx`
- Create: `src/app/(app)/wiki/[...slug]/edit/page.tsx`

**Interfaces:**
- Consumes: `GET /api/pages/<slug>` 的 `raw`/`title`（Task 1）、`PUT /api/pages/<slug>`（现成）、`useApiFetch`、`useCurrentSubject`、`Button`、`useUIStore().darkMode`。
- Produces: `MdEditor({ value, onChange, height? })`、`PageEditor({ slug })`、`/wiki/[...slug]/edit` 路由。

> 本任务无单测（项目无 DOM 测试环境）；交付物 = 可经直链 `/wiki/<slug>/edit` 跑通的编辑页，验收见 Step 5/6。

- [ ] **Step 1: 实现 `md-editor.tsx`**

创建 `src/components/wiki/md-editor.tsx`：

```tsx
'use client';

import dynamic from 'next/dynamic';
import { useUIStore } from '@/stores/ui-store';

// @uiw/react-md-editor 触碰 window，必须 ssr:false 且只在 client 组件内动态加载。
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

interface MdEditorProps {
  value: string;
  onChange: (next: string) => void;
  height?: number;
}

export function MdEditor({ value, onChange, height = 520 }: MdEditorProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  return (
    <div data-color-mode={darkMode ? 'dark' : 'light'}>
      <MDEditor
        value={value}
        onChange={(v) => onChange(v ?? '')}
        height={height}
        preview="live"
      />
    </div>
  );
}
```

- [ ] **Step 2: 实现 `page-editor.tsx`**

创建 `src/components/wiki/page-editor.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import { MdEditor } from './md-editor';

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

  // 受控编辑器：value 为 null 表示尚未编辑，回落到首次加载的 raw。
  const initialRaw = data?.raw ?? '';
  const current = value ?? initialRaw;
  const dirty = value !== null && value !== initialRaw;

  const save = useMutation({
    mutationFn: async () => {
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
    },
    onSuccess: async () => {
      await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
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
      <div className="max-w-content mx-auto px-6 py-8 w-full">
        <div className="h-8 w-40 rounded bg-subtle animate-pulse" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="max-w-content mx-auto px-6 py-8 w-full space-y-3">
        <p className="text-sm text-danger">Failed to load page for editing.</p>
        <Button intent="outline" onClick={() => router.push(readHref)}>Back to page</Button>
      </div>
    );
  }

  const canSave = current.trim() !== '' && dirty && !save.isPending;

  return (
    <div className="max-w-content mx-auto px-6 py-6 w-full space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-foreground-tertiary">Editing</p>
          <h1 className="text-lg font-semibold text-foreground truncate">{data?.title ?? slug}</h1>
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
        <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger whitespace-pre-wrap">
          {errorText}
        </div>
      )}

      <MdEditor value={current} onChange={(next) => setValue(next)} />
    </div>
  );
}
```

- [ ] **Step 3: 实现 `/edit` 路由壳**

创建 `src/app/(app)/wiki/[...slug]/edit/page.tsx`：

```tsx
import { PageEditor } from '@/components/wiki/page-editor';

export default async function EditPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  return <PageEditor slug={slug} />;
}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误（注意 `@uiw/react-md-editor` 的类型；若 `onChange` 签名不匹配，确认封装里 `(v) => onChange(v ?? '')` 已处理 `string | undefined`）。

- [ ] **Step 5: dev 直链验收**

```bash
npm run dev:all
```
直接访问 `http://localhost:3000/wiki/<某已存在页 slug>/edit`：
- 编辑器加载出整文件 markdown（含 frontmatter）。
- 改一处正文 → Save → 跳回 `/wiki/<slug>` 且看到更新。
- 改一个非法 wikilink（如 `[[根本不存在的页]]` 用错语法触发校验失败）→ Save → 顶部内联错误，留在编辑态。
- 有改动时点 Cancel → 弹确认；空内容时 Save 禁用。

- [ ] **Step 6: 提交**

```bash
git add src/components/wiki/md-editor.tsx src/components/wiki/page-editor.tsx "src/app/(app)/wiki/[...slug]/edit/page.tsx"
git commit -m "feat: 页面在线编辑页（/edit 路由 + md-editor 封装 + 保存走 PUT 重索引）"
```

---

### Task 3: 阅读页「Edit」入口按钮

**Files:**
- Modify: `src/components/wiki/frontmatter-display.tsx`（加 `editHref` prop + 标题行 Edit 按钮）
- Modify: `src/components/wiki/page-renderer.tsx`（透传 `editHref`）
- Modify: `src/app/(app)/wiki/[...slug]/page.tsx`（构造并传 `editHref`）

**Interfaces:**
- Consumes: `/wiki/<slug>/edit?s=<subjectSlug>`（Task 2 路由）。
- Produces: 阅读页标题行右侧的「Edit」`<Link>`。

- [ ] **Step 1: FrontmatterDisplay 加 editHref + Edit 按钮**

修改 `src/components/wiki/frontmatter-display.tsx`：

a) 顶部 import 追加：
```tsx
import Link from 'next/link';
import { Pencil } from 'lucide-react';
```

b) props 接口加字段：
```tsx
interface FrontmatterDisplayProps {
  title: string;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
  editHref?: string;
}
```

c) 函数签名解构加 `editHref`：
```tsx
export default function FrontmatterDisplay({
  title,
  tags,
  sources,
  created,
  updated,
  editHref,
}: FrontmatterDisplayProps) {
```

d) 把原 H1（`<h1 className="... mb-5 ...">{title}</h1>`，现 `:43-45`）替换为标题行 flex（H1 左、Edit 右）：
```tsx
      <div className="flex items-start justify-between gap-3 mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-prose-heading leading-tight">
          {title}
        </h1>
        {editHref && (
          <Link
            href={editHref}
            className="shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Link>
        )}
      </div>
```

- [ ] **Step 2: PageRenderer 透传 editHref**

修改 `src/components/wiki/page-renderer.tsx`：

a) `PageRendererProps` 接口加 `editHref?: string;`（放在 `titleSlugMap?` 旁）。

b) 函数签名解构加 `editHref`（与 `title` 等并列）。

c) FrontmatterDisplay 调用（现 `:66-72`）加 `editHref`：
```tsx
        <FrontmatterDisplay
          title={title}
          tags={tags}
          sources={sources}
          created={created}
          updated={updated}
          editHref={editHref}
        />
```

- [ ] **Step 3: 阅读页构造并传 editHref**

修改 `src/app/(app)/wiki/[...slug]/page.tsx` 的 `<PageRenderer .../>` 调用（现 `:90-100`），在末尾 `titleSlugMap={titleSlugMap}` 之后加一行：
```tsx
        editHref={`/wiki/${slug}/edit?s=${encodeURIComponent(subject.slug)}`}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 5: dev 验收**

`npm run dev:all`（若未运行）→ 打开任一 `/wiki/<slug>` 页：
- 标题右侧出现「Edit」按钮，点击进入 `/wiki/<slug>/edit?s=<subjectSlug>`。
- 编辑保存后跳回，内容更新。

- [ ] **Step 6: 提交**

```bash
git add src/components/wiki/frontmatter-display.tsx src/components/wiki/page-renderer.tsx "src/app/(app)/wiki/[...slug]/page.tsx"
git commit -m "feat: wiki 阅读页标题行加 Edit 入口按钮"
```

---

### Task 4: 文档与整体验收

**Files:**
- Modify: `src/app/CLAUDE.md`（GET raw 说明 + edit 页 + 文件树）
- Modify: `src/components/CLAUDE.md`（wiki/ 清单加 page-editor / md-editor）
- Modify: `CLAUDE.md`（根级 Changelog 追加一行）

- [ ] **Step 1: 更新 `src/app/CLAUDE.md`**

a) API 表 `/api/pages/[...slug]` GET 行说明末尾补：`；响应含整文件 raw 字段（供编辑器加载）`。

b) 页面表 `(app)/health/page.tsx` 行下方追加：
```markdown
| `(app)/wiki/[...slug]/edit/page.tsx` | 🆕 页面在线编辑：`@uiw/react-md-editor` 编辑整文件 markdown，保存走 `PUT /api/pages`（Saga 重索引）后跳回读页 |
```

c) 文件清单 `api/` 树无需改（pages 路由已在）；若有 `(app)/` 树则在 wiki 节点下补 `edit/page.tsx`。

- [ ] **Step 2: 更新 `src/components/CLAUDE.md`**

在 `wiki/` 组件清单（`page-renderer` 等所在处）追加两行说明：
```markdown
- `page-editor.tsx` —— 🆕 在线编辑容器：拉 raw → md-editor → Save(PUT)/Cancel → 失效缓存 + router.refresh + 跳回读页；错误内联、dirty 守卫
- `md-editor.tsx` —— 🆕 `@uiw/react-md-editor` 的 `dynamic(ssr:false)` 封装，data-color-mode 跟随 darkMode
```
并在 `frontmatter-display` 说明里补：标题行支持可选 `editHref` 渲染 Edit 按钮。

- [ ] **Step 3: 更新根 `CLAUDE.md` Changelog**

第九节变更记录表末尾追加：
```markdown
| 2026-06-21 | 页面在线编辑 | 阅读页加 Edit 入口 → 独立 `(app)/wiki/[...slug]/edit` 客户端编辑页（`@uiw/react-md-editor` 改整文件 raw markdown）；`GET /api/pages` 增 `raw` 字段（serializeWikiDocument）；保存走现成 `PUT`（Saga 重索引）+ 失效缓存 + router.refresh；spec/plan 见 docs/superpowers/{specs,plans}/2026-06-21-page-inline-editing* |
```

- [ ] **Step 4: 全量门禁（tsc + vitest）**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 无新增错误；全部 vitest 用例 PASS（含 Task 1 新增的 pages GET 路由测试）。
（`npm run lint` 在 BASE 即坏，按项目约定不作门禁。）

- [ ] **Step 5: 提交**

```bash
git add src/app/CLAUDE.md src/components/CLAUDE.md CLAUDE.md
git commit -m "docs: 记录页面在线编辑（/edit + GET raw 字段）"
```

---

## Self-Review

**1. Spec coverage（逐节核对 spec → task）：**
- spec §四 GET 增 raw → Task 1。✔
- spec §五 文件：md-editor.tsx / page-editor.tsx / edit/page.tsx → Task 2；route.ts GET → Task 1；read page editHref → Task 3。✔
- spec §六 组件契约 MdEditor / PageEditor 签名 → Task 2 完整代码。✔
- spec §七 状态（loading / editing / load-error）→ Task 2 page-editor 三分支。✔
- spec §八 边界：空内容禁用 Save（canSave）、PUT 400 内联（onError + errorText）、404/网络错误（isError 分支 + mutation onError）、meta 页可编辑（无特殊处理，天然支持）、全文 round-trip（编辑 raw、PUT 整文件）→ Task 1/2。✔
- spec §九 测试：GET raw 路由测试 → Task 1；组件 dev 验收 → Task 2/3 dev 步骤。✔
- spec §十 不变量：PUT/DELETE 不改（plan 未触）；api-fetch（useApiFetch GET / PUT body subjectId）；md-editor dynamic ssr:false in client（Task 2）；serializeWikiDocument 复用；深链 ?s=；门禁 tsc+vitest；ui 原语。✔

**2. Placeholder scan：** 无 TBD/TODO；每个 code step 均含完整代码与确切命令。✔

**3. Type consistency：**
- `serializeWikiDocument(doc)` 在 Task 1 GET 与其测试中签名一致（`@/server/wiki/markdown`）。
- `raw` 字段：Task 1 产出 `raw: string`，Task 2 page-editor 消费 `data.raw`，一致。
- `MdEditor({ value, onChange, height? })` Task 2 定义、page-editor 消费（`onChange={(next)=>setValue(next)}`）一致；`onChange` 归一化 `string | undefined → string`。
- `editHref?: string` 在 FrontmatterDisplay（定义）→ PageRenderer（透传）→ read page（构造传入）三处一致。
- INVALIDATE_KEYS 与 chat-interface 既有列表字面量一致；保存后 `router.refresh()` 对齐 server-rendered 读页。✔

> 说明：编辑器加载用 queryKey `['page-detail', subjectId, slug]`（与 context 面板单页 key 一致，复用缓存）；保存成功失效列表含 `'page-detail'`，故 context 面板与编辑页缓存均会刷新。

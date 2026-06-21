# 标签导航 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 LLM 生成的页面 tags 可导航：tag chips 可点 → 单标签页（带该 tag 的页列表）+ `/tags` 索引（所有 tag + 计数）+ 侧边栏入口。

**Architecture:** 纯客户端聚合——复用现成 `GET /api/pages`（已返回当前 subject 全部页含 tags），不加后端。聚合/过滤逻辑放纯函数 `src/lib/tags.ts`（可 node 单测）。新增共享 `<TagLink>`（prop 驱动、无 hooks，server/client 通用）替换 3 处只读 chip；新增 `/tags` 与 `/tags/[tag]` 客户端路由 + 侧边栏 Tags 入口。

**Tech Stack:** Next.js 15 App Router、React 19 + TanStack Query、Tailwind + 设计系统 `<Tag>`、vitest（node env，无 RTL）。

## Global Constraints

- **纯客户端聚合**：复用 `GET /api/pages`（已含 tags），**不新增后端接口、不改 schema**。
- **排除 `meta` 系统标签**：聚合/过滤/可点 chip 全程排除 `meta` 标签与带 meta 的系统页。
- **`<TagLink>` prop 驱动**：接收 `subjectSlug` 作为 prop（不调 hooks），以便在 Server Component（dashboard）与 Client Component（context panel）通用。
- 深链固定 `/tags/<encodeURIComponent(tag)>?s=<encodeURIComponent(subjectSlug)>`；页链接 `/wiki/<slug>?s=<subjectSlug>`。
- 客户端 HTTP 只用 `@/lib/api-fetch`：GET 用 `useApiFetch()`（自动注入 subjectId）。
- `src/lib/tags.ts` 为纯函数，类型从 `@/lib/contracts` 引入，不依赖 server/DB/Next。
- tag 不归一化（大小写按存储原样匹配）。
- 复用 `@/components/ui/tag` 的 `<Tag>`；颜色用 CSS 变量类。
- **门禁** = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，**不作门禁**。
- commit message 中文、一句话；**禁止**任何 AI 署名 trailer / "Generated with" 脚注 / Co-Authored-By。

---

### Task 1: 纯函数 `src/lib/tags.ts`

**Files:**
- Create: `src/lib/tags.ts`
- Test: `src/lib/__tests__/tags.test.ts`

**Interfaces:**
- Produces: `META_TAG = 'meta'`；`aggregateTags(pages: WikiPage[]): { tag: string; count: number }[]`（排除 meta 标签与 meta 系统页，按 count 降序、同 count tag 字母升序）；`pagesWithTag(pages: WikiPage[], tag: string): WikiPage[]`（排除 meta 系统页，区分大小写）。
- Consumes: `WikiPage`（`@/lib/contracts`，字段 `slug/title/path/summary/contentHash/tags: string[]/createdAt/updatedAt/subjectId`）。

- [ ] **Step 1: 写失败测试**

创建 `src/lib/__tests__/tags.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { aggregateTags, pagesWithTag, META_TAG } from '../tags';
import type { WikiPage } from '@/lib/contracts';

function page(slug: string, tags: string[]): WikiPage {
  return {
    slug,
    title: slug,
    path: `wiki/general/${slug}.md`,
    summary: '',
    contentHash: 'h',
    tags,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    subjectId: 's1',
  };
}

describe('aggregateTags', () => {
  it('计数并按 count 降序、同 count 字母升序', () => {
    const pages = [
      page('a', ['math', 'algebra']),
      page('b', ['math']),
      page('c', ['algebra']),
      page('d', ['zzz']),
    ];
    // math:2, algebra:2, zzz:1 → 同 count 字母序 algebra 在 math 前
    expect(aggregateTags(pages)).toEqual([
      { tag: 'algebra', count: 2 },
      { tag: 'math', count: 2 },
      { tag: 'zzz', count: 1 },
    ]);
  });

  it('排除 meta 标签本身', () => {
    const pages = [page('a', ['math', META_TAG]), page('b', ['math'])];
    expect(aggregateTags(pages)).toEqual([{ tag: 'math', count: 2 }]);
  });

  it('排除带 meta 标签的系统页（其所有标签都不计入）', () => {
    const pages = [page('index', [META_TAG, 'overview']), page('b', ['overview'])];
    expect(aggregateTags(pages)).toEqual([{ tag: 'overview', count: 1 }]);
  });

  it('空输入返回 []', () => {
    expect(aggregateTags([])).toEqual([]);
  });
});

describe('pagesWithTag', () => {
  it('返回含该 tag 的内容页', () => {
    const pages = [page('a', ['math']), page('b', ['algebra']), page('c', ['math', 'algebra'])];
    expect(pagesWithTag(pages, 'math').map((p) => p.slug)).toEqual(['a', 'c']);
  });

  it('排除带 meta 的系统页', () => {
    const pages = [page('index', [META_TAG, 'math']), page('a', ['math'])];
    expect(pagesWithTag(pages, 'math').map((p) => p.slug)).toEqual(['a']);
  });

  it('区分大小写；未知 tag 返回 []', () => {
    const pages = [page('a', ['Math'])];
    expect(pagesWithTag(pages, 'math')).toEqual([]);
    expect(pagesWithTag(pages, 'nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/__tests__/tags.test.ts`
Expected: FAIL —「Cannot find module '../tags'」。

- [ ] **Step 3: 实现 `tags.ts`**

创建 `src/lib/tags.ts`：

```ts
import type { WikiPage } from '@/lib/contracts';

export const META_TAG = 'meta';

function isMetaPage(page: WikiPage): boolean {
  return (page.tags ?? []).includes(META_TAG);
}

/**
 * 聚合内容页的标签计数。排除 meta 系统页与 meta 标签本身。
 * 排序：count 降序，同 count 按 tag 字母升序。
 */
export function aggregateTags(pages: WikiPage[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    if (isMetaPage(page)) continue;
    for (const tag of page.tags ?? []) {
      if (tag === META_TAG) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** 返回带指定 tag 的内容页（排除 meta 系统页）；区分大小写按原样匹配。 */
export function pagesWithTag(pages: WikiPage[], tag: string): WikiPage[] {
  return pages.filter((page) => !isMetaPage(page) && (page.tags ?? []).includes(tag));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/lib/__tests__/tags.test.ts`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/tags.ts src/lib/__tests__/tags.test.ts
git commit -m "feat: 标签聚合/过滤纯函数 aggregateTags/pagesWithTag"
```

---

### Task 2: `<TagLink>` 组件 + 三处 chip 改为可点

**Files:**
- Create: `src/components/wiki/tag-link.tsx`
- Modify: `src/components/layout/context-panel-context-tab.tsx`
- Modify: `src/app/(app)/page.tsx`（dashboard 最近页 chip）
- Modify: `src/components/wiki/frontmatter-display.tsx`（加 `subjectSlug` prop + chip 改 TagLink）
- Modify: `src/components/wiki/page-renderer.tsx`（透传 `subjectSlug`）
- Modify: `src/app/(app)/wiki/[...slug]/page.tsx`（传 `subjectSlug`）

**Interfaces:**
- Produces: `TagLink({ tag, subjectSlug, tone?, size? })`。
- Consumes: `Tag`/`TagProps`（`@/components/ui/tag`）、`useCurrentSubject().slug`（context panel）、`META_TAG`（`@/lib/tags`，用于过滤；或直接字面量 `'meta'`）。

> 无单测（项目无 DOM 测试环境）；门禁 = `npx tsc --noEmit`，验收见 Step 7。

- [ ] **Step 1: 实现 `tag-link.tsx`**

创建 `src/components/wiki/tag-link.tsx`：

```tsx
import Link from 'next/link';
import { Tag, type TagProps } from '@/components/ui/tag';

interface TagLinkProps {
  tag: string;
  subjectSlug: string;
  tone?: TagProps['tone'];
  size?: TagProps['size'];
}

/**
 * 可点 tag chip：链接到 /tags/<tag>?s=<subjectSlug>。
 * prop 驱动（不调 hooks），可在 Server / Client Component 通用。
 */
export function TagLink({ tag, subjectSlug, tone = 'neutral', size }: TagLinkProps) {
  const href = `/tags/${encodeURIComponent(tag)}?s=${encodeURIComponent(subjectSlug)}`;
  return (
    <Link href={href} className="rounded-sm hover:opacity-80 transition-opacity focus-ring">
      <Tag tone={tone} size={size}>{tag}</Tag>
    </Link>
  );
}
```

- [ ] **Step 2: context-panel-context-tab 改为 TagLink**

修改 `src/components/layout/context-panel-context-tab.tsx`：

a) 顶部 import 追加：
```tsx
import { TagLink } from '@/components/wiki/tag-link';
```
（`useCurrentSubject` 已 import。）

b) 把 `const { id: subjectId } = useCurrentSubject();`（约 `:56`）改为：
```tsx
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();
```

c) 把 Tags 的 `<dd>`（约 `:116-122`）里的 map 替换为（过滤 meta + 用 TagLink）：
```tsx
                  <dd className="flex flex-wrap gap-1">
                    {fm.tags.filter((t) => t !== 'meta').map((t) => (
                      <TagLink key={t} tag={t} subjectSlug={subjectSlug} />
                    ))}
                  </dd>
```
（如该文件已不再使用 `Tag` import，删除以免未用 import；若别处仍用则保留。）

- [ ] **Step 3: dashboard 最近页 chip 改为 TagLink**

修改 `src/app/(app)/page.tsx`：

a) 顶部 import 追加：
```tsx
import { TagLink } from '@/components/wiki/tag-link';
```

b) 把最近页卡片里的 tag 块（约 `:138-146`）替换为（`subject` 是 `DashboardPage` 内 `await resolveActiveSubject()` 的结果，含 `.slug`）：
```tsx
                  {page.tags && page.tags.filter((t) => t !== 'meta').length > 0 && (
                    <span className="hidden lg:flex gap-1 shrink-0">
                      {page.tags.filter((t) => t !== 'meta').slice(0, 2).map((t) => (
                        <TagLink key={t} tag={t} subjectSlug={subject.slug} />
                      ))}
                    </span>
                  )}
```
（若 `Tag` 已无其他用处则删 import。）

- [ ] **Step 4: frontmatter-display 加 subjectSlug + chip 改 TagLink**

修改 `src/components/wiki/frontmatter-display.tsx`：

a) 顶部 import 追加：
```tsx
import { TagLink } from '@/components/wiki/tag-link';
```

b) props 接口加字段（与现有 `editHref?` 并列）：
```tsx
  subjectSlug?: string;
```

c) 函数签名解构加 `subjectSlug`。

d) Tags 的 `<dd>` 里的 map（现 `<Tag key={t} tone="neutral" size="base">{t}</Tag>`）替换为：
```tsx
              <dd className="flex flex-wrap gap-1">
                {tags.filter((t) => t !== 'meta').map((t) =>
                  subjectSlug ? (
                    <TagLink key={t} tag={t} subjectSlug={subjectSlug} size="base" />
                  ) : (
                    <Tag key={t} tone="neutral" size="base">{t}</Tag>
                  ),
                )}
              </dd>
```
（保留 `Tag` import，fallback 分支仍用。）

- [ ] **Step 5: PageRenderer 透传 subjectSlug**

修改 `src/components/wiki/page-renderer.tsx`：

a) `PageRendererProps` 接口加 `subjectSlug?: string;`（放在 `editHref?` 旁）。

b) 函数签名解构加 `subjectSlug`。

c) `<FrontmatterDisplay ... editHref={editHref} />` 调用加 `subjectSlug={subjectSlug}`：
```tsx
        <FrontmatterDisplay
          title={title}
          tags={tags}
          sources={sources}
          created={created}
          updated={updated}
          editHref={editHref}
          subjectSlug={subjectSlug}
        />
```

- [ ] **Step 6: wiki 阅读页传 subjectSlug**

修改 `src/app/(app)/wiki/[...slug]/page.tsx` 的 `<PageRenderer .../>` 调用，在 `editHref={...}` 之后加：
```tsx
        subjectSlug={subject.slug}
```

- [ ] **Step 7: 类型检查 + dev 验收**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

dev 验收（`npm run dev:all`）：阅读页/右侧面板/首页最近页的 tag chip 均可点 → 跳 `/tags/<tag>?s=<subjectSlug>`（路由在 Task 3 落地后才有内容；此步先确认 chip 变成链接且 href 正确，可 hover 看地址）。

- [ ] **Step 8: 提交**

```bash
git add src/components/wiki/tag-link.tsx src/components/layout/context-panel-context-tab.tsx "src/app/(app)/page.tsx" src/components/wiki/frontmatter-display.tsx src/components/wiki/page-renderer.tsx "src/app/(app)/wiki/[...slug]/page.tsx"
git commit -m "feat: TagLink 组件 + 阅读页/上下文面板/首页 tag chip 改为可点"
```

---

### Task 3: `/tags` 索引 + `/tags/[tag]` 路由 + 侧边栏入口

**Files:**
- Create: `src/components/tags/tags-index-view.tsx`
- Create: `src/components/tags/tag-pages-view.tsx`
- Create: `src/app/(app)/tags/page.tsx`
- Create: `src/app/(app)/tags/[tag]/page.tsx`
- Modify: `src/components/layout/sidebar.tsx`（footer 加 Tags 入口）

**Interfaces:**
- Consumes: `aggregateTags` / `pagesWithTag`（Task 1）、`TagLink`（Task 2）、`useApiFetch`、`useCurrentSubject`、`WikiPage`（contracts）。

> 无单测；门禁 = `npx tsc --noEmit`，验收见 Step 6。

- [ ] **Step 1: 实现 `tags-index-view.tsx`**

创建 `src/components/tags/tags-index-view.tsx`：

```tsx
'use client';

import { Hash } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { aggregateTags } from '@/lib/tags';
import { TagLink } from '@/components/wiki/tag-link';
import type { WikiPage } from '@/lib/contracts';

export function TagsIndexView() {
  const apiFetch = useApiFetch();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) return [] as WikiPage[];
      return (await res.json()) as WikiPage[];
    },
    enabled: !!subjectId,
    staleTime: 30_000,
  });

  const tags = aggregateTags(pages);

  return (
    <div className="max-w-content mx-auto px-6 py-8 w-full space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
          <Hash className="h-5 w-5 text-foreground-tertiary" />
          Tags
        </h1>
        <p className="mt-1 text-sm text-foreground-secondary">
          Browse pages by tag in this subject.
        </p>
      </header>

      {isLoading ? (
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-7 w-20 rounded-sm bg-subtle animate-pulse" />
          ))}
        </div>
      ) : tags.length === 0 ? (
        <p className="text-sm text-foreground-tertiary italic">No tags yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {tags.map(({ tag, count }) => (
            <li key={tag} className="inline-flex items-center gap-1">
              <TagLink tag={tag} subjectSlug={subjectSlug} size="base" />
              <span className="text-xs text-foreground-tertiary tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 实现 `tag-pages-view.tsx`**

创建 `src/components/tags/tag-pages-view.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { Hash } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { pagesWithTag } from '@/lib/tags';
import type { WikiPage } from '@/lib/contracts';

export function TagPagesView({ tag }: { tag: string }) {
  const apiFetch = useApiFetch();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) return [] as WikiPage[];
      return (await res.json()) as WikiPage[];
    },
    enabled: !!subjectId,
    staleTime: 30_000,
  });

  const matched = pagesWithTag(pages, tag);

  return (
    <div className="max-w-content mx-auto px-6 py-8 w-full space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
          <Hash className="h-5 w-5 text-foreground-tertiary" />
          {tag}
        </h1>
        <Link href="/tags" className="mt-1 inline-block text-sm text-accent hover:underline">
          ← All tags
        </Link>
      </header>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-9 rounded-md bg-subtle animate-pulse" />
          ))}
        </div>
      ) : matched.length === 0 ? (
        <p className="text-sm text-foreground-tertiary italic">No pages with this tag.</p>
      ) : (
        <ul className="space-y-0.5">
          {matched.map((p) => (
            <li key={p.slug}>
              <Link
                href={`/wiki/${p.slug}?s=${encodeURIComponent(subjectSlug)}`}
                className="flex items-center gap-2 h-9 px-3 rounded-md text-sm text-foreground hover:bg-subtle transition-colors focus-ring"
              >
                {p.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 实现路由壳**

创建 `src/app/(app)/tags/page.tsx`：
```tsx
import { TagsIndexView } from '@/components/tags/tags-index-view';

export default function TagsPage() {
  return <TagsIndexView />;
}
```

创建 `src/app/(app)/tags/[tag]/page.tsx`：
```tsx
import { TagPagesView } from '@/components/tags/tag-pages-view';

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return <TagPagesView tag={decodeURIComponent(tag)} />;
}
```

- [ ] **Step 4: 侧边栏 Tags 入口**

修改 `src/components/layout/sidebar.tsx`：

a) lucide import 追加 `Hash`（与 `Activity` 等并列）。

b) 在 footer 的 Health `<Link>` 之后、page 计数行之前，加一个 Tags 入口 `<Link>`（与 Health 同款样式）：
```tsx
        <Link
          href="/tags"
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-2 h-8 px-2 rounded-md text-sm transition-colors focus-ring',
            pathname.startsWith('/tags')
              ? 'bg-subtle text-foreground font-medium'
              : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
          )}
        >
          <Hash className="h-3.5 w-3.5 text-foreground-tertiary" />
          Tags
        </Link>
```
（`pathname` 已在组件内 `usePathname()`；`cn` 已 import。）

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 6: dev 验收**

`npm run dev:all`：
- 侧边栏点「Tags」→ `/tags` 显示所有 tag + 计数。
- 点某 tag → `/tags/<tag>` 列出带该 tag 的页；点页 → 跳 `/wiki/<slug>`。
- 阅读页/面板/首页的 chip 点击也到对应 `/tags/<tag>`。
- 无 tag 的 subject → 「No tags yet.」；不存在的 tag URL → 「No pages with this tag.」。

- [ ] **Step 7: 提交**

```bash
git add src/components/tags/tags-index-view.tsx src/components/tags/tag-pages-view.tsx "src/app/(app)/tags/page.tsx" "src/app/(app)/tags/[tag]/page.tsx" src/components/layout/sidebar.tsx
git commit -m "feat: /tags 索引 + /tags/[tag] 页 + 侧边栏 Tags 入口"
```

---

### Task 4: 文档与整体验收

**Files:**
- Modify: `src/app/CLAUDE.md`（页面表加 tags 路由）
- Modify: `src/components/CLAUDE.md`（tags/ + tag-link）
- Modify: `CLAUDE.md`（根级 Changelog 追加一行）

- [ ] **Step 1: 更新 `src/app/CLAUDE.md`**

页面表追加两行：
```markdown
| `(app)/tags/page.tsx` | 🆕 标签索引：列出当前 subject 所有 tag + 页计数（客户端聚合 /api/pages）|
| `(app)/tags/[tag]/page.tsx` | 🆕 单标签页：列出带该 tag 的页 |
```

- [ ] **Step 2: 更新 `src/components/CLAUDE.md`**

在 `wiki/` 清单加：
```markdown
- `tag-link.tsx` —— 🆕 可点 tag chip（Link 包 Tag，prop 驱动 subjectSlug，链到 /tags/<tag>?s=）
```
新增 `tags/` 小节：
```markdown
### `tags/`
- `tags-index-view.tsx` —— 🆕 标签索引（aggregateTags(/api/pages) → tag+count）
- `tag-pages-view.tsx` —— 🆕 单标签页列表（pagesWithTag）
```

- [ ] **Step 3: 更新根 `CLAUDE.md` Changelog**

第九节表末尾追加：
```markdown
| 2026-06-21 | 标签导航 | tag chips 全部可点（共享 TagLink）→ `/tags/<tag>` 单标签页 + `/tags` 索引（纯函数 aggregateTags/pagesWithTag 客户端聚合 /api/pages，排除 meta）+ 侧边栏 Tags 入口；spec/plan 见 docs/superpowers/{specs,plans}/2026-06-21-tag-navigation* |
```

- [ ] **Step 4: 全量门禁（tsc + vitest）**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 无新增错误；全部 vitest 用例 PASS（含 Task 1 新增的 tags 纯函数测试）。
（`npm run lint` 在 BASE 即坏，按项目约定不作门禁。）

- [ ] **Step 5: 提交**

```bash
git add src/app/CLAUDE.md src/components/CLAUDE.md CLAUDE.md
git commit -m "docs: 记录标签导航（/tags + TagLink）"
```

---

## Self-Review

**1. Spec coverage（逐节核对 spec → task）：**
- spec §二 界面①可点 chips → Task 2；②/tags/<tag> → Task 3；③/tags 索引 → Task 3；④侧边栏入口 → Task 3。✔
- spec §四 纯函数契约 aggregateTags/pagesWithTag → Task 1。✔
- spec §五 文件：tags.ts(T1)、tag-link(T2)、tags/page + tags/[tag]/page + 2 views(T3)、frontmatter/context-panel/dashboard chip 改造(T2)、sidebar(T3)。✔
- spec §六 UI 行为（索引计数、单标签列表、空态、sidebar active）→ T3。✔
- spec §七 边界：decodeURIComponent（T3 路由壳）、未知 tag 空态（T3 view）、meta 排除（T1 纯函数 + T2 chip filter）、大小写区分（T1）。✔
- spec §八 测试：tags.ts 纯函数 → T1；组件 dev 验收 → T2/T3。✔
- spec §九 不变量：无新后端/不改 /api/pages（plan 未触）；useApiFetch GET；TagLink prop 驱动 subjectSlug；深链风格；tags.ts 纯 node 可测；门禁 tsc+vitest；复用 Tag。✔

**2. Placeholder scan：** 无 TBD/TODO；每个 code step 均含完整代码与确切命令。✔

**3. Type consistency：**
- `aggregateTags(pages): {tag,count}[]` / `pagesWithTag(pages, tag): WikiPage[]` / `META_TAG` 在 T1 定义，T3 views 消费一致。
- `TagLink({ tag, subjectSlug, tone?, size? })` 在 T2 定义，T2 三处 + T3 两 views 消费一致（均传 `subjectSlug`）。
- `subjectSlug?: string` 在 frontmatter-display（定义）→ page-renderer（透传）→ wiki 页（传 `subject.slug`）三处一致。
- 两 views 复用 queryKey `['pages', subjectId]`（与 sidebar 同 key，复用缓存）。
- chip 过滤 meta 用字面量 `'meta'`（与 `META_TAG='meta'` 同值）；纯函数侧用 `META_TAG`。✔

> 说明：TagLink 不加 `'use client'`——它仅组合 Link + Tag、无 hooks，可被 Server Component（dashboard、wiki 页经 frontmatter-display 实际是 client）与 Client Component 共同 import；Tag 自身的 'use client' 边界由 Next 处理。

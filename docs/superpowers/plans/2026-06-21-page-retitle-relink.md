# 页面改标题 + 引用联动（Retitle & Relink）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改页面 frontmatter 标题时，把本 subject 内正文中以旧标题书写的 `[[Old Title]]` 引用，在同一个 Saga 事务里重写为 `[[New Title]]`；slug/URL/文件全程不动。

**Architecture:** 新增纯函数 `rewriteBacklinkText`（用现成 `extractWikiLinks` 拿 link + position，仅替换匹配旧标题的 target 文本）。把它接进现有 `PUT /api/pages/[...slug]`：检测标题变化 → 收集同 subject backlink 源页 → 重写 → 把重写后的源页作为额外 `update` 条目追加到同一 changeset，一次原子提交，返回 `referencesUpdated`。编辑器保存成功后据此弹 toast。

**Tech Stack:** TypeScript 5、Next.js 15 App Router（Route Handler）、Vitest（node 环境）、Zod、gray-matter、TanStack React Query、@uiw/react-md-editor（既有）。

## Global Constraints

- **不改 DB schema、不改 slug / 文件路径 / URL、不动 `page_aliases`。**
- 复用 `extractWikiLinks`（`@/server/wiki/wikilinks`，wikilink 唯一真实源）与 `serializeWikiDocument`（`@/server/wiki/markdown`，round-trip 真相）；**不复刻链接解析**。
- 写操作走现有**同步** Saga 路径：`createChangeset → validateChangeset → applyChangeset`；所有 changeset 条目必须同一 subject、同一事务（失败自动 rollback）。
- PUT 顶部沿用 `requireAuth(request)` + `requireCsrf(request)` + `resolveSubjectFromRequest(request, { body })`。
- 客户端只用 `@/lib/api-fetch` 的 `useApiFetch()`；PUT body 显式带 `subjectId`（编辑器已如此）。
- 跨主题引用（来自别的 subject 的 `[[本subject:Old Title]]`）**不重写**；meta 系统页（`getBacklinks` 已排除）**不重写**。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，**非门禁**。
- commit message 用**中文**、一句话总结；**禁止**任何 AI 署名 trailer / "Generated with…" 脚注。

---

### Task 1: `rewriteBacklinkText` 纯函数

**Files:**
- Create: `src/server/wiki/relink.ts`
- Test: `src/server/wiki/__tests__/relink.test.ts`

**Interfaces:**
- Consumes: `extractWikiLinks(markdown: string, opts: { currentSubjectSlug?: string }): ExtractedLink[]` from `./wikilinks`。`ExtractedLink` 字段：`{ raw: string; rawTitle: string; target: string; targetSubjectSlug: string; alias: string | null; position: { start: number; end: number } }`。
- Produces: `rewriteBacklinkText(raw: string, oldTitle: string, newTitle: string, subjectSlug: string): string`。

> 关键设计：用 `extractWikiLinks` 取每个 `[[…]]` token 的 `raw` / `rawTitle` / `targetSubjectSlug` / `position`；筛出 `rawTitle`（去前缀/锚点/别名后的 target 文本，已 trim）忽略大小写 == `oldTitle` 且指向本 subject 的 token；对每个 token 用 `token.raw.replace(token.rawTitle, () => newTitle)` 替换**首个** target 文本出现处（天然保留 subject 前缀、`#锚点`、`|别名`，因为它们都在首个 target 文本之后），再按 `position` **从右往左**回填到原串。`extractWikiLinks` 已对 code fence / 行内 code 做等长 mask，故代码块内的 `[[…]]` 不会被改，且 position 偏移不受影响。

- [ ] **Step 1: 写失败测试**

创建 `src/server/wiki/__tests__/relink.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { rewriteBacklinkText } from '../relink';

const SUBJECT = 'general';

describe('rewriteBacklinkText', () => {
  it('重写 title-form [[Old Title]] → [[New Title]]', () => {
    const out = rewriteBacklinkText('see [[Old Title]] here', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('see [[New Title]] here');
  });

  it('小写 [[old title]] 也重写（忽略大小写匹配）', () => {
    const out = rewriteBacklinkText('[[old title]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[New Title]]');
  });

  it('保留别名 [[Old Title|看这里]] → [[New Title|看这里]]', () => {
    const out = rewriteBacklinkText('[[Old Title|看这里]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[New Title|看这里]]');
  });

  it('保留锚点 [[Old Title#用法]] → [[New Title#用法]]', () => {
    const out = rewriteBacklinkText('[[Old Title#用法]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[New Title#用法]]');
  });

  it('保留锚点+别名 [[Old Title#用法|看]] → [[New Title#用法|看]]', () => {
    const out = rewriteBacklinkText('[[Old Title#用法|看]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[New Title#用法|看]]');
  });

  it('slug-form [[old-title]] 不动（rawTitle 非旧标题）', () => {
    const out = rewriteBacklinkText('[[old-title]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[old-title]]');
  });

  it('跨主题前缀 [[other:Old Title]] 不动', () => {
    const out = rewriteBacklinkText('[[other:Old Title]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[other:Old Title]]');
  });

  it('显式本-subject 前缀 [[general:Old Title]] 重写并保留前缀', () => {
    const out = rewriteBacklinkText('[[general:Old Title]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[general:New Title]]');
  });

  it('同段多处混合：title-form 改、slug-form 不改、多处不串位', () => {
    const input = 'A [[Old Title]] B [[old-title]] C [[Old Title|x]] D';
    const out = rewriteBacklinkText(input, 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('A [[New Title]] B [[old-title]] C [[New Title|x]] D');
  });

  it('code fence 内的 [[Old Title]] 不改', () => {
    const input = '```\n[[Old Title]]\n```\n[[Old Title]]';
    const out = rewriteBacklinkText(input, 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('```\n[[Old Title]]\n```\n[[New Title]]');
  });

  it('行内 code 内的 [[Old Title]] 不改', () => {
    const input = '`[[Old Title]]` and [[Old Title]]';
    const out = rewriteBacklinkText(input, 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('`[[Old Title]]` and [[New Title]]');
  });

  it('无匹配返回原串', () => {
    const input = 'nothing to see [[Other Page]]';
    const out = rewriteBacklinkText(input, 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe(input);
  });

  it('空旧标题返回原串', () => {
    const out = rewriteBacklinkText('[[Old Title]]', '   ', 'New Title', SUBJECT);
    expect(out).toBe('[[Old Title]]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/wiki/__tests__/relink.test.ts`
Expected: FAIL —— 形如 `Failed to resolve import "../relink"` 或 `rewriteBacklinkText is not a function`。

- [ ] **Step 3: 写最小实现**

创建 `src/server/wiki/relink.ts`：

```ts
/**
 * 改页面标题时，把别处正文里以「旧标题」书写的同-subject wikilink 文本刷成新标题。
 * 纯函数、无副作用。详见 docs/superpowers/specs/2026-06-21-page-retitle-relink-design.md。
 */
import { extractWikiLinks } from './wikilinks';

/**
 * 重写整文件 raw markdown 里指向旧标题的同-subject wikilink。
 *
 * 规则：仅当某 [[…]] 的 target 文本（rawTitle，去 subject 前缀 / #锚点 / |别名 后，已 trim）
 * 忽略大小写等于 oldTitle，且该链接指向本 subject（无前缀，或前缀 == subjectSlug）时，
 * 把其 target 文本替换为 newTitle，保留 subject 前缀、#锚点、|别名。slug-form / 跨主题 / 代码块内
 * 的链接一律不动。按 position 从右往左替换以保持偏移正确。无匹配返回原串。
 */
export function rewriteBacklinkText(
  raw: string,
  oldTitle: string,
  newTitle: string,
  subjectSlug: string,
): string {
  const oldKey = oldTitle.trim().toLowerCase();
  if (oldKey === '') return raw;

  const links = extractWikiLinks(raw, { currentSubjectSlug: subjectSlug });
  const matches = links
    .filter(
      (l) =>
        l.rawTitle.trim().toLowerCase() === oldKey &&
        (!l.targetSubjectSlug || l.targetSubjectSlug === subjectSlug),
    )
    // 从右往左替换，避免前面 token 的 position 偏移被破坏
    .sort((a, b) => b.position.start - a.position.start);

  let result = raw;
  for (const link of matches) {
    // 替换首个 target 文本出现处；前缀/锚点/别名都在其后，天然保留。
    const newToken = link.raw.replace(link.rawTitle, () => newTitle);
    result =
      result.slice(0, link.position.start) +
      newToken +
      result.slice(link.position.end);
  }
  return result;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/wiki/__tests__/relink.test.ts`
Expected: PASS —— 13 个用例全绿。

- [ ] **Step 5: 门禁 + 提交**

Run: `npx tsc --noEmit`（Expected: 无输出 / exit 0）
Run: `npx vitest run`（Expected: 全部既有用例 + 新增 relink 用例通过）

```bash
git add src/server/wiki/relink.ts src/server/wiki/__tests__/relink.test.ts
git commit -m "feat: 新增 rewriteBacklinkText 纯函数（改标题时重写同 subject backlink 文本）"
```

---

### Task 2: `PUT /api/pages/[...slug]` 检测标题变化并联动重写

**Files:**
- Modify: `src/app/api/pages/[...slug]/route.ts`（`UpdatePageSchema` 第 17-19 行；`PUT` 第 79-128 行）

**Interfaces:**
- Consumes: `rewriteBacklinkText(raw, oldTitle, newTitle, subjectSlug): string`（Task 1）；`parseFrontmatter(content): { data: WikiFrontmatter; body: string }`（`@/server/wiki/frontmatter`，`data.title` 恒为 string，缺省 `''`）；`pagesRepo.getBacklinks(subjectId, slug): WikiPage[]`（已排除 meta 页，`WikiPage` 含 `subjectId` / `slug` / `title`）；`readPageInSubject`、`serializeWikiDocument`、`buildWikiPath`、`createChangeset`、`validateChangeset`、`applyChangeset`（均已在本文件 import）；`ChangesetEntry` from `@/lib/contracts`。
- Produces: `PUT` 响应体 `{ ok: true; slug: string; subjectId: string; referencesUpdated: number }`。`UpdatePageSchema` 接受可选 `refreshReferences?: boolean`（默认 true）。

> 无独立单测：PUT 调真实 Saga（fs+git+db），mock 全链路与收益不成比例，且核心重写逻辑已被 Task 1 全覆盖。本任务验收 = `tsc` 干净 + 既有 `vitest` 全绿 + dev 眼测（与特性②给 PUT 加 `raw` 字段时一致）。

- [ ] **Step 1: 扩展 import 与 schema**

在 `src/app/api/pages/[...slug]/route.ts` 顶部 import 区追加：

```ts
import { parseFrontmatter } from '@/server/wiki/frontmatter';
import { rewriteBacklinkText } from '@/server/wiki/relink';
import type { ChangesetEntry } from '@/lib/contracts';
```

把 `UpdatePageSchema`（现为）：

```ts
const UpdatePageSchema = z.object({
  content: z.string().min(1),
});
```

改为：

```ts
const UpdatePageSchema = z.object({
  content: z.string().min(1),
  refreshReferences: z.boolean().optional(),
});
```

- [ ] **Step 2: 改写 PUT 的 changeset 组装**

把 PUT 里「构造单条 changeset → validate → apply → 返回」这一段（现为第 110-127 行）：

```ts
  const changeset = createChangeset(crypto.randomUUID(), subject, [
    {
      action: 'update',
      path: buildWikiPath(subject.slug, slug),
      content: parsed.data.content,
    },
  ]);

  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    return NextResponse.json(
      { error: 'Changeset validation failed', details: validation.errors },
      { status: 400 },
    );
  }

  await applyChangeset(changeset);
  return NextResponse.json({ ok: true, slug, subjectId: subject.id });
```

替换为：

```ts
  const oldTitle = existing.title;
  const newTitle = parseFrontmatter(parsed.data.content).data.title;

  const entries: ChangesetEntry[] = [
    {
      action: 'update',
      path: buildWikiPath(subject.slug, slug),
      content: parsed.data.content,
    },
  ];

  // 标题变了且开启联动时，把本 subject 内以旧标题书写的引用一并重写进同一事务。
  let referencesUpdated = 0;
  const refresh = parsed.data.refreshReferences ?? true;
  if (refresh && newTitle && newTitle !== oldTitle) {
    const backlinks = pagesRepo
      .getBacklinks(subject.id, slug)
      .filter((b) => b.subjectId === subject.id);
    for (const bl of backlinks) {
      const doc = readPageInSubject(subject.slug, bl.slug);
      if (!doc) continue;
      const sourceRaw = serializeWikiDocument(doc);
      const rewritten = rewriteBacklinkText(sourceRaw, oldTitle, newTitle, subject.slug);
      if (rewritten !== sourceRaw) {
        entries.push({
          action: 'update',
          path: buildWikiPath(subject.slug, bl.slug),
          content: rewritten,
        });
        referencesUpdated += 1;
      }
    }
  }

  const changeset = createChangeset(crypto.randomUUID(), subject, entries);

  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    return NextResponse.json(
      { error: 'Changeset validation failed', details: validation.errors },
      { status: 400 },
    );
  }

  await applyChangeset(changeset);
  return NextResponse.json({ ok: true, slug, subjectId: subject.id, referencesUpdated });
```

- [ ] **Step 3: 门禁**

Run: `npx tsc --noEmit`
Expected: 无输出 / exit 0（确认 `ChangesetEntry`、`parseFrontmatter`、`rewriteBacklinkText` 类型均匹配）。

Run: `npx vitest run`
Expected: 全部既有用例通过（本任务不新增用例，确认无回归）。

- [ ] **Step 4: 提交**

```bash
git add src/app/api/pages/[...slug]/route.ts
git commit -m "feat: PUT /api/pages 改标题时同事务重写本 subject 引用并返回 referencesUpdated"
```

---

### Task 3: 编辑器保存后提示「同步更新了 N 处引用」

**Files:**
- Modify: `src/components/wiki/page-editor.tsx`（`save` mutation 第 39-58 行）

**Interfaces:**
- Consumes: `PUT /api/pages/<slug>` 响应体 `{ ok: true; referencesUpdated: number; ... }`（Task 2）。
- Produces: 无对外接口；仅在保存成功且 `referencesUpdated > 0` 时设置一条内联成功提示文案，跳回阅读页前展示。

> 无单测：React 组件，项目无 DOM 测试环境；验收 = `tsc` 干净 + dev 眼测。沿用现有 `errorText` 内联提示的同款样式做成功提示，**不引第三方 toast 库**（YAGNI）。

- [ ] **Step 1: mutation 解析并暂存 referencesUpdated**

把 `save` mutation（现为第 39-58 行）：

```ts
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
```

替换为（`mutationFn` 返回 `referencesUpdated`；`onSuccess` 据此设置提示）：

```ts
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
```

> 说明：保存成功后立即 `router.push(readHref)` 卸载编辑器，原地 toast 来不及看到，故把提示文案暂存 `sessionStorage`，由阅读页读取并展示一次。Task 3 仅负责写入；读取展示见 Step 2（放阅读页的轻量客户端组件）。

- [ ] **Step 2: 阅读页消费提示（一次性内联 banner）**

创建 `src/components/wiki/retitle-notice.tsx`：

```tsx
'use client';

import { useEffect, useState } from 'react';

const KEY = 'wiki:retitle-notice';

/** 读取并一次性展示编辑器写入的「引用已联动更新」提示；展示后清除。 */
export function RetitleNotice() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem(KEY);
    if (stored) {
      setMessage(stored);
      sessionStorage.removeItem(KEY);
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, []);

  if (!message) return null;

  return (
    <div className="max-w-content mx-auto px-6 pt-4 w-full">
      <div className="rounded-md border border-accent/30 bg-accent-subtle px-3 py-2 text-sm text-accent-strong">
        {message}
      </div>
    </div>
  );
}
```

在阅读页 `src/app/(app)/wiki/[...slug]/page.tsx` 渲染它：在 `return ( <div className="flex flex-col min-h-full">` 之后、`<PageRenderer .../>` 之前插入 `<RetitleNotice />`，并在文件顶部 import：

```tsx
import { RetitleNotice } from '@/components/wiki/retitle-notice';
```

```tsx
  return (
    <div className="flex flex-col min-h-full">
      <RetitleNotice />
      <PageRenderer
```

- [ ] **Step 3: 门禁**

Run: `npx tsc --noEmit`
Expected: 无输出 / exit 0。

Run: `npx vitest run`
Expected: 全部既有用例通过（本任务不新增用例）。

- [ ] **Step 4: 提交**

```bash
git add src/components/wiki/page-editor.tsx src/components/wiki/retitle-notice.tsx "src/app/(app)/wiki/[...slug]/page.tsx"
git commit -m "feat: 改标题保存后在阅读页提示同步更新的引用数"
```

---

## 验收（全部任务完成后）

- `npx tsc --noEmit` 干净；`npx vitest run` 全绿（含新增 13 个 relink 用例）。
- dev 眼测：建两个页 A、B，B 正文含 `[[A 的标题]]`；编辑 A 把标题改名保存 → 跳回 A 阅读页顶部出现「已同步更新 1 处引用…」提示；打开 B 阅读/编辑，正文链接文本已是 A 的新标题且可跳转。
- slug/URL 不变：A 的 URL `/wiki/<原 slug>` 仍可访问，文件未移动。

## 边界与已知取舍（实现时照此处理，勿"自行补强"）

- 跨主题引用（来自别的 subject 的 `[[本subject:Old Title]]`）不重写：slug 没变仍可跳，仅显示陈旧。
- meta 系统页（index/log）中的引用不重写：`getBacklinks` 本就排除 meta 页，系统页由 ingest 再生。
- 新标题含 wikilink 特殊字符（`|` `#` `[` `]`）不做转义：属 wikilink 固有限制，不在本期处理（YAGNI）。
- validate 阶段 `[[New Title]]` 可能产生 unresolved **warning**：warning 不阻断 apply，apply 后两遍索引修正，无需特殊处理。

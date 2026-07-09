# Tags 页词云展示 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) 语法跟踪进度。

**Goal:** `/tags` 索引页从平铺 chip 列表改为词云：count 越大字号越大、颜色越实。

**Architecture:** 纯前端。`src/lib/tags.ts` 新增两个纯函数（log 平滑 min-max 权重 + djb2 哈希确定性打散），`tags-index-view.tsx` 改为居中 flex-wrap 词云渲染，零后端改动。

**Tech Stack:** React 19 / Tailwind / vitest。

**Spec:** `docs/superpowers/specs/2026-07-10-tags-word-cloud-design.md`

## Global Constraints

- 不改 `aggregateTags` / `pagesWithTag` / `TagLink` / `/tags/[tag]` 页 / 任何 API。
- 打散必须确定性（禁 `Math.random`），防 hydration 抖动。
- 代码注释与 commit message 用中文。

---

### Task 1: 纯函数 tagCloudWeights + shuffleTagsDeterministic

**Files:**
- Modify: `src/lib/tags.ts`
- Test: `src/lib/__tests__/tags.test.ts`

**Interfaces:**
- Produces:
  - `tagCloudWeights(tags: { tag: string; count: number }[]): { tag: string; count: number; weight: number }[]` — weight ∈ [0,1]，log 平滑 min-max；max===min 时全 0.5。
  - `shuffleTagsDeterministic<T extends { tag: string }>(tags: T[]): T[]` — 按 tag 名 djb2 哈希排序的确定性打散，不改输入数组。

- [x] **Step 1: 写失败单测**（追加到 `src/lib/__tests__/tags.test.ts` 末尾）

```ts
import { tagCloudWeights, shuffleTagsDeterministic } from '../tags'; // 并入顶部 import

describe('tagCloudWeights', () => {
  it('空输入返回 []', () => {
    expect(tagCloudWeights([])).toEqual([]);
  });

  it('单 tag 或全同 count 时 weight 全为 0.5', () => {
    expect(tagCloudWeights([{ tag: 'a', count: 3 }])[0].weight).toBe(0.5);
    const same = tagCloudWeights([
      { tag: 'a', count: 2 },
      { tag: 'b', count: 2 },
    ]);
    expect(same.map((t) => t.weight)).toEqual([0.5, 0.5]);
  });

  it('min 得 0、max 得 1，中间值经 log 平滑落在 (0,1)', () => {
    const out = tagCloudWeights([
      { tag: 'min', count: 1 },
      { tag: 'mid', count: 10 },
      { tag: 'max', count: 100 },
    ]);
    const byTag = Object.fromEntries(out.map((t) => [t.tag, t.weight]));
    expect(byTag.min).toBe(0);
    expect(byTag.max).toBe(1);
    expect(byTag.mid).toBeCloseTo(0.5, 5); // log 空间正中
  });

  it('极端偏斜分布下低频 tag 仍有区分度（log 平滑）', () => {
    const out = tagCloudWeights([
      { tag: 'a', count: 1 },
      { tag: 'b', count: 2 },
      { tag: 'hot', count: 1000 },
    ]);
    const byTag = Object.fromEntries(out.map((t) => [t.tag, t.weight]));
    expect(byTag.b).toBeGreaterThan(0.05); // 线性归一化时 b≈0.001，log 后明显更大
  });
});

describe('shuffleTagsDeterministic', () => {
  it('两次调用结果一致且元素不丢', () => {
    const input = [{ tag: 'a' }, { tag: 'b' }, { tag: 'c' }, { tag: 'd' }];
    const once = shuffleTagsDeterministic(input);
    expect(shuffleTagsDeterministic(input)).toEqual(once);
    expect([...once].map((t) => t.tag).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('不修改输入数组', () => {
    const input = [{ tag: 'b' }, { tag: 'a' }];
    const snapshot = [...input];
    shuffleTagsDeterministic(input);
    expect(input).toEqual(snapshot);
  });
});
```

- [x] **Step 2: 跑测确认失败**

Run: `npx vitest run src/lib/__tests__/tags.test.ts`
Expected: FAIL（`tagCloudWeights is not a function` / 导出不存在）

- [x] **Step 3: 最小实现**（追加到 `src/lib/tags.ts` 末尾）

```ts
/**
 * 词云权重：对 count 取 log 平滑后 min-max 归一化到 [0,1]。
 * 单 tag 或全部同 count 时统一取 0.5，避免除零。
 */
export function tagCloudWeights(
  tags: { tag: string; count: number }[],
): { tag: string; count: number; weight: number }[] {
  if (tags.length === 0) return [];
  const logs = tags.map((t) => Math.log(t.count));
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  const span = max - min;
  return tags.map((t, i) => ({
    ...t,
    weight: span === 0 ? 0.5 : (logs[i] - min) / span,
  }));
}

/** djb2 字符串哈希（无符号 32 位） */
function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * 确定性打散：按 tag 名哈希排序，SSR/CSR 结果一致（不用 Math.random 防 hydration 抖动）。
 * 返回新数组，不修改输入。
 */
export function shuffleTagsDeterministic<T extends { tag: string }>(tags: T[]): T[] {
  return [...tags].sort((a, b) => djb2(a.tag) - djb2(b.tag) || a.tag.localeCompare(b.tag));
}
```

- [x] **Step 4: 跑测确认通过**

Run: `npx vitest run src/lib/__tests__/tags.test.ts`
Expected: PASS（原有用例 + 新增用例全绿）

- [x] **Step 5: Commit**

```bash
git add src/lib/tags.ts src/lib/__tests__/tags.test.ts
git commit -m "feat(tags): 词云权重与确定性打散纯函数"
```

---

### Task 2: TagsIndexView 词云渲染

**Files:**
- Modify: `src/components/tags/tags-index-view.tsx`

**Interfaces:**
- Consumes: Task 1 的 `tagCloudWeights` / `shuffleTagsDeterministic`。

- [x] **Step 1: 改写渲染**

把 `src/components/tags/tags-index-view.tsx` 整文件替换为：

```tsx
'use client';

import Link from 'next/link';
import { Hash } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { aggregateTags, tagCloudWeights, shuffleTagsDeterministic } from '@/lib/tags';
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

  const tags = shuffleTagsDeterministic(tagCloudWeights(aggregateTags(pages)));

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 w-full space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
          <Hash className="h-5 w-5 text-foreground-tertiary" />
          Tags
        </h1>
        <p className="mt-1 text-sm text-foreground-secondary">
          Browse pages by tag in this subject.
        </p>
      </header>

      {!subjectId || isLoading ? (
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-7 w-20 rounded-sm bg-subtle animate-pulse" />
          ))}
        </div>
      ) : tags.length === 0 ? (
        <p className="text-sm text-foreground-tertiary italic">No tags yet.</p>
      ) : (
        <ul className="flex flex-wrap items-baseline justify-center gap-x-4 gap-y-2 py-4">
          {tags.map(({ tag, count, weight }) => (
            <li key={tag}>
              <Link
                href={`/tags/${encodeURIComponent(tag)}${subjectSlug ? `?s=${encodeURIComponent(subjectSlug)}` : ''}`}
                title={`${count} page${count === 1 ? '' : 's'}`}
                className="text-accent hover:underline whitespace-nowrap leading-tight"
                style={{
                  fontSize: `${(0.875 + weight * 1.625).toFixed(3)}rem`,
                  opacity: 0.45 + weight * 0.55,
                }}
              >
                {tag}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

要点：不再 import `TagLink`；`?s=` 与 `tag-link.tsx` 链接形态保持一致。

- [x] **Step 2: 类型校验**

Run: `npx tsc --noEmit`
Expected: 退出码 0（IDE 诊断不可信，以此为准）

- [x] **Step 3: 目视验证**

启动 dev（若未在跑），浏览器打开 `/tags`：多 tag 时字号/深浅有梯度、大词分布打散、hover 显示 "N pages"、点击跳 `/tags/<tag>`、暗色主题正常。

- [x] **Step 4: Commit**

```bash
git add src/components/tags/tags-index-view.tsx
git commit -m "feat(tags): tags 索引页改为词云展示"
```

---

## Self-Review

- Spec 覆盖：权重函数（Task 1）、打散（Task 1）、渲染/热度色/hover 计数/不复用 TagLink（Task 2）、空态保持（Task 2 代码原样保留）——齐。
- 无占位符；类型签名两任务一致。

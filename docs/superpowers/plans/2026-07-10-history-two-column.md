# History 页两栏布局 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** History 页从「单列 + 内联展开」改为宽屏两栏（左记录列表 / 右 diff+回滚），窄屏退化为现有内联展开。

**Architecture:** 纯前端重构，只改 `src/components/history/operation-list.tsx`；`OperationDiff({ operationId })`、`RevertButton({ entry })`、API 全部复用不动。数据 query 一份，宽屏/窄屏渲染两套结构（Tailwind `md:` 断点切换）。

**Tech Stack:** React 19 + Tailwind + TanStack React Query（既有）。

## Global Constraints

- 零后端/API/契约改动。
- 样式走 Tailwind + CSS 变量类（`bg-subtle`、`text-foreground-*`、`bg-accent-subtle`、`border-border`）。
- 选中行高亮仿 `settings-nav.tsx`：`bg-accent-subtle` + `aria-current`。
- 右栏初始空态提示 "Select an operation to view its diff"。
- 组件无既有测试，本次不新增；验证 = `npx tsc --noEmit` + Playwright 走查。

---

### Task 1: 重构 operation-list.tsx 为两栏布局

**Files:**
- Modify: `src/components/history/operation-list.tsx`（整文件替换）

**Interfaces:**
- Consumes: `OperationDiff({ operationId: string })`（`./operation-diff`）、`RevertButton({ entry: HistoryEntry })`（`./revert-button`）、`HistoryEntry`（`@/lib/contracts`，字段：`id`/`type`/`status`/`date`/`affectedPages[{slug}]`）。
- Produces: 导出 `OperationList()`（签名不变，`(app)/history/page.tsx` 零改动）。

- [ ] **Step 1: 整文件替换 `src/components/history/operation-list.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { History as HistoryIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { cn } from '@/lib/cn';
import { Tag } from '@/components/ui/tag';
import type { HistoryEntry } from '@/lib/contracts';
import { OperationDiff } from './operation-diff';
import { RevertButton } from './revert-button';

const TYPE_LABELS: Record<string, string> = {
  ingest: '摄入',
  'save-to-wiki': '保存',
  curate: '整理',
  merge: '合并',
  split: '拆分',
  edit: '编辑',
  delete: '删除',
};

function entrySummary(entry: HistoryEntry) {
  const shown = entry.affectedPages.slice(0, 5);
  const extra = entry.affectedPages.length - shown.length;
  return `${shown.map((p) => p.slug).join(', ') || '（无页面变更）'}${extra > 0 ? ` +${extra}` : ''}`;
}

function entryWhen(entry: HistoryEntry) {
  return entry.date ? new Date(entry.date).toLocaleString() : '—';
}

/** 窄屏（md 以下）保留的内联展开行 */
function Row({ entry }: { entry: HistoryEntry }) {
  const [open, setOpen] = useState(false);
  const typeLabel = TYPE_LABELS[entry.type] ?? entry.type;

  return (
    <li className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-subtle"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Tag tone={entry.status === 'reverted' ? 'neutral' : 'accent'} size="sm">
            {typeLabel}
          </Tag>
          {entry.status === 'reverted' && (
            <span className="text-xs text-foreground-tertiary">已回滚</span>
          )}
          <span className="truncate text-sm text-foreground">{entrySummary(entry)}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-foreground-tertiary">
          {entryWhen(entry)}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <OperationDiff operationId={entry.id} />
          <RevertButton entry={entry} />
        </div>
      )}
    </li>
  );
}

/** 宽屏左栏紧凑行 */
function ListItem({
  entry,
  selected,
  onSelect,
}: {
  entry: HistoryEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const typeLabel = TYPE_LABELS[entry.type] ?? entry.type;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected || undefined}
        className={cn(
          'w-full rounded-md px-3 py-2 text-left transition-colors',
          selected ? 'bg-accent-subtle' : 'hover:bg-subtle',
        )}
      >
        <span className="flex items-center gap-2">
          <Tag tone={entry.status === 'reverted' ? 'neutral' : 'accent'} size="sm">
            {typeLabel}
          </Tag>
          {entry.status === 'reverted' && (
            <span className="text-xs text-foreground-tertiary">已回滚</span>
          )}
          <span className="ml-auto shrink-0 text-xs tabular-nums text-foreground-tertiary">
            {entryWhen(entry)}
          </span>
        </span>
        <span className="mt-1 block truncate text-sm text-foreground">{entrySummary(entry)}</span>
      </button>
    </li>
  );
}

/** 宽屏右栏详情 */
function DetailPane({ entry }: { entry: HistoryEntry }) {
  const typeLabel = TYPE_LABELS[entry.type] ?? entry.type;

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Tag tone={entry.status === 'reverted' ? 'neutral' : 'accent'} size="sm">
            {typeLabel}
          </Tag>
          {entry.status === 'reverted' && (
            <span className="text-xs text-foreground-tertiary">已回滚</span>
          )}
          <span className="text-xs tabular-nums text-foreground-tertiary">{entryWhen(entry)}</span>
        </div>
        {entry.affectedPages.length > 0 && (
          <p className="text-sm text-foreground-secondary">
            {entry.affectedPages.map((p) => p.slug).join(', ')}
          </p>
        )}
        <RevertButton entry={entry} />
      </header>
      <OperationDiff operationId={entry.id} />
    </div>
  );
}

export function OperationList() {
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['history', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/history');
      if (!res.ok) return [] as HistoryEntry[];
      return (await res.json()) as HistoryEntry[];
    },
    enabled: !!subjectId,
    staleTime: 10_000,
  });

  const selected = entries.find((e) => e.id === selectedId) ?? null;

  const header = (
    <header>
      <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
        <HistoryIcon className="h-5 w-5 text-foreground-tertiary" />
        History
      </h1>
      <p className="mt-1 text-sm text-foreground-secondary">
        本主题的每一次写操作。选中查看 diff 或回滚。
      </p>
    </header>
  );

  const loadingSkeleton = (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-md bg-subtle" />
      ))}
    </div>
  );

  const emptyList = <p className="text-sm italic text-foreground-tertiary">No operations yet.</p>;

  return (
    <>
      {/* 窄屏：保留单列内联展开 */}
      <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8 md:hidden">
        {header}
        {!subjectId || isLoading ? (
          loadingSkeleton
        ) : entries.length === 0 ? (
          emptyList
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <Row key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>

      {/* 宽屏：两栏 */}
      <div className="hidden h-full min-h-0 md:flex">
        <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border px-4 py-6">
          {header}
          {!subjectId || isLoading ? (
            loadingSkeleton
          ) : entries.length === 0 ? (
            emptyList
          ) : (
            <ul className="space-y-1">
              {entries.map((entry) => (
                <ListItem
                  key={entry.id}
                  entry={entry}
                  selected={entry.id === selectedId}
                  onSelect={() => setSelectedId(entry.id)}
                />
              ))}
            </ul>
          )}
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
          {selected ? (
            <DetailPane entry={selected} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm italic text-foreground-tertiary">
                Select an operation to view its diff
              </p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 退出码 0（IDE 诊断不作准，以 tsc 为权威）。

- [ ] **Step 3: Playwright 走查**

前置：确认 dev server 在跑（`npm run dev` 或用户已有的 dev:all；若已在跑不要重复启动）。用 Playwright MCP 打开 `http://localhost:3000/history`（端口可能顺延，以 dev server 输出为准）：

1. 宽屏（默认视口）：左栏记录列表可见，右栏显示 "Select an operation to view its diff" 空态；
2. 点任意一条记录：该行高亮 `bg-accent-subtle`，右栏出现摘要头 + 回滚按钮 + diff；
3. `browser_resize` 到 375×800：退化为单列，点行内联展开 diff。

Expected: 三步均符合。

- [ ] **Step 4: Commit**

```bash
git add src/components/history/operation-list.tsx
git commit -m "feat: History 页改两栏布局（左记录列表 / 右 diff+回滚）"
```

### Task 2: 更新模块文档

**Files:**
- Modify: `src/components/CLAUDE.md`（`history/` 小节 + 变更记录表）

**Interfaces:** 无（纯文档）。

- [ ] **Step 1: 更新 `history/` 小节描述**

把 `operation-list.tsx` 的描述行改为：

```markdown
- `operation-list.tsx` —— 操作时间线（rowid DESC）：宽屏两栏（左紧凑记录列表可选中高亮 / 右 DetailPane 摘要+RevertButton+OperationDiff，初始空态提示），md 以下退化为原单列内联展开 Row；数据 query 一份两套渲染
```

并在变更记录表末尾追加一行：

```markdown
| 2026-07-10 | History 页两栏布局：`operation-list.tsx` 重构为宽屏两栏（本地 selectedId state，选中高亮仿 settings-nav）+ 窄屏保留内联展开；`OperationDiff`/`RevertButton`/API 不动。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-10-history-two-column* |
```

- [ ] **Step 2: Commit**

```bash
git add src/components/CLAUDE.md
git commit -m "docs: 同步 History 两栏布局到组件模块文档"
```

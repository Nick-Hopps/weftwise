# 选中正文文本 → 悬浮「追问」按钮 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阅读页正文里选中文字后浮出「Ask AI」按钮，点击把选中文本作为引用 pin 进右侧 Ask AI 对话并聚焦输入框。

**Architecture:** 纯前端。两端（正文里的悬浮按钮 / 右侧面板里的 chat）通过 Zustand ui-store 的一个**瞬态信箱字段** `pendingChatReference` 对接：按钮写入 pending 并打开 chat tab，`ChatInterface` 挂载后消费它（pin 进现有 `refs` 引用机制 + 聚焦），消费即清空。选中文本 / 最近标题 / id 派生 / 截断这些纯逻辑抽到 `lib/selection-text.ts` 单测，DOM 与组件接线靠 `tsc` + 手动验证。

**Tech Stack:** React 19 + TypeScript 5 + Zustand 5 + Tailwind + lucide-react；测试 vitest（**node 环境，无 jsdom，测试文件仅 `*.test.ts`**）。

## Global Constraints

- 测试只能放 `src/**/__tests__/**/*.test.ts`（vitest `include` 仅匹配 `.ts`；环境为 `node`，**没有 DOM**——只有纯函数与 zustand store 能单测）。
- 测试从 `'vitest'` 显式 import（`globals: false`）：`import { describe, it, expect } from 'vitest';`。
- 路径别名 `@/*` → `src/*`（vitest 与 tsconfig 均已配）。
- 文案用**英文**（按钮 "Ask AI"，fallback section "Selection"）——与近期阅读页英文化一致。
- 客户端组件文件顶部加 `'use client';`；样式走 Tailwind + `cn()`，颜色用 `bg-surface`/`text-foreground` 等语义 token。
- **零后端 / DB / API 改动。** 不新建路由。
- `npm run lint` 在本项目不可用；类型校验统一用 `npx tsc --noEmit`。
- ⚠️ **worktree 写入泄漏**：本仓库存在 `Write`/`Edit` 偶发落到主仓库工作树（而非当前 worktree）的问题。**每个 Task 写文件后，必须 `git -C <worktree> status --short` 确认改动出现在 worktree**；若没出现，去主仓库工作树把文件移回 worktree 对应路径并从主仓库删除，再提交。
- 执行起步：worktree 无 `node_modules`，**先在 worktree 根目录跑 `npm install`**，再开始 Task 1。
- commit message 用**中文**、一句话总结；**不要**加 `Co-Authored-By` / "Generated with Claude Code" 等 AI 署名。

---

## Task 0: 环境就绪（执行前置）

**Files:** 无（仅环境）

- [ ] **Step 1: 安装依赖**

Run（在 worktree 根目录）：
```bash
npm install
```
Expected: 安装完成，生成 `node_modules`。

- [ ] **Step 2: 基线测试通过**

Run:
```bash
npx vitest run
```
Expected: 全绿（现有 519 用例左右，0 失败）。若有预先失败，先报告再决定是否继续。

---

## Task 1: 纯逻辑 `lib/selection-text.ts`

选中文本归一化、上限截断、稳定 id 派生、最近标题提取。全部纯函数，node 环境可测。

**Files:**
- Create: `src/lib/selection-text.ts`
- Test: `src/lib/__tests__/selection-text.test.ts`

**Interfaces:**
- Produces:
  - `MAX_SELECTION_CONTEXT_CHARS: number`（= 4000）
  - `interface HeadingScanNode { readonly tagName: string; readonly textContent: string | null; readonly previousElementSibling: HeadingScanNode | null; readonly parentElement: HeadingScanNode | null }`
  - `normalizeSelectionText(raw: string): string | null`
  - `truncateForContext(text: string, max?: number): string`
  - `selectionRefId(text: string): string`
  - `findNearestHeadingText(start: HeadingScanNode | null): string | null`

- [ ] **Step 1: 写失败测试**

Create `src/lib/__tests__/selection-text.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  MAX_SELECTION_CONTEXT_CHARS,
  normalizeSelectionText,
  truncateForContext,
  selectionRefId,
  findNearestHeadingText,
  type HeadingScanNode,
} from '@/lib/selection-text';

/** 构造一个最小假节点，便于在 node 环境下测试标题扫描。 */
function node(
  tagName: string,
  opts: { text?: string; prev?: HeadingScanNode | null; parent?: HeadingScanNode | null } = {},
): HeadingScanNode {
  return {
    tagName,
    textContent: opts.text ?? null,
    previousElementSibling: opts.prev ?? null,
    parentElement: opts.parent ?? null,
  };
}

describe('normalizeSelectionText', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeSelectionText('  hello  ')).toBe('hello');
  });
  it('returns null for empty or whitespace-only', () => {
    expect(normalizeSelectionText('')).toBeNull();
    expect(normalizeSelectionText('   \n\t ')).toBeNull();
  });
});

describe('truncateForContext', () => {
  it('leaves short text unchanged', () => {
    expect(truncateForContext('short')).toBe('short');
  });
  it('leaves text at the limit unchanged', () => {
    const atMax = 'a'.repeat(MAX_SELECTION_CONTEXT_CHARS);
    expect(truncateForContext(atMax)).toBe(atMax);
  });
  it('truncates and appends an ellipsis past the limit', () => {
    const long = 'a'.repeat(MAX_SELECTION_CONTEXT_CHARS + 500);
    const out = truncateForContext(long);
    expect(out.length).toBe(MAX_SELECTION_CONTEXT_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('selectionRefId', () => {
  it('is deterministic for the same text', () => {
    expect(selectionRefId('hello world')).toBe(selectionRefId('hello world'));
  });
  it('differs for different text', () => {
    expect(selectionRefId('a')).not.toBe(selectionRefId('b'));
  });
  it('is prefixed with sel-', () => {
    expect(selectionRefId('x').startsWith('sel-')).toBe(true);
  });
});

describe('findNearestHeadingText', () => {
  it('returns the nearest preceding heading among siblings', () => {
    const h2 = node('H2', { text: 'Topic' });
    const p = node('P', { text: 'body', prev: h2 });
    expect(findNearestHeadingText(p)).toBe('Topic');
  });
  it('climbs ancestors when no sibling heading exists', () => {
    const h1 = node('H1', { text: 'Title' });
    const article = node('ARTICLE', { prev: null });
    // section <div> sits after the <h1>; the <p> lives inside it.
    const section = node('DIV', { prev: h1, parent: article });
    const p = node('P', { text: 'deep', prev: null, parent: section });
    expect(findNearestHeadingText(p)).toBe('Title');
  });
  it('returns null when there is no heading anywhere', () => {
    const p = node('P', { text: 'lonely' });
    expect(findNearestHeadingText(p)).toBeNull();
  });
  it('returns null for an empty-text heading', () => {
    const h2 = node('H2', { text: '  ' });
    const p = node('P', { prev: h2 });
    expect(findNearestHeadingText(p)).toBeNull();
  });
  it('returns null for a null start node', () => {
    expect(findNearestHeadingText(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/__tests__/selection-text.test.ts`
Expected: FAIL（`Cannot find module '@/lib/selection-text'` 或导出未定义）。

- [ ] **Step 3: 写实现**

Create `src/lib/selection-text.ts`:
```ts
/** 选中文本作为对话上下文时的字符上限，防超长选区撑爆请求体。 */
export const MAX_SELECTION_CONTEXT_CHARS = 4000;

/**
 * 最近标题扫描所需的最小 DOM 结构子集。
 * 运行时传入真实 `Element`，测试时传入手搓假节点——两者结构兼容。
 */
export interface HeadingScanNode {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly previousElementSibling: HeadingScanNode | null;
  readonly parentElement: HeadingScanNode | null;
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4']);

/** trim 选区文本；空或纯空白返回 null（调用方据此不弹按钮）。 */
export function normalizeSelectionText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 截断到上限；超出则截断并补省略号。 */
export function truncateForContext(text: string, max = MAX_SELECTION_CONTEXT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 由选中文本派生稳定 id（同文本同 id → 引用列表去重）。djb2 哈希。 */
export function selectionRefId(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `sel-${(hash >>> 0).toString(36)}`;
}

/** 从选区起点元素向上找最近的 h1~h4 标题文本；找不到返回 null。 */
export function findNearestHeadingText(start: HeadingScanNode | null): string | null {
  let node = start;
  while (node) {
    let sib: HeadingScanNode | null = node;
    while (sib) {
      if (HEADING_TAGS.has(sib.tagName)) {
        const t = sib.textContent?.trim();
        return t && t.length > 0 ? t : null;
      }
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/__tests__/selection-text.test.ts`
Expected: PASS（全部用例绿）。

- [ ] **Step 5: 提交**

先确认改动落在 worktree（见 Global Constraints 的泄漏检查），再：
```bash
git add src/lib/selection-text.ts src/lib/__tests__/selection-text.test.ts
git commit -m "feat: 新增选区文本归一化/截断/标题提取纯函数"
```

---

## Task 2: ui-store 瞬态信箱 `pendingChatReference`

加一个不持久化的字段当作按钮↔chat 的信箱，外加写入 / 消费两个 action。

**Files:**
- Modify: `src/stores/ui-store.ts`
- Test: `src/stores/__tests__/ui-store.test.ts`

**Interfaces:**
- Consumes: `selectionRefId` from `@/lib/selection-text`（Task 1）
- Produces（挂在 `useUIStore` 上）：
  - `interface PendingChatReference { id: string; section: string | null; text: string }`
  - state `pendingChatReference: PendingChatReference | null`
  - `askAboutSelection(payload: { section: string | null; text: string }): void`
  - `consumePendingChatReference(): PendingChatReference | null`

- [ ] **Step 1: 写失败测试**

Create `src/stores/__tests__/ui-store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';

// node 环境无 localStorage——给 zustand persist 一个最小桩，避免写入告警/异常。
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  };
}

import { useUIStore } from '@/stores/ui-store';

describe('ui-store pendingChatReference mailbox', () => {
  beforeEach(() => {
    useUIStore.setState({
      pendingChatReference: null,
      contextPanelOpen: false,
      contextPanelTab: 'context',
    });
  });

  it('askAboutSelection writes a derived ref and opens the chat tab', () => {
    useUIStore.getState().askAboutSelection({ section: 'Intro', text: 'hello world' });
    const s = useUIStore.getState();
    expect(s.pendingChatReference).toEqual({
      id: expect.stringMatching(/^sel-/),
      section: 'Intro',
      text: 'hello world',
    });
    expect(s.contextPanelOpen).toBe(true);
    expect(s.contextPanelTab).toBe('chat');
  });

  it('derives a stable id for identical text', () => {
    useUIStore.getState().askAboutSelection({ section: null, text: 'same' });
    const a = useUIStore.getState().pendingChatReference?.id;
    useUIStore.getState().askAboutSelection({ section: null, text: 'same' });
    const b = useUIStore.getState().pendingChatReference?.id;
    expect(a).toBe(b);
  });

  it('consumePendingChatReference returns the value then clears it', () => {
    useUIStore.getState().askAboutSelection({ section: null, text: 'pick me' });
    const taken = useUIStore.getState().consumePendingChatReference();
    expect(taken?.text).toBe('pick me');
    expect(useUIStore.getState().pendingChatReference).toBeNull();
    expect(useUIStore.getState().consumePendingChatReference()).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/ui-store.test.ts`
Expected: FAIL（`askAboutSelection is not a function` / 类型上不存在）。

- [ ] **Step 3: 写实现**

在 `src/stores/ui-store.ts`：

(a) 文件顶部 import 区加：
```ts
import { selectionRefId } from '@/lib/selection-text';
```

(b) 在 `ContextPanelTab` 类型声明附近新增导出类型：
```ts
export interface PendingChatReference {
  id: string;
  section: string | null;
  text: string;
}
```

(c) `UIState` 接口里，`subjectDialog` 字段附近加 state 字段：
```ts
  /** 选中正文文本后「追问」的瞬态信箱（不持久化）。 */
  pendingChatReference: PendingChatReference | null;
```
并在接口的 actions 区（`closeSubjectDialog` 附近）加方法签名：
```ts
  askAboutSelection: (payload: { section: string | null; text: string }) => void;
  consumePendingChatReference: () => PendingChatReference | null;
```

(d) 把 store 工厂签名从 `(set) =>` 改为 `(set, get) =>`：
```ts
export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
```

(e) 在初始 state 里（`subjectDialog: {...}` 那行附近）加：
```ts
      pendingChatReference: null,
```

(f) 在 actions 实现区（`closeSubjectDialog` 实现之后）加：
```ts
      askAboutSelection: (payload) =>
        set({
          pendingChatReference: {
            id: selectionRefId(payload.text),
            section: payload.section,
            text: payload.text,
          },
          contextPanelOpen: true,
          contextPanelTab: 'chat',
        }),
      consumePendingChatReference: () => {
        const current = get().pendingChatReference;
        if (current) set({ pendingChatReference: null });
        return current;
      },
```

(g) **不要**把 `pendingChatReference` 加进 `partialize`（保持瞬态、不持久化）；version 维持 `5`，不新增迁移。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/ui-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型校验 + 提交**

Run: `npx tsc --noEmit`
Expected: 无报错。

确认改动落 worktree 后：
```bash
git add src/stores/ui-store.ts src/stores/__tests__/ui-store.test.ts
git commit -m "feat: ui-store 新增选区追问瞬态信箱与读写 action"
```

---

## Task 3: 选区追踪 hook `use-text-selection`

监听正文容器内的文本选区，输出文本 / 位置 / 最近标题。DOM 逻辑，靠 `tsc` + 后续手动验证。

**Files:**
- Create: `src/hooks/use-text-selection.ts`

**Interfaces:**
- Consumes: `normalizeSelectionText` / `truncateForContext` / `findNearestHeadingText` / `HeadingScanNode` from `@/lib/selection-text`（Task 1）
- Produces:
  - `interface SelectionRect { top: number; left: number; width: number; height: number }`
  - `interface SelectionInfo { text: string; section: string | null; rect: SelectionRect }`
  - `useTextSelection(containerRef: RefObject<HTMLElement | null>): SelectionInfo | null`

- [ ] **Step 1: 写实现**

Create `src/hooks/use-text-selection.ts`:
```ts
'use client';

import { useEffect, useState, type RefObject } from 'react';
import {
  normalizeSelectionText,
  truncateForContext,
  findNearestHeadingText,
  type HeadingScanNode,
} from '@/lib/selection-text';

export interface SelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface SelectionInfo {
  text: string;
  section: string | null;
  rect: SelectionRect;
}

/**
 * 追踪 `containerRef` 容器内的文本选区。
 * - 拖拽中不输出，松手（pointerup）后才计算；
 * - 选区折叠 / 落在容器外 / 滚动 / 改窗尺寸时输出 null。
 */
export function useTextSelection(
  containerRef: RefObject<HTMLElement | null>,
): SelectionInfo | null {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);

  useEffect(() => {
    const compute = () => {
      const sel = window.getSelection();
      const container = containerRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !container) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      // 选区必须完全落在正文容器内。
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const norm = normalizeSelectionText(sel.toString());
      if (!norm) {
        setSelection(null);
        return;
      }
      const domRect = range.getBoundingClientRect();
      if (domRect.width === 0 && domRect.height === 0) {
        setSelection(null);
        return;
      }
      const startNode = range.startContainer;
      const startEl =
        startNode.nodeType === Node.TEXT_NODE
          ? startNode.parentElement
          : (startNode as Element);
      const section = findNearestHeadingText(
        startEl as unknown as HeadingScanNode | null,
      );
      setSelection({
        text: truncateForContext(norm),
        section,
        rect: {
          top: domRect.top,
          left: domRect.left,
          width: domRect.width,
          height: domRect.height,
        },
      });
    };

    // 松手后选区已定型，延一帧再算，避免读到中间态。
    const onPointerUp = () => window.setTimeout(compute, 0);
    // 选区被折叠（点击空白）立即收起按钮。
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    // 滚动 / resize 后 rect 失效，直接收起。
    const onInvalidate = () => setSelection(null);

    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('scroll', onInvalidate, true);
    window.addEventListener('resize', onInvalidate);
    return () => {
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', onInvalidate, true);
      window.removeEventListener('resize', onInvalidate);
    };
  }, [containerRef]);

  return selection;
}
```

- [ ] **Step 2: 类型校验**

Run: `npx tsc --noEmit`
Expected: 无报错。（hook 暂无消费方，未使用导出不报错。若 `Element → HeadingScanNode` 结构赋值在你的 TS 版本下报错，已有 `as unknown as` 兜底。）

- [ ] **Step 3: 提交**

确认改动落 worktree 后：
```bash
git add src/hooks/use-text-selection.ts
git commit -m "feat: 新增正文选区追踪 hook use-text-selection"
```

---

## Task 4: 悬浮按钮组件 `SelectionAskButton`

把 hook 的选区数据渲染成贴在选区上方的「Ask AI」按钮，点击触发 store action。

**Files:**
- Create: `src/components/wiki/selection-ask-button.tsx`

**Interfaces:**
- Consumes: `useTextSelection` / `SelectionInfo`（Task 3）；`useUIStore` 的 `askAboutSelection`（Task 2）
- Produces: `SelectionAskButton({ containerRef }: { containerRef: RefObject<HTMLElement | null> }): JSX.Element | null`

- [ ] **Step 1: 写实现**

Create `src/components/wiki/selection-ask-button.tsx`:
```tsx
'use client';

import { type RefObject } from 'react';
import { Sparkles } from 'lucide-react';
import { useTextSelection } from '@/hooks/use-text-selection';
import { useUIStore } from '@/stores/ui-store';

/** 选区上方按钮与选区之间的间距（px）。 */
const OFFSET = 8;
/** 选区距视口顶部小于此值时，按钮翻到选区下方，避免溢出视口。 */
const FLIP_THRESHOLD = 48;

export function SelectionAskButton({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const selection = useTextSelection(containerRef);
  const askAboutSelection = useUIStore((s) => s.askAboutSelection);

  if (!selection) return null;

  const { rect } = selection;
  const flipBelow = rect.top < FLIP_THRESHOLD;
  const top = flipBelow ? rect.top + rect.height + OFFSET : rect.top - OFFSET;
  const left = rect.left + rect.width / 2;

  return (
    <button
      type="button"
      // 阻止默认避免点击清掉原生选区（文本已在 hook state 里捕获，双保险）。
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => askAboutSelection({ section: selection.section, text: selection.text })}
      style={{
        position: 'fixed',
        top,
        left,
        transform: `translate(-50%, ${flipBelow ? '0' : '-100%'})`,
      }}
      className="z-overlay inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 h-8 text-xs font-medium text-foreground shadow-md transition-colors hover:bg-subtle focus-ring animate-fade-in"
    >
      <Sparkles className="h-3.5 w-3.5 text-accent" />
      Ask AI
    </button>
  );
}
```

- [ ] **Step 2: 类型校验**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 3: 提交**

确认改动落 worktree 后：
```bash
git add src/components/wiki/selection-ask-button.tsx
git commit -m "feat: 新增选区悬浮 Ask AI 按钮组件"
```

---

## Task 5: ChatInterface 消费信箱

让右侧面板内的 `ChatInterface`（embedded 变体）在 `pendingChatReference` 出现时，把它 pin 进现有 `refs` 引用列表并聚焦输入框。

**Files:**
- Modify: `src/components/chat/chat-interface.tsx`

**Interfaces:**
- Consumes: `useUIStore` 的 `pendingChatReference` state + `consumePendingChatReference()` action（Task 2）；现有 `refs` state（`Passage[]`，`{ id, section, text }`）与 `textareaRef`。

- [ ] **Step 1: 写实现**

在 `src/components/chat/chat-interface.tsx`：

(a) 组件内（已有 `useUIStore` 引用；现有 `const currentConversationId = useUIStore((s) => s.currentConversationId);` 附近）新增两个选择器：
```ts
  const pendingChatReference = useUIStore((s) => s.pendingChatReference);
  const consumePendingChatReference = useUIStore((s) => s.consumePendingChatReference);
```

(b) 在 `refs` / `pickerOpen` 相关 state 之后、`sendMessage` 之前，新增一个消费 effect：
```ts
  // 选中正文文本点「Ask AI」→ ui-store 信箱 → 这里 pin 进引用并聚焦。
  // 仅 embedded（右侧面板）变体消费，避免命令面板等其它实例抢占。
  useEffect(() => {
    if (variant !== 'embedded') return;
    if (!pendingChatReference) return;
    const ref = consumePendingChatReference();
    if (!ref) return;
    setRefs((prev) =>
      prev.some((x) => x.id === ref.id)
        ? prev
        : [...prev, { id: ref.id, section: ref.section ?? 'Selection', text: ref.text }],
    );
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [variant, pendingChatReference, consumePendingChatReference]);
```

(说明：`Passage` 形状为 `{ id: string; section: string; text: string }`，`ref.section ?? 'Selection'` 兜底；`setRefs` / `textareaRef` 均为现有。)

- [ ] **Step 2: 类型校验**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 3: 提交**

确认改动落 worktree 后：
```bash
git add src/components/chat/chat-interface.tsx
git commit -m "feat: ChatInterface 消费选区追问信箱并 pin 为引用"
```

---

## Task 6: 接入阅读页 `WikiReadingView`

把正文包一层带 ref 的容器并挂上悬浮按钮，使选区监听限定在正文。

**Files:**
- Modify: `src/components/wiki/wiki-reading-view.tsx`

**Interfaces:**
- Consumes: `SelectionAskButton`（Task 4）

- [ ] **Step 1: 写实现**

在 `src/components/wiki/wiki-reading-view.tsx`：

(a) 顶部 import：把 `import { useEffect, useState } from 'react';` 改为
```ts
import { useEffect, useRef, useState } from 'react';
```
并新增：
```ts
import { SelectionAskButton } from './selection-ask-button';
```

(b) 组件函数体内（`const apiFetch = useApiFetch();` 附近）声明 ref：
```ts
  const articleRef = useRef<HTMLDivElement>(null);
```

(c) **分栏分支**：把左侧文章列改成带 ref 的容器并在其内渲染按钮。原：
```tsx
          <div className="min-w-0 lg:overflow-y-auto">{article}</div>
```
改为：
```tsx
          <div ref={articleRef} className="min-w-0 lg:overflow-y-auto">
            {article}
            <SelectionAskButton containerRef={articleRef} />
          </div>
```

(d) **非分栏分支**：原：
```tsx
  return <div className="flex min-h-full flex-col">{article}</div>;
```
改为：
```tsx
  return (
    <div ref={articleRef} className="flex min-h-full flex-col">
      {article}
      <SelectionAskButton containerRef={articleRef} />
    </div>
  );
```

(说明：按钮 `position: fixed`，在 DOM 树里的位置不影响定位；两分支只会渲染其一，复用同一个 `articleRef`。`SelectionAskButton` 在无选区时返回 null，不占位。)

- [ ] **Step 2: 类型校验**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 3: 提交**

确认改动落 worktree 后：
```bash
git add src/components/wiki/wiki-reading-view.tsx
git commit -m "feat: 阅读页正文挂载选区悬浮追问按钮"
```

---

## Task 7: 端到端手动验证

代码全部接好后，跑起来真验一遍（项目无组件测试，DOM 路径靠手动）。

**Files:** 无

- [ ] **Step 1: 全量测试 + 类型校验**

Run:
```bash
npx vitest run && npx tsc --noEmit
```
Expected: 测试全绿、类型无报错。

- [ ] **Step 2: 起开发服务**

Run（worktree 根目录）：
```bash
npm run dev:all
```
Expected: Next.js 起在某端口（注意 memory：build 后跑 dev 可能撞 `.next` 缓存，必要时 `rm -rf .next` 重启；端口可能顺延）。

- [ ] **Step 3: 手动走查（浏览器或 Playwright）**

打开任一已有 wiki 页（`/wiki/<slug>`），逐项确认：
1. 在正文里用鼠标选中一段文字 → 选区上方浮出「Ask AI」按钮。
2. 点按钮 → 右侧面板打开并停在 **Ask AI** tab；输入区出现一条带引用图标的选中文本 chip；输入框获得焦点。
3. 输入一个问题回车 → 正常流式作答，引用上下文含选中文本。
4. 选区折叠（点空白）/ 滚动页面 → 按钮消失。
5. 在**侧栏 / Sources 面板**里选字 → **不**弹按钮（范围限定正文）。
6. 面板原本关闭时点按钮 → 面板自动打开并完成上述注入（验证"信箱留值等挂载"路径）。

- [ ] **Step 4: 记录结果**

把走查结果如实写进任务汇报（哪几条通过、是否有偏差）。不通过则回到对应 Task 修复。

---

## Task 8: 文档与变更记录

按项目惯例补 CLAUDE.md 索引与 changelog。

**Files:**
- Modify: `src/components/CLAUDE.md`
- Modify: `src/lib/CLAUDE.md`
- Modify: `CLAUDE.md`（根）

- [ ] **Step 1: 更新 `src/lib/CLAUDE.md`**

在 lib 的文件清单 / 说明处补一行：`selection-text.ts` —— 选区文本归一化 / 上限截断 / 稳定 id 派生 / 最近标题提取的纯函数（供 `use-text-selection` hook 消费）。并在其 changelog 表加一行（日期 2026-06-30）。

- [ ] **Step 2: 更新 `src/components/CLAUDE.md`**

在 `wiki/` 小节补：`selection-ask-button.tsx` —— 正文选区上方浮出的「Ask AI」按钮（消费 `use-text-selection`，点击调 `ui-store.askAboutSelection`）。在文件清单树补 `selection-ask-button`。changelog 表加一行（2026-06-30）：选中正文文本悬浮追问——新增 `wiki/selection-ask-button.tsx` + `hooks/use-text-selection` + `lib/selection-text`；`ui-store` 加瞬态 `pendingChatReference` 信箱 + `askAboutSelection`/`consumePendingChatReference`；`chat-interface` 消费信箱 pin 为引用；`wiki-reading-view` 包正文容器 ref 挂按钮。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-selection-ask-floating-button*。

- [ ] **Step 3: 更新根 `CLAUDE.md`**

在第九节 Changelog 表末尾加一行（2026-06-30）：选中正文文本悬浮追问按钮——纯前端；正文选区→悬浮「Ask AI」→ ui-store 瞬态信箱 → 右侧 Ask AI tab pin 选中文本为引用并聚焦；零后端/DB/API 改动。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-selection-ask-floating-button*。

- [ ] **Step 4: 提交**

确认改动落 worktree 后：
```bash
git add src/components/CLAUDE.md src/lib/CLAUDE.md CLAUDE.md
git commit -m "docs: 同步选区追问按钮的模块文档与 changelog"
```

---

## 完成标准

- `npx vitest run` 全绿（含新增 selection-text 与 ui-store 用例）。
- `npx tsc --noEmit` 无报错。
- 手动走查 Task 7 六项全部符合预期。
- 8 个 Task 各自一个（或数个）中文 commit，无 AI 署名，全部落在 worktree 分支。

# Job 详情弹窗（任务日志 + 完整错误）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给右下角 job 状态浮层加一个「查看详情/查看错误」入口，打开独立弹窗展示当前任务的完整日志时间线，并在失败时展示完整错误（含 stack，可一键复制）。

**Architecture:** 纯前端增强。新增两个可单测纯函数（`eventLogLine` / `parseJobError`）+ 一个独立 `JobDetailDialog` 组件；`ProgressToast` 把已持有的 `events/status` 透传给弹窗（弹窗**不**自建 SSE），失败时弹窗经 `GET /api/jobs/[id]` 取 `resultJson.error` 展示完整错误。

**Tech Stack:** React 19 + TypeScript 5 + Tailwind + TanStack React Query + lucide-react + vitest。

## Global Constraints

- 不改 DB schema、不改 worker/事件发射、不新增 API 路由（只读用现成 `GET /api/jobs/[id]`）。
- 客户端与后端通信只用 `@/lib/api-fetch` 的 `apiFetch`，禁止手写 `fetch`。
- 样式走 Tailwind + `cn()`（`@/lib/cn`），颜色用 CSS 变量类（`bg-surface`/`text-danger`/`text-accent`/`text-foreground-secondary` 等）。
- 弹窗**不得**对同一 `jobId` 新建第二条 `EventSource`；流数据由 `ProgressToast` 透传。
- commit message 用中文一句话；**禁止** AI 署名 trailer / "Generated with" 脚注。
- 校验用 `npx tsc --noEmit`（`next lint` 在本项目不可用）与 `npm test`。

---

### Task 1: 纯函数 `job-log.ts`（`eventLogLine` + `parseJobError`）

**Files:**
- Create: `src/lib/job-log.ts`
- Test: `src/lib/__tests__/job-log.test.ts`

**Interfaces:**
- Consumes: `JobStreamEvent`（type-only import 自 `@/hooks/use-job-stream`，结构 `{ type: string; data: Record<string, unknown>; id?: string }`）。
- Produces:
  - `interface JobLogLine { time: string; text: string; isError: boolean }`
  - `interface JobError { message: string; stack?: string; cause?: string; responseText?: string; finishReason?: string; usage?: unknown }`
  - `function eventLogLine(event: JobStreamEvent): JobLogLine`
  - `function parseJobError(resultJson: string | null | undefined): JobError | null`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/__tests__/job-log.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { eventLogLine, parseJobError } from '../job-log';

describe('eventLogLine', () => {
  it('prefers message over step/description', () => {
    const line = eventLogLine({ type: 'ingest:llm', data: { message: 'A', step: 'B', description: 'C' } });
    expect(line.text).toBe('A');
  });

  it('falls back step → description → type', () => {
    expect(eventLogLine({ type: 't', data: { step: 'S' } }).text).toBe('S');
    expect(eventLogLine({ type: 't', data: { description: 'D' } }).text).toBe('D');
    expect(eventLogLine({ type: 'ingest:start', data: {} }).text).toBe('ingest:start');
  });

  it('treats empty-string fields as absent', () => {
    expect(eventLogLine({ type: 't', data: { message: '', step: 'S' } }).text).toBe('S');
  });

  it('flags error events', () => {
    expect(eventLogLine({ type: 'job:failed', data: {} }).isError).toBe(true);
    expect(eventLogLine({ type: 'lint:semantic:error', data: {} }).isError).toBe(true);
    expect(eventLogLine({ type: 'ingest:start', data: {} }).isError).toBe(false);
  });

  it('formats createdAt as HH:mm:ss and tolerates missing/invalid', () => {
    const iso = '2026-06-28T12:03:45.000Z';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(eventLogLine({ type: 't', data: { createdAt: iso } }).time)
      .toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
    expect(eventLogLine({ type: 't', data: {} }).time).toBe('');
    expect(eventLogLine({ type: 't', data: { createdAt: 'nonsense' } }).time).toBe('');
  });
});

describe('parseJobError', () => {
  it('returns null for empty/invalid input', () => {
    expect(parseJobError(null)).toBeNull();
    expect(parseJobError(undefined)).toBeNull();
    expect(parseJobError('')).toBeNull();
    expect(parseJobError('{not json')).toBeNull();
  });

  it('returns null when no error field', () => {
    expect(parseJobError(JSON.stringify({ pagesCreated: [] }))).toBeNull();
  });

  it('extracts message and optional technical fields', () => {
    const json = JSON.stringify({
      error: {
        message: 'boom',
        stack: 'Error: boom\n  at x',
        cause: 'root cause',
        responseText: 'raw',
        finishReason: 'length',
        usage: { totalTokens: 9 },
      },
    });
    const e = parseJobError(json);
    expect(e).not.toBeNull();
    expect(e!.message).toBe('boom');
    expect(e!.stack).toContain('at x');
    expect(e!.cause).toBe('root cause');
    expect(e!.responseText).toBe('raw');
    expect(e!.finishReason).toBe('length');
    expect(e!.usage).toEqual({ totalTokens: 9 });
  });

  it('falls back message when missing', () => {
    const e = parseJobError(JSON.stringify({ error: { stack: 's' } }));
    expect(e!.message).toBe('Job failed');
  });

  it('stringifies non-string cause', () => {
    const e = parseJobError(JSON.stringify({ error: { message: 'm', cause: { code: 'E' } } }));
    expect(e!.cause).toBe(JSON.stringify({ code: 'E' }));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/__tests__/job-log.test.ts`
Expected: FAIL（`Failed to resolve import "../job-log"` 或 `eventLogLine is not a function`）。

- [ ] **Step 3: 写最小实现**

创建 `src/lib/job-log.ts`：

```ts
import type { JobStreamEvent } from '@/hooks/use-job-stream';

export interface JobLogLine {
  time: string;
  text: string;
  isError: boolean;
}

export interface JobError {
  message: string;
  stack?: string;
  cause?: string;
  responseText?: string;
  finishReason?: string;
  usage?: unknown;
}

function pickText(data: Record<string, unknown>): string {
  for (const key of ['message', 'step', 'description'] as const) {
    const v = data[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function formatLogTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 把一条 job 事件归一化为一行日志（时间 + 文本 + 是否错误行）。 */
export function eventLogLine(event: JobStreamEvent): JobLogLine {
  const data = event.data ?? {};
  const createdAt = typeof data.createdAt === 'string' ? data.createdAt : '';
  return {
    time: formatLogTime(createdAt),
    text: pickText(data) || event.type,
    isError: event.type === 'job:failed' || event.type.endsWith(':error'),
  };
}

/** 解析 jobs.resultJson 中的 error 对象；非法/无 error 返回 null。 */
export function parseJobError(resultJson: string | null | undefined): JobError | null {
  if (!resultJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const err = (parsed as Record<string, unknown>).error;
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const out: JobError = {
    message: typeof e.message === 'string' ? e.message : String(e.message ?? 'Job failed'),
  };
  if (typeof e.stack === 'string') out.stack = e.stack;
  if (e.cause != null) out.cause = typeof e.cause === 'string' ? e.cause : JSON.stringify(e.cause);
  if (typeof e.responseText === 'string') out.responseText = e.responseText;
  if (typeof e.finishReason === 'string') out.finishReason = e.finishReason;
  if (e.usage != null) out.usage = e.usage;
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/__tests__/job-log.test.ts`
Expected: PASS（11 个断言全绿）。

- [ ] **Step 5: 类型校验**

Run: `npx tsc --noEmit`
Expected: 无错误（新文件无类型问题）。

- [ ] **Step 6: 提交**

```bash
git add src/lib/job-log.ts src/lib/__tests__/job-log.test.ts
git commit -m "feat(job-dialog): 新增 eventLogLine/parseJobError 纯函数及单测"
```

---

### Task 2: `JobDetailDialog` 组件

**Files:**
- Create: `src/components/shared/job-detail-dialog.tsx`

**Interfaces:**
- Consumes:
  - `eventLogLine`、`parseJobError`、`JobError` 自 `@/lib/job-log`（Task 1）。
  - `JobStreamEvent`、`JobStreamStatus` 自 `@/hooks/use-job-stream`（已存在导出）。
  - `Job` 自 `@/lib/contracts`（已存在，`resultJson: string | null`）。
  - `apiFetch` 自 `@/lib/api-fetch`；`IconButton` 自 `@/components/ui/icon-button`；`cn` 自 `@/lib/cn`。
- Produces:
  - `interface JobDetailDialogProps { jobId: string; events: JobStreamEvent[]; status: JobStreamStatus; open: boolean; onClose: () => void }`
  - `function JobDetailDialog(props: JobDetailDialogProps): JSX.Element | null`

- [ ] **Step 1: 写组件**

创建 `src/components/shared/job-detail-dialog.tsx`：

```tsx
'use client';

/**
 * JobDetailDialog —— job 详情弹窗：上半部展示当前任务全部事件日志（时间线，
 * error 行红色高亮），失败时下半部经 GET /api/jobs/[id] 取 resultJson.error
 * 展示完整错误（message + 可折叠技术细节 + 一键复制）。
 *
 * 关键约束：本组件不自建 useJobStream —— events/status 由 ProgressToast 透传，
 * 避免对同一 jobId 新开第二条 EventSource。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import type { Job } from '@/lib/contracts';
import type { JobStreamEvent, JobStreamStatus } from '@/hooks/use-job-stream';
import { eventLogLine, parseJobError } from '@/lib/job-log';

interface JobDetailDialogProps {
  jobId: string;
  events: JobStreamEvent[];
  status: JobStreamStatus;
  open: boolean;
  onClose: () => void;
}

/** 与 progress-toast 的 detectJobType 保持一致的类型识别（本地实现，避免跨组件依赖）。 */
function jobTitle(events: JobStreamEvent[]): string {
  for (const e of events) {
    if (e.type.startsWith('ingest')) return 'Ingesting';
    if (e.type.startsWith('lint')) return 'Linting';
  }
  return 'Processing';
}

export function JobDetailDialog({ jobId, events, status, open, onClose }: JobDetailDialogProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [copied, setCopied] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(true);

  const lines = useMemo(() => events.map(eventLogLine), [events]);

  // 失败时拉权威完整错误（resultJson.error）。SSE 实时 job:failed 只带摘要。
  const jobQuery = useQuery<Job>({
    queryKey: ['job', jobId],
    queryFn: async () => {
      const res = await apiFetch(`/api/jobs/${jobId}`);
      if (!res.ok) throw new Error(`GET /api/jobs/${jobId} → ${res.status}`);
      return (await res.json()) as Job;
    },
    enabled: open && status === 'failed',
  });

  const jobError = parseJobError(jobQuery.data?.resultJson);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 新日志到达时自动滚到底（仅当用户当前已在底部，避免打断手动上滚）
  useEffect(() => {
    const el = logRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  if (!open) return null;

  const handleScroll = () => {
    const el = logRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const copyError = async () => {
    if (!jobError) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jobError, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用（非安全上下文）时静默 */
    }
  };

  const title = jobTitle(events);

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-command flex items-start justify-center pt-[12vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-detail-title"
        className="flex h-[70vh] max-h-[640px] w-full max-w-2xl mx-4 flex-col bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down"
      >
        <div className="flex items-center justify-between h-12 shrink-0 px-4 border-b border-border">
          <h2 id="job-detail-title" className="text-sm font-semibold text-foreground">
            {title}
            {status === 'completed' && ' — Done'}
            {status === 'failed' && ' — Failed'}
          </h2>
          <IconButton size="sm" onClick={onClose} aria-label="Close">
            <X />
          </IconButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {/* 日志区 */}
          <div className="px-4 py-2 text-xs font-medium text-foreground-secondary border-b border-border">
            日志 · {lines.length}
          </div>
          <div
            ref={logRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-2 space-y-0.5 font-mono text-xs"
          >
            {lines.length === 0 ? (
              <p className="text-foreground-tertiary">暂无日志</p>
            ) : (
              lines.map((line, idx) => (
                <div
                  key={idx}
                  className={cn(
                    'flex gap-2 whitespace-pre-wrap break-words',
                    line.isError ? 'text-danger' : 'text-foreground-secondary',
                  )}
                >
                  {line.time && (
                    <span className="shrink-0 text-foreground-tertiary tabular-nums">{line.time}</span>
                  )}
                  <span>{line.text}</span>
                </div>
              ))
            )}
          </div>

          {/* 错误区（仅失败时） */}
          {status === 'failed' && (
            <div className="shrink-0 border-t border-border bg-danger/5 max-h-[45%] overflow-y-auto">
              <div className="flex items-center justify-between px-4 py-2">
                <span className="text-xs font-medium text-danger">错误</span>
                {jobError && (
                  <IconButton size="sm" onClick={copyError} aria-label="复制错误">
                    {copied ? <Check /> : <Copy />}
                  </IconButton>
                )}
              </div>
              <div className="px-4 pb-3 space-y-2">
                {jobQuery.isLoading && <p className="text-xs text-foreground-tertiary">加载错误详情…</p>}
                {jobError ? (
                  <>
                    <p className="text-sm font-medium text-foreground whitespace-pre-wrap break-words">
                      {jobError.message}
                    </p>
                    <button
                      type="button"
                      onClick={() => setErrorExpanded((v) => !v)}
                      className="flex items-center gap-1 text-xs text-foreground-secondary focus-ring"
                    >
                      {errorExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      技术细节
                    </button>
                    {errorExpanded && (
                      <div className="space-y-2 font-mono text-xs text-foreground-tertiary">
                        {jobError.stack && <pre className="whitespace-pre-wrap break-words">{jobError.stack}</pre>}
                        {jobError.cause && (
                          <pre className="whitespace-pre-wrap break-words">cause: {jobError.cause}</pre>
                        )}
                        {jobError.responseText && (
                          <pre className="whitespace-pre-wrap break-words">response: {jobError.responseText}</pre>
                        )}
                        {jobError.finishReason && (
                          <pre className="whitespace-pre-wrap break-words">finishReason: {jobError.finishReason}</pre>
                        )}
                        {jobError.usage != null && (
                          <pre className="whitespace-pre-wrap break-words">usage: {JSON.stringify(jobError.usage)}</pre>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  !jobQuery.isLoading && (
                    <p className="text-sm text-foreground-secondary whitespace-pre-wrap break-words">
                      {lines.filter((l) => l.isError).slice(-1)[0]?.text ?? '任务失败，无更多错误信息。'}
                    </p>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型校验**

Run: `npx tsc --noEmit`
Expected: 无错误。
（若报 `JSX.Element` 命名空间问题，把返回类型注解去掉即可——函数体已隐式返回 `null | JSX`。）

- [ ] **Step 3: 提交**

```bash
git add src/components/shared/job-detail-dialog.tsx
git commit -m "feat(job-dialog): 新增 JobDetailDialog（日志时间线+失败完整错误+复制）"
```

---

### Task 3: 接入 `ProgressToast`（入口按钮 + 渲染弹窗）

**Files:**
- Modify: `src/components/shared/progress-toast.tsx`

**Interfaces:**
- Consumes: `JobDetailDialog` 自 `./job-detail-dialog`（Task 2）。

- [ ] **Step 1: 加 import 与 state**

在 `src/components/shared/progress-toast.tsx` 顶部 import 区追加：

```tsx
import { JobDetailDialog } from './job-detail-dialog';
```

在 `ProgressToast` 函数体内、`const [collapsed, setCollapsed] = useState(false);` 之后追加：

```tsx
  const [detailOpen, setDetailOpen] = useState(false);
```

- [ ] **Step 2: 加「查看详情/查看错误」入口**

在 body 区 `{!isFinished && ( ... events received ... )}` 块**之后**、`</div>`（`px-3 py-3 space-y-2` 容器结束）**之前**，插入入口按钮：

```tsx
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            className={cn(
              'text-xs font-medium focus-ring',
              status === 'failed' ? 'text-danger' : 'text-accent',
            )}
          >
            {status === 'failed' ? '查看错误 →' : '查看详情 →'}
          </button>
```

- [ ] **Step 3: 渲染弹窗（把 return 包成 Fragment）**

把组件 `return ( <div className="fixed bottom-4 right-0 z-sheet pointer-events-none"> ... </div> );` 整体包进 `<>...</>`，并在定位容器 `</div>` 之后追加弹窗：

```tsx
  return (
    <>
      <div className="fixed bottom-4 right-0 z-sheet pointer-events-none">
        {/* …既有 toast 卡片与边缘 handle 全部保持不变… */}
      </div>
      <JobDetailDialog
        jobId={jobId}
        events={events}
        status={status}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </>
  );
```

> 注意：`jobId` 在此处已保证非 null（函数顶部 `if (!mounted || !jobId) return null;` 已早退），可直接传入 `string`。

- [ ] **Step 4: 类型校验**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: 全量单测回归**

Run: `npm test`
Expected: 既有用例 + 新增 `job-log` 用例全绿。

- [ ] **Step 6: 提交**

```bash
git add src/components/shared/progress-toast.tsx
git commit -m "feat(job-dialog): ProgressToast 接入查看详情/查看错误入口并渲染弹窗"
```

---

### Task 4: 手动验证（真实运行）

**Files:** 无（仅运行与观察）

- [ ] **Step 1: 启动开发服务**

Run: `npm run dev:all`（Next.js + worker）
Expected: 服务起来，无编译错误。

- [ ] **Step 2: 验收成功路径**

触发一个 ingest 任务 → 浮层出现「查看详情 →」→ 点击 → 弹窗日志区随事件实时增长、按时间逐行、可滚动 → 完成后 header 显示 "— Done"。

- [ ] **Step 3: 验收失败路径**

构造一个会失败的任务（如临时把 LLM key 改错触发 `job:failed`）→ 浮层入口变红「查看错误 →」→ 点击 → 弹窗下半部展示 `error.message` + 可展开 stack/cause 等 → 点「复制」可复制完整 error JSON → 日志区失败相关行为红色。

- [ ] **Step 4: 验收无双连接**

打开浏览器 DevTools → Network → 确认打开弹窗后对 `/api/jobs/<id>/events` 的 SSE 连接**仍只有一条**（弹窗未新建第二条）；仅在失败时多一条对 `/api/jobs/<id>` 的普通 GET。

---

## 自查（Self-Review）

**1. Spec 覆盖：**
- 形态=独立弹窗（spec §3）→ Task 2/3。
- 日志区=全部事件按时间逐行 + error 红高亮（spec §5.2/§6）→ Task 1 `eventLogLine` + Task 2 渲染。
- 错误区=`GET /api/jobs/[id]` 取 `resultJson.error` + 折叠技术细节 + 复制（spec §5.3/§6）→ Task 1 `parseJobError` + Task 2 渲染。
- 不自建第二条 SSE（spec §4/§9）→ Task 2 透传 + Task 4 Step 4 验收。
- 纯前端、不动后端（spec §2）→ 全程仅改 `src/lib` + `src/components/shared`。
- 测试（spec §8）→ Task 1 单测；组件层按惯例不强加，改以 tsc + 手动验证（Task 4）。

**2. 占位符扫描：** 无 TBD/TODO；每个改码步骤均给出完整代码。

**3. 类型一致性：** `eventLogLine`/`parseJobError`/`JobError`/`JobLogLine` 在 Task 1 定义，Task 2 按相同签名消费；`JobDetailDialogProps` 字段与 Task 3 传参一致（`jobId/events/status/open/onClose`）；`Job.resultJson: string | null` 与 `parseJobError` 入参类型一致。

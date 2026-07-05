# Ingest 多任务支持 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ingest 支持多文件批量提交、worker 并发执行（仅 ingest 之间并发）、以及右下角聚合进度面板展示所有活跃任务。

**Architecture:** 三层独立改动：① 新增全局设置 `ingestConcurrency`（app_settings，默认 2，clamp 1–4）；② worker 的 `isProcessing` 布尔升级为 `runningJobs` Map + 纯函数 `decideClaim` 决策（空闲可 claim 任意类型、全 ingest 且未满可再 claim ingest、否则不 claim）——复用**已有的** `queue.claim('ingest')` 类型过滤，队列层零改动；③ 前端 workbench 多文件循环 POST + `GlobalJobTracker` 改为追踪 job 列表、新 `JobsPanel` 聚合面板替换单条 `ProgressToast` 挂载。

**Tech Stack:** Next.js 15 / React 19 / TypeScript 5、better-sqlite3 + 自建 jobs 队列、zod、vitest、TanStack React Query、SSE（`use-job-stream`）。

**Spec:** `docs/superpowers/specs/2026-07-06-ingest-multi-task-design.md`

## Global Constraints

- `ingestConcurrency`：int，默认 **2**，范围 **1–4**；worker 每轮 tick 实时读取（不缓存）；设为 1 行为等同现状。
- 并发策略：**仅 ingest 之间可并发**；非 ingest 任务（lint/curate/fix/embed-index/re-enrich/save-to-wiki）与一切互斥（独占执行）。
- 与 spec 的偏差（已确认更优）：队列层不加 `onlyTypes` 数组参数——`jobsRepo.claimNextJob(type?)` 已支持单类型过滤，直接用 `queue.claim('ingest')`。
- 验证命令：**不要用 `npm run lint`**（next lint 已弃用且会交互卡住）；用 `npx tsc --noEmit` + `npx vitest run <file>`。
- git commit message 用中文一句话；**禁止** Co-Authored-By / "Generated with Claude Code" 脚注。
- 客户端 HTTP 一律 `apiFetch` / `useApiFetch()`；组件样式走 Tailwind + `cn()` + CSS 变量 token。
- 全局设置贯通链：`lib/contracts.ts`（schema+默认值）→ `db/repos/settings-repo.ts`（getter/setter）→ `GET/PUT /api/settings` → `components/layout/settings-content.tsx`（不写 Zustand）。

---

### Task 1: `ingestConcurrency` 全局设置贯通

**Files:**
- Modify: `src/lib/contracts.ts:258-332`（常量/schema/AppSettings）
- Modify: `src/server/db/repos/settings-repo.ts`（key 常量 + getter/setter）
- Modify: `src/app/api/settings/route.ts`（GET 聚合 + PUT 分发）
- Modify: `src/components/layout/settings-content.tsx`（AgentsPanel 加一行）
- Test: `src/server/db/repos/__tests__/settings-repo.test.ts`（已存在，追加用例）

**Interfaces:**
- Produces: `getIngestConcurrency(): number`（Task 3 的 worker 消费）、`setIngestConcurrency(value: number): number`、contracts 导出 `DEFAULT_INGEST_CONCURRENCY = 2` 与 `IngestConcurrencySchema`（zod，int 1–4）、`AppSettings.ingestConcurrency: number`。

- [ ] **Step 1: 追加失败的 settings-repo 测试**

在 `src/server/db/repos/__tests__/settings-repo.test.ts` 中，参照文件里已有的 agent 设置用例风格追加（describe 块与既有测试同级）：

```ts
import { getIngestConcurrency, setIngestConcurrency } from '../settings-repo';
// ↑ 并入文件顶部既有的 settings-repo import

describe('ingestConcurrency', () => {
  it('缺省时返回默认值 2', () => {
    expect(getIngestConcurrency()).toBe(2);
  });

  it('set 后 get 读到新值', () => {
    setIngestConcurrency(4);
    expect(getIngestConcurrency()).toBe(4);
  });

  it('越界值被 zod 拒绝', () => {
    expect(() => setIngestConcurrency(0)).toThrow();
    expect(() => setIngestConcurrency(5)).toThrow();
    expect(() => setIngestConcurrency(2.5)).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/settings-repo.test.ts`
Expected: FAIL —— `getIngestConcurrency` 未导出（import 报错）。

- [ ] **Step 3: contracts 加常量与 schema**

在 `src/lib/contracts.ts` 的 agent 设置常量区（`DEFAULT_AGENT_AUTO_CURATE` 附近，约 260 行）追加：

```ts
// ── Ingest 并发（worker 每轮 tick 实时读取；1 = 行为等同串行现状）─────────
export const DEFAULT_INGEST_CONCURRENCY = 2;
export const IngestConcurrencySchema = z.number().int().min(1).max(4);
```

`AppSettings` 接口（约 304 行）加一行：

```ts
  ingestConcurrency: number;
```

`AppSettingsSchema`（约 319 行）加一行：

```ts
  ingestConcurrency: IngestConcurrencySchema,
```

- [ ] **Step 4: settings-repo 加 getter/setter**

在 `src/server/db/repos/settings-repo.ts`：key 常量区（35 行附近）加：

```ts
const KEY_INGEST_CONCURRENCY = 'ingestConcurrency';
```

顶部 import 区并入：

```ts
import { DEFAULT_INGEST_CONCURRENCY, IngestConcurrencySchema } from '@/lib/contracts';
```

在 `getAgentMaxParallelSubAgents` 一组之后追加（复用文件内已有的 `readNumber`/`writeKey`）：

```ts
/**
 * Returns ingest worker concurrency (1-4). Falls back to DEFAULT_INGEST_CONCURRENCY (2).
 * Reads DB on every call so changes take effect without worker restart.
 */
export function getIngestConcurrency(): number {
  return readNumber(KEY_INGEST_CONCURRENCY, DEFAULT_INGEST_CONCURRENCY);
}

/** Persists ingest concurrency. Validates via IngestConcurrencySchema (1-4). */
export function setIngestConcurrency(value: number): number {
  const v = IngestConcurrencySchema.parse(value);
  writeKey(KEY_INGEST_CONCURRENCY, String(v));
  return v;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/settings-repo.test.ts`
Expected: PASS（含新增 3 用例）。

- [ ] **Step 6: 贯通 API 路由**

`src/app/api/settings/route.ts`：

- import 并入 `getIngestConcurrency, setIngestConcurrency`（来自 settings-repo）与 `IngestConcurrencySchema`（来自 contracts）；
- GET 聚合对象（53 行附近 `agentMaxParallelSubAgents: ...` 之后）加：

```ts
    ingestConcurrency: getIngestConcurrency(),
```

- PUT 的 partial schema（75 行附近）加：

```ts
  ingestConcurrency: IngestConcurrencySchema.optional(),
```

- PUT 分发（111 行附近）加：

```ts
  if (d.ingestConcurrency !== undefined) setIngestConcurrency(d.ingestConcurrency);
```

- [ ] **Step 7: 设置面板加行**

`src/components/layout/settings-content.tsx` 的 `AgentsPanel`，在 "Parallel sub-agents" 行之后追加：

```tsx
      <NumberSettingRow
        label="Ingest concurrency"
        description="How many ingest jobs run at once; other job types always run alone"
        value={settings?.ingestConcurrency ?? 2}
        min={1}
        max={4}
        onSave={(v) => savePartial.mutate({ ingestConcurrency: v })}
        pending={savePartial.isPending}
      />
```

- [ ] **Step 8: 类型检查 + 提交**

Run: `npx tsc --noEmit`
Expected: 退出码 0。

```bash
git add src/lib/contracts.ts src/server/db/repos/settings-repo.ts src/server/db/repos/__tests__/settings-repo.test.ts src/app/api/settings/route.ts src/components/layout/settings-content.tsx
git commit -m "feat(settings): 新增 ingestConcurrency 全局设置（默认 2，范围 1-4）"
```

---

### Task 2: `decideClaim` 纯函数（worker 调度决策）

**Files:**
- Modify: `src/server/jobs/worker.ts`（追加导出的纯函数，本 task 不动 startWorker）
- Test: 新建 `src/server/jobs/__tests__/decide-claim.test.ts`

**Interfaces:**
- Produces: `export type ClaimDecision = 'any' | 'ingest-only' | 'none'` 与 `export function decideClaim(runningTypes: readonly string[], ingestLimit: number): ClaimDecision`（Task 3 的 startWorker 消费）。
- Consumes: 无（纯函数）。

- [ ] **Step 1: 写失败的测试**

新建 `src/server/jobs/__tests__/decide-claim.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { decideClaim } from '../worker';

describe('decideClaim', () => {
  it('完全空闲 → 可 claim 任意类型', () => {
    expect(decideClaim([], 2)).toBe('any');
  });

  it('全是 ingest 且未满额 → 只允许再 claim ingest', () => {
    expect(decideClaim(['ingest'], 2)).toBe('ingest-only');
    expect(decideClaim(['ingest', 'ingest'], 3)).toBe('ingest-only');
  });

  it('全是 ingest 且已满额 → 不 claim', () => {
    expect(decideClaim(['ingest', 'ingest'], 2)).toBe('none');
    expect(decideClaim(['ingest'], 1)).toBe('none');
  });

  it('有非 ingest 在跑 → 独占，不 claim', () => {
    expect(decideClaim(['lint'], 2)).toBe('none');
    expect(decideClaim(['curate'], 4)).toBe('none');
  });

  it('limit=1 时行为等同串行现状', () => {
    expect(decideClaim([], 1)).toBe('any');
    expect(decideClaim(['ingest'], 1)).toBe('none');
    expect(decideClaim(['fix'], 1)).toBe('none');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/jobs/__tests__/decide-claim.test.ts`
Expected: FAIL —— `decideClaim` 未导出。

- [ ] **Step 3: 实现纯函数**

在 `src/server/jobs/worker.ts` 的 `decideJobFailureAction` 之后追加：

```ts
export type ClaimDecision = 'any' | 'ingest-only' | 'none';

/**
 * 并发调度决策（纯函数，便于测试）：
 *  - 完全空闲 → 可 claim 任意类型（claim 到非 ingest 则该 job 独占直到结束）；
 *  - 当前全是 ingest 且数量 < ingestLimit → 只允许再 claim 一个 ingest；
 *  - 其余（有非 ingest 在跑 / ingest 已满额）→ 本轮不 claim。
 * 仅 ingest 之间可并发；写入安全由 vault-mutex（进程内队列 + 跨进程文件锁）保证。
 */
export function decideClaim(
  runningTypes: readonly string[],
  ingestLimit: number,
): ClaimDecision {
  if (runningTypes.length === 0) return 'any';
  if (runningTypes.every((t) => t === 'ingest') && runningTypes.length < ingestLimit) {
    return 'ingest-only';
  }
  return 'none';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/server/jobs/__tests__/decide-claim.test.ts`
Expected: PASS（5 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/server/jobs/worker.ts src/server/jobs/__tests__/decide-claim.test.ts
git commit -m "feat(jobs): 新增 decideClaim 并发调度纯函数（仅 ingest 可并发）"
```

---

### Task 3: worker 并发执行改造

**Files:**
- Modify: `src/server/jobs/worker.ts:70,123-207`（`isProcessing` → `runningJobs`；tick 内 claim 决策 + job 执行抽函数）

**Interfaces:**
- Consumes: Task 2 的 `decideClaim`；Task 1 的 `getIngestConcurrency`（从 `../db/repos/settings-repo` import，该文件已有同源 import 可并入）；既有 `queue.claim(type?)`（`src/server/jobs/queue.ts:12`，传 `'ingest'` 即类型过滤）。
- Produces: 无新导出；`startWorker` 行为变化——每轮 tick 按决策 claim，多个 ingest 并行 `runJob`。

- [ ] **Step 1: 改造 startWorker**

对 `src/server/jobs/worker.ts` 做如下修改。

(a) 第 70 行的模块级状态替换：

```ts
// 旧
let isProcessing = false;
// 新：运行中任务表 jobId → type（并发调度依据）
const runningJobs = new Map<string, string>();
```

(b) import 区并入 `getIngestConcurrency`（`from '../db/repos/settings-repo'`，该行已 import 5 个 maintenance getter，直接加一项）。

(c) 把 `startWorker` 中 setInterval 回调体（131–207 行）里"claim + 执行"的整段逻辑重写为：

```ts
  const intervalId = setInterval(() => {
    // 并发调度：仅 ingest 之间可并发（上限实时读设置）；非 ingest 独占。
    // 写入安全由 vault-mutex（进程内队列 + 跨进程文件锁）保证，git commit 排队执行。
    const decision = decideClaim([...runningJobs.values()], getIngestConcurrency());
    if (decision === 'none') return;

    const job = decision === 'ingest-only' ? queue.claim('ingest') : queue.claim();
    if (!job) return;

    runningJobs.set(job.id, job.type);
    void runJob(job).finally(() => {
      runningJobs.delete(job.id);
    });
  }, pollIntervalMs);
```

(d) 原回调体中从 `const handler = handlers.get(job.type)` 到 `finally { clearInterval(heartbeatId); isProcessing = false; }` 的全部逻辑，原样搬进模块级新函数 `runJob`（放在 `startWorker` 之前），仅做两处机械替换——删除三处 `isProcessing = true/false`、handler 缺失分支改为 `return`：

```ts
async function runJob(job: Job): Promise<void> {
  const handler = handlers.get(job.type);
  if (!handler) {
    queue.fail(job.id, new Error(`No handler registered for job type: ${job.type}`));
    events.emit(job.id, 'job:failed', `No handler registered for job type: ${job.type}`);
    return;
  }

  const emit = (
    type: string,
    message: string,
    data?: Record<string, unknown>
  ): void => {
    events.emit(job.id, type, message, data);
  };

  // Start heartbeat to extend lease during long-running jobs
  const heartbeatId = setInterval(() => {
    try {
      queue.updateHeartbeat(job.id);
    } catch {
      // If heartbeat fails, the lease will expire and another worker can reclaim
    }
  }, HEARTBEAT_INTERVAL_MS);

  const attempt = job.attemptCount;

  try {
    const result = await handler(job, emit);
    queue.complete(job.id, result);
    events.emit(job.id, 'job:completed', 'Job completed successfully', { result });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const errorData: Record<string, unknown> = { error: errorMessage };
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      if (e.finishReason) errorData.finishReason = e.finishReason;
      if (e.usage) errorData.usage = e.usage;
    }

    const action = decideJobFailureAction(error, attempt, MAX_RETRIES);
    if (action === 'cancelled') {
      // 用户取消：cancel 路由通常已把 job 落终态(failed)+清检查点；这里幂等兜底
      // （若仍为 running 则 requestCancel 会落终态），并补发 job:cancelled 区别于失败。
      queue.requestCancel(job.id);
      events.emit(job.id, 'job:cancelled', 'Job cancelled by user', { manual: true });
    } else if (action === 'retry') {
      // Retry: requeue the SAME job (preserves job ID for SSE tracking)
      const delay = RETRY_DELAY_MS * attempt;
      events.emit(
        job.id,
        'job:retrying',
        `Retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1}) after ${delay}ms...`,
        { attempt, maxRetries: MAX_RETRIES },
      );
      await sleep(delay);
      queue.requeue(job.id);
    } else {
      queue.fail(job.id, error);
      events.emit(job.id, 'job:failed', errorMessage, errorData);
    }
  } finally {
    clearInterval(heartbeatId);
  }
}
```

注意：`setInterval` 回调不再是 `async`（内部用 `void runJob(...).finally(...)` 火忘执行），避免同一轮 tick 阻塞后续 tick。retry 分支 `requeue` 后 job 回到 pending，`runJob` 结束、`runningJobs` 清掉该 id，下一轮 tick 会按正常调度重新 claim——与现状语义一致（claim 会再取到它）。

- [ ] **Step 2: 类型检查 + 全量跑 jobs 相关测试**

Run: `npx tsc --noEmit && npx vitest run src/server/jobs`
Expected: tsc 退出码 0；jobs 目录既有测试（maintenance-tick、decide-claim）全 PASS。

- [ ] **Step 3: 全量单测回归**

Run: `npx vitest run`
Expected: 全部 PASS（改动不触及任何 service/repo 逻辑，若有失败先排查是否与本改动相关）。

- [ ] **Step 4: 提交**

```bash
git add src/server/jobs/worker.ts
git commit -m "feat(jobs): worker 支持 ingest 并发执行（runningJobs Map + decideClaim 调度）"
```

---

### Task 4: workbench 多文件批量提交

**Files:**
- Modify: `src/app/(app)/_components/ingest-workbench.tsx`

**Interfaces:**
- Consumes: 既有 `POST /api/ingest`（multipart 单文件，返回 `{ jobId, sourceId }`）；既有 `wiki:job-started` CustomEvent 约定（Task 5 的 tracker 消费）。
- Produces: UI 行为——文件模式支持多选/多文件拖拽；单文件走既有 live view，多文件循环上传后展示逐条结果面板（复用 URL 模式的 `urlResults` 面板结构）。

- [ ] **Step 1: state 与文件选择改多文件**

对 `ingest-workbench.tsx` 做如下修改。

(a) `selectedFile: File | null` 替换为数组，并加批量结果 state（`urlResults` 旁，64 行附近）：

```ts
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileResults, setFileResults] = useState<
    Array<{ filename: string; jobId?: string; error?: string }> | null
  >(null);
```

（删除原 `selectedFile` state；`reset` 中 `setSelectedFile(null)` 改为 `setSelectedFiles([]); setFileResults(null);`）

(b) 隐藏的 `<input type="file">`（386 行附近）加 `multiple`，onChange 改为：

```tsx
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) {
              setSelectedFiles(files);
              setError(null);
            }
          }}
        />
```

(c) `handleDrop`（342 行附近）改为收全部文件：

```ts
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setMode('file');
      setSelectedFiles(files);
      setError(null);
    }
  }, []);
```

(d) drop zone 的已选态展示（447–456 行）改为支持多文件：

```tsx
                {selectedFiles.length > 0 ? (
                  <>
                    <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                      <FileUp className="h-5 w-5 text-accent" aria-hidden />
                      <span className="font-mono">
                        {selectedFiles.length === 1
                          ? selectedFiles[0].name
                          : `${selectedFiles.length} files selected`}
                      </span>
                    </span>
                    <span className="font-mono text-xs text-foreground-tertiary">
                      {formatBytes(selectedFiles.reduce((sum, f) => sum + f.size, 0))} · click to
                      choose again
                    </span>
                  </>
                ) : (
```

（未选中分支不变；`canStart` 中 `!!selectedFile` 改为 `selectedFiles.length > 0`。）

(e) dashboard handoff effect（177–185 行）改为 `setSelectedFiles([handoff])`（`startUpload(handoff)` 调用不变——handoff 恒为单文件）。

- [ ] **Step 2: handleStart 文件分支支持批量**

`handleStart` 的 file 分支（255–262 行）替换为：

```ts
    if (mode === 'file') {
      if (selectedFiles.length === 0) {
        fileRef.current?.click();
        return;
      }
      if (selectedFiles.length === 1) {
        await startUpload(selectedFiles[0]);
        return;
      }
      // 批量：逐个上传（每文件独立 job），逐条归集结果，留在本页展示结果面板
      setError(null);
      setCreatedPages([]);
      setFileResults(null);
      setUploading(true);
      const subjectId = useUIStore.getState().currentSubjectId;
      const results: Array<{ filename: string; jobId?: string; error?: string }> = [];
      for (const file of selectedFiles) {
        try {
          const formData = new FormData();
          formData.append('file', file);
          if (subjectId) formData.append('subjectId', subjectId);
          const res = await apiFetch('/api/ingest', { method: 'POST', body: formData });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Upload failed (${res.status})`);
          }
          const data = await res.json();
          results.push({ filename: file.name, jobId: data.jobId });
          window.dispatchEvent(
            new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }),
          );
        } catch (err) {
          results.push({
            filename: file.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      setFileResults(results);
      setSelectedFiles([]);
      if (fileRef.current) fileRef.current.value = '';
      setUploading(false);
      return;
    }
```

- [ ] **Step 3: 批量结果面板**

在既有 `urlResults` 面板（508–532 行）之后，仿其结构加 `fileResults` 面板：

```tsx
            {fileResults && (
              <div className="flex flex-col gap-1.5 rounded-md border border-border bg-canvas p-3">
                <span className="text-xs font-semibold text-foreground">
                  {fileResults.filter((r) => r.jobId).length}/{fileResults.length} files queued
                </span>
                <ul className="flex flex-col gap-1">
                  {fileResults.map((r) => (
                    <li key={r.filename} className="flex items-start gap-2 text-xs">
                      <FileUp
                        className={cn('mt-0.5 h-3 w-3 shrink-0', r.jobId ? 'text-accent' : 'text-danger')}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="break-all font-mono text-foreground-secondary">{r.filename}</span>
                        {r.error && <span className="text-danger"> — {r.error}</span>}
                        {r.jobId && <span className="text-foreground-tertiary"> — queued</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                <span className="text-xs text-foreground-tertiary">
                  Jobs run in the background — watch progress in the corner panel.
                </span>
              </div>
            )}
```

顺带把 drop zone 未选中态的提示文案 `Drag & drop, or click to browse` 下方一行改为 `.md · .txt · .html · .pdf — up to 50 MB each, multiple files OK`。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 退出码 0（重点确认 `selectedFile` 的所有旧引用已清干净）。

- [ ] **Step 5: 手动验证**

Run: `npm run dev:all`（若用户已在跑 dev:all 则直接用现有实例），浏览器打开 `/ingest`：
- 文件模式选择 2+ 个小 `.md` 文件 → Start ingest → 出现 "N/N files queued" 逐条面板；
- 单文件仍进入既有 live view；
- worker 日志可见两个 ingest job 并行处理（Task 3 生效后）。

**⚠️ 注意（来自项目经验）**：测试 ingest 会污染真实 vault——用小的无害测试文件，验证后到 `/history` 回滚或 `git -C data/vault revert` 清理，并删除 `data/vault/raw/<subject>/` 下的测试源文件。

- [ ] **Step 6: 提交**

```bash
git add "src/app/(app)/_components/ingest-workbench.tsx"
git commit -m "feat(ui): ingest workbench 文件模式支持多文件批量提交"
```

---

### Task 5: 多任务聚合进度面板

**Files:**
- Create: `src/components/shared/jobs-panel.tsx`
- Modify: `src/components/shared/global-job-tracker.tsx`（重写为多 job 追踪）
- Reference（只读复用，不改）: `src/components/shared/progress-toast.tsx`（`detectJobType`/样式参考）、`src/components/shared/job-detail-dialog.tsx`、`src/hooks/use-job-stream.ts`

**Interfaces:**
- Consumes: `useJobStream(jobId: string | null, reconnectKey?: number): { events: JobStreamEvent[]; status: JobStreamStatus; latestMessage: string }`（`JobStreamEvent = { id, type, data: Record<string, unknown> }` 风格，payload 嵌套在 `evt.data.data.*`）；`JobDetailDialog({ jobId, events, status, open, onClose })`；`GET /api/jobs?status=running|pending`（返回 `Job[]`，含 `paramsJson`）；`wiki:job-started` CustomEvent。
- Produces: `JobsPanel({ jobs, onRemove }: { jobs: TrackedJob[]; onRemove: (id: string) => void })` 与 `type TrackedJob = { id: string; type: string; label: string; queueStatus: 'running' | 'pending'; reconnectKey: number }`（仅 tracker 消费，二者同 PR 内闭环）。

- [ ] **Step 1: 重写 GlobalJobTracker 为多 job 追踪**

`src/components/shared/global-job-tracker.tsx` 整体替换为：

```tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { JobsPanel, type TrackedJob } from './jobs-panel';
import { apiFetch } from '@/lib/api-fetch';
import type { Job } from '@/lib/contracts';

/** 从 job params 提取一行可读摘要（文件名 / URL / slug），兜底 job 类型名。 */
function jobLabel(job: Pick<Job, 'type' | 'paramsJson'>): string {
  const p = (job.paramsJson ?? {}) as Record<string, unknown>;
  const candidate = p.filename ?? p.url ?? p.slug;
  if (typeof candidate === 'string' && candidate) return candidate;
  return job.type;
}

/**
 * Polls for active (running + pending) jobs and shows them in a single
 * aggregated JobsPanel. Mounted once in Providers so progress is visible
 * from any page. Per-row SSE subscription & query invalidation live in
 * JobsPanel rows.
 */
export function GlobalJobTracker() {
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  // 行级终态后用户/定时器移除的 id：轮询不再重新加回（防已完成 job 复现）。
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const checkActiveJobs = useCallback(async () => {
    try {
      const [runningRes, pendingRes] = await Promise.all([
        apiFetch('/api/jobs?status=running'),
        apiFetch('/api/jobs?status=pending'),
      ]);
      if (!runningRes.ok || !pendingRes.ok) return;
      const running = (await runningRes.json()) as Job[];
      const pending = (await pendingRes.json()) as Job[];
      const active = [
        ...running.map((j) => ({ job: j, queueStatus: 'running' as const })),
        ...pending.map((j) => ({ job: j, queueStatus: 'pending' as const })),
      ];
      setJobs((prev) => {
        const prevById = new Map(prev.map((t) => [t.id, t]));
        const activeIds = new Set(active.map((a) => a.job.id));
        const next: TrackedJob[] = active
          .filter((a) => !dismissed.has(a.job.id))
          .map((a) => ({
            id: a.job.id,
            type: a.job.type,
            label: prevById.get(a.job.id)?.label ?? jobLabel(a.job),
            queueStatus: a.queueStatus,
            reconnectKey: prevById.get(a.job.id)?.reconnectKey ?? 0,
          }));
        // 已离开 running/pending 的行保留（终态展示由行内 SSE 驱动，移除走 onRemove）
        for (const t of prev) {
          if (!activeIds.has(t.id) && !dismissed.has(t.id)) next.push(t);
        }
        return next;
      });
    } catch {
      // ignore network errors
    }
  }, [dismissed]);

  useEffect(() => {
    checkActiveJobs();
    const interval = setInterval(checkActiveJobs, 5000);
    return () => clearInterval(interval);
  }, [checkActiveJobs]);

  // 组件启动/重试即时补入（retry 场景同 id 需 bump reconnectKey 重新订阅 SSE）。
  useEffect(() => {
    function onJobStarted(e: CustomEvent<{ jobId: string }>) {
      const jobId = e.detail.jobId;
      setDismissed((prev) => {
        if (!prev.has(jobId)) return prev;
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
      setJobs((prev) => {
        const existing = prev.find((t) => t.id === jobId);
        if (existing) {
          return prev.map((t) =>
            t.id === jobId
              ? { ...t, queueStatus: 'running', reconnectKey: t.reconnectKey + 1 }
              : t,
          );
        }
        return [
          ...prev,
          { id: jobId, type: 'ingest', label: 'Starting…', queueStatus: 'running', reconnectKey: 0 },
        ];
      });
    }
    window.addEventListener('wiki:job-started', onJobStarted as EventListener);
    return () => window.removeEventListener('wiki:job-started', onJobStarted as EventListener);
  }, []);

  const handleRemove = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
    setJobs((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return <JobsPanel jobs={jobs} onRemove={handleRemove} />;
}
```

- [ ] **Step 2: 新建 JobsPanel**

新建 `src/components/shared/jobs-panel.tsx`：

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Loader2, ListTodo, Square, X } from 'lucide-react';
import { useJobStream } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import { JobDetailDialog } from './job-detail-dialog';

export interface TrackedJob {
  id: string;
  type: string;
  /** 一行可读摘要：文件名 / URL / slug，兜底 job 类型名。 */
  label: string;
  /** 轮询到的队列状态：running 才建 SSE（浏览器 SSE 连接数有限）。 */
  queueStatus: 'running' | 'pending';
  /** bump 以强制重新订阅（retry 同 id 场景）。 */
  reconnectKey: number;
}

const COMPLETED_LINGER_MS = 5_000;

function jobTypeVerb(type: string): string {
  switch (type) {
    case 'ingest':
      return 'Ingesting';
    case 'lint':
      return 'Linting';
    case 'curate':
      return 'Curating';
    case 'fix':
      return 'Fixing';
    case 're-enrich':
      return 'Enriching';
    case 'embed-index':
      return 'Indexing';
    default:
      return 'Processing';
  }
}

function RowStatusIcon({ status, queueStatus }: { status: string; queueStatus: string }) {
  if (status === 'completed') return <Check className="h-3.5 w-3.5 text-success" />;
  if (status === 'failed') return <X className="h-3.5 w-3.5 text-danger" />;
  if (queueStatus === 'pending' && status === 'idle')
    return <ListTodo className="h-3.5 w-3.5 text-foreground-tertiary" />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
}

/** 单任务行：running 时持有自己的 SSE 订阅；终态后驻留（completed 定时移除）。 */
function JobRow({ job, onRemove }: { job: TrackedJob; onRemove: (id: string) => void }) {
  // pending 行不建 SSE（浏览器每域 SSE 连接有限；轮询会在其转 running 后接上）
  const streamId = job.queueStatus === 'running' ? job.id : null;
  const { events, status, latestMessage } = useJobStream(streamId, job.reconnectKey);
  const [detailOpen, setDetailOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const queryClient = useQueryClient();

  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';
  const wasCancelled = events.some((e) => e.type === 'job:cancelled');

  // 任一 job 完成 → 失效列表缓存（保持旧 GlobalJobTracker 语义）
  useEffect(() => {
    if (!isCompleted) return;
    queryClient.invalidateQueries({ queryKey: ['pages'] });
    queryClient.invalidateQueries({ queryKey: ['page-detail'] });
  }, [isCompleted, queryClient]);

  // completed 行驻留几秒后自动移除；failed 行驻留到用户手动关闭
  useEffect(() => {
    if (!isCompleted) return;
    const t = setTimeout(() => onRemove(job.id), COMPLETED_LINGER_MS);
    return () => clearTimeout(t);
  }, [isCompleted, job.id, onRemove]);

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await apiFetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    } catch {
      // 结果由 SSE 终态事件反映
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <li className="flex flex-col gap-1 px-3 py-2">
        <div className="flex items-center gap-2">
          <RowStatusIcon status={status} queueStatus={job.queueStatus} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            <span className="text-foreground-secondary">{jobTypeVerb(job.type)}</span>{' '}
            <span className="font-mono">{job.label}</span>
          </span>
          {status === 'streaming' && (
            <IconButton
              size="sm"
              onClick={handleCancel}
              disabled={cancelling}
              aria-label="Stop job"
              className="tip tip-l"
              data-tip="Stop job"
            >
              <Square />
            </IconButton>
          )}
          {(isCompleted || isFailed) && (
            <IconButton size="sm" onClick={() => onRemove(job.id)} aria-label="Dismiss">
              <X />
            </IconButton>
          )}
        </div>
        <p className="truncate pl-[22px] text-xs text-foreground-tertiary">
          {job.queueStatus === 'pending' && status === 'idle'
            ? 'Queued'
            : isFailed
              ? wasCancelled
                ? 'Cancelled'
                : latestMessage || 'Failed'
              : latestMessage || '…'}
        </p>
        {(isFailed || events.length > 0) && (
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            className={cn(
              'self-start pl-[22px] text-xs font-medium focus-ring',
              isFailed && !wasCancelled ? 'text-danger' : 'text-accent',
            )}
          >
            {isFailed && !wasCancelled ? 'View error →' : 'View details →'}
          </button>
        )}
      </li>
      <JobDetailDialog
        jobId={job.id}
        events={events}
        status={status}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </>
  );
}

/**
 * 右下角聚合任务面板：列出所有 running/pending job，各行独立 SSE 进度。
 * 单行时视觉接近旧 ProgressToast；可整体折叠为边缘把手。
 */
export function JobsPanel({
  jobs,
  onRemove,
}: {
  jobs: TrackedJob[];
  onRemove: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (jobs.length > 0) {
      const t = setTimeout(() => setVisible(true), 10);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [jobs.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (jobs.length === 0) return null;

  const runningCount = jobs.filter((j) => j.queueStatus === 'running').length;

  return (
    <div className="fixed bottom-4 right-0 z-sheet pointer-events-none">
      <div
        role="status"
        aria-live="polite"
        inert={collapsed}
        className={cn(
          'mr-4 w-80 rounded-lg border border-border bg-surface shadow-lg transition-all duration-base ease-standard',
          collapsed
            ? 'pointer-events-none translate-x-[calc(100%+1rem)] opacity-0'
            : visible
              ? 'pointer-events-auto translate-x-0 opacity-100'
              : 'pointer-events-none translate-y-4 opacity-0',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex-1 text-sm font-medium text-foreground">
            Tasks
            <span className="ml-1.5 font-mono text-xs text-foreground-tertiary">
              {runningCount} running · {jobs.length - runningCount} queued/done
            </span>
          </span>
          <IconButton
            size="sm"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse tasks"
            className="tip tip-l"
            data-tip="Collapse"
          >
            <ChevronRight />
          </IconButton>
        </div>
        <ul className="max-h-72 divide-y divide-border-subtle overflow-y-auto">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} onRemove={onRemove} />
          ))}
        </ul>
      </div>

      {/* 折叠后的边缘把手（贴右缘，展示 running 计数） */}
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Expand tasks"
        data-tip="Expand tasks"
        inert={!collapsed}
        className={cn(
          'tip tip-l !absolute right-0 top-0 flex flex-col items-center gap-1 rounded-l-lg border border-r-0 border-border bg-surface px-1.5 py-2 shadow-lg focus-ring transition-all duration-base ease-standard',
          collapsed
            ? 'translate-x-0 opacity-100 pointer-events-auto'
            : 'translate-x-full opacity-0 pointer-events-none',
        )}
      >
        {runningCount > 0 ? (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        ) : (
          <Check className="h-4 w-4 text-success" />
        )}
        <span className="font-mono text-[10px] tabular-nums text-foreground-tertiary">
          {jobs.length}
        </span>
      </button>
    </div>
  );
}
```

注意：`JobStreamEvent` 的 payload 嵌套在 `evt.data.data.*`（项目已知坑），本组件只读 `e.type`/`latestMessage`，不解 payload；若后续要读 `progress` 等字段记得取嵌套层。

- [ ] **Step 3: 确认 `paramsJson` 字段形状**

`jobLabel` 依赖 `GET /api/jobs` 返回的 job 含 `paramsJson`（对象或 JSON 字符串）。检查 `src/app/api/jobs/route.ts` 与 `jobs-repo.listJobs` 的序列化：若 `paramsJson` 是字符串，`jobLabel` 开头加：

```ts
  const raw = job.paramsJson;
  const p = (typeof raw === 'string' ? JSON.parse(raw || '{}') : raw ?? {}) as Record<string, unknown>;
```

（用 try/catch 包 `JSON.parse` 兜底为 `{}`。以实际返回为准调整。）

- [ ] **Step 4: 类型检查 + 全量单测**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 均 PASS。旧 `ProgressToast` 仍被保留在代码库（`ingest-live-view` 等无引用则仅 tracker 停用其挂载）——检查 `grep -rn "ProgressToast" src/` 确认除 progress-toast.tsx 自身外无残余消费者引用被破坏；若 `IngestPill`（`components/layout/ingest-pill.tsx`）订阅同一 CustomEvent，确认其不受影响（只加不改事件语义）。

- [ ] **Step 5: 手动验证（Playwright 或浏览器）**

`npm run dev:all` 下：
- 批量上传 3 个小文件 → 面板出现 3 行：2 行 running（并发=2）+ 1 行 Queued；
- 队列行在前一个完成后 5s 内转为 running 并出现进度；
- completed 行 5s 后自动消失；构造一个失败（如上传空文件）→ 行驻留 + "View error →" 打开 JobDetailDialog；
- 折叠把手工作正常；单任务时面板不挡聊天输入区。
- 验证后清理测试数据（见 Task 4 Step 5 的警告）。

- [ ] **Step 6: 提交**

```bash
git add src/components/shared/jobs-panel.tsx src/components/shared/global-job-tracker.tsx
git commit -m "feat(ui): 多任务聚合进度面板替换单条 ProgressToast 全局追踪"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `CLAUDE.md`（根，Changelog 加一行）
- Modify: `src/server/jobs/CLAUDE.md`（"单任务串行"描述更新为并发调度 + `decideClaim`）
- Modify: `src/components/CLAUDE.md`（shared/ 清单加 `jobs-panel.tsx`，global-job-tracker 描述更新）

**Interfaces:** 无（纯文档）。

- [ ] **Step 1: 更新三份 CLAUDE.md**

- 根 `CLAUDE.md` Changelog 表追加一行（日期 2026-07-06）：`Ingest 多任务支持 | workbench 文件模式多选批量提交（前端循环单文件 POST）；worker 并发调度（decideClaim 纯函数：仅 ingest 之间并发、上限 app_settings.ingestConcurrency 默认 2、非 ingest 独占；写入安全靠 vault-mutex）；GlobalJobTracker 改多 job 追踪 + 新 JobsPanel 聚合面板（每 running 行独立 SSE、pending 行不建连接、completed 5s 自动移除）。已知限制：并发 ingest 写同一页时后提交者基于略旧快照。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-06-ingest-multi-task*`
- `src/server/jobs/CLAUDE.md`："**串行**：`isProcessing` 布尔 flag…" 一节改为描述 `runningJobs` Map + `decideClaim` 三态决策与 `ingestConcurrency` 设置；模块职责第 2 条"单任务串行"同步改。
- `src/components/CLAUDE.md`：`shared/` 清单加 `jobs-panel.tsx —— 聚合任务面板（多行、独立 SSE、折叠把手）`；`global-job-tracker` 描述改为"轮询 running+pending 聚合追踪"。

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md src/server/jobs/CLAUDE.md src/components/CLAUDE.md
git commit -m "docs: 同步 ingest 多任务支持到根级与模块级 CLAUDE.md"
```

---

## Self-Review 记录

- **Spec 覆盖**：批量提交→Task 4；worker 并发+调度纯函数→Task 2/3；`ingestConcurrency` 设置贯通→Task 1；聚合面板（pending 可见、行级详情复用 JobDetailDialog、completed 驻留/failed 常驻、invalidation 保留）→Task 5；测试要求（claim 类型过滤已有实现故不新增 repo 测试、decideClaim 全分支、前端手动验证）→各 task 内嵌；已知限制→文档 Task 6。Spec 中"queue.claim 加 onlyTypes"被简化为复用既有 `claim(type?)`，已在 Global Constraints 声明偏差。
- **类型一致性**：`decideClaim(runningTypes, ingestLimit)` Task 2 定义 / Task 3 消费一致；`TrackedJob`/`JobsPanel` 仅 Task 5 内闭环；`getIngestConcurrency` Task 1 定义 / Task 3 消费一致。
- **占位符**：无 TBD；Task 5 Step 3 是显式的"以实际返回为准"验证步骤而非留白。

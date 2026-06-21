# Lint 体检中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给已有但无 UI 的 lint 引擎补一个只读「知识库体检中心」：触发 lint、按严重度/类型展示 findings、点击跳转到对应页。

**Architecture:** 复用现有 `POST /api/lint`（触发）与 `use-job-stream`（进度）；新增唯一只读接口 `GET /api/lint/latest`（收口最近一次 completed lint job 的 findings），由一个纯函数 `selectLatestFindings` 承载可测逻辑。前端新增 `(app)/health` 路由页 + 侧边栏入口（critical 计数徽标）。findings 的排序/分组/深链由纯函数 `lint-findings.ts` 承载并单测。

**Tech Stack:** Next.js 15 App Router (Route Handler `runtime='nodejs'`)、React 19 + TanStack Query、Zustand、Tailwind + 设计系统原语（Button/Tag/Panel）、vitest（node env，无 RTL）。

## Global Constraints

- 测试环境 **node-only，无 RTL/DOM**（`vitest.config.ts`）；只测纯函数与路由 handler（mock 依赖），React 组件不写单测。
- 客户端 HTTP **只用 `@/lib/api-fetch`**：GET 用 `useApiFetch()`（自动注入 `?subjectId`），POST/PUT 在 body 显式带 `subjectId`，禁止手写 `fetch('/api/...')`。
- 路由 handler 顶部必须 `export const runtime = 'nodejs'`；只读 GET 用 `requireAuth`（无需 CSRF）。
- **门禁** = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` / `next build` 的 lint 步在 BASE 即坏（预存历史问题），**不作门禁**。
- subject 解析统一走 `resolveSubjectFromRequest(request)`；所有共享领域类型放 `src/lib/contracts.ts`。
- 深链风格固定 `/wiki/<slug>?s=<subjectSlug>`。
- commit message 用中文、一句话总结；禁止任何 AI 署名 trailer / 脚注。
- 不改动 `POST /api/lint`、`lint-service.ts` 及其两阶段实现。

---

### Task 1: 共享类型 + `selectLatestFindings` 纯函数

**Files:**
- Modify: `src/lib/contracts.ts`（在 `LintFinding` 接口后追加两个类型）
- Create: `src/server/services/lint-latest.ts`
- Test: `src/server/services/__tests__/lint-latest.test.ts`

**Interfaces:**
- Produces: `EnrichedLintFinding`（= `LintFinding` + `subjectId` + `subjectSlug`）、`LintLatestResult`（`{ jobId, ranAt, bySeverity, findings }`）、`selectLatestFindings(jobs: Job[]): LintLatestResult`。
- Consumes: `Job`（`src/lib/contracts.ts`，含 `type/status/subjectId/resultJson/createdAt/completedAt`）。

- [ ] **Step 1: 在 contracts.ts 追加共享类型**

在 `src/lib/contracts.ts` 的 `LintFinding` 接口（结尾 `}`）之后插入：

```ts
export interface EnrichedLintFinding extends LintFinding {
  subjectId: SubjectId;
  subjectSlug: string;
}

export interface LintLatestResult {
  jobId: string | null;
  ranAt: string | null;
  bySeverity: { critical: number; warning: number; info: number };
  findings: EnrichedLintFinding[];
}
```

- [ ] **Step 2: 写失败测试**

创建 `src/server/services/__tests__/lint-latest.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { selectLatestFindings } from '../lint-latest';
import type { Job } from '@/lib/contracts';

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    type: 'lint',
    status: 'completed',
    subjectId: 's1',
    paramsJson: '{}',
    resultJson: JSON.stringify({ findings: [] }),
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: '2026-01-01T00:01:00.000Z',
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    ...over,
  };
}

const finding = (severity: 'critical' | 'warning' | 'info') => ({
  type: 'broken-link',
  severity,
  pageSlug: 'p',
  description: 'd',
  suggestedFix: null,
  subjectId: 's1',
  subjectSlug: 'general',
});

describe('selectLatestFindings', () => {
  it('空列表返回空结构', () => {
    expect(selectLatestFindings([])).toEqual({
      jobId: null,
      ranAt: null,
      bySeverity: { critical: 0, warning: 0, info: 0 },
      findings: [],
    });
  });

  it('多个 completed job 取 createdAt 最新的一条', () => {
    const older = job({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = job({
      id: 'new',
      createdAt: '2026-02-01T00:00:00.000Z',
      completedAt: '2026-02-01T00:05:00.000Z',
      resultJson: JSON.stringify({ findings: [finding('critical'), finding('info')] }),
    });
    const res = selectLatestFindings([older, newer]);
    expect(res.jobId).toBe('new');
    expect(res.ranAt).toBe('2026-02-01T00:05:00.000Z');
    expect(res.findings).toHaveLength(2);
    expect(res.bySeverity).toEqual({ critical: 1, warning: 0, info: 1 });
  });

  it('忽略乱序输入，仍按时间取最新', () => {
    const a = job({ id: 'a', createdAt: '2026-03-01T00:00:00.000Z' });
    const b = job({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(selectLatestFindings([a, b]).jobId).toBe('a');
  });

  it('忽略非 completed 的 job', () => {
    const running = job({ id: 'run', status: 'running', createdAt: '2026-09-01T00:00:00.000Z' });
    const done = job({ id: 'done', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(selectLatestFindings([running, done]).jobId).toBe('done');
  });

  it('resultJson 损坏时 findings 退化为空但保留 jobId', () => {
    const broken = job({ id: 'x', resultJson: 'not json' });
    const res = selectLatestFindings([broken]);
    expect(res.jobId).toBe('x');
    expect(res.findings).toEqual([]);
    expect(res.bySeverity).toEqual({ critical: 0, warning: 0, info: 0 });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/server/services/__tests__/lint-latest.test.ts`
Expected: FAIL —「Cannot find module '../lint-latest'」。

- [ ] **Step 4: 实现 `lint-latest.ts`**

创建 `src/server/services/lint-latest.ts`：

```ts
/**
 * 从一组 lint job 中选出最近一次 completed 的 findings 快照。
 * 纯函数：不触 DB / 请求，便于单测；scope（subject vs all）由调用方在传入前用 queue.list 过滤。
 */
import type { Job, EnrichedLintFinding, LintLatestResult } from '@/lib/contracts';

export function selectLatestFindings(jobs: Job[]): LintLatestResult {
  const completed = jobs.filter((j) => j.type === 'lint' && j.status === 'completed');
  if (completed.length === 0) {
    return { jobId: null, ranAt: null, bySeverity: { critical: 0, warning: 0, info: 0 }, findings: [] };
  }

  // createdAt 为 ISO-8601，字符串比较即时间序
  const latest = completed.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));

  let findings: EnrichedLintFinding[] = [];
  try {
    const parsed = latest.resultJson ? (JSON.parse(latest.resultJson) as { findings?: unknown }) : null;
    if (parsed && Array.isArray(parsed.findings)) {
      findings = parsed.findings as EnrichedLintFinding[];
    }
  } catch {
    findings = [];
  }

  const bySeverity = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };

  return { jobId: latest.id, ranAt: latest.completedAt, bySeverity, findings };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/server/services/__tests__/lint-latest.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 6: 提交**

```bash
git add src/lib/contracts.ts src/server/services/lint-latest.ts src/server/services/__tests__/lint-latest.test.ts
git commit -m "feat: lint findings 共享类型 + selectLatestFindings 纯函数（最近一次体检快照）"
```

---

### Task 2: `GET /api/lint/latest` 路由

**Files:**
- Create: `src/app/api/lint/latest/route.ts`
- Test: `src/app/api/lint/latest/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `selectLatestFindings`（Task 1）、`queue.list({ type, status, subjectId? })`、`requireAuth`、`resolveSubjectFromRequest`。
- Produces: `GET(request: NextRequest)` 返回 `NextResponse.json(LintLatestResult)`。

- [ ] **Step 1: 写失败测试**

创建 `src/app/api/lint/latest/__tests__/route.test.ts`（沿用 `retry/route.test.ts` 的 mock 模式）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockList = vi.fn();
const mockResolve = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/jobs/queue', () => ({ list: (...a: unknown[]) => mockList(...a) }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...a: unknown[]) => mockResolve(...a),
}));

import { GET } from '../route';

function call(qs = '') {
  return GET(new NextRequest(`http://localhost/api/lint/latest${qs}`));
}

function lintJob(over: Record<string, unknown> = {}) {
  return {
    id: 'j',
    type: 'lint',
    status: 'completed',
    subjectId: 's1',
    resultJson: JSON.stringify({ findings: [] }),
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockResolve.mockReset();
});

describe('GET /api/lint/latest', () => {
  it('subject-scoped：解析 subject 后按 subjectId 查询并返回最近 findings', async () => {
    mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
    mockList.mockReturnValue([
      lintJob({
        id: 'latest',
        createdAt: '2026-05-01T00:00:00.000Z',
        resultJson: JSON.stringify({
          findings: [
            { type: 'orphan', severity: 'warning', pageSlug: 'p', description: 'd', suggestedFix: null, subjectId: 's1', subjectSlug: 'general' },
          ],
        }),
      }),
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockList).toHaveBeenCalledWith({ type: 'lint', status: 'completed', subjectId: 's1' });
    expect(body.jobId).toBe('latest');
    expect(body.bySeverity).toEqual({ critical: 0, warning: 1, info: 0 });
  });

  it('allSubjects=1：不解析 subject，只查全量 lint job 并过滤 subjectId 为 null 的', async () => {
    mockList.mockReturnValue([
      lintJob({ id: 'scoped', subjectId: 's1' }),
      lintJob({ id: 'global', subjectId: null, createdAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    const res = await call('?allSubjects=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledWith({ type: 'lint', status: 'completed' });
    expect(body.jobId).toBe('global');
  });

  it('subject 解析失败时直接回传 error 响应', async () => {
    const { NextResponse } = await import('next/server');
    mockResolve.mockReturnValue({ subject: null, error: NextResponse.json({ error: 'x' }, { status: 404 }) });
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/app/api/lint/latest/__tests__/route.test.ts`
Expected: FAIL —「Cannot find module '../route'」。

- [ ] **Step 3: 实现路由**

创建 `src/app/api/lint/latest/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { selectLatestFindings } from '@/server/services/lint-latest';

export const runtime = 'nodejs';

/**
 * GET /api/lint/latest
 *
 * 返回当前 subject（默认）或全量（`?allSubjects=1`）最近一次 completed lint job 的 findings 快照。
 * 从未跑过返回 { jobId: null, findings: [] }。只读，仅 requireAuth。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const allSubjects = request.nextUrl.searchParams.get('allSubjects') === '1';

  if (allSubjects) {
    const jobs = queue
      .list({ type: 'lint', status: 'completed' })
      .filter((j) => j.subjectId === null);
    return NextResponse.json(selectLatestFindings(jobs));
  }

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;

  const jobs = queue.list({ type: 'lint', status: 'completed', subjectId: resolution.subject.id });
  return NextResponse.json(selectLatestFindings(jobs));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/app/api/lint/latest/__tests__/route.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/app/api/lint/latest/route.ts src/app/api/lint/latest/__tests__/route.test.ts
git commit -m "feat: GET /api/lint/latest 收口最近一次体检 findings（subject/全量）"
```

---

### Task 3: 前端纯函数 `lint-findings`（排序 / 分组 / 深链）

**Files:**
- Create: `src/components/health/lint-findings.ts`
- Test: `src/components/health/__tests__/lint-findings.test.ts`

**Interfaces:**
- Produces：
  - `sortFindings(findings: EnrichedLintFinding[]): EnrichedLintFinding[]`
  - `groupBySeverity(findings: EnrichedLintFinding[]): { severity: 'critical'|'warning'|'info'; findings: EnrichedLintFinding[] }[]`（固定三组顺序）
  - `findingHref(f: EnrichedLintFinding): string | null`（coverage-gap 返回 null）
- Consumes: `EnrichedLintFinding`、`LintFinding`（contracts）。

- [ ] **Step 1: 写失败测试**

创建 `src/components/health/__tests__/lint-findings.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { sortFindings, groupBySeverity, findingHref } from '../lint-findings';
import type { EnrichedLintFinding, LintFinding } from '@/lib/contracts';

function f(over: Partial<EnrichedLintFinding> = {}): EnrichedLintFinding {
  return {
    type: 'broken-link',
    severity: 'warning',
    pageSlug: 'page',
    description: 'd',
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
    ...over,
  };
}

describe('sortFindings', () => {
  it('按 severity critical→warning→info，再按 type，再按 pageSlug', () => {
    const input = [
      f({ severity: 'info', type: 'orphan', pageSlug: 'b' }),
      f({ severity: 'critical', type: 'contradiction', pageSlug: 'z' }),
      f({ severity: 'warning', type: 'orphan', pageSlug: 'a' }),
      f({ severity: 'warning', type: 'orphan', pageSlug: 'b' }),
    ];
    const out = sortFindings(input);
    expect(out.map((x) => [x.severity, x.type, x.pageSlug])).toEqual([
      ['critical', 'contradiction', 'z'],
      ['warning', 'orphan', 'a'],
      ['warning', 'orphan', 'b'],
      ['info', 'orphan', 'b'],
    ]);
  });

  it('不修改原数组', () => {
    const input = [f({ severity: 'info' }), f({ severity: 'critical' })];
    const copy = [...input];
    sortFindings(input);
    expect(input).toEqual(copy);
  });
});

describe('groupBySeverity', () => {
  it('始终返回 critical/warning/info 三组固定顺序', () => {
    const groups = groupBySeverity([f({ severity: 'info' })]);
    expect(groups.map((g) => g.severity)).toEqual(['critical', 'warning', 'info']);
    expect(groups[0].findings).toEqual([]);
    expect(groups[2].findings).toHaveLength(1);
  });

  it('空输入返回三个空组', () => {
    const groups = groupBySeverity([]);
    expect(groups.every((g) => g.findings.length === 0)).toBe(true);
  });
});

describe('findingHref', () => {
  it('普通 finding 返回带 ?s= 的 wiki 深链', () => {
    expect(findingHref(f({ pageSlug: 'foo/bar', subjectSlug: 'general' }))).toBe(
      '/wiki/foo/bar?s=general',
    );
  });

  it('coverage-gap 返回 null（建议的新页不可点击）', () => {
    const cg: LintFinding['type'] = 'coverage-gap';
    expect(findingHref(f({ type: cg }))).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/health/__tests__/lint-findings.test.ts`
Expected: FAIL —「Cannot find module '../lint-findings'」。

- [ ] **Step 3: 实现纯函数**

创建 `src/components/health/lint-findings.ts`：

```ts
import type { EnrichedLintFinding, LintFinding } from '@/lib/contracts';

const SEVERITY_ORDER: Record<LintFinding['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const SEVERITIES: LintFinding['severity'][] = ['critical', 'warning', 'info'];

export function sortFindings(findings: EnrichedLintFinding[]): EnrichedLintFinding[] {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    const t = a.type.localeCompare(b.type);
    if (t !== 0) return t;
    return a.pageSlug.localeCompare(b.pageSlug);
  });
}

export function groupBySeverity(
  findings: EnrichedLintFinding[],
): { severity: LintFinding['severity']; findings: EnrichedLintFinding[] }[] {
  const sorted = sortFindings(findings);
  return SEVERITIES.map((severity) => ({
    severity,
    findings: sorted.filter((f) => f.severity === severity),
  }));
}

export function findingHref(f: EnrichedLintFinding): string | null {
  // coverage-gap 指向尚不存在的建议新页，不可点击
  if (f.type === 'coverage-gap') return null;
  return `/wiki/${f.pageSlug}?s=${encodeURIComponent(f.subjectSlug)}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/health/__tests__/lint-findings.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/components/health/lint-findings.ts src/components/health/__tests__/lint-findings.test.ts
git commit -m "feat: lint findings 排序/分组/深链纯函数"
```

---

### Task 4: 体检页 UI（hook + finding-row + health-view + 路由页）

**Files:**
- Create: `src/hooks/use-lint-summary.ts`
- Create: `src/components/health/finding-row.tsx`
- Create: `src/components/health/health-view.tsx`
- Create: `src/app/(app)/health/page.tsx`

**Interfaces:**
- Consumes: `useApiFetch`、`useCurrentSubject`、`useJobStream`、`groupBySeverity`/`findingHref`（Task 3）、`LintLatestResult`/`EnrichedLintFinding`/`LintFinding`（contracts）、`Button`/`Tag`。
- Produces: `useLintSummary(allSubjects?: boolean)`（React Query，返回 `LintLatestResult`）、`<FindingRow finding showSubject? />`、`<HealthView />`、`/health` 路由页。

> 本任务无单测（项目无 DOM 测试环境）；交付物 = 可在 dev 跑通的 `/health` 页，验收见 Step 6。

- [ ] **Step 1: 实现 `use-lint-summary` hook**

创建 `src/hooks/use-lint-summary.ts`：

```ts
'use client';

import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import type { LintLatestResult } from '@/lib/contracts';

const EMPTY: LintLatestResult = {
  jobId: null,
  ranAt: null,
  bySeverity: { critical: 0, warning: 0, info: 0 },
  findings: [],
};

/**
 * 读取最近一次体检结果。allSubjects=true 时读全量快照（侧边栏徽标恒用 subject-scoped）。
 */
export function useLintSummary(allSubjects = false) {
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();

  return useQuery({
    queryKey: ['lint-latest', allSubjects ? 'all' : subjectId],
    queryFn: async (): Promise<LintLatestResult> => {
      const res = await apiFetch(`/api/lint/latest${allSubjects ? '?allSubjects=1' : ''}`);
      if (!res.ok) return EMPTY;
      return (await res.json()) as LintLatestResult;
    },
    staleTime: 30_000,
    enabled: allSubjects || !!subjectId,
  });
}
```

- [ ] **Step 2: 实现 `finding-row.tsx`**

创建 `src/components/health/finding-row.tsx`：

```tsx
'use client';

import Link from 'next/link';
import {
  AlertTriangle,
  CircleDashed,
  Clock,
  FileWarning,
  Link2,
  Unlink,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import type { EnrichedLintFinding, LintFinding } from '@/lib/contracts';
import { Tag } from '@/components/ui/tag';
import { findingHref } from './lint-findings';

const TYPE_ICON: Record<LintFinding['type'], LucideIcon> = {
  'broken-link': Unlink,
  orphan: Unplug,
  'missing-frontmatter': FileWarning,
  'stale-source': Clock,
  contradiction: AlertTriangle,
  'missing-crossref': Link2,
  'coverage-gap': CircleDashed,
};

const TYPE_LABEL: Record<LintFinding['type'], string> = {
  'broken-link': 'Broken link',
  orphan: 'Orphan',
  'missing-frontmatter': 'Missing frontmatter',
  'stale-source': 'Stale source',
  contradiction: 'Contradiction',
  'missing-crossref': 'Missing cross-ref',
  'coverage-gap': 'Coverage gap',
};

const SEVERITY_TONE: Record<LintFinding['severity'], 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'neutral',
};

export function FindingRow({
  finding,
  showSubject = false,
}: {
  finding: EnrichedLintFinding;
  showSubject?: boolean;
}) {
  const Icon = TYPE_ICON[finding.type];
  const href = findingHref(finding);

  return (
    <div className="flex gap-3 px-3 py-2.5 rounded-md hover:bg-subtle transition-colors">
      <Icon className="h-4 w-4 shrink-0 mt-0.5 text-foreground-tertiary" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Tag tone={SEVERITY_TONE[finding.severity]} size="sm">
            {finding.severity}
          </Tag>
          <span className="text-xs text-foreground-tertiary">{TYPE_LABEL[finding.type]}</span>
          {showSubject && (
            <span className="text-xs text-foreground-tertiary">· {finding.subjectSlug}</span>
          )}
          {href ? (
            <Link href={href} className="text-sm font-medium text-accent hover:underline truncate">
              {finding.pageSlug}
            </Link>
          ) : (
            <span className="text-sm font-medium text-foreground truncate inline-flex items-center">
              {finding.pageSlug}
              <Tag tone="neutral" size="sm" className="ml-1.5">
                suggested page
              </Tag>
            </span>
          )}
        </div>
        <p className="text-sm text-foreground-secondary">{finding.description}</p>
        {finding.suggestedFix && (
          <p className="text-xs text-foreground-tertiary">
            <span className="font-medium">Fix:</span> {finding.suggestedFix}
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 实现 `health-view.tsx`**

创建 `src/components/health/health-view.tsx`：

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, RefreshCw } from 'lucide-react';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { useLintSummary } from '@/hooks/use-lint-summary';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/ui/tag';
import { groupBySeverity } from './lint-findings';
import { FindingRow } from './finding-row';
import type { LintFinding } from '@/lib/contracts';

type Scope = 'subject' | 'all';

const SEVERITY_TONE: Record<LintFinding['severity'], 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'neutral',
};

export function HealthView() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const [scope, setScope] = useState<Scope>('subject');
  const allSubjects = scope === 'all';

  const { data, isLoading } = useLintSummary(allSubjects);

  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [semanticErrored, setSemanticErrored] = useState(false);
  const { status: streamStatus, events, latestMessage } = useJobStream(jobId);

  // 体检完成 → 记录语义阶段是否报错 → 失效缓存重取
  useEffect(() => {
    if (streamStatus === 'completed') {
      setSemanticErrored(events.some((e) => e.type === 'lint:semantic:error'));
      queryClient.invalidateQueries({ queryKey: ['lint-latest', allSubjects ? 'all' : subjectId] });
      setJobId(null);
    } else if (streamStatus === 'failed') {
      setJobId(null);
    }
  }, [streamStatus, events, queryClient, allSubjects, subjectId]);

  const running = starting || (jobId !== null && streamStatus !== 'completed' && streamStatus !== 'failed');

  async function runLint() {
    setStarting(true);
    setSemanticErrored(false);
    try {
      const res = await apiFetch('/api/lint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allSubjects ? { allSubjects: true } : { subjectId }),
      });
      if (res.ok) {
        const json = (await res.json()) as { jobId: string };
        setJobId(json.jobId);
      }
    } finally {
      setStarting(false);
    }
  }

  function switchScope(next: Scope) {
    setScope(next);
    setSemanticErrored(false);
  }

  const [typeFilter, setTypeFilter] = useState<LintFinding['type'] | null>(null);
  useEffect(() => setTypeFilter(null), [scope]);

  const allFindings = data?.findings ?? [];
  const visibleFindings = useMemo(
    () => (typeFilter ? allFindings.filter((f) => f.type === typeFilter) : allFindings),
    [allFindings, typeFilter],
  );
  const groups = useMemo(() => groupBySeverity(visibleFindings), [visibleFindings]);
  const presentTypes = useMemo(
    () => [...new Set(allFindings.map((f) => f.type))].sort(),
    [allFindings],
  );

  const total = allFindings.length;
  const neverRun = data?.jobId == null;

  return (
    <div className="max-w-content mx-auto px-6 py-8 w-full space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <Activity className="h-5 w-5 text-foreground-tertiary" />
            Health
          </h1>
          <p className="mt-1 text-sm text-foreground-secondary">
            {allSubjects
              ? 'Quality findings across all subjects.'
              : `Quality findings for "${subjectSlug}".`}
            {data?.ranAt && (
              <span className="text-foreground-tertiary"> · Last checked {new Date(data.ranAt).toLocaleString()}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => switchScope('subject')}
              className={
                'h-8 px-3 text-sm transition-colors ' +
                (!allSubjects ? 'bg-subtle text-foreground font-medium' : 'text-foreground-secondary hover:bg-subtle')
              }
            >
              This subject
            </button>
            <button
              type="button"
              onClick={() => switchScope('all')}
              className={
                'h-8 px-3 text-sm transition-colors border-l border-border ' +
                (allSubjects ? 'bg-subtle text-foreground font-medium' : 'text-foreground-secondary hover:bg-subtle')
              }
            >
              All subjects
            </button>
          </div>
          <Button intent="primary" onClick={runLint} loading={running}>
            <RefreshCw className="h-3.5 w-3.5" />
            {neverRun ? 'Run health check' : 'Re-run'}
          </Button>
        </div>
      </header>

      {running && (
        <p className="text-sm text-foreground-secondary">{latestMessage || 'Running health check…'}</p>
      )}

      {semanticErrored && (
        <div className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
          语义检查未完成，仅展示确定性结果。
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-md bg-subtle animate-pulse" />
          ))}
        </div>
      ) : neverRun ? (
        <div className="rounded-md border border-border bg-canvas px-6 py-10 text-center">
          <p className="text-sm text-foreground-secondary">
            Never run a health check{allSubjects ? '' : ` for "${subjectSlug}"`} yet.
          </p>
          <Button intent="primary" className="mt-3" onClick={runLint} loading={running}>
            Run now
          </Button>
        </div>
      ) : total === 0 ? (
        <p className="text-sm text-foreground-tertiary italic">No findings — looks healthy. ✨</p>
      ) : (
        <div className="space-y-4">
          {/* 概要计数条 */}
          <div className="flex items-center gap-3">
            {(['critical', 'warning', 'info'] as const).map((sev) => (
              <span key={sev} className="inline-flex items-center gap-1.5 text-sm text-foreground-secondary">
                <Tag tone={SEVERITY_TONE[sev]} size="sm">
                  {data!.bySeverity[sev]}
                </Tag>
                {sev}
              </span>
            ))}
          </div>

          {/* type 过滤 chips */}
          {presentTypes.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setTypeFilter(null)}
                className={
                  'h-6 px-2 rounded-sm text-xs transition-colors ' +
                  (typeFilter === null ? 'bg-accent-subtle text-accent-strong' : 'bg-subtle text-foreground-secondary hover:text-foreground')
                }
              >
                All
              </button>
              {presentTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTypeFilter((cur) => (cur === t ? null : t))}
                  className={
                    'h-6 px-2 rounded-sm text-xs transition-colors ' +
                    (typeFilter === t ? 'bg-accent-subtle text-accent-strong' : 'bg-subtle text-foreground-secondary hover:text-foreground')
                  }
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          {/* 分组列表 */}
          {groups.map((group) =>
            group.findings.length === 0 ? null : (
              <section key={group.severity}>
                <h2 className="text-xs font-medium uppercase tracking-wider text-foreground-tertiary px-3 mb-1">
                  {group.severity} ({group.findings.length})
                </h2>
                <div className="space-y-0.5">
                  {group.findings.map((f, i) => (
                    <FindingRow key={`${f.subjectId}:${f.type}:${f.pageSlug}:${i}`} finding={f} showSubject={allSubjects} />
                  ))}
                </div>
              </section>
            ),
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 实现路由页**

创建 `src/app/(app)/health/page.tsx`：

```tsx
import { HealthView } from '@/components/health/health-view';

export default function HealthPage() {
  return <HealthView />;
}
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误（注意：仓库根目录已存在的 `_materialize*.ts`/`_cleanup.ts` 临时脚本报错与本任务无关，忽略它们；只确认本任务新增文件无类型错误）。

- [ ] **Step 6: dev 验收**

```bash
npm run dev:all
```
浏览器访问 `http://localhost:3000/health`：
- 从未跑过 → 显示 never-run 空态 + 「Run now」。
- 点「Run health check」→ 顶部出现进度文案 → 完成后列表按 critical/warning/info 分组显示。
- 点某条 finding 的页面链接 → 跳到 `/wiki/<slug>?s=<subjectSlug>`。
- coverage-gap 条目不可点击，带「suggested page」标签。
- 切到「All subjects」→ 触发全量体检 → 条目显示 subject 标签。
Expected: 上述行为全部正常。

- [ ] **Step 7: 提交**

```bash
git add src/hooks/use-lint-summary.ts src/components/health/finding-row.tsx src/components/health/health-view.tsx "src/app/(app)/health/page.tsx"
git commit -m "feat: 体检中心页面（/health 触发+分组展示 findings+跳转）"
```

---

### Task 5: 侧边栏 Health 入口 + critical 徽标

**Files:**
- Modify: `src/components/layout/sidebar.tsx`

**Interfaces:**
- Consumes: `useLintSummary`（Task 4）、`Tag`、`Activity` 图标。

- [ ] **Step 1: 扩充 import**

将 `src/components/layout/sidebar.tsx` 顶部的 lucide 图标 import 改为加入 `Activity`：

```tsx
import {
  Activity,
  ChevronDown,
  FileText,
  Pin,
  Plus,
  Search,
  Settings2,
} from 'lucide-react';
```

并在现有 import 区追加：

```tsx
import { Tag } from '@/components/ui/tag';
import { useLintSummary } from '@/hooks/use-lint-summary';
```

- [ ] **Step 2: 读取 critical 计数 + health active 态**

在 `Sidebar` 组件体内（`const { id: subjectId } = useCurrentSubject();` 之后）追加：

```tsx
  const { data: lintSummary } = useLintSummary(false);
  const criticalCount = lintSummary?.bySeverity.critical ?? 0;
  const isHealthActive = pathname === '/health';
```

- [ ] **Step 3: 改写 footer 加入 Health 入口**

将 footer 整块（`{/* Footer */}` 那个 `<div className="shrink-0 border-t border-border px-2 py-2 flex items-center justify-between">...</div>`）替换为：

```tsx
      {/* Footer */}
      <div className="shrink-0 border-t border-border px-2 py-2 space-y-1">
        <Link
          href="/health"
          onClick={onNavigate}
          className={cn(
            'flex items-center justify-between gap-2 h-8 px-2 rounded-md text-sm transition-colors focus-ring',
            isHealthActive
              ? 'bg-subtle text-foreground font-medium'
              : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
          )}
        >
          <span className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-foreground-tertiary" />
            Health
          </span>
          {criticalCount > 0 && (
            <Tag tone="danger" size="sm">
              {criticalCount}
            </Tag>
          )}
        </Link>
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-foreground-tertiary">
            {totalAll} {totalAll === 1 ? 'page' : 'pages'}
          </span>
          <IconButton
            size="sm"
            aria-label="Open settings"
            title="Settings"
            onClick={openSettingsDialog}
          >
            <Settings2 />
          </IconButton>
        </div>
      </div>
```

- [ ] **Step 4: 类型检查 + dev 验收**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

dev 验收（`npm run dev:all` 若未运行则启动）：
- 侧边栏 footer 出现「Health」入口，点击进入 `/health`。
- 当前 subject 存在 critical findings 时，入口右侧显示红色计数徽标；为 0 时不显示。

- [ ] **Step 5: 提交**

```bash
git add src/components/layout/sidebar.tsx
git commit -m "feat: 侧边栏 Health 入口 + critical 计数徽标"
```

---

### Task 6: 文档与整体验收

**Files:**
- Modify: `src/app/CLAUDE.md`（API 路由表 + 页面表 + 文件清单）
- Modify: `CLAUDE.md`（根级 Changelog 追加一行）

- [ ] **Step 1: 更新 `src/app/CLAUDE.md`**

在 API 路由表 `/api/lint` 行下方追加：

```markdown
| `/api/lint/latest` | GET | 返回当前 subject（或 `?allSubjects=1` 全量）最近一次 completed lint job 的 findings 快照（含 bySeverity 计数）；从未跑过返回 `{ jobId:null, findings:[] }` |
```

在页面路由表（`(app)/subjects/page.tsx` 行下方）追加：

```markdown
| `(app)/health/page.tsx` | 🆕 知识库体检中心：触发 lint（当前 subject / 全量）+ 按严重度分组展示 findings + 跳转到对应页（只读，自动修复见后续特性）|
```

在「相关文件清单」的 `api/` 树中 `lint/route.ts` 下追加一行 `│   ├── lint/latest/route.ts`。

- [ ] **Step 2: 更新根 `CLAUDE.md` Changelog**

在第九节变更记录表末尾追加：

```markdown
| 2026-06-21 | Lint 体检中心 | 新增 `(app)/health` 只读体检页（触发 lint + 按严重度/类型分组展示 findings + 深链跳转）+ `GET /api/lint/latest`（`selectLatestFindings` 收口最近快照）+ 侧边栏 Health 入口/critical 徽标；纯函数 `lint-findings`/`selectLatestFindings` 单测；spec/plan 见 docs/superpowers/{specs,plans}/2026-06-21-lint-health-center* |
```

- [ ] **Step 3: 全量门禁（tsc + vitest）**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 无新增错误（忽略仓库根目录预存的 `_materialize*.ts`/`_cleanup.ts`）；全部 vitest 用例 PASS（含新增的 lint-latest / route / lint-findings 三组）。
（注：`npm run lint` 在 BASE 即坏，按项目约定不作门禁。）

- [ ] **Step 4: 提交**

```bash
git add src/app/CLAUDE.md CLAUDE.md
git commit -m "docs: 记录 Lint 体检中心（/health + /api/lint/latest）"
```

---

## Self-Review

**1. Spec coverage（逐节核对 spec → task）：**
- spec §四 `GET /api/lint/latest` → Task 1（pure 选择器）+ Task 2（路由）。✔
- spec §五 新增文件全覆盖：route.ts(T2)、health/page.tsx(T4)、health-view.tsx(T4)、finding-row.tsx(T4)、lint-findings.ts(T3)、use-lint-summary.ts(T4)、sidebar 改动(T5)。✔
- spec §六 纯函数契约 sortFindings/groupBySeverity/findingHref → Task 3。✔
- spec §七 UI 四态（never-run/idle/running/completed→refetch）→ Task 4 health-view。✔
- spec §八 边界：coverage-gap 不可点击 → T3 findingHref + T4 finding-row；语义阶段失败黄条 → T4（从 job stream events 探测 `lint:semantic:error`，per-run best-effort）；作用域切换 → T4 switchScope。✔
- spec §九 测试：lint-findings(T3)、selectLatestFindings(T1)、route(T2，超出 spec 的额外保障）。✔
- spec §十 不变量：不改 POST /api/lint 与 lint-service（全 plan 未触碰）；复用 resolveSubjectFromRequest/useApiFetch/use-job-stream/ui 原语；深链 `?s=` 风格（T3）。✔

**2. Placeholder scan：** 无 TBD/TODO；每个 code step 均含完整代码与确切命令。✔

**3. Type consistency：**
- `selectLatestFindings(jobs: Job[]): LintLatestResult` 在 T1 定义、T2 消费一致。
- `EnrichedLintFinding`/`LintLatestResult` 在 contracts 定义（T1），T1/T2/T3/T4 全部从 `@/lib/contracts` 引用，无重复定义。
- `findingHref`/`groupBySeverity`/`sortFindings` 在 T3 定义，T4 finding-row/health-view 消费签名一致。
- `useLintSummary(allSubjects?: boolean)` 在 T4 定义，T4 health-view 与 T5 sidebar 消费一致。
- queue.list 过滤参数 `{ type:'lint', status:'completed', subjectId? }` 与 jobs-repo `JobFilter` 字段一致。✔

> 说明（spec 偏差，非缺口）：spec §八「语义阶段失败黄条」原设想由 latest 接口承载，但 lint 的 `result_json` 仅含 findings、不含错误态；改为前端在该次 run 的 job stream events 中探测 `lint:semantic:error` 来显示（per-run best-effort，跨会话缓存结果不复现该提示）。已在 Task 4 落实。

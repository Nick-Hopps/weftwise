# 任务日志可读性改进（fix/curate 工具循环 + lint）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fix/curate 工具循环期间每次工具调用（含只读）都产生一条人类可读日志事件；lint semantic 阶段开始/结束事件补充页数、模型标签与 findings 分类统计。

**Architecture:** 在 `generateTextWithTools` 上经 AI SDK `onStepFinish` 透传可选 `onToolCall` 回调（单点改动，对齐 agent-loop 既有模式）；fix/curate service 传回调 emit `fix:tool`/`curate:tool`，文案复用 `lib/tool-activity.ts` 新增的 `toolActivityLine` 纯函数；lint 只改事件 message/data，不改调用结构。

**Tech Stack:** TypeScript / Vercel AI SDK v5（`generateText` 的 `onStepFinish`，步内工具调用字段为 `toolName`/`input`）/ vitest。

**Spec:** `docs/superpowers/specs/2026-07-09-job-log-clarity-design.md`

## Global Constraints

- `onToolCall` 回调内部异常必须吞掉（try/catch），绝不影响 LLM 循环。
- `resolveTask('lint')` 解析失败不得抛给 lint 主流程，回落省略模型名。
- 不改 DB schema、API、prompt、工具行为本身。
- 生成代码用中文注释；commit message 用中文一句话。
- 测试命令：`npx vitest run <file>`（`npm run lint` 在本机不可用，用 `npx tsc --noEmit` 校验类型）。

---

### Task 1: `toolActivityLine` 纯函数

**Files:**
- Modify: `src/lib/tool-activity.ts`（文件末尾追加）
- Test: `src/lib/__tests__/tool-activity.test.ts`（追加用例）

**Interfaces:**
- Consumes: 同文件既有 `toolActivityIcon` / `toolActivityVerb` / `summarizeToolArgs`。
- Produces: `export function toolActivityLine(tool: string, args: unknown): string` — 供 Task 3/4 的 service emit 使用。

- [ ] **Step 1: 写失败测试**

在 `src/lib/__tests__/tool-activity.test.ts` 末尾（`describe('tool-activity', ...)` 内部末尾）追加：

```ts
  describe('toolActivityLine', () => {
    it('拼装 icon + verb + 参数摘要', () => {
      expect(toolActivityLine('wiki_read', { slug: 'some-page' })).toBe('📄 Reading "some-page"…');
      expect(toolActivityLine('wiki_search', { query: 'panda diet' })).toBe('🔍 Searching "panda diet"…');
      expect(toolActivityLine('wiki_merge', { sourceSlug: 'a', targetSlug: 'b' })).toBe('🔗 Merging "a → b"…');
    });

    it('无参数摘要时省略引号段', () => {
      expect(toolActivityLine('wiki_list', {})).toBe('🗂 Listing pages…');
    });

    it('未知工具回落工具名', () => {
      expect(toolActivityLine('mystery_tool', { x: 1 })).toBe('• mystery_tool…');
    });
  });
```

同时把文件顶部 import 改为：

```ts
import { toolActivityIcon, toolActivityVerb, summarizeToolArgs, toolActivityLine } from '../tool-activity';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/__tests__/tool-activity.test.ts`
Expected: FAIL —— `toolActivityLine` 未导出。

- [ ] **Step 3: 实现**

在 `src/lib/tool-activity.ts` 末尾追加：

```ts
/** 组装单行日志文案（供 job 事件日志用），如 `📄 Reading "some-page"…`。 */
export function toolActivityLine(tool: string, args: unknown): string {
  const summary = summarizeToolArgs(tool, args);
  const head = `${toolActivityIcon(tool)} ${toolActivityVerb(tool)}`;
  return summary ? `${head} "${summary}"…` : `${head}…`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/__tests__/tool-activity.test.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/tool-activity.ts src/lib/__tests__/tool-activity.test.ts
git commit -m "feat(lib): tool-activity 新增 toolActivityLine 单行日志文案纯函数"
```

---

### Task 2: `generateTextWithTools` 支持 `onToolCall`

**Files:**
- Modify: `src/server/llm/provider-registry.ts:233-284`（`generateTextWithTools`）
- Test: `src/server/llm/__tests__/provider-registry-toolcall.test.ts`（新建）

**Interfaces:**
- Consumes: AI SDK `generateText` 的 `onStepFinish?: (step) => void`，step 内 `step.toolCalls: Array<{ toolName: string; input: unknown }>`。
- Produces: `generateTextWithTools` opts 新增可选字段 `onToolCall?: (info: { tool: string; args: unknown }) => void` —— Task 3/4 依赖此签名。

- [ ] **Step 1: 写失败测试**

新建 `src/server/llm/__tests__/provider-registry-toolcall.test.ts`（mock 风格参照同目录 `provider-registry-cancel.test.ts`）：

```ts
/**
 * generateTextWithTools 的 onToolCall 透传：fix/curate tool-loop 借此
 * 把每步工具调用转成 job 事件日志。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  stepCountIs: vi.fn(() => 'step-count-is'),
}));

vi.mock('../task-router', () => ({
  resolveTask: vi.fn(() => ({ task: 'fix', logLabel: 'test-model', timeoutMs: 60_000, maxRetries: 0 })),
}));

vi.mock('../provider-factory', () => ({
  getLanguageModel: vi.fn(() => 'fake-model'),
}));

import { generateTextWithTools } from '../provider-registry';

const BASE_OPTS = { system: 's', messages: [], tools: {}, maxSteps: 3 } as never;

describe('generateTextWithTools — onToolCall 透传', () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
  });

  it('onStepFinish 触发时按 toolCalls 逐个回调 onToolCall', async () => {
    mocks.generateText.mockImplementation(async (opts: { onStepFinish?: (step: unknown) => void }) => {
      opts.onStepFinish?.({
        toolCalls: [
          { toolName: 'wiki_read', input: { slug: 'a' } },
          { toolName: 'wiki_search', input: { query: 'q' } },
        ],
      });
      return { text: 'done' };
    });
    const seen: { tool: string; args: unknown }[] = [];
    await generateTextWithTools('fix', { ...BASE_OPTS, onToolCall: (info) => seen.push(info) });
    expect(seen).toEqual([
      { tool: 'wiki_read', args: { slug: 'a' } },
      { tool: 'wiki_search', args: { query: 'q' } },
    ]);
  });

  it('onToolCall 抛错被吞掉，不影响主流程', async () => {
    mocks.generateText.mockImplementation(async (opts: { onStepFinish?: (step: unknown) => void }) => {
      opts.onStepFinish?.({ toolCalls: [{ toolName: 'wiki_read', input: {} }] });
      return { text: 'done' };
    });
    const result = await generateTextWithTools('fix', {
      ...BASE_OPTS,
      onToolCall: () => { throw new Error('boom'); },
    });
    expect(result.text).toBe('done');
  });

  it('不传 onToolCall 时不挂 onStepFinish（零开销）', async () => {
    mocks.generateText.mockResolvedValue({ text: 'done' });
    await generateTextWithTools('fix', BASE_OPTS);
    expect(mocks.generateText.mock.calls[0][0].onStepFinish).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/llm/__tests__/provider-registry-toolcall.test.ts`
Expected: 第 1、3 用例 FAIL（`onToolCall` 未透传 / `onStepFinish` 恒挂或恒缺）。

- [ ] **Step 3: 实现**

`src/server/llm/provider-registry.ts` 中 `generateTextWithTools` 的 opts 类型加一行（`shouldCancel` 之后）：

```ts
    /** 每步结束时对该步每个 tool call 回调一次；回调抛错被吞掉，不影响主流程。 */
    onToolCall?: (info: { tool: string; args: unknown }) => void;
```

`generateText({...})` 调用参数（`abortSignal: controller.signal,` 之前）加：

```ts
      onStepFinish: opts.onToolCall
        ? (step) => {
            for (const tc of step.toolCalls) {
              try {
                opts.onToolCall!({ tool: tc.toolName, args: tc.input });
              } catch {
                // 观测回调不得影响 LLM 循环
              }
            }
          }
        : undefined,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/llm/__tests__/provider-registry-toolcall.test.ts src/server/llm/__tests__/provider-registry-cancel.test.ts && npx tsc --noEmit`
Expected: 全 PASS，tsc 零错误。

- [ ] **Step 5: 提交**

```bash
git add src/server/llm/provider-registry.ts src/server/llm/__tests__/provider-registry-toolcall.test.ts
git commit -m "feat(llm): generateTextWithTools 加 onToolCall 逐步回调（经 onStepFinish 透传）"
```

---

### Task 3: fix-service 接入工具事件 + 前端注册

**Files:**
- Modify: `src/server/services/fix-service.ts:92-114`
- Modify: `src/hooks/use-job-stream.ts:218-224`（`fix:*` 白名单）

**Interfaces:**
- Consumes: Task 1 `toolActivityLine`；Task 2 `onToolCall`。
- Produces: 新事件类型 `fix:agent:start`、`fix:tool`（message 即展示文案，data 带 `{ tool }`）。

- [ ] **Step 1: fix-service 改动**

`src/server/services/fix-service.ts` 顶部 import 区加：

```ts
import { toolActivityLine } from '@/lib/tool-activity';
```

在 `if (loop.length > 0) {` 块内、`await generateTextWithTools(...)` 之前（`promptCtx` 定义之后）加：

```ts
    emit('fix:agent:start', `Analyzing ${loop.length} finding(s) across ${new Set(loop.map((f) => f.pageSlug)).size} page(s) with the model…`, {
      findings: loop.length,
    });
```

`generateTextWithTools('fix', {...})` 调用加一个参数（`shouldCancel` 之后）：

```ts
      onToolCall: (info) => emit('fix:tool', toolActivityLine(info.tool, info.args), { tool: info.tool }),
```

- [ ] **Step 2: 前端白名单注册**

`src/hooks/use-job-stream.ts` 的 fix 事件列表（`'fix:start',` 之后）加两行：

```ts
        'fix:agent:start',
        'fix:tool',
```

- [ ] **Step 3: 校验**

Run: `npx tsc --noEmit && npx vitest run src/server/services/__tests__`
Expected: tsc 零错误，services 既有测试全 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/server/services/fix-service.ts src/hooks/use-job-stream.ts
git commit -m "feat(fix): tool-loop 每次工具调用 emit fix:tool 日志事件 + 阶段2 上下文事件"
```

---

### Task 4: curate-service 接入工具事件 + 前端注册

**Files:**
- Modify: `src/server/services/curate-service.ts:84-96`
- Modify: `src/hooks/use-job-stream.ts:206-214`（`curate:*` 白名单）

**Interfaces:**
- Consumes: Task 1 `toolActivityLine`；Task 2 `onToolCall`；同文件既有 `seedSet`（`null`=manual）、`CURATE_CAPS`。
- Produces: 新事件类型 `curate:agent:start`、`curate:tool`。

- [ ] **Step 1: curate-service 改动**

`src/server/services/curate-service.ts` 顶部 import 区加：

```ts
import { toolActivityLine } from '@/lib/tool-activity';
```

在 `// 4. 驱动工具循环` 注释之前加：

```ts
  emit('curate:agent:start', `Reviewing ${metas.length} candidate page(s) (mode: ${seedSet === null ? 'manual' : 'auto'}, caps: ${Object.entries(CURATE_CAPS).map(([k, v]) => `${k}≤${v}`).join(' ')})…`, {
    candidates: metas.length,
    mode: seedSet === null ? 'manual' : 'auto',
    caps: CURATE_CAPS,
  });
```

`generateTextWithTools('curate', {...})` 调用加一个参数（`shouldCancel` 之后）：

```ts
    onToolCall: (info) => emit('curate:tool', toolActivityLine(info.tool, info.args), { tool: info.tool }),
```

- [ ] **Step 2: 前端白名单注册**

`src/hooks/use-job-stream.ts` 的 curate 事件列表（`'curate:start',` 之后）加两行：

```ts
        'curate:agent:start',
        'curate:tool',
```

- [ ] **Step 3: 校验**

Run: `npx tsc --noEmit && npx vitest run src/server/services/__tests__`
Expected: tsc 零错误，测试全 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/server/services/curate-service.ts src/hooks/use-job-stream.ts
git commit -m "feat(curate): tool-loop 每次工具调用 emit curate:tool 日志事件 + 循环前上下文事件"
```

---

### Task 5: lint 事件上下文补充 + `summarizeFindings`

**Files:**
- Modify: `src/server/services/lint-service.ts`
- Test: `src/server/services/__tests__/lint-summarize.test.ts`（新建）

**Interfaces:**
- Consumes: `pagesRepo.getAllPages(subject.id)` / `pagesRepo.isMetaPage(p)`（`src/server/db/repos/pages-repo`）；`resolveTask('lint').logLabel`（`src/server/llm/task-router`）。
- Produces: `export function summarizeFindings(findings: Pick<LintFinding, 'severity' | 'type'>[]): { bySeverity: Record<string, number>; byType: Record<string, number>; text: string }`。

- [ ] **Step 1: 写失败测试**

新建 `src/server/services/__tests__/lint-summarize.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { summarizeFindings } from '../lint-service';

describe('summarizeFindings', () => {
  it('按 severity 与 type 聚合并生成单行文案', () => {
    const res = summarizeFindings([
      { severity: 'critical', type: 'broken-link' },
      { severity: 'warning', type: 'broken-link' },
      { severity: 'warning', type: 'contradiction' },
    ] as never);
    expect(res.bySeverity).toEqual({ critical: 1, warning: 2 });
    expect(res.byType).toEqual({ 'broken-link': 2, contradiction: 1 });
    expect(res.text).toBe('1 critical, 2 warning; broken-link×2, contradiction×1');
  });

  it('空 findings 返回空文案', () => {
    const res = summarizeFindings([]);
    expect(res.bySeverity).toEqual({});
    expect(res.byType).toEqual({});
    expect(res.text).toBe('');
  });
});
```

注意：`lint-service.ts` 是 side-effect 注册模块（`registerHandler('lint', ...)`），若 import 时因依赖链报错，测试顶部按同目录既有 service 测试的 mock 方式 mock `../jobs/worker`：

```ts
vi.mock('../../jobs/worker', () => ({ registerHandler: vi.fn() }));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/lint-summarize.test.ts`
Expected: FAIL —— `summarizeFindings` 未导出。

- [ ] **Step 3: 实现**

`src/server/services/lint-service.ts`：

顶部 import 区加：

```ts
import * as pagesRepo from '../db/repos/pages-repo';
import { resolveTask } from '../llm/task-router';
```

新增导出纯函数（`runLintJob` 之前）：

```ts
/** findings 分类统计（severity/type 计数 + 单行文案），供 lint 事件与 result 附带。 */
export function summarizeFindings(
  findings: Pick<LintFinding, 'severity' | 'type'>[],
): { bySeverity: Record<string, number>; byType: Record<string, number>; text: string } {
  const bySeverity: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byType[f.type] = (byType[f.type] ?? 0) + 1;
  }
  const severityText = ['critical', 'warning', 'info']
    .filter((s) => bySeverity[s])
    .map((s) => `${bySeverity[s]} ${s}`)
    .join(', ');
  const typeText = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}×${n}`)
    .join(', ');
  return { bySeverity, byType, text: [severityText, typeText].filter(Boolean).join('; ') };
}

/** lint task 的模型标签；配置解析失败时回落 null（不阻断 lint 主流程）。 */
function lintModelLabel(): string | null {
  try {
    return resolveTask('lint').logLabel;
  } catch {
    return null;
  }
}
```

`lint:semantic:start` emit（第 65 行）替换为：

```ts
    const pageCount = pagesRepo.getAllPages(subject.id).filter((p) => !pagesRepo.isMetaPage(p)).length;
    const model = lintModelLabel();
    emit(
      'lint:semantic:start',
      `Subject "${subject.slug}": running LLM semantic analysis on ${pageCount} page(s)${model ? ` with ${model}` : ''} (single pass, may take a few minutes)…`,
      { pageCount, model },
    );
```

`lint:semantic:done` emit（第 71-75 行）替换为：

```ts
      const semanticStats = summarizeFindings(semanticFindings);
      emit(
        'lint:semantic:done',
        `Subject "${subject.slug}": ${semanticFindings.length} semantic finding(s)${semanticStats.text ? ` (${semanticStats.text})` : ''}`,
        { findings: semanticFindings, subject: subject.slug, ...semanticStats },
      );
```

`lint:complete` emit（第 91-102 行）替换为（`bySeverity` 手写计数改用 `summarizeFindings`，data 形状保持含 `bySeverity`，新增 `byType`）：

```ts
  const stats = summarizeFindings(allFindings);
  emit(
    'lint:complete',
    `Lint complete: ${allFindings.length} total finding(s)${stats.text ? ` (${stats.text})` : ''}`,
    { totalFindings: allFindings.length, bySeverity: stats.bySeverity, byType: stats.byType },
  );
```

注意：既有 `lint:complete` 的 `bySeverity` 对无 findings 的 severity 输出 0（如 `{ critical: 0, ... }`），`summarizeFindings` 只输出非零项——检查前端是否有消费方依赖恒有三键（`grep -rn "bySeverity" src/components src/hooks`）；若有则在 emit 处补零展开 `{ critical: 0, warning: 0, info: 0, ...stats.bySeverity }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__ && npx tsc --noEmit`
Expected: 全 PASS，tsc 零错误。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/lint-service.ts src/server/services/__tests__/lint-summarize.test.ts
git commit -m "feat(lint): semantic 阶段事件补页数/模型标签，done/complete 补 findings 分类统计"
```

---

### Task 6: 端到端验证 + 文档同步

**Files:**
- Modify: `CLAUDE.md`（变更记录表加一行）
- Modify: `src/server/services/CLAUDE.md`（fix/curate/lint 事件清单同步）
- Modify: `src/server/llm/CLAUDE.md`（`generateTextWithTools` 签名同步）

**Interfaces:**
- Consumes: Task 1-5 全部产物。

- [ ] **Step 1: 全量回归**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS（基线 157 文件 / 1034 用例 + 本次新增），tsc 零错误。

- [ ] **Step 2: 文档同步**

- `src/server/llm/CLAUDE.md`：`generateTextWithTools` 签名行补 `onToolCall?`。
- `src/server/services/CLAUDE.md`：fix 事件清单补 `fix:agent:start`/`fix:tool`；curate 补 `curate:agent:start`/`curate:tool`；lint 小节提及事件含分类统计。
- 根 `CLAUDE.md` 变更记录表加一行（日期 2026-07-09，一句话概括本特性，引用 spec/plan 路径）。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md src/server/services/CLAUDE.md src/server/llm/CLAUDE.md
git commit -m "docs: 同步任务日志可读性改进（fix/curate 工具事件 + lint 统计）的模块文档"
```

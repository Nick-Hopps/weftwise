# Wiki Fix / Curate 定向后置校验 Phase 1C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Fix 与 Curate 增加基于实际 applied operations 的定向后置校验，并把 clean / residual 结果写入 Job、SSE 与健康页。

**Architecture:** `operations` 是写入范围唯一真实源；共享收集器把当前 Job 的 Changeset 转为 `PostconditionScope`，共享确定性校验器检查链接、孤立页与 provenance 不变量。Fix 仅在实际写入且存在原语义 finding 时复用 `lint` 模型路由执行一次无工具结构化复检；统一编排器把所有异常降级为 `completed + residual` 报告，Fix / Curate 服务和 Health UI 只消费该契约。

**Tech Stack:** TypeScript 5、Next.js 15、React 19、Vercel AI SDK 4、Zod、better-sqlite3、Drizzle ORM、Vitest、SSE。

## Global Constraints

- 当前隔离工作区为 `.worktrees/wiki-postcondition-phase1c`，分支为 `feat/wiki-postcondition-phase1c`；执行时不得新建第二个 worktree。
- 所有新增 task、plan、spec、代码注释和 commit message 使用中文；commit message 为一句 Conventional Commit。
- 影响范围只能来自当前 `jobId + subjectId` 的 `status='applied' AND post_head IS NOT NULL` operations。
- 后置校验只读 Vault / SQLite，不调用写工具、不入队修复、不 rollback、不重放已提交写入。
- residual 或校验器异常不得使已完成写入的 Job 进入 failed / retry；结果必须是 `completed + postconditionStatus:'residual'`。
- 空 operation scope 表示本 Job 没有产生状态变化，返回 clean，且不调用语义模型。
- Fix 语义复检最多调用一次 `generateStructuredOutput('lint', ...)`，不提供工具；Curate 永远不调用语义模型。
- 不新增 LLM task，不修改 `llm-config.example.json`，不修改 `src/server/agents/tools/**` 或 `src/server/agents/skills/**`。
- 继续保留 Fix 完成后的自动全量 lint，仅用于刷新 Health findings，不把它当作当前 Job 的 postcondition。
- 每项任务遵循 RED → GREEN → REFACTOR；定向测试通过后才能提交。
- 当前协作模式默认使用 `superpowers:executing-plans` 内联执行；除非 Nick 明确要求，不派生 sub-agent。

---

## 文件结构

### 新增文件

- `src/server/services/operation-scope-collector.ts`：读取、校验并合并当前 Job 的 applied Changeset。
- `src/server/services/postcondition-verifier.ts`：加载写后快照并执行共享确定性结构检查。
- `src/server/services/fix-semantic-postcondition.ts`：Fix 原语义 finding 的单次、有界、无工具 LLM 复检。
- `src/server/services/postcondition-service.ts`：校验编排、失败降级、统一事件与报告。
- `src/server/services/__tests__/operation-scope-collector.test.ts`：operation JSON / 路径 / 去重测试。
- `src/server/services/__tests__/postcondition-verifier.test.ts`：结构不变量纯函数测试。
- `src/server/services/__tests__/fix-semantic-postcondition.test.ts`：触发边界、决策映射与失败降级测试。
- `src/server/services/__tests__/postcondition-service.test.ts`：统一报告与异常语义测试。
- `src/components/health/postcondition-summary.ts`：SSE 报告解析与 Health 提示模型纯函数。
- `src/components/health/__tests__/postcondition-summary.test.ts`：clean / residual / semantic failed UI 映射测试。

### 主要修改文件

- `src/lib/contracts.ts`：`PostconditionScope`、finding、report 共享契约。
- `src/server/db/repos/operations-repo.ts`：按 Job / Subject 查询 applied operations。
- `src/server/db/repos/sources-repo.ts`：定向读取 `page_sources` 完整性行。
- `src/server/db/repos/__tests__/{operations-repo,sources-repo}.test.ts`：真实 SQLite repo 覆盖。
- `src/server/services/{fix-service,curate-service}.ts`：写后接入统一校验。
- `src/server/services/__tests__/{fix-service,curate-service}.test.ts`：服务所有返回路径契约。
- `src/hooks/use-job-stream.ts`：注册四个 verify 命名事件。
- `src/components/health/health-view.tsx`：展示 Fix / Curate 后置校验摘要。
- `src/lib/CLAUDE.md`、`src/server/{db,services}/CLAUDE.md`、`src/components/CLAUDE.md`：共享契约、维护边界和事件文档。

---

### Task 1: 后置校验领域契约与 Operation Scope

**Files:**
- Modify: `src/lib/contracts.ts`
- Modify: `src/server/db/repos/operations-repo.ts`
- Modify: `src/server/db/repos/__tests__/operations-repo.test.ts`
- Create: `src/server/services/operation-scope-collector.ts`
- Create: `src/server/services/__tests__/operation-scope-collector.test.ts`

**Interfaces:**
- Consumes: `OperationRow`、`parseWikiPath()`、Zod。
- Produces: `PostconditionScope`、`PostconditionFinding`、`PostconditionReport`、`listAppliedForJob()`、`buildPostconditionScope()`、`collectPostconditionScope()`。

- [ ] **Step 1: 写 applied operation 查询和 scope 解析失败测试**

在 repo 测试的 `setup()` 中追加同 Job 的 applied / pending / reverted operation，并断言：

```ts
it('listAppliedForJob：只返回当前 job/subject 已提交 operation，按 rowid 正序', async () => {
  const repo = await setup();
  expect(repo.listAppliedForJob('job-ing', 's1').map((row) => row.id)).toEqual([
    'opA',
    'opC',
  ]);
});
```

新建 collector 测试，直接构造 `OperationRow[]`：

```ts
const subject = { id: 's1', slug: 'general' };

function operationRaw(changesetJson: string, id = 'op-1'): OperationRow {
  return {
    id,
    jobId: 'job-1',
    subjectId: 's1',
    preHead: 'pre',
    postHead: `post-${id}`,
    changesetJson,
    status: 'applied',
    jobType: 'fix',
  };
}

function operation(id: string, entries: ChangesetEntry[]): OperationRow {
  return operationRaw(JSON.stringify(entries), id);
}

it('合并多个 Changeset 并按首次出现顺序去重 slug', () => {
  const scope = buildPostconditionScope('job-1', subject, [
    operation('op-1', [
      { action: 'create', path: 'wiki/general/a.md', content: '# A' },
      { action: 'update', path: 'wiki/general/b.md', content: '# B' },
    ]),
    operation('op-2', [
      { action: 'update', path: 'wiki/general/a.md', content: '# A2' },
      { action: 'delete', path: 'wiki/general/c.md', content: null },
    ]),
  ]);
  expect(scope).toMatchObject({
    operationIds: ['op-1', 'op-2'],
    createdSlugs: ['a'],
    updatedSlugs: ['b', 'a'],
    deletedSlugs: ['c'],
    touchedSlugs: ['a', 'b', 'c'],
  });
});

it.each([
  ['损坏 JSON', '{'],
  ['非法 entry', '[{"action":"move","path":"wiki/general/a.md","content":null}]'],
  ['越界 Subject', '[{"action":"delete","path":"wiki/other/a.md","content":null}]'],
  ['非 Wiki 路径', '[{"action":"delete","path":"raw/general/a.md","content":null}]'],
])('%s 抛出 PostconditionScopeError', (_name, changesetJson) => {
  expect(() => buildPostconditionScope('job-1', subject, [operationRaw(changesetJson)]))
    .toThrow(PostconditionScopeError);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/db/repos/__tests__/operations-repo.test.ts src/server/services/__tests__/operation-scope-collector.test.ts`  
Expected: FAIL，提示查询函数、collector 或共享类型不存在。

- [ ] **Step 3: 在 contracts 中增加唯一共享契约**

```ts
export interface PostconditionScope {
  jobId: string;
  subjectId: SubjectId;
  createdSlugs: string[];
  updatedSlugs: string[];
  deletedSlugs: string[];
  touchedSlugs: string[];
  operationIds: string[];
}

export type PostconditionFindingType =
  | 'broken-link'
  | 'dangling-incoming-link'
  | 'orphan-page'
  | 'dangling-page-source'
  | 'contradiction'
  | 'missing-crossref'
  | 'verification-error';

export interface PostconditionFinding {
  type: PostconditionFindingType;
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string | null;
  description: string;
  relatedSlugs?: string[];
}

export type PostconditionSemanticStatus = 'not-needed' | 'clean' | 'residual' | 'failed';

export interface PostconditionReport {
  status: 'clean' | 'residual';
  checkedAt: string;
  scope: PostconditionScope;
  residualFindings: PostconditionFinding[];
  semanticStatus: PostconditionSemanticStatus;
  verificationError: string | null;
}
```

- [ ] **Step 4: 实现 Repo 查询与严格 scope 收集器**

Repo SQL 固定为：

```sql
SELECT o.id, o.job_id, o.subject_id, o.pre_head, o.post_head,
       o.changeset_json, o.status, j.type AS job_type
FROM operations o
LEFT JOIN jobs j ON j.id = o.job_id
WHERE o.job_id = ? AND o.subject_id = ?
  AND o.status = 'applied' AND o.post_head IS NOT NULL
ORDER BY o.rowid ASC
```

Collector 对 `changeset_json` 使用完整 Zod schema：

```ts
const ChangesetEntriesSchema = z.array(z.object({
  action: z.enum(['create', 'update', 'delete']),
  path: z.string().min(1),
  content: z.string().nullable(),
}).superRefine((entry, ctx) => {
  if (entry.action !== 'delete' && entry.content === null) {
    ctx.addIssue({ code: 'custom', message: `${entry.action} content 不能为空` });
  }
}));

export class PostconditionScopeError extends Error {}

export function buildPostconditionScope(
  jobId: string,
  subject: Pick<Subject, 'id' | 'slug'>,
  rows: OperationRow[],
): PostconditionScope;

export function collectPostconditionScope(
  jobId: string,
  subject: Pick<Subject, 'id' | 'slug'>,
): PostconditionScope {
  return buildPostconditionScope(
    jobId,
    subject,
    operationsRepo.listAppliedForJob(jobId, subject.id),
  );
}
```

`buildPostconditionScope()` 必须校验 row 的 job / subject，使用 `parseWikiPath()` 校验路径 Subject，并用保序 `Set` 分别聚合五个数组；任一行不可解析就抛 `PostconditionScopeError`。

- [ ] **Step 5: 运行定向测试与类型检查**

Run: `npx vitest run src/server/db/repos/__tests__/operations-repo.test.ts src/server/services/__tests__/operation-scope-collector.test.ts && npx tsc --noEmit`  
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/lib/contracts.ts src/server/db/repos/operations-repo.ts src/server/db/repos/__tests__/operations-repo.test.ts src/server/services/operation-scope-collector.ts src/server/services/__tests__/operation-scope-collector.test.ts
git commit -m "feat: 建立后置校验范围契约"
```

---

### Task 2: 共享确定性后置校验器

**Files:**
- Modify: `src/server/db/repos/sources-repo.ts`
- Modify: `src/server/db/repos/__tests__/sources-repo.test.ts`
- Create: `src/server/services/postcondition-verifier.ts`
- Create: `src/server/services/__tests__/postcondition-verifier.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PostconditionScope` / `PostconditionFinding`，`pagesRepo.getAllPagesAcrossSubjects()`、`pagesRepo.getAllLinks()`。
- Produces: `PageSourceIntegrityRow`、`listPageSourceIntegrityRows()`、`PostconditionSnapshot`、`loadPostconditionSnapshot()`、`verifyDeterministicPostconditions()`。

- [ ] **Step 1: 写 page_sources 完整性查询失败测试**

在真实 SQLite 中插入正常、page 缺失、source 缺失、source Subject 错配四种行：

```ts
it('返回指定 slug 的 page/source 存在性与 source subject', async () => {
  const rows = repo.listPageSourceIntegrityRows('s1', ['alive', 'deleted']);
  expect(rows).toEqual(expect.arrayContaining([
    { subjectId: 's1', pageSlug: 'alive', sourceId: 'src-ok', pageExists: true, sourceSubjectId: 's1' },
    { subjectId: 's1', pageSlug: 'deleted', sourceId: 'src-missing', pageExists: false, sourceSubjectId: null },
  ]));
});

it('空 slug 列表不执行非法 IN 查询', () => {
  expect(repo.listPageSourceIntegrityRows('s1', [])).toEqual([]);
});
```

- [ ] **Step 2: 写确定性规则失败测试**

用纯 `PostconditionSnapshot` fixture 覆盖四类 finding 和定向边界：

```ts
function page(subjectId: string, slug: string): WikiPage {
  return {
    subjectId,
    slug,
    title: slug,
    path: `wiki/${subjectId}/${slug}.md`,
    summary: '',
    contentHash: `hash-${slug}`,
    tags: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
}

function link(
  subjectId: string,
  sourceSlug: string,
  targetSubjectId: string,
  targetSlug: string,
): WikiLink {
  return { subjectId, sourceSlug, targetSubjectId, targetSlug, context: '' };
}

const findings = verifyDeterministicPostconditions(subject, scope, {
  pages: [page('s1', 'edited'), page('s1', 'new-page'), page('s2', 'foreign-source')],
  links: [
    link('s1', 'edited', 's1', 'missing-target'),
    link('s2', 'foreign-source', 's1', 'deleted-page'),
    link('s1', 'unrelated', 's1', 'historical-missing'),
  ],
  pageSources: [
    { subjectId: 's1', pageSlug: 'deleted-page', sourceId: 'src-1', pageExists: false, sourceSubjectId: 's1' },
  ],
});

expect(findings.map((finding) => finding.type)).toEqual([
  'broken-link',
  'dangling-incoming-link',
  'dangling-page-source',
  'orphan-page',
]);
expect(findings.every((finding) => !finding.description.includes('historical-missing'))).toBe(true);
```

另写用例覆盖：跨 Subject broken target、已存在目标不报、created 页有跨 Subject 入链不 orphan、meta created 页不报、重复 link 去重、结果稳定排序、空 scope 返回空数组。

- [ ] **Step 3: 运行测试确认 RED**

Run: `npx vitest run src/server/db/repos/__tests__/sources-repo.test.ts src/server/services/__tests__/postcondition-verifier.test.ts`  
Expected: FAIL，提示完整性查询或 verifier 不存在。

- [ ] **Step 4: 实现 provenance Repo 查询**

```ts
export interface PageSourceIntegrityRow {
  subjectId: SubjectId;
  pageSlug: string;
  sourceId: string;
  pageExists: boolean;
  sourceSubjectId: SubjectId | null;
}

export function listPageSourceIntegrityRows(
  subjectId: SubjectId,
  pageSlugs: string[],
): PageSourceIntegrityRow[];
```

实现使用参数化 `IN (...)`，从 `page_sources ps` 左联 `pages p`（复合条件 `subject_id + slug`）与 `sources s`，只查询当前 Subject 和 scope slug。`pageExists` 用 `p.slug IS NOT NULL` 映射，保留 source 缺失行。

- [ ] **Step 5: 实现快照加载和纯确定性校验**

```ts
export interface PostconditionSnapshot {
  pages: WikiPage[];
  links: WikiLink[];
  pageSources: PageSourceIntegrityRow[];
}

export function loadPostconditionSnapshot(
  subject: Subject,
  scope: PostconditionScope,
): PostconditionSnapshot {
  return {
    pages: pagesRepo.getAllPagesAcrossSubjects(),
    links: pagesRepo.getAllLinks(undefined, pagesRepo.getMetaPageKeys()),
    pageSources: sourcesRepo.listPageSourceIntegrityRows(
      subject.id,
      [...new Set([...scope.touchedSlugs, ...scope.deletedSlugs])],
    ),
  };
}

export function verifyDeterministicPostconditions(
  subject: Subject,
  scope: PostconditionScope,
  snapshot = loadPostconditionSnapshot(subject, scope),
): PostconditionFinding[];
```

实现以 `<subjectId>\0<slug>` 构建 page key：只检查存活 touched 页出链、当前已不存在 deleted 目标的存活入链、存活非 meta created 页入链、scope provenance 行。finding 通过 `type + pageSlug + description` key 去重并按同一 key 排序。

- [ ] **Step 6: 运行定向测试与类型检查**

Run: `npx vitest run src/server/db/repos/__tests__/sources-repo.test.ts src/server/services/__tests__/postcondition-verifier.test.ts && npx tsc --noEmit`  
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/server/db/repos/sources-repo.ts src/server/db/repos/__tests__/sources-repo.test.ts src/server/services/postcondition-verifier.ts src/server/services/__tests__/postcondition-verifier.test.ts
git commit -m "feat: 实现确定性后置校验"
```

---

### Task 3: Fix 单次语义复检

**Files:**
- Create: `src/server/services/fix-semantic-postcondition.ts`
- Create: `src/server/services/__tests__/fix-semantic-postcondition.test.ts`

**Interfaces:**
- Consumes: `LintFinding[]`、Task 1 的 scope / finding、`generateStructuredOutput('lint')`、`scanWikiPages()`、`getWikiLanguage()`。
- Produces: `semanticFindingId()`、`FixSemanticPostconditionResult`、`recheckFixSemanticPostconditions()`。

- [ ] **Step 1: 写决策映射与调用边界失败测试**

Mock `generateStructuredOutput` 并断言一次调用、task 为 lint、无 tools 参数：

```ts
it('一次复检原语义 finding，并把 residual 映射为共享 finding', async () => {
  generateMock.mockResolvedValue({ decisions: [
    { findingId: semanticFindingId(contradiction), status: 'resolved', reason: '两页现已一致' },
    { findingId: semanticFindingId(missingLink), status: 'residual', reason: '仍是纯文本提及' },
  ] });

  const result = await recheckFixSemanticPostconditions({
    subject,
    scope,
    findings: [contradiction, missingLink],
    shouldCancel: () => false,
  });

  expect(generateMock).toHaveBeenCalledTimes(1);
  expect(generateMock.mock.calls[0][0]).toBe('lint');
  expect(result.status).toBe('residual');
  expect(result.residualFindings).toEqual([
    expect.objectContaining({ type: 'missing-crossref', pageSlug: missingLink.pageSlug }),
  ]);
});
```

再覆盖：空 findings 不调用、空 scope 不调用、未知/重复/缺失 decision 保守 residual、超上限 finding 保守 residual、模型异常为 failed、调用前/调用后取消为 failed、输出不能新增 coverage-gap。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/fix-semantic-postcondition.test.ts`  
Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 定义窄 Schema、稳定内部 ID 与有界输入**

```ts
const SemanticDecisionSchema = z.object({
  decisions: z.array(z.object({
    findingId: z.string().length(64),
    status: z.enum(['resolved', 'residual']),
    reason: z.string().max(500),
  })),
});

export const MAX_SEMANTIC_RECHECK_FINDINGS = 40;
export const MAX_SEMANTIC_RECHECK_PAGES = 24;
export const MAX_SEMANTIC_PAGE_CHARS = 8_000;
export const MAX_SEMANTIC_PROMPT_CHARS = 120_000;

export function semanticFindingId(finding: Pick<LintFinding, 'type' | 'pageSlug' | 'description'>): string {
  return createHash('sha256')
    .update(`${finding.type}\0${finding.pageSlug}\0${finding.description}`)
    .digest('hex');
}
```

选择页面时按以下稳定顺序：finding 的 `pageSlug` → `scope.touchedSlugs` → 当前 Subject 中 slug 被 finding 描述明确包含的页面；去重后应用页数和总字符上限。不能装入请求的 finding 直接转 residual，不从请求中静默丢弃。

系统提示与用户提示固定只做复检，不允许发现新问题：

```ts
const FIX_POSTCONDITION_SYSTEM_PROMPT = `你是 Wiki 修复结果复检器。只判断输入中的原始 finding 在当前页面内容中是否已经解决。
不得提出新 finding，不得执行工具，不得把证据不足判断为 resolved。证据不足时返回 residual。`;

function buildFixPostconditionPrompt(input: {
  subject: Pick<Subject, 'slug' | 'name' | 'description'>;
  findings: Array<{ findingId: string; finding: LintFinding }>;
  pages: Array<{ slug: string; content: string }>;
}): string {
  return JSON.stringify(input);
}
```

- [ ] **Step 4: 实现单次无工具复检与保守失败**

```ts
export interface FixSemanticPostconditionResult {
  status: 'clean' | 'residual' | 'failed';
  residualFindings: PostconditionFinding[];
  error: string | null;
}

export async function recheckFixSemanticPostconditions(input: {
  subject: Subject;
  scope: PostconditionScope;
  findings: LintFinding[];
  shouldCancel: () => boolean;
}): Promise<FixSemanticPostconditionResult>;
```

函数先过滤 `contradiction | missing-crossref`。可复检集合为空时返回 clean；调用前后检查取消；只调用：

```ts
await generateStructuredOutput(
  'lint',
  SemanticDecisionSchema,
  FIX_POSTCONDITION_SYSTEM_PROMPT,
  buildFixPostconditionPrompt({ subject, findings: requestedFindings, pages: promptPages }),
);
```

catch 中只 `console.warn` 完整异常，对外返回固定安全文案 `Fix 语义后置复检未完成。`，并把所有原语义 finding 映射为 residual；不得把异常重新抛给 worker。

- [ ] **Step 5: 运行定向测试与类型检查**

Run: `npx vitest run src/server/services/__tests__/fix-semantic-postcondition.test.ts && npx tsc --noEmit`  
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/server/services/fix-semantic-postcondition.ts src/server/services/__tests__/fix-semantic-postcondition.test.ts
git commit -m "feat: 实现 Fix 语义复检"
```

---

### Task 4: 统一后置校验报告编排

**Files:**
- Create: `src/server/services/postcondition-service.ts`
- Create: `src/server/services/__tests__/postcondition-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 的 collector、确定性 verifier、Fix semantic checker。
- Produces: `verifyJobPostconditions()`，供 Fix / Curate 唯一调用。

- [ ] **Step 1: 写 clean / residual / failure orchestration 失败测试**

通过模块 mock 控制各阶段：

```ts
it('Fix 合并确定性与语义 residual，并发出统一事件', async () => {
  collectMock.mockReturnValue(scopeWithOneOperation);
  deterministicMock.mockReturnValue([brokenLink]);
  semanticMock.mockResolvedValue({
    status: 'residual', residualFindings: [contradiction], error: null,
  });
  const emit = vi.fn();

  const report = await verifyJobPostconditions({
    kind: 'fix', job, subject, semanticFindings: [originalContradiction], emit,
  });

  expect(report.status).toBe('residual');
  expect(report.residualFindings).toEqual([brokenLink, contradiction]);
  expect(emit).toHaveBeenNthCalledWith(1, 'fix:verify:start', expect.any(String), expect.any(Object));
  expect(emit).toHaveBeenNthCalledWith(2, 'fix:verify:complete', expect.any(String), expect.objectContaining({
    postconditionStatus: 'residual', residualCount: 2, postcondition: report,
  }));
});
```

另写：空 scope clean 且不调用 verifier / semantic；Curate 不调用 semantic；collector 抛错、确定性 verifier 抛错均返回带 `verification-error` 的 residual；semantic failed 保留结构 findings 并设置 `semanticStatus:'failed'`；`checkedAt` 使用注入 clock；finding 合并稳定去重。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/postcondition-service.test.ts`  
Expected: FAIL，提示编排模块不存在。

- [ ] **Step 3: 实现统一编排接口**

```ts
export async function verifyJobPostconditions(input: {
  kind: 'fix' | 'curate';
  job: Job;
  subject: Subject;
  semanticFindings?: LintFinding[];
  emit: (type: string, message: string, data?: Record<string, unknown>) => void;
  now?: () => Date;
}): Promise<PostconditionReport>;
```

执行顺序固定：emit start → collect scope → 空 scope clean → deterministic → Fix semantic（仅有语义 finding）→ 去重排序 → 计算 status → emit complete。Curate 强制 `semanticStatus:'not-needed'`。

基础设施 catch 返回：

```ts
function emptyPostconditionScope(jobId: string, subjectId: SubjectId): PostconditionScope {
  return {
    jobId,
    subjectId,
    createdSlugs: [],
    updatedSlugs: [],
    deletedSlugs: [],
    touchedSlugs: [],
    operationIds: [],
  };
}

{
  status: 'residual',
  checkedAt: now().toISOString(),
  scope: scope ?? emptyPostconditionScope(job.id, subject.id),
  residualFindings: [{
    type: 'verification-error',
    severity: 'warning',
    pageSlug: null,
    description: '后置校验未能完整执行，请检查 Job 详情并人工复核。',
  }],
  semanticStatus: 'not-needed',
  verificationError: '后置校验未能完整执行。',
}
```

完整异常只写服务端 `console.warn`，不进入 SSE / resultJson。

- [ ] **Step 4: 运行定向测试与类型检查**

Run: `npx vitest run src/server/services/__tests__/postcondition-service.test.ts && npx tsc --noEmit`  
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/postcondition-service.ts src/server/services/__tests__/postcondition-service.test.ts
git commit -m "feat: 编排后置校验报告"
```

---

### Task 5: Fix 服务接入后置校验

**Files:**
- Modify: `src/server/services/fix-service.ts`
- Modify: `src/server/services/__tests__/fix-service.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `verifyJobPostconditions()`。
- Produces: 所有 Fix 成功结果的 `postconditionStatus` / `postcondition`，以及增强后的 `fix:complete` data。

- [ ] **Step 1: 扩展 Fix 服务测试为报告契约**

Mock 统一编排器返回固定报告：

```ts
const postconditionMock = vi.hoisted(() => ({
  verifyJobPostconditions: vi.fn(async () => cleanReport),
}));
vi.mock('@/server/services/postcondition-service', () => postconditionMock);

it('写入完成后传入原语义 findings，并返回后置报告', async () => {
  latestMock.selectLatestFindings.mockReturnValueOnce({ findings: [contradiction] });
  const emit = vi.fn();
  const result = await runFixJob(job(), emit);

  expect(postconditionMock.verifyJobPostconditions).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'fix', job: expect.objectContaining({ id: 'j1' }),
    semanticFindings: [contradiction], emit,
  }));
  expect(result).toMatchObject({ postconditionStatus: 'clean', postcondition: cleanReport });
  expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.objectContaining({
    postconditionStatus: 'clean', residualCount: 0,
  }));
});
```

补充 worklist 空、只有 frontmatter、tool-loop 三条路径都调用一次 postcondition；residual report 仍正常 return，不抛错；embedding enqueue 次数保持原样。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/fix-service.test.ts`  
Expected: FAIL，结果缺少 postcondition 或编排器未调用。

- [ ] **Step 3: 在现有写入和 embedding 后接入报告**

```ts
const postcondition = await verifyJobPostconditions({
  kind: 'fix',
  job,
  subject,
  semanticFindings: snapshotSemantic,
  emit,
});

const completeData = {
  deterministic: deterministicFixed,
  update,
  create,
  writes,
  postconditionStatus: postcondition.status,
  residualCount: postcondition.residualFindings.length,
  semanticStatus: postcondition.semanticStatus,
  postcondition,
};
const verificationText = postcondition.status === 'clean'
  ? 'Postcondition clean.'
  : `Postcondition residual: ${postcondition.residualFindings.length} issue(s).`;
emit(
  'fix:complete',
  `Fix complete: ${deterministicFixed} frontmatter, ${update} edited, ${create} created. ${verificationText}`,
  completeData,
);
return { ...completeData };
```

完成文案必须区分 clean / residual，但不得把 residual 写成 Job failed。不要移动或复制现有 `enqueueEmbedIndex()`。

- [ ] **Step 4: 运行 Fix 相关回归与类型检查**

Run: `npx vitest run src/server/services/__tests__/fix-service.test.ts src/server/services/__tests__/fix-tools.test.ts src/server/services/__tests__/fix-deterministic.test.ts && npx tsc --noEmit`  
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/fix-service.ts src/server/services/__tests__/fix-service.test.ts
git commit -m "feat: 接入 Fix 后置校验"
```

---

### Task 6: Curate 服务接入后置校验

**Files:**
- Modify: `src/server/services/curate-service.ts`
- Modify: `src/server/services/__tests__/curate-service.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `verifyJobPostconditions()`。
- Produces: 普通和候选不足早退两条 Curate 成功路径的统一报告。

- [ ] **Step 1: 写普通与早退路径失败测试**

```ts
it.each([
  ['manual', { scope: 'subject', subjectId: 's1' }, false],
  ['候选不足', { scope: 'subject', subjectId: 's1' }, true],
])('%s 路径都返回 postcondition', async (_name, params, onePage) => {
  if (onePage) pagesMock.getAllPages.mockReturnValueOnce([{ slug: 'a', tags: [] }]);
  const emit = vi.fn();
  const result = await runCurateJob(job(params), emit);
  expect(postconditionMock.verifyJobPostconditions).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'curate', semanticFindings: undefined, emit,
  }));
  expect(result).toMatchObject({ postconditionStatus: 'clean', postcondition: cleanReport });
});
```

补充 residual 报告仍 emit `curate:complete` 且不抛错；Curate 不传语义 findings；embedding 行为不变。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/curate-service.test.ts`  
Expected: FAIL，早退或普通路径缺少 postcondition。

- [ ] **Step 3: 收敛 Curate 两条完成路径**

新增局部 helper，避免复制报告拼装：

```ts
interface CurateTotals {
  merge: number;
  split: number;
  delete: number;
  create: number;
  writes: number;
}

type CurateEmit = (
  type: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

async function completeCurate(
  totals: CurateTotals,
  job: Job,
  subject: Subject,
  emit: CurateEmit,
): Promise<Record<string, unknown>> {
  const postcondition = await verifyJobPostconditions({ kind: 'curate', job, subject, emit });
  const result = {
    ...totals,
    postconditionStatus: postcondition.status,
    residualCount: postcondition.residualFindings.length,
    semanticStatus: postcondition.semanticStatus,
    postcondition,
  };
  const verificationText = postcondition.status === 'clean'
    ? 'Postcondition clean.'
    : `Postcondition residual: ${postcondition.residualFindings.length} issue(s).`;
  emit(
    'curate:complete',
    `Curation done: ${totals.merge} merge(s), ${totals.split} split(s), ${totals.delete} delete(s), ${totals.create} create(s). ${verificationText}`,
    result,
  );
  return result;
}
```

`scopeSlugs.length < 2` 以零 totals 调 helper；普通路径在现有 embedding enqueue 后调用 helper。`CurateTotals` 明确定义 merge / split / delete / create / writes 数字字段。

- [ ] **Step 4: 运行 Curate 相关回归与类型检查**

Run: `npx vitest run src/server/services/__tests__/curate-service.test.ts src/server/services/__tests__/curate-tools.test.ts src/server/wiki/__tests__/curate-plan.test.ts && npx tsc --noEmit`  
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/curate-service.ts src/server/services/__tests__/curate-service.test.ts
git commit -m "feat: 接入 Curate 后置校验"
```

---

### Task 7: SSE 注册与 Health 结果展示

**Files:**
- Modify: `src/hooks/job-stream-logic.ts`
- Modify: `src/hooks/use-job-stream.ts`
- Modify: `src/hooks/__tests__/job-stream-logic.test.ts`
- Create: `src/components/health/postcondition-summary.ts`
- Create: `src/components/health/__tests__/postcondition-summary.test.ts`
- Modify: `src/components/health/health-view.tsx`

**Interfaces:**
- Consumes: `PostconditionReport` 与 `JobStreamEvent` 的 `{ message, data, createdAt }` SSE 包装。
- Produces: `POSTCONDITION_JOB_EVENT_TYPES`、`extractPostconditionReport()`、`buildPostconditionNotice()`，以及 Fix / Curate 完成提示。

- [ ] **Step 1: 写 SSE 报告解析和提示模型失败测试**

```ts
it('从 verify:complete 的嵌套 data 中解析报告', () => {
  expect(extractPostconditionReport({
    type: 'fix:verify:complete',
    data: { message: 'done', data: { postcondition: cleanReport } },
  })).toEqual(cleanReport);
});

it.each([
  [cleanReport, 'success', '后置校验通过'],
  [residualReport, 'warning', '发现 2 个残留问题'],
  [semanticFailedReport, 'warning', '语义复检未完成'],
])('报告映射为明确提示', (report, tone, text) => {
  const notice = buildPostconditionNotice(report);
  expect(notice.tone).toBe(tone);
  expect(`${notice.title} ${notice.details.join(' ')}`).toContain(text);
});
```

另写非法 data 返回 null；残留摘要最多 3 条且每条截断到 180 字符；不修改原 report。

在 `job-stream-logic.test.ts` 增加事件注册断言：

```ts
expect(POSTCONDITION_JOB_EVENT_TYPES).toEqual([
  'fix:verify:start',
  'fix:verify:complete',
  'curate:verify:start',
  'curate:verify:complete',
]);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/components/health/__tests__/postcondition-summary.test.ts`  
Expected: FAIL，提示 summary 模块不存在。

- [ ] **Step 3: 实现纯解析与提示模型**

```ts
export interface PostconditionNotice {
  tone: 'success' | 'warning';
  title: string;
  details: string[];
}

export function extractPostconditionReport(event: JobStreamEvent | undefined): PostconditionReport | null;
export function buildPostconditionNotice(report: PostconditionReport): PostconditionNotice;
```

`extractPostconditionReport()` 必须读取 `event.data.data.postcondition` 并使用以下守卫，不直接类型断言未验证 JSON：

```ts
function isPostconditionReport(value: unknown): value is PostconditionReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  const scope = report.scope as Record<string, unknown> | null;
  const scopeArrays = ['createdSlugs', 'updatedSlugs', 'deletedSlugs', 'touchedSlugs', 'operationIds'];
  return (report.status === 'clean' || report.status === 'residual')
    && typeof report.checkedAt === 'string'
    && !!scope
    && typeof scope.jobId === 'string'
    && typeof scope.subjectId === 'string'
    && scopeArrays.every((key) => Array.isArray(scope[key]))
    && Array.isArray(report.residualFindings)
    && ['not-needed', 'clean', 'residual', 'failed'].includes(String(report.semanticStatus))
    && (report.verificationError === null || typeof report.verificationError === 'string');
}
```

`buildPostconditionNotice()` 的 semantic failed 文案优先级高于普通 residual。

- [ ] **Step 4: 注册 verify 事件并接入 Health state**

在 `job-stream-logic.ts` 导出只读常量：

```ts
export const POSTCONDITION_JOB_EVENT_TYPES = [
  'fix:verify:start',
  'fix:verify:complete',
  'curate:verify:start',
  'curate:verify:complete',
] as const;
```

`use-job-stream.ts` 在现有 `namedEventTypes` 末尾展开 `...POSTCONDITION_JOB_EVENT_TYPES`，四个名称只维护一份。

Health 分别保留 `curateEvents` 与 `fixEvents`；终态 effect 在清空 jobId 前读取最后一个对应 verify complete：

```ts
const verificationEvent = [...events]
  .reverse()
  .find((event) => event.type === `${kind}:verify:complete`);
setPostcondition(extractPostconditionReport(verificationEvent));
```

开始新 Fix / Curate 时清空旧报告。渲染使用现有 success / warning 设计 token：clean 绿色，residual 或 semantic failed 黄色，展示 title 与最多三条 details。Fix 原有 `void runLint()`、pages / lint-latest invalidation 保持不变；Curate 增加完成摘要但不自动新增 lint Job。

- [ ] **Step 5: 运行 UI / stream 定向测试、Lint 与类型检查**

Run: `npx vitest run src/components/health/__tests__/postcondition-summary.test.ts src/hooks/__tests__/job-stream-logic.test.ts src/components/health/__tests__/lint-findings.test.ts && npm run lint && npx tsc --noEmit`  
Expected: 测试与类型检查 PASS；ESLint 0 errors（允许仓库已有 warnings，不得新增 warning）。

- [ ] **Step 6: 提交**

```bash
git add src/hooks/job-stream-logic.ts src/hooks/use-job-stream.ts src/hooks/__tests__/job-stream-logic.test.ts src/components/health/postcondition-summary.ts src/components/health/__tests__/postcondition-summary.test.ts src/components/health/health-view.tsx
git commit -m "feat: 展示后置校验结果"
```

---

### Task 8: 维护文档与全量验收

**Files:**
- Modify: `src/lib/CLAUDE.md`
- Modify: `src/server/db/CLAUDE.md`
- Modify: `src/server/services/CLAUDE.md`
- Modify: `src/components/CLAUDE.md`
- Modify: `docs/superpowers/plans/2026-07-12-wiki-postcondition-phase1c.md`

**Interfaces:**
- Consumes: Tasks 1–7 的最终行为与测试证据。
- Produces: 可维护文档、完成勾选和全量验证记录。

- [ ] **Step 1: 更新模块文档**

在 Lib 文档把 `PostconditionScope / PostconditionFinding / PostconditionReport` 加入 `contracts.ts` 的领域类型清单。在 DB 文档记录：

```text
operations-repo.listAppliedForJob(jobId, subjectId) 只返回 applied + post_head 非空操作，供写后范围收集；sources-repo.listPageSourceIntegrityRows 提供定向 provenance 完整性快照。
```

在 Services 文档补充 Fix / Curate 事件和失败语义：

```text
fix:verify:start / fix:verify:complete
curate:verify:start / curate:verify:complete
postcondition residual 不改变 Job completed 状态，不触发重写或回滚。
```

在 Components 文档记录 Health clean / residual / semantic failed 三态展示，以及 Fix 自动 lint 仍只是 findings 刷新。

- [ ] **Step 2: 运行全部定向测试**

Run:

```bash
npx vitest run \
  src/server/db/repos/__tests__/operations-repo.test.ts \
  src/server/db/repos/__tests__/sources-repo.test.ts \
  src/server/services/__tests__/operation-scope-collector.test.ts \
  src/server/services/__tests__/postcondition-verifier.test.ts \
  src/server/services/__tests__/fix-semantic-postcondition.test.ts \
  src/server/services/__tests__/postcondition-service.test.ts \
  src/server/services/__tests__/fix-service.test.ts \
  src/server/services/__tests__/curate-service.test.ts \
  src/components/health/__tests__/postcondition-summary.test.ts \
  src/hooks/__tests__/job-stream-logic.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 3: 验证 LLM 配置与禁止修改范围**

Run: `git diff main...HEAD -- llm-config.example.json src/server/agents/tools src/server/agents/skills`  
Expected: 无输出。

Run: `npx vitest run src/server/llm/__tests__/config-example.test.ts`  
Expected: PASS。

- [ ] **Step 4: 运行全量质量门禁**

Run: `npm test -- --run`  
Expected: 全量 Vitest PASS。

Run: `npm run lint`  
Expected: 0 errors；不得新增 warning。

Run: `npx tsc --noEmit`  
Expected: PASS。

Run: `npm run build`  
Expected: Next.js production build PASS。

- [ ] **Step 5: 回填计划验收记录**

把本计划全部 checkbox 改为 `[x]`，并在文末新增“验收记录”。记录必须逐项写明定向测试的实际文件数与用例数、全量测试的实际文件数与用例数、ESLint 的实际 error / warning 数、TypeScript 结果、production build 结果，以及 `llm-config.example.json` 未修改；所有数字直接抄录最新命令输出。

- [ ] **Step 6: 提交文档与验收记录**

```bash
git add src/lib/CLAUDE.md src/server/db/CLAUDE.md src/server/services/CLAUDE.md src/components/CLAUDE.md docs/superpowers/plans/2026-07-12-wiki-postcondition-phase1c.md
git commit -m "chore: 完成 Phase 1C 全量验收"
```

---

## 完成后的分支收尾

实现和全量验证完成后，使用 `superpowers:verification-before-completion` 复核最新证据，再使用 `superpowers:finishing-a-development-branch`：

1. 确认 worktree 干净且所有提交都在 `feat/wiki-postcondition-phase1c`；
2. 回到主工作区；
3. 在 `main` 执行 `git merge --no-ff feat/wiki-postcondition-phase1c -m "merge: 合并 feat/wiki-postcondition-phase1c"`；
4. 在合并后的 `main` 至少重跑全量 Vitest、ESLint、TypeScript 与 production build；
5. 删除 `.worktrees/wiki-postcondition-phase1c` worktree；
6. 删除 `feat/wiki-postcondition-phase1c` 分支；
7. 确认 `main` 工作区干净。

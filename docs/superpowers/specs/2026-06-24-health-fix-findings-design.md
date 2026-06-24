# Health 页「一键修复」findings — 设计文档

> 日期：2026-06-24
> 主题：在 Health 体检页新增「Fix issues」按钮，自动修复 lint 检查发现的问题（确定性 + LLM 语义两阶段）

---

## 一、背景与目标

`(app)/health` 体检页目前是**只读**的：触发 lint → 按严重度/类型分组展示 7 类 findings → 深链跳到对应页。每条 finding 带一段 `suggestedFix` 文本，但没有任何执行入口（根 CLAUDE.md 与 `src/app/CLAUDE.md` 都注明"自动修复见后续特性"）。

**目标**：在 Health 页加一个 **单个「Fix issues」按钮**，把"当前检查发现的问题"中**可安全自动修复**的那部分一键修掉，复用现有 Saga 事务与异步 job + SSE 模式，与同页的 Re-run / Tidy structure 入口一致。

**非目标（v1 明确不做）**：

- 逐条 finding 的 Fix 按钮、修复前预览 / dry-run / 人工逐条审批（直接执行，靠 ⑥ 版本历史逐条 revert 兜底）。
- 跨 subject 批量修复（"All subjects"范围禁用该按钮，仅单 subject）。
- 修复 `orphan` / `stale-source` / `coverage-gap`（见第二节路由表，路由到既有去向）。
- 不新建 agent runtime（沿用 service + 无 tools 的 `generateStructuredOutput`，与 lint/curate/merge 一致）。

---

## 二、关键架构决策

### 决策 1：修复范围路由 —— 只修「落到 finding 所在页正文/frontmatter 编辑」的子集

7 类 finding 的"可修复性"差异极大。v1 一刀切干净的原则：**每个修复动作都只编辑 finding 所指页的正文或 frontmatter**（或其 frontmatter 字段），不触碰跨页判断、不引入新的 DB 删除管线、不做内容创作。

| 类型 | 严重度 | 检测来源 | v1 处理 | 修复机制 |
|------|--------|----------|---------|----------|
| `missing-frontmatter` | warning（固定） | 确定性 | ✅ 修 | **确定性**：补齐缺失/非法必填字段 |
| `broken-link` | warning（固定） | 确定性 | ✅ 修 | **LLM/页**：重链到现存页 / 删悬空链接 / 拿不准不动 |
| `missing-crossref` | warning/info（LLM 判） | LLM 语义 | ✅ 修 | **LLM/页**：把建议的 `[[link]]` 织入正文 |
| `contradiction` | critical/warning（LLM 判） | LLM 语义 | ✅ 修 | **LLM/页**：保守调和，LLM 不确定即自我否决 |
| `orphan` | info（固定） | 确定性 | ❌ 不修 | 跨页判断（需决定从哪挂链）→ 路由到手动 / Tidy structure |
| `stale-source` | info（固定） | 确定性 | ❌ 不修 | 多为"源变更需重新摄入"，删关联会丢溯源 → 路由到 Re-ingest |
| `coverage-gap` | warning/info（LLM 判） | LLM 语义 | ❌ 不修 | 本质是建新页=内容创作 → 路由到 Ingest |

> 严重度：确定性四类在 `lint-deterministic.ts` 中固定；语义三类由 LLM 在 lint 时判定（`lint-prompt.ts`），故为区间。
> in/out 划分理由：被排除的三类要么需要跨页/全局决策（orphan），要么需要新的 DB 删除能力且语义有歧义（stale-source），要么是内容创作而非"修复"（coverage-gap）——`fix` 一律只编辑 finding 所指页本身。后续若要纳入，各自需要独立增设计。

### 决策 2：新增 `fix` job 类型 + `fix-service`，subject-scoped 异步

与 `curate` 完全同构：`POST /api/fix`（auth + csrf + `resolveSubjectFromRequest(required)`）→ `queue.enqueue('fix', subject.id, { subjectId })` → 202 `{ jobId }`；前端 `useJobStream` 追踪。`fix-service.ts` 顶部 `registerHandler('fix', ...)`，在 `worker-entry.ts` import。

### 决策 3：工作清单 = 新鲜重扫确定性 ∪ 最近快照语义

不盲信前端传来的陈旧快照，也不为了找问题去重跑昂贵的 LLM lint：

- **确定性类（`missing-frontmatter` / `broken-link`）**：job 内**重新调用 `runDeterministicChecksForSubject(subject)`** 得到当前最新结果（便宜、准确，避免基于已被手动修过的陈旧快照）。
- **语义类（`missing-crossref` / `contradiction`）**：从**最近一次 completed lint job 快照**取（`selectLatestFindings` 同款逻辑；语义检测只能来自先前 lint，重跑代价高）。

合并去重后即工作清单。每个修复器在动手前**再校验当前状态**（幂等：frontmatter 已合法则跳过、broken-link 目标已存在则跳过），所以即使快照略陈旧也安全。

### 决策 4：每个 LLM 修复逐条自我门控（safe-by-construction）

LLM 修复 prompt 统一返回 `{ proceed: boolean, reason: string, body: string, summary?: string }`。`proceed:false`（如 contradiction 拿不准该信哪边）→ 该页不提交、记为 `skipped(需人工)`。改完的页一律过 `validateChangeset`（重新解析 wikilink）；若 LLM 引入新坏链 → 校验失败 → 跳过该页、emit warn、不污染 vault。riskier 的 `contradiction` 因此可安全纳入。

### 决策 5：提交粒度 —— 确定性 1 次 commit + LLM 每页 1 次 commit

- 阶段 1：所有 `missing-frontmatter` 修复合并为**一个** Saga changeset（多 `update` 条目）→ 一次 commit。
- 阶段 2：按 `pageSlug` 分组，**每页一个独立 commit**。
- 每个 commit 都进 `operations` 表 → ⑥ 历史里可逐条 revert（与 curate 一致）。

---

## 三、组件与数据流

```
Health 页 "Fix issues" 按钮
   │ POST /api/fix { subjectId }   (auth + csrf + resolveSubject required)
   ▼
queue.enqueue('fix', subject.id, { subjectId })  → 202 { jobId }
   ▼
fix-service.ts :: runFixJob(job, emit)
   │
   ├─ emit fix:start
   │
   ├─ 构建工作清单（决策3）
   │     deterministic = runDeterministicChecksForSubject(subject)
   │                       .filter(type ∈ {missing-frontmatter, broken-link})
   │     semantic      = selectLatestFindings(lint快照)
   │                       .filter(type ∈ {missing-crossref, contradiction})
   │     partitionFindings → { frontmatterFixes, llmFindings }（纯函数）
   │
   ├─ 阶段1 确定性（仅 missing-frontmatter）
   │     for each: fixMissingFrontmatter(doc, now)  （纯函数）→ entries[]
   │     若 entries 非空 → createChangeset → validate → apply（1 commit）
   │     emit fix:deterministic { fixed: N }
   │
   ├─ 阶段2 LLM/页（broken-link / missing-crossref / contradiction）
   │     按 pageSlug 分组 llmFindings
   │     for each page（串行，仿 curate）：
   │        doc = readPageInSubject(subject.slug, slug)；不存在/findings 失效 → skip
   │        result = generateStructuredOutput('fix', FixPageSchema,
   │                    FIX_SYSTEM_PROMPT,
   │                    buildFixPageUserPrompt(doc, findingsOnPage, slugRoster, ctx))
   │        try/catch：LLM 瞬时错误 → emit fix:skip 继续下一页（不中止）
   │        !result.proceed → emit fix:skip(reason) 继续
   │        proceed → stampSystemFrontmatter → createChangeset(单页 update)
   │                  → validate（坏链则 emit fix:warn 跳过）→ apply（1 commit/页）
   │                  → emit fix:page
   │
   ├─ 若有任何页内容变更 → enqueueEmbedIndex(subject.id)
   │
   └─ emit fix:complete { fixed, skipped, failed, byType }
        return summary（写入 job.resultJson）
   ▼
前端：useJobStream done → invalidate ['lint-latest', ...] + ['pages']
      → 展示结果摘要 banner → 自动 runLint() 闭环刷新 findings 列表
```

### 新增 / 改动文件

| 文件 | 改动 |
|------|------|
| `src/lib/contracts.ts` | `Job.type` 联合加 `'fix'` |
| `src/server/llm/config-schema.ts` | `BUILTIN_LLM_TASKS` 加 `'fix'`（task-router 缺配也回落 defaults，但加入枚举使 `'fix'` 成为合法 `LLMTask` 字面量） |
| `src/server/llm/prompts/fix-prompt.ts` | 🆕 `FixPageSchema` + `FIX_SYSTEM_PROMPT` + `buildFixPageUserPrompt(doc, findings, slugRoster, ctx)`，注入 `PromptContext` 语言指令 + 本 subject 合法页名册（title/slug，供 broken-link 重链只指向真实页） |
| `src/server/services/fix-deterministic.ts` | 🆕 纯函数：`fixMissingFrontmatter(doc, now)` + `partitionFindings(findings)` 分桶 + `buildFixWorklist(deterministic, semantic)` 合并去重 |
| `src/server/services/fix-service.ts` | 🆕 `registerHandler('fix', runFixJob)`，编排上述两阶段 + emit |
| `src/server/worker-entry.ts` | import `'./services/fix-service'` |
| `src/app/api/fix/route.ts` | 🆕 `POST`：auth + csrf + resolveSubject(required) → enqueue → 202 |
| `src/components/health/health-view.tsx` | 加 "Fix issues" 按钮（`Wrench` 图标）+ useJobStream + 完成后摘要 banner + 自动 runLint 刷新 |
| 前端 SSE 事件标签处 | 注册 `fix:*` 事件文案（与 `lint:*` / `curate:*` 同处） |

### `FixPageSchema`（结构化输出契约）

```ts
const FixPageSchema = z.object({
  proceed: z.boolean(),          // 是否有把握修复本页 findings
  reason: z.string(),            // proceed=false 时说明为何放弃；true 时简述改了什么
  body: z.string(),              // 修复后的完整正文（忠实：只动 findings 要求处，其余逐字保留）
  summary: z.string().optional() // 可选：若修复显著改变要点，更新摘要
});
```

> 只输出 `body`（+可选 `summary`）；title/slug/created/updated 由系统 `stampSystemFrontmatter` 主理，LLM 不碰。

---

## 四、UX

- "Fix issues" 按钮放在 header 操作区，Re-run 与 Tidy structure 之间，`Wrench` 图标。
- **禁用条件**：`allSubjects`（仅单 subject）/ `neverRun`（从未体检）/ `total === 0`（无 findings）/ 正在 lint 或 curate 或 fix 运行中。
- 运行中显示 `latestMessage`（SSE 进度文案）。
- 完成后：展示结果摘要 banner（`已修复 N · 跳过 M（需人工）· 失败 K`），invalidate `['lint-latest', scope]` + `['pages']`，并**自动调 `runLint()`** 重跑体检以刷新 findings 列表（闭环：用户立即看到修复后的真实状态）。

> 自动重跑 lint 复用现有 `runLint()`，无新增网络面。

---

## 五、SSE 事件

| 事件 | 时机 | data |
|------|------|------|
| `fix:start` | 任务开始 | `{ deterministic, semantic }`（两类计数） |
| `fix:deterministic` | 确定性阶段提交后 | `{ fixed }` |
| `fix:page` | 单页 LLM 修复提交成功 | `{ slug, types }` |
| `fix:skip` | 单条/单页跳过（finding 失效 / LLM no-go / LLM 错误） | `{ slug, reason }` |
| `fix:warn` | 单页改动校验失败（如引入坏链）被丢弃 | `{ slug, errors }` |
| `fix:complete` | 任务结束 | `{ fixed, skipped, failed, byType }` |

`job:started` / `job:completed` / `job:failed` 由 `worker.ts` 自动发。

---

## 六、边界与错误处理

- **从未跑过 lint**：按钮禁用（`neverRun`），不会进入 job。
- **快照陈旧**：确定性类重扫保证当前；语义类逐页动手前重读 doc + 重校验 finding 是否仍适用，失效则 skip。
- **LLM 瞬时错误**：单页 try/catch → `fix:skip` 继续其余页，不中止整个 job（仿 curate FIX 2）。
- **LLM 引入坏链**：`validateChangeset` 拦截 → `fix:warn` 跳过该页，vault 不被污染。
- **并发**：worker 单实例串行 + `vault-mutex` 双保险（与所有写任务一致）。
- **历史/回滚**：每个 commit 进 `operations`，⑥ 历史按 job type `fix` 展示，可逐条 revert。

---

## 七、测试策略

纯函数单测（vitest，放 `src/server/services/__tests__/`）：

1. `fixMissingFrontmatter`：补齐各缺失字段为正确默认（title→slug 派生、tags/sources→`[]`、时间戳→传入 now）；已合法则返回原内容（幂等）；不改动正文 body。
2. `partitionFindings`：7 类正确分入 `{ frontmatterFixes, llmFindings, ignored }` 三桶。
3. `buildFixWorklist`：确定性新鲜结果 ∪ 快照语义、按 `(type, pageSlug)` 去重。

LLM 阶段不做端到端单测（沿用项目惯例，结构化输出契约由 schema 保证）。

---

## 八、对既有约定的遵守

- 写接口走 `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest(required)`，长任务只入队（`src/app/CLAUDE.md`）。
- 所有 vault 写入经 Saga：`createChangeset → validateChangeset → applyChangeset`，subject 贯通到底（`src/server/wiki/CLAUDE.md`）。
- LLM 输出用 `generateStructuredOutput('fix', ...)` + zod schema，禁止直出 markdown 文件；prompt 经 `PromptContext` 注入语言指令（slug/wikilink/frontmatter key 禁翻译）。
- 复用 `frontmatter.ts` / `wiki-store.ts` / `wiki-transaction.ts` / `embedding-service.ts`，不复刻。
- 客户端数据请求走 `useApiFetch()`，POST body 显式带 `subjectId`。

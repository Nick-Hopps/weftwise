[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **services**

# `src/server/services/` — 长任务处理器

## 模块职责

把 "queue 任务类型" 绑定到实际的业务编排（LLM 调用 → changeset → git）。**每个文件都是 side-effect import**：在 `worker-entry.ts` 顶部被引用一次即完成 `registerHandler` 注册。

## 入口与启动

```
worker-entry.ts
  ├── import './services/ingest-service';   // register 'ingest'
  ├── import './services/lint-service';     // register 'lint'
  └── import './services/query-service';    // register 'save-to-wiki'
```

## 对外接口（Handlers 概览）

### `ingest-service.ts` — 任务类型 `'ingest'`

> **强校验** `params.subjectId`（缺失直接 fail job）。所有页面的 `existingPages` / `titleMap` 都仅取自该 subject。

多阶段 LLM 工作流：

1. 读 `sources/*` 原始文件 → `parseSourceAsync`（md/html/pdf 分发）。
2. **Plan 阶段**：`generateStructuredOutput('ingest', IngestPlanSchema, PLAN_SYSTEM_PROMPT, ...)` 产生页面清单；prompt header 注入当前 SubjectContext + "默认不跨主题链接"指引。
3. **Page Body 阶段**：对每个 plan 条目生成 markdown 正文（`PageBodySchema`），写入 `vault/wiki/<subject>/<slug>.md`。
4. **Index 阶段**：更新/创建该 subject 的 `index.md`（每 subject 独立一份，`tags: [meta]`）。
5. 构造 `ChangesetEntry[]`：frontmatter + body 组装为完整文件。
6. `createChangeset(jobId, subject, entries)` → `validateChangeset` → `applyChangeset`（内部走 Saga）。
7. 维护该 subject 的 `log.md`（追加日志条目，保留已有 frontmatter）。

关键常量：`SOURCE_TEXT_LIMIT = 30_000`（传给 LLM 的最大字符数）。

返回值类型 `IngestResult`：`{ pagesCreated, pagesUpdated, linksAdded, commitSha }`。

### `query-service.ts` — 任务类型 `'save-to-wiki'` + 同步函数

- 同步函数 `answerQuery(question, subjectId, currentPageSlug?)`：
  1. FTS5 搜 top 5 相关 page（限定 subject）；
  2. 组装上下文 → `generateStructuredOutput('query', QueryResponseSchema, ...)`，prompt 注入 SubjectContext；
  3. 返回 `QueryResult { answer, citations, savedAsPage: null }`。
- 任务 `save-to-wiki`：同时支持 `params.subjectId`（来自 body）与 `job.subjectId`（来自 enqueue），走 changeset 写入对应 subject。

`NO_QUERY_CONTEXT_ANSWER` 常量 —— 该 subject 知识库为空时的兜底回答。

### `lint-service.ts` — 任务类型 `'lint'`

扫 pages + links → 调 LLM 产出 `LintFinding[]`，写回 `result_json` 供前端展示。分类：
`broken-link` / `orphan` / `missing-frontmatter` / `stale-source` / `contradiction` / `missing-crossref` / `coverage-gap`（见 `contracts.ts`）。

> 默认 **subject-scoped**（`params.subjectId` 必填）；`{ allSubjects: true }` 显式触发全量。deterministic 与 semantic 两阶段都按 subjectId 扫描。

## 关键依赖与配置

- 上游：`jobs/worker` (registerHandler)、`jobs/queue` (requeue 等)、`jobs/events` (emit)
- 下游：`wiki/wiki-transaction`、`wiki/wiki-store`、`wiki/markdown`、`sources/*`、`llm/provider-registry`、`llm/prompts/*`

## 扩展指南

- **新增服务**：
  1. `src/lib/contracts.ts::Job.type` 联合加新字面量；
  2. 新建 `src/server/services/<name>-service.ts`；
  3. 顶部 `registerHandler('<name>', async (job, emit) => {...})`；
  4. **强校验 `job.subjectId`**（除非显式是全局型任务），通过 `subjectsRepo.getById(job.subjectId)` 解析为 Subject；
  5. 在 `worker-entry.ts` import 新文件；
  6. Route Handler 里：先 `resolveSubjectFromRequest(request, { required: true, body })` → `queue.enqueue('<name>', subject.id, params)`。

- **emit 事件规范**（供前端 SSE 消费）：
  - `job:started` / `job:completed` / `job:failed` / `job:retrying` 由 `worker.ts` 自动发射。
  - Service 内的业务事件建议命名 `ingest:planning` / `ingest:writing-page` / `ingest:committing` 等，便于前端 UX 映射。

## 测试与质量

- 当前零测试。优先级：
  - `query-service.answerQuery` 在"库为空 / 命中 0 条 / 命中多条"的不同分支；
  - `ingest-service.buildLogContent` round-trip；
  - Saga 失败时 emit 的顺序与最终 job.status 一致。

## 常见问题 (FAQ)

- **两个 ingest 任务能并发吗？**
  不能。`worker.ts::isProcessing` 串行 + `vault-mutex.ts` 双保险。
- **LLM 生成了无效 wikilink 怎么办？**
  `validateChangeset` 会捕获（通过 `extractWikiLinks` 再次解析）；失败则整个 changeset 被拒绝。
- **如何调试 ingest 失败？**
  1. 查 `jobs` 表 `status='failed'` 的记录；
  2. 查对应 `job_events` 表里的 `data_json`（含 `finishReason`、`usage`、`cause`）；
  3. 查 worker 控制台日志（`[LLM][Task: ingest][Model: ...] failed after ...`）。

## 相关文件清单

```
src/server/services/
├── ingest-service.ts   # 多阶段 LLM 摄入
├── query-service.ts    # 问答 + save-to-wiki
└── lint-service.ts     # 全库 lint 扫描
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |
| 2026-04-25 | Subject：三类 service 强校验 subjectId / prompt 注入 SubjectContext / lint 默认 subject-scoped |

---

_生成时间：2026-04-22 00:25:29_

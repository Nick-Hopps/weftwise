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

> **强校验** `params.subjectId`（缺失直接 fail job）。所有页面的 `existingPages` / `titleMap` 都仅取自该 subject（实读 pagesRepo，不再截断）。

预清洗 → 切块 → 预算预检（超 `agentMaxTokensPerJob` 则启动前 fail-fast）→ 自适应流水线（≤25k token 走 inline；超过则先 map 逐块摘要）；planner 标注 `sourceRefs`，orchestrator 按其注入 `relevantChunks` 给 writer；常量在 `ingest-prep.ts`。

调用 `runPipeline(...)` 执行 **4 个内容 skill 阶段**（全部结构化输出、无写盘工具，只往 `ctx.pending` 暂存），随后由 service 层 `finalizeIngest` 收口提交：

1. **`ingest-planner`**（sequence）：读原始源文件，产出页面变更计划（`ChangesetEntry[]` 骨架）。
2. **`ingest-writer`**（fanout × N pages）：对每个 plan 条目生成忠实层散文（与源文忠实对应的 markdown 正文，不含 callout）与 frontmatter。`checkpointAs: 'writer-page'`。
3. **`ingest-enricher`**（fanout × N pages）：读取 writer 产出（injectPriorPageAs），叠加 `[!type]` callout 增益层（intuition / example / quiz / background / diagram / pitfall 六类）。**结构化输出（`generateObject`），无 tools**。`checkpointAs: 'enricher-page'`。
4. **verify（`kind:'verify'` step → `agents/runtime/verify-page.ts::runPageVerification`，fanout × N pages）**：读取 enricher 产出（injectPriorPageAs:'content'），**P3 确定性两段式联网核查**——triage（`ingest-verifier-triage` 挑存疑 callout 断言+query）→ 编排层 Tavily 搜索（去重+上限3+`Promise.allSettled`）→ apply（`ingest-verifier-apply` 证据驱动改 callout）。全程 `generateObject` 无 tools。降级：未配置/triage 空/零证据 → 既有 `ingest-verifier`(v2) 自检 或 passthrough。被引用 URL 经编排层确定性追加进页 frontmatter `sources` + 累积进 `ctx.citedSources`。`checkpointAs: 'verifier-page'`。搜索后端配置在全局设置（`settings-repo::getWebSearchConfig`），未配置时整段退化为 P2 自检。

**finalize（`finalizeIngest`，service 层，非 agent）**：
- `runSingle('ingest-indexer')`：**无 tools 结构化输出**，输入全 subject 页清单（existing ∪ plan，排除 index/log meta）+ 现有 index/log 全文，产出 `{ indexMd, logMd }`（不接触页正文）。
- ⑨ 提交前若 `ctx.citedSources` 非空：一次性 `extractContent(全部 url)`（失败回落 snippet）→ 纯函数 `buildWebSourceImports`（`saveSource` 包 `saveRawSource`，单源失败跳过）→ 把网页源 `{ links, extraStagePaths }` 作 `commitPending` 第三参（`saveRawSource` 导入 source 实体；`extraStagePaths`=raw 文件+sidecar 进同一 commit；`links`→`page_sources`）。导出纯函数 `filenameFromUrl` / `buildWebSourceImports`。
- `commitPending(ctx, [index.md, log.md], webSources?)`：把 `ctx.pending`（全部内容页）∪ index/log（∪ 网页源文件）一次性原子提交（`createChangeset → validate → fs → SQLite → git`）。

> **2026-06-21**：原第五阶段 tool-using `ingest-reviewer` 在 packyapi openai-compatible 转译下工具死循环（反复读 index/log 不消费、永不 commit → 撞 maxSteps），已删除；改为上述 `ingest-indexer`（无 tools）+ service 层 `commitPending`。

各内容阶段（2→3→4）通过 orchestrator `ctx.pending` last-write-wins upsert 传递：后阶段按 path 覆盖前阶段暂存页。预算预检使用 `CONTENT_STAGE_FACTOR=3`（三轮内容阶段）估算 token 消耗；`DEFAULT_AGENT_MAX_TOKENS_PER_JOB` 由 500k 提升至 1.2M。

旧的多阶段 LLM 直调（`generateStructuredOutput` plan → pageBody → index）与 `buildLogContent` helper 均已移除，详见 `src/server/agents/CLAUDE.md`。

接入断点续传：启动时 `loadCheckpoint(job.id)` 载入检查点句柄并挂至 `AgentContext.checkpoint`；若 `ckpt.hasAny()` 则 emit `ingest:resuming`；steps 标注 `checkpointAs` 使 orchestrator 逐页续传；预算预检调 `reduceCostForResume(ingest-prep)` 按已写页比例折减估算值；pipeline 成功返回前 `checkpoint.clear()` 删除所有检查点行。

### `query-service.ts` — 任务类型 `'save-to-wiki'` + 同步函数 + 多轮记忆 + 混合检索

- 同步函数 `prepareQueryContext(query, subjectId)`（⑧ 改 async）：
  1. 若配置了 embedding 则 FTS5 + 向量语义两路（`hybridRankSlugs`，RRF 合并）；否则纯 FTS5。
  2. 返回 top K 相关页面摘要。
- 同步函数 `answerQuery(question, subjectId, currentPageSlug?, history?)`：
  1. 调 `prepareQueryContext` 获取检索结果；
  2. 组装上下文 + 可选历史记录 → `generateStructuredOutput('query', QueryResponseSchema, ...)`，prompt 注入 SubjectContext；
  3. 返回 `QueryResult { answer, citations, savedAsPage: null }`。
  - `history` 可选参数：`{ role: 'user'|'assistant', content }[]`，非空时注入 buildQueryUserPrompt 的 transcript 段。
- 任务 `save-to-wiki`：同时支持 `params.subjectId`（来自 body）与 `job.subjectId`（来自 enqueue），走 changeset 写入对应 subject。
- 流式分支 `streamQueryAnswer(...)` 新增 `history` 可选参透传。

`NO_QUERY_CONTEXT_ANSWER` 常量 —— 该 subject 知识库为空时的兜底回答。

### `lint-service.ts` — 任务类型 `'lint'`

扫 pages + links → 调 LLM 产出 `LintFinding[]`，写回 `result_json` 供前端展示。分类：
`broken-link` / `orphan` / `missing-frontmatter` / `stale-source` / `contradiction` / `missing-crossref` / `coverage-gap`（见 `contracts.ts`）。

> 默认 **subject-scoped**（`params.subjectId` 必填）；`{ allSubjects: true }` 显式触发全量。deterministic 与 semantic 两阶段都按 subjectId 扫描。

### `merge-service.ts` — 任务类型 `'merge'`

把 source 页合并进 target 页（A 存活）。`params { targetSlug, sourceSlug, subjectId }`。流程：读 A/B 两页 → 单次 `generateStructuredOutput('merge', MergeResultSchema, …)` 产 `{ mergedBody, mergedSummary }` → 确定性拼装 A 新 frontmatter（保 A title/created、`tags`/`sources` 并集、summary 用 LLM、updated=now via `stampSystemFrontmatter`）→ `repointLinksToPage` 把合并体自身 + 本 subject 内所有指向 B 的 backlink 源页（排除 A/B 自身）重链到 A → 单 `createChangeset` `[update A, delete B, ...update 引用页]` → validate → apply（删 B 时 wiki_links/page_sources 级联自动清）。发 `merge:start` / `merge:complete`。跨 subject 指向 B 的引用不重链（单事务约束）。

### `split-service.ts` — 任务类型 `'split'`

把源页 A 拆成 N 个独立新页（A 删除）。`params { sourceSlug, hint?, subjectId }`。流程：读 A → 单次 `generateStructuredOutput('split', SplitResultSchema, …)` 产 `{ pages: [{title,body,summary,isPrimary}] }`（`.min(2)`，<2 抛错）→ `wiki/split-plan.ts::planSplitPages` 服务端派生唯一 slug（冲突加后缀、排除 A.slug）+ 兜底恰一 primary → 每新页确定性拼装 frontmatter（title/body/summary 用 LLM、`tags`/`sources`/`created` 继承 A、updated=now）且正文经 `repointLinksToPage` 把指向 A 的自引用重指主页 → 单 `createChangeset` `[create×N, delete A, ...update 本 subject backlink 源页（重指主页，排除 A）]` → validate → apply。发 `split:start` / `split:complete`（result 含 `primarySlug`，供前端跳主页）。跨 subject 指向 A 的引用不重指。

### `embedding-service.ts` 🆕 — 任务类型 `'embed-index'`

向量嵌入索引脱离 Saga（⑧）。`params { subjectId }`；若未配置 embedding 则 no-op。

- **回填缺/过期页**：按 `content_hash + model` 判定（hash 变 / model 更新 / 首次生成），调 `generateEmbeddings` 逐页嵌入（按 content 前 8000 token 截断），写 `page_embeddings` upsert。
- **清理孤儿**：对比 live page slugs，删除孤儿向量（如 page 被删）。
- 入队接口：`enqueueEmbedIndex(subjectId): Job`（返回 job）。
- 触发时机：
  - 写操作后 enqueue（ingest finalize / merge / split / 页面编辑 PUT/DELETE）。
  - worker 启动时对每个 subject 自愈检查。

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

- 当前零测试（services 层）。优先级：
  - `query-service.answerQuery` 在"库为空 / 命中 0 条 / 命中多条"的不同分支；
  - Saga 失败时 emit 的顺序与最终 job.status 一致；
  - ingest pipeline 测试见 `src/server/agents/runtime/__tests__/`。

## 常见问题 (FAQ)

- **两个 ingest 任务能并发吗？**
  不能。`worker.ts::isProcessing` 串行 + `vault-mutex.ts` 双保险。
- **LLM 生成了无效 wikilink 怎么办？**
  `validateChangeset` 会捕获（通过 `extractWikiLinks` 再次解析）；失败则整个 changeset 被拒绝。
- **如何调试 ingest 失败？**
  1. 查 `jobs` 表 `status='failed'` 的记录；
  2. 查对应 `job_events` 表里的 `data_json`（含 `finishReason`、`usage`、`cause`）；
  3. 查 worker 控制台日志；ingest pipeline 详细 step 事件在 SSE `agent:step-*` 事件流中。

## 相关文件清单

```
src/server/services/
├── ingest-service.ts   # 多阶段 LLM 摄入（分片自适应流水线）
├── ingest-prep.ts      # 预检/预算/常量纯函数
├── query-service.ts    # 问答 + save-to-wiki + 多轮记忆 + 混合检索（⑧）
├── conversation-title.ts # 🆕 确定性会话标题派生纯函数
├── lint-service.ts     # 全库 lint 扫描
├── merge-service.ts    # 合并两页（LLM 融合 + 删源页 + 同事务重链）
├── split-service.ts    # 拆分一页（LLM 拆 N 页 + 删源页 + 同事务重指主页）
└── embedding-service.ts # 🆕 向量嵌入索引（embed-index 任务，Saga 外独立）（⑧）
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |
| 2026-04-25 | Subject：三类 service 强校验 subjectId / prompt 注入 SubjectContext / lint 默认 subject-scoped |
| 2026-04-27 | ingest-service 切换为 multi-agent runtime；旧多阶段 LLM 直调与 buildLogContent helper 移除 |
| 2026-06-20 | ingest-service 接入断点续传（loadCheckpoint / steps checkpointAs / reduceCostForResume 预检折减 / emit ingest:resuming / 成功 clear）|
| 2026-06-20 | ingest 流水线扩展为 5 阶段：新增 enricher（callout 增益层）+ verifier（参数化自检，P2），均为结构化输出无 tools；CONTENT_STAGE_FACTOR=3 预算估算 + DEFAULT_AGENT_MAX_TOKENS_PER_JOB 500k→1.2M |
| 2026-06-22 | 新增 `merge-service`（任务类型 `merge`）：LLM 融合两页 + 删源页 + 同事务重链（④b）|
| 2026-06-22 | 新增 `split-service`（任务类型 `split`）：LLM 拆 N 页 + 删源页 + 同事务重指主页（④c）|
| 2026-06-22 | ingest 增量合并：writer fanout step 加 `injectExistingPageForUpdate:true`，更新已有页时 orchestrator 注入现有正文，writer 并入新材料而非整页覆盖（⑤）|
| 2026-06-22 | query-service 多轮记忆：answerQuery/streamQueryAnswer 加 history 参（注入 transcript），conversations-repo CRUD 落库多轮；新增 conversation-title.ts deriveConversationTitle 确定性派生（⑦）|
| 2026-06-22 | 新增 `embedding-service`（任务类型 `embed-index`）：向量嵌入回填/清理（content_hash+model 判过期，FK CASCADE，未配置 no-op）；query-service prepareQueryContext 改 async 走 hybridRankSlugs（RRF 合并 FTS+向量）；写操作后 enqueue（⑧）|
| 2026-06-22 | ingest verifier 阶段→ P3 联网核查（⑨）：steps 第4步改 `verify` step kind（`verify-page.ts::runPageVerification` 两段式 triage→Tavily→apply，全程无 tools）；`finalizeIngest` 把 `ctx.citedSources` 经 `extractContent`+`buildWebSourceImports`+`saveRawSource` 导入为 source，作 `commitPending` 第三参随同一 commit 落地；`MIN_SKILL_VERSIONS` 加 triage/apply；未配置 web 搜索退化为 P2 自检 |

---

_生成时间：2026-04-22 00:25:29_

[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **services**

# `src/server/services/` — 长任务处理器

## 模块职责

把 "queue 任务类型" 绑定到实际的业务编排（LLM 调用 → changeset → git）。**每个文件都是 side-effect import**：在 `worker-entry.ts` 顶部被引用一次即完成 `registerHandler` 注册。

## 入口与启动

```
worker-entry.ts
  ├── import './services/ingest-service';    // register 'ingest'
  ├── import './services/lint-service';      // register 'lint'
  ├── import './services/query-service';     // register 'save-to-wiki'
  ├── import './services/curate-service';   // register 'curate'
  └── import './services/reenrich-service'; // register 're-enrich'
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

### `query-service.ts` — 任务类型 `'save-to-wiki'` + agentic 工具循环 + 多轮记忆

问答检索改为**模型自驱工具循环**（取代旧的预先 top-5 检索喂模型方案）：

- `streamAgenticQuery(opts)` — 流式 agentic 问答：
  1. 调 `createAccessedPages()` 创建访问页收集器；
  2. 调 `buildQueryTools(subject, accessed)` 获取 subject-scoped 三工具（`list_pages` / `search_wiki` / `read_page`，来自 `query-tools.ts`）；
  3. 用 `streamTextWithTools('query', { system, messages, tools, maxSteps: QUERY_MAX_STEPS })` 驱动工具循环；
  4. 返回 `{ stream, accessed }`（`accessed` 供事后 `accessedToContext` 生成引用上下文）。
- `runQuery(question, subject, currentPageSlug?)` — 非流式 agentic 问答：
  1. 调 `subjectHasContent(subject.id)` 空 subject 短路守卫；空库直接返回 `NO_QUERY_CONTEXT_ANSWER`；
  2. 同样走 `generateTextWithTools` 工具循环；
  3. 引用由 `generateQueryCitations` 从 `accessedToContext(subject, accessed)` 取页生成。
- `generateQueryCitations(question, fullAnswer, context, subject)` — 对已有答案与访问页上下文做二次结构化输出，产出 `{ pageSlug, excerpt }[]` 引用列表；
- 任务 `save-to-wiki`：同时支持 `params.subjectId`（来自 body）与 `job.subjectId`（来自 enqueue），走 changeset 写入对应 subject。

`NO_QUERY_CONTEXT_ANSWER` 常量 —— 空 subject 短路时的兜底回答。
`QUERY_MAX_STEPS = 6` 常量 —— 工具循环最大步数，防 runaway。

**`query-tools.ts`**（新增）— subject-scoped 工具定义：
- `buildQueryTools(subject, accessed)` — 构造三工具：`list_pages`（枚举本 subject 全部页标题/slug）、`search_wiki`（FTS5 全文检索）、`read_page`（读单页正文，命中则写入 `accessed`）；工具 execute 失败返回 `{ error }` 字符串而非抛出，防止中断循环。
- `createAccessedPages()` — 创建 `AccessedPages` 收集器（`add`/`getAll`）。
- `accessedToContext(subject, accessed)` — 把已访问页转为 `QueryContextPage[]` 供引用生成。
- `subjectHasContent(subjectId)` — 确定性检查：`pagesRepo.countPages(subjectId) > 0`；空 subject 时短路，消灭"宏观问题报不存在文档"误报。

### `lint-service.ts` — 任务类型 `'lint'`

扫 pages + links → 调 LLM 产出 `LintFinding[]`，写回 `result_json` 供前端展示。分类：
`broken-link` / `orphan` / `missing-frontmatter` / `stale-source` / `contradiction` / `missing-crossref` / `coverage-gap`（见 `contracts.ts`）。

> 默认 **subject-scoped**（`params.subjectId` 必填）；`{ allSubjects: true }` 显式触发全量。deterministic 与 semantic 两阶段都按 subjectId 扫描。

### `curate-service.ts` 🆕 — 任务类型 `'curate'`

Agent 驱动的 subject 结构策展（merge/split 内化）。`params { subjectId, scope: 'subject'|'pages', touchedSlugs? }`。

**流程（三阶段）**：

1. **triage**：读取本 subject 全量页面元数据（title/summary/tags/slug），单次 `generateStructuredOutput('curate', CurateTriageSchema)` 产出候选 merge 对（A+B）+ 候选 split 页清单，附理由。
2. **confirm（逐候选）**：读取候选页完整正文，对 merge 候选调 `generateStructuredOutput('curate', CurateMergeConfirmSchema)`，对 split 候选调 `generateStructuredOutput('curate', CurateSplitConfirmSchema)`，产出 go/no-go 决策（no-go 发 `curate:skip` 带理由）。
3. **execute（逐候选）**：go 的候选复用 `wiki/page-ops.ts::executePageMerge` / `executePageSplit`（不含 emit / embed enqueue —— curate-service 自持）；执行失败单候选发 `curate:warn` 并继续其余候选，不中止整体任务。

**护栏**：
- `applyDecisionCaps`：merge≤5 / split≤5，超出截断并警告。
- `scope:'pages'`（auto，由 ingest finalize 在 `agentAutoCurate=true` 时自动入队）：执行阶段每个候选必须至少涉及一个 `touchedSlugs` 中的页（`restrictToSeed`），否则跳过；防止自动策展无边界扩散。
- `scope:'subject'`（manual，Health 页 "Tidy structure" 按钮）：整个 subject 无 seed 过滤。

**事件**：`curate:start` / `curate:plan`（triage 结果）/ `curate:merge`（merge 执行成功）/ `curate:split`（split 执行成功）/ `curate:skip`（confirm no-go）/ `curate:warn`（执行失败）/ `curate:complete`。

> merge/split 的 LLM 调用与 Saga 执行已抽取至 `wiki/page-ops.ts`，curate-service 与未来其他调用方均可复用；curate-service 自己只负责编排与 emit。

### `fix-service.ts` 🆕 — 任务类型 `'fix'`

一键修复 lint findings。`params { subjectId }`。

**工作清单构建**（`buildFixWorklist`，纯函数 `fix-deterministic.ts`）：
- **确定性 findings**：调 `runDeterministicChecksForSubject(subjectId)`（新鲜重扫，不依赖快照），取 `missing-frontmatter` + `broken-link` 类型。
- **语义 findings**：调 `selectLatestFindings(subjectId)`（最近 completed lint 快照），取 `missing-crossref` + `contradiction` 类型。
- `orphan` / `stale-source` / `coverage-gap` 不在修复范围。

**流程（两阶段）**：

1. **阶段1（确定性补 frontmatter）**：`fixMissingFrontmatter(slug, doc, now)` 纯函数批量填补缺失 frontmatter 字段（title/summary/tags/created），一次 Saga commit 提交所有受影响页（1 commit）。broken-link 在此阶段跳过（需 LLM 判断语义意图）。
2. **阶段2（LLM 逐页修复）**：对剩余 findings 按页分组（broken-link / missing-crossref / contradiction），逐页调 `generateStructuredOutput('fix', FixPageSchema, ...)`：
   - `FixPageSchema.proceed`（自我门控）：LLM 判断本页不值得修复时跳过，发 `fix:skip` 带理由。
   - 修复结果经 `validateChangeset` 校验（拦截新引入的坏链），校验失败发 `fix:warn` 跳过该页。
   - 每页成功修复独立 1 commit（粒度可回滚）。

**事件**：`fix:start` / `fix:deterministic` / `fix:page`（单页 LLM 修复成功）/ `fix:skip`（页面不存在 / LLM no-go / LLM 错误）/ `fix:warn`（校验失败或护栏拦截，计入 failed）/ `fix:complete`。

完成后 UI 自动重跑 lint（`health-view` 在 job completed 事件后触发）。

### `reenrich-service.ts` 🆕 — 任务类型 `'re-enrich'`

手动重新增益：复用 ingest 增益流水线（enricher → verify），跳过 writer——现有页正文即忠实层，直接当 draft；`commitPending` 收口提交（不重写 index/log）。即便 subject `augmentationLevel` 为 `off` 也强制按 `standard` 跑（用户显式触发语义）。

emit `reenrich:start` 后进入 pipeline；流水线完成后 `checkpoint.clear()`，返回 commit result。需要 `ingest-enricher v2` / `ingest-verifier v2` / `ingest-verifier-triage v1` / `ingest-verifier-apply v1`（不满足则 fail-fast 提示删除旧 skill 文件重播种）。

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
- **复用 merge/split 执行逻辑**：不要在新 service 里重复 LLM+Saga 逻辑；调用 `wiki/page-ops.ts::executePageMerge` / `executePageSplit`（无 emit/enqueue，由调用方自行发事件/入队 embed）。

- **emit 事件规范**（供前端 SSE 消费）：
  - `job:started` / `job:completed` / `job:failed` / `job:retrying` 由 `worker.ts` 自动发射。
  - Service 内的业务事件建议命名 `ingest:planning` / `ingest:writing-page` / `ingest:committing` 等，便于前端 UX 映射。

## 测试与质量

已覆盖（`__tests__/`，vitest，以纯函数与编排为主）：`lint-deterministic`（broken-link/orphan 取数收敛后行为不变）、`maintenance-policy` / `maintenance-scheduler`、`ingest-prep` / `ingest-service` / `ingest-finalize-sources` / `ingest-augmentation-steps`、`embedding-service`、`fix-deterministic`、`lint-latest`、`reenrich-input` / `reenrich-maturity`、`conversation-title`、`query-tools`（subjectHasContent / buildQueryTools / accessedToContext / 工具 execute 路径）、`query-service-agentic`（streamAgenticQuery / runQuery 空库守卫 / generateQueryCitations 引用验证）。ingest pipeline 另见 `src/server/agents/runtime/__tests__/`。

仍待补充：

- `query-service` agentic 分支在"库为空 / 工具调用失败 / 空答案回落"的不同路径；
- Saga 失败时 emit 的顺序与最终 job.status 一致。

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
├── ingest-service.ts    # 多阶段 LLM 摄入（分片自适应流水线）
├── ingest-prep.ts       # 预检/预算/常量纯函数
├── query-service.ts     # 问答 + save-to-wiki + 多轮记忆（agentic 工具循环）
├── query-tools.ts       # 🆕 subject-scoped 三工具（list_pages/search_wiki/read_page）+ AccessedPages + subjectHasContent
├── conversation-title.ts # 确定性会话标题派生纯函数
├── lint-service.ts      # 全库 lint 扫描
├── curate-service.ts    # 🆕 agent 策展（curate 任务：triage→confirm→execute，复用 page-ops）
├── fix-service.ts       # 🆕 一键修复 lint findings（fix 任务：确定性阶段1 + LLM 阶段2）
├── fix-deterministic.ts # 🆕 纯函数：fixMissingFrontmatter / buildFixWorklist / partitionFindings
├── reenrich-service.ts  # 🆕 手动重新增益（re-enrich 任务：复用增益流水线、跳过 writer）
├── embedding-service.ts # 向量嵌入索引（embed-index 任务，Saga 外独立）（⑧）
├── maintenance-policy.ts # 🆕 纯函数：递减回报间隔策略（SPACING_LADDER / countCallouts / nextMaturity，P5）
└── maintenance-scheduler.ts # 🆕 纯函数：sweep 页面选取（runMaintenanceSweep，P5）
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |
| 2026-04-25 | Subject：三类 service 强校验 subjectId / prompt 注入 SubjectContext / lint 默认 subject-scoped |
| 2026-04-27 | ingest-service 切换为 multi-agent runtime；旧多阶段 LLM 直调与 buildLogContent helper 移除 |
| 2026-06-20 | ingest-service 接入断点续传（loadCheckpoint / steps checkpointAs / reduceCostForResume 预检折减 / emit ingest:resuming / 成功 clear）|
| 2026-06-20 | ingest 流水线扩展为 5 阶段：新增 enricher（callout 增益层）+ verifier（参数化自检，P2），均为结构化输出无 tools；CONTENT_STAGE_FACTOR=3 预算估算 + DEFAULT_AGENT_MAX_TOKENS_PER_JOB 500k→1.2M |
| 2026-06-22 | ingest 增量合并：writer fanout step 加 `injectExistingPageForUpdate:true`，更新已有页时 orchestrator 注入现有正文，writer 并入新材料而非整页覆盖（⑤）|
| 2026-06-22 | query-service 多轮记忆：answerQuery/streamQueryAnswer 加 history 参（注入 transcript），conversations-repo CRUD 落库多轮；新增 conversation-title.ts deriveConversationTitle 确定性派生（⑦）|
| 2026-06-22 | 新增 `embedding-service`（任务类型 `embed-index`）：向量嵌入回填/清理（content_hash+model 判过期，FK CASCADE，未配置 no-op）；query-service prepareQueryContext 改 async 走 hybridRankSlugs（RRF 合并 FTS+向量）；写操作后 enqueue（⑧）|
| 2026-06-22 | ingest verifier 阶段→ P3 联网核查（⑨）：steps 第4步改 `verify` step kind（`verify-page.ts::runPageVerification` 两段式 triage→Tavily→apply，全程无 tools）；`finalizeIngest` 把 `ctx.citedSources` 经 `extractContent`+`buildWebSourceImports`+`saveRawSource` 导入为 source，作 `commitPending` 第三参随同一 commit 落地；`MIN_SKILL_VERSIONS` 加 triage/apply；未配置 web 搜索退化为 P2 自检 |
| 2026-06-23 | 删除 `merge-service`（任务类型 `'merge'`）与 `split-service`（任务类型 `'split'`）；merge/split 执行逻辑内化至 `wiki/page-ops.ts`；新增 `curate-service`（任务类型 `'curate'`：triage→confirm→execute，seed 护栏，caps merge≤5/split≤5）；ingest finalize 在 `agentAutoCurate=true` 时自动入队 curate（scope:'pages', touchedSlugs）|
| 2026-06-23 | 新增 `reenrich-service`（任务类型 `'re-enrich'`）：手动重新增益，复用 ingest 增益流水线（enricher→verify），跳过 writer，commitPending 收口；P4 增益强度（`subjects.augmentation_level`）贯穿服务层（off→standard 降级） |
| 2026-06-24 | 新增 `fix-service`（任务类型 `'fix'`）：两阶段修复 lint findings——阶段1 确定性补 frontmatter（`fix-deterministic.ts` 纯函数，1 commit）；阶段2 按页 `generateStructuredOutput('fix')` 逐页修复（`proceed` 自我门控 + `validateChangeset` 拦坏链，每页 1 commit）；orphan/stale-source/coverage-gap 不修；完成后 UI 自动重跑 lint |
| 2026-06-24 | 性能：`lint-deterministic` 确定性检查一次性取数（`getAllPages` 3→1、跨主题 meta 扫描 2→1，行为不变）；落地 `lint-deterministic` 单测 |
| 2026-06-25 | Ask AI 问答从预先 top-5 检索改为 agentic 工具循环：新增 `query-tools.ts`（`list_pages`/`search_wiki`/`read_page` subject-scoped 三工具 + `AccessedPages` + `subjectHasContent` 空库守卫）；`query-service` 重构为 `streamAgenticQuery`/`runQuery`（均走 `streamTextWithTools`/`generateTextWithTools`）；引用来自 `accessedToContext` 实际访问页；删除旧死代码 `prepareQueryContext`/`streamQueryAnswer`/`QUERY_STREAM_SYSTEM_PROMPT`；新增 `query-tools.test.ts` + `query-service-agentic.test.ts` |

---

_生成时间：2026-04-22 00:25:29_

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
  ├── import './services/curate-service';    // register 'curate'
  ├── import './services/fix-service';       // register 'fix'
  ├── import './services/research-service';  // register 'research'
  ├── import './services/research-import-service'; // register 'research-import'
  └── import './services/reenrich-service';  // register 're-enrich'
```

## 对外接口（Handlers 概览）

### `ingest-service.ts` — 任务类型 `'ingest'`

> **强校验** `params.subjectId`（缺失直接 fail job）。所有页面的 `existingPages` / `titleMap` 都仅取自该 subject（实读 pagesRepo，不再截断）。

预清洗 → 切块 → 预算预检（超 `agentMaxTokensPerJob` 则启动前 fail-fast）→ 自适应流水线（≤25k token 走 inline；超过则先 map 逐块摘要）；planner 标注 `sourceRefs`，orchestrator 按其注入 `relevantChunks` 给 writer；常量在 `ingest-prep.ts`。

调用 `runPipeline(...)` 执行 **4 个内容 skill 阶段**（全部结构化输出、无写盘工具，只往 `ctx.pending` 暂存），随后由 service 层 `finalizeIngest` 收口提交：

1. **`ingest-planner`**（sequence）：读原始源文件，产出页面变更计划（`ChangesetEntry[]` 骨架）。
2. **`ingest-writer`**（fanout × N pages）：对每个 plan 条目生成忠实层散文（与源文忠实对应的 markdown 正文，不含 callout）与 frontmatter。`checkpointAs: 'writer-page'`。
3. **`ingest-enricher`**（fanout × N pages）：读取 writer 产出（injectPriorPageAs），叠加 `[!type]` callout 增益层（intuition / example / quiz / background / diagram / pitfall 六类）。**组合输出（`generateText` + `image.generate` + `finish`）**；生图返回 PNG/JPEG/WebP asset，与页面同一 Saga 提交。`checkpointAs: 'enricher-page'`。
4. **verify（`kind:'verify'` step → `agents/runtime/verify-page.ts::runPageVerification`，fanout × N pages）**：读取 enricher 产出（injectPriorPageAs:'content'），**P3 确定性两段式联网核查**——triage（`ingest-verifier-triage` 挑存疑 callout 断言+query）→ 编排层 Tavily 搜索（去重+上限3+`Promise.allSettled`）→ apply（`ingest-verifier-apply` 证据驱动改 callout）。全程 `generateObject` 无 tools。降级：未配置/triage 空/零证据 → 既有 `ingest-verifier`(v2) 自检 或 passthrough。被引用 URL 经编排层确定性追加进页 frontmatter `sources` + 累积进 `ctx.citedSources`。`checkpointAs: 'verifier-page'`。搜索后端配置在全局设置（`settings-repo::getWebSearchConfig`），未配置时整段退化为 P2 自检。

**finalize（`finalizeIngest`，service 层，非 agent）**：
- **T2.1（2026-07-06）：index/log 不再走 LLM**，改由 `wiki/meta-pages.ts` 纯函数确定性渲染——`renderIndexPage(pages, opts)` 按每页第一个 tag 分组（无 tag 归 Uncategorized/未分类，永远排最后）、组内按标题排序，条目 `[[slug|Title]] — summary`；`renderLogPage(entries, opts)` 保留最近 `MAX_LOG_ENTRIES=50` 条（新条目在前，超出截断），既有条目由 `parseLogEntries` 从现有 `log.md` 正文解析 bullet 行还原，新条目由 `buildIngestLogEntry(sources, pageCount)` 生成。索引覆盖全 subject（existing ∪ 本次 plan 页，排除 index/log meta）；每页 tags 优先取本次实际写入内容（`ctx.pending` 里 writer/enricher/verifier 产物的 frontmatter，经 `pendingPageTags()` 解析），未触碰页沿用 DB 既有 tags。固定文案（分组标题/表头）按 `resolveTemplateLang(wikiLanguage)` 粗略二值化为 zh/en 模板；页面自身的 title/summary 仍是 LLM 按 wikiLanguage 生成的原文，不受此二值化影响。**去掉了一次全 subject 页清单塞进 prompt 的 LLM 调用**，token 消耗不再随页数增长，且 index/log 结构不再受 LLM 遗漏/幻觉影响。
- ⑨ 提交前若 `ctx.citedSources` 非空：一次性 `extractContent(全部 url)`（失败回落 snippet）→ 纯函数 `buildWebSourceImports`（`saveSource` 包 `saveRawSource`，单源失败跳过）→ 把网页源 `{ links, extraStagePaths }` 作 `commitPending` 第三参（`saveRawSource` 导入 source 实体；`extraStagePaths`=raw 文件+sidecar 进同一 commit；`links`→`page_sources`）。导出纯函数 `filenameFromUrl` / `buildWebSourceImports`。
- `commitPending(ctx, [index.md, log.md], webSources?)`：把 `ctx.pending`（全部内容页）∪ index/log（∪ 网页源文件）一次性原子提交（`createChangeset → validate → fs → SQLite → git`）。

> **2026-06-21**：原第五阶段 tool-using `ingest-reviewer` 在 packyapi openai-compatible 转译下工具死循环（反复读 index/log 不消费、永不 commit → 撞 maxSteps），已删除；改为无 tools 的 `ingest-indexer` 结构化输出 + service 层 `commitPending`。
> **2026-07-06（T2.1）**：`ingest-indexer` skill 本身也已移除（`examples/skills/ingest-indexer.md` 已删，`MIN_SKILL_VERSIONS` 去掉该项）——index/log 改为上面的确定性渲染，finalize 阶段不再有任何 LLM 调用。

各内容阶段（2→3→4）通过 orchestrator `ctx.pending` last-write-wins upsert 传递：后阶段按 path 覆盖前阶段暂存页。预算预检使用 `CONTENT_STAGE_FACTOR=3`（三轮内容阶段）估算 token 消耗；`DEFAULT_AGENT_MAX_TOKENS_PER_JOB` 由 500k 提升至 1.2M。

旧的多阶段 LLM 直调（`generateStructuredOutput` plan → pageBody → index）与 `buildLogContent` helper 均已移除，详见 `src/server/agents/CLAUDE.md`。

接入断点续传：启动时 `loadCheckpoint(job.id)` 载入检查点句柄并挂至 `AgentContext.checkpoint`；若 `ckpt.hasAny()` 则 emit `ingest:resuming`；steps 标注 `checkpointAs` 使 orchestrator 逐页续传；预算预检调 `reduceCostForResume(ingest-prep)` 按已写页比例折减估算值；pipeline 成功返回前 `checkpoint.clear()` 删除所有检查点行。

### `query-service.ts` — 任务类型 `'save-to-wiki'` + agentic 工具循环 + 多轮记忆

问答检索改为**模型自驱工具循环**（取代旧的预先 top-5 检索喂模型方案）：

- `streamAgenticQuery(opts)` — 流式 agentic 问答：
  1. 调 `createAccessedPages()` 创建访问页收集器；
  2. 每轮先由 `classifyQueryIntent(question, context)` 通过 `query` 结构化 LLM 一次分类 `read/propose/direct-reenrich/image-insert/reset-*` 和页面目标；服务端按可信当前页、选区与 reset phase 收窄结果，普通失败回退 read、确认失败回退 unclear；
  3. read/propose 都有只读 evidence、History list/diff 与 `workflow.status`，只有 propose 额外获得页面/move/History/workflow PendingAction 工具；`wiki.image.insert` 还需 `imageInsertEnabled` 才进入真实 ToolSet，再由必传 `ToolExecutionPolicy` 编译；
  4. 用 `streamTextWithTools('query', { system, messages, tools, maxSteps: QUERY_MAX_STEPS })` 驱动工具循环；system prompt 按真实 mode/配图能力构造，不描述未下发工具；
  5. 返回 `{ stream, accessed }`（`accessed` 供事后 `accessedToContext` 生成引用上下文）。
- `query-intent::resolveDirectReenrichTarget(intent, currentPageSlug?)` — 只消费结构化分类器返回的 `current-page/slug` 目标，不再解析自然语言；`/api/query` 命中后直接创建 workflow PendingAction，不运行主 Query 工具循环或 coverage。
- `runQuery(question, subject, currentPageSlug?)` — 非流式 agentic 问答：
  1. 始终进入 `generateTextWithTools` 工具循环；active Subject 为空时仍可显式查询其他 Subject；
  2. 引用使用**流后确定性解析**（零 LLM 二次调用）：`extractCitationsFromAnswer(answer, accessed, subject.slug)`（`citation-extract.ts`）。

引用不再靠模型二次结构化输出生成，而是靠 prompt 纪律 + 确定性解析（退役 `generateQueryCitations`/`QueryCitationsSchema`/`[unverified]` 前缀机制）：

- `QUERY_AGENTIC_SYSTEM_PROMPT` 的 CITE INLINE 纪律要求 active Subject 用 `[[slug]]`，其他 Subject 用 `[[subject:slug]]`；两者都必须是本轮 `wiki_read` / `wiki_read_cross_subject` 真正读过的页面；
- `extractCitationsFromAnswer(answer, accessed, subjectSlug)`（`citation-extract.ts`，纯函数）：`extractWikiLinks` 解析答案全文 → 复合页面身份与 `accessed.bodies/crossBodies` 求交集（过滤幻觉链接、错误 Subject 和未读页）→ 按 `subjectSlug + slug` 去重；`pickExcerpt(anchorText, pageBody)` 用词重叠打分在页面正文按句界切出 1-3 句，**恒为页面原文字面子串**；跨主题 citation 额外携带 `subjectSlug`；
- 流式分支（`streamAgenticQuery` + `/api/query`）与 `runQuery` 均在**流结束后**同步调用此解析，聊天 UI 正文内联 `[[slug]]` 由前端渲染层直接渲染成 wikilink，不再需要模型额外产出 citations 数组；
- coverage 判定与引用解析解耦，改为**流后异步 fire-and-forget 小调用**：`assessCoverageInBackground(subject, question, answer)` 只喂问题+答案（不喂 accessed 上下文），走 `CoverageSchema`/`COVERAGE_SYSTEM_PROMPT`/`buildCoverageUserPrompt`（`query-prompt.ts`）判定 `coverageSufficient`；`false` 时经 `recordCoverageGap` best-effort 写入 `research-backlog-repo.create`（source='ask-ai'；`try/catch` 包裹，写入失败/异常只 `console.error` 不影响已返回的问答响应，也不阻塞响应本身）；`done` 事件不再携带 `coverageSufficient`（T3.2 引入时曾同步携带，现已异步化）；
- `resolveQueryTools(mode, { imageInsertEnabled })` — `query:read` 包含当前 Subject 证据工具、跨 Subject 三工具、`history.list/diff`、`workflow.status` 与可选 `web.search`；`query:propose` 额外开放页面、`wiki.move`、History/workflow PendingAction 工具和一个版本的 `wiki.reenrich` alias；`wiki.image.insert` 还需 LLM 分类确认。所有 preview 仍严格绑定 active Subject；
- 任务 `save-to-wiki`：同时支持 `params.subjectId`（来自 body）与 `job.subjectId`（来自 enqueue）；`saveQueryAsPage` 只组装 answer + `## References` 正文和 `query-answer` tag，再调用 `page-write::createPageInSubject(..., { jobId })`，与 `wiki.create` 共用唯一 slug、create plan/apply、Saga 和 embedding 回填。页面 citation 只保留为正文 wikilink，frontmatter `sources` 继续专用于 raw source ID（本路径为空）。若 worker 在 commit 后、job complete 前重试，则按该 job 的 applied operation 恢复唯一 canonical create slug、核对页面仍存在并补 enqueue embedding，不创建后缀重复页。

`NO_QUERY_CONTEXT_ANSWER` 常量 —— 工具循环完成后仍没有可用答案时的兜底回答，coverage 判定可据此写入 backlog。
`QUERY_MAX_STEPS = 8` 常量 —— 为 list → cross-search → cross-read 留出有界调用空间，同时防 runaway。

**`query-tools.ts`**（新增）— subject-scoped 工具上下文，经共享 registry 解析实际 ToolDef：
- `buildQueryToolContext(subject, accessed, options?)` — 默认严格只读并注入 active Subject 的 History list/diff 与脱敏 workflow status；只有传入已校验 conversationId 时才注入页面/move/History/workflow preview 与 `onPendingAction`。预览调用 `pending-action-service`，不会写 vault/index/git、入队或取消 job。
- `createAccessedPages()` — 创建 `AccessedPages` 对象（active 页面 `meta/bodies` + 以 `subjectSlug\0slug` 为键的 `crossMeta/crossBodies` + `sourceRefs`）；跨 Subject 同名 slug 不碰撞，来源正文/excerpt 不进入引用上下文。
- `accessedToContext(subject, accessed)` — 把已访问页转为 `QueryContextPage[]` 供引用生成。

### `pending-action-service.ts` — 持久化写入审批状态机

创建预览时以 strict schema 规范化并哈希服务端 payload，页面/move/History/workflow/TagBatch 均只生成 plan；批准前不创建或取消 job、不写 Vault。Chat action 绑定 conversation，Tags 工作台 action 以 NULL conversation 按 Subject 恢复；TagBatch 使用独立 schema，不扩张 Query 的 `wiki.preview_change` 工具面。选区配图走专用入口：服务端读取 canonical 非 meta 页，把客户端完整块 offset 规范化为原文/prefix/suffix 锚点；Reshape 拒绝。批准时原子 claim、复算 hash 与同一 plan，HEAD 变化会刷新 preview 并要求重新批准；配图会重新定位锚点并原子创建 `image-insert` job。页面、move、TagBatch 与 History 仍走 Saga；workflow start 的 job insert + action applied、workflow cancel 的 job 终止 + action applied 分别在同一 SQLite IMMEDIATE transaction 中提交，失败整体回滚。取消提交后再发送 `job:cancelled` 并 best-effort 对账 Research provenance。`pending_actions.operation` CHECK 同步提供 Drizzle 迁移与启动期原子兼容重建，保留历史行并拒绝未知 operation。该能力复用现有 `query` LLM task，图片生成复用 `ingest:image`，因此 `llm-config.example.json` 无需更新。

### `image-insert-service.ts` — 任务类型 `'image-insert'`

先按 jobId 查 applied operation 做崩溃重试恢复，不重复生图；新执行在生图前后复核 stable HEAD 与块锚点，轮询取消并 abort 模型调用。生成结果只留内存，最终将 stamped 页面 update 与 base64 asset create 放入同一 changeset，以 `expectedPreHead + assertCanApply` 在 vault 锁内复核；取消/验证/apply 失败走 Saga rollback，不留下孤立资产。成功后 best-effort 入队 embedding。图片模型继续复用 `ingest:image`。

### `lint-service.ts` — 任务类型 `'lint'`

扫 pages + links → 调 LLM 产出 `LintFinding[]`，补 subject 上下文与稳定 ID 后写回 `result_json` 供前端展示。九类 finding：
`broken-link` / `orphan` / `missing-frontmatter` / `stale-source` / `contradiction` / `missing-crossref` / `coverage-gap` / `orphan-source` / `thin-page`（见 `contracts.ts`）。

语义阶段的模型输出必须携带 `targetSlug + evidence[{ pageSlug, quote }]`，并由 `lint-semantic-validation.ts` 对当前 vault 做第二次事实校验：逐条 quote 必须是页面原文字面片段；missing-crossref 的 source/target 必须存在且当前确实没有同 Subject wikilink；coverage-gap 的目标页必须不存在且至少有两个独立证据页；contradiction 必须有两个不同页面的精确引文。无法证明的模型输出直接丢弃。调用点固定 `temperature: 0` 降低同输入漂移，但真实性只由上述服务端校验决定。

手动 Health check 使用 `discovery`，执行确定性扫描与开放式语义发现。Fix/Curate 完成后不再创建 lint job：任务内 `verifyJobPostconditions` 已产出 `perFindingOutcomes`，`remediation-status.ts` 在读取原 lint 快照时把 baseline 之后已完成验证的关联 finding 直接移除并重算 severity，真实 fixed/failed/skipped 结果保留在近期摘要；Research 等 provenance run 到达验证终态后执行同样投影。若用户之后手动 discovery 又发现同一 finding，较新的 lint 结果优先并重新展示。`/api/lint` 的显式 `verification` 模式与 `lint-verification.ts` 暂留作旧客户端兼容，不再由 Health UI 调用。

> 默认 **subject-scoped**（`params.subjectId` 必填）；`{ allSubjects: true }` 显式触发全量。deterministic 与 semantic 两阶段都按 subjectId 扫描。

`stale-source` 的缺失/哈希变化规则统一由 `sources/source-staleness.ts::isSourceStale` 提供，lint 与 `wiki.inspect` 共用，避免两份判定漂移。

**事件补充统计**（纯函数 `summarizeFindings`，按 severity/type 计数 + 拼一句可读摘要文本）：`lint:semantic:start` 携带 `pageCount`/`model`（本次将跑语义分析的页数 + 模型标签）；`lint:semantic:done`/`lint:complete` 携带 `bySeverity`/`byType`（`lint:complete` 另带 `totalFindings`），日志文案附带形如 `(2 critical, 3 warning; missing-crossref×2)` 的分类摘要。

### Health remediation Phase 2A — identity、router 与状态闭环

**稳定身份（`finding-identity.ts`）**：确定性 finding 与缺少新字段的历史快照继续使用 `lint-finding:v1 / subjectId / type / pageSlug / sourceId|sourceFilename / 规范化 description`；经验证的新语义 finding 使用 `lint-finding:v2`：missing-crossref 由 source+target、coverage-gap 由 target、contradiction 由排序后的 `pageSlug+quote` 证据确定，不再因 description 改写产生新 ID。tuple 做 SHA-256 后产出 64 位小写 hex。`identifyFindings()` 按计算 ID 去重并保留首次顺序；新旧快照读取都重算身份，不信任持久化 JSON 内的 ID。

**九类纯路由（`remediation-router.ts::routeFinding`）**：router 不读 DB、不入队、不写 Vault，只返回服务端 `RemediationPlan`；新增 finding type 会在穷尽 switch 的 `assertNever` 处暴露遗漏。

| Finding | Workflow | Action / 安全边界 |
|------|------|------|
| `missing-frontmatter` | `fix` | `fix`，确定性补齐 frontmatter |
| `broken-link` | `fix` | `fix`，复用受 Guard 保护的修复工具 |
| `missing-crossref` | `fix` | `fix`，写后继续语义校验 |
| `contradiction` | `fix` | `fix`，必须读取 page/source evidence |
| `orphan` | `curate` | `curate`，只作页面 seed，不提供删除 action |
| `stale-source` | `source-review` | 有 `sourceId` 时只提供 `review-source` 导航，否则 `skipped` |
| `coverage-gap` | `research` | `research`，候选仍需用户确认 |
| `orphan-source` | `re-ingest` | 有 `sourceId` 时提供 `re-ingest`；删除不进入通用 action，仍需专用二次确认 |
| `thin-page` | `research` | 当前零来源薄页走 `research` |

**统一执行（`remediation-service.ts::remediate`）**：只接受 `fix | curate | research | re-ingest`，在创建任务前通过 `queue.listLatestCompletedLint(subjectId)` 单行读取最新 lint，完成 auth/CSRF 后的 CAS 校验、1–100 个稳定 ID 格式与存在性校验、router action 校验及批量全有或全无校验；`POST /api/research` 的 finding 分支复用同一单行读取边界。规范化 `RemediationContext { lintJobId, action, sorted(unique(findingIds)) }` 既是任务 provenance，也是 `subjectId + context` 幂等键；Fix/Curate/Research 的原子 get-or-create 只把同 subject/type 的 pending/running，或 `lintRanAt` 后完成（兼容时间戳缺失）的候选交给 matcher 做精确 context 匹配，不扫描整个 subject 历史。Re-ingest 通过原子 requeue/create helper 保留 failed ingest checkpoint 并合并 context；同一事务先借助受 `json_valid` 保护的 `sourceId + status` 表达式索引读取全部 pending/running，优先复用 exact-context job，否则任取一条 active 阻止新建；只有不存在 active 时才用 `sourceId + createdAt/id` 索引读取最新 terminal，防止新 terminal 遮蔽旧在途任务。

**状态恢复（`remediation-status.ts`）**：`buildHealthSnapshot()` 将当前 lint、router plan、近期 jobs 与 route 批量注入的 `ResearchRunView[]` 合成为 `HealthSnapshot`，自身保持纯函数。`MAX_REMEDIATION_JOBS = 200`；API 先有界取 jobs，再按 subject 批量读取关联 run，避免逐 finding 查询。无 job 使用 router 初始状态；pending/running 为 `queued`。Research run 映射为：`awaiting-approval` 保持待批，`importing/verifying` 为 queued，`dismissed/empty` 为 skipped，`completed/partial/failed` 对 finding run 读取已物化的逐 finding `fixed/residual/unverifiable`，topic run 按整体终态映射；没有持久化 run 的历史 Research job 继续从旧 `resultJson.candidates` 保守回退。Fix / Curate 优先读取 `perFindingOutcomes`。关联处置在当前 lint 快照之后完成自身验证后，无论逐 finding 结果为 fixed/failed/skipped，都从当前 findings 移除并把真实结果写入 `recentOutcomes`；Research 仅在 provenance run 到达验证终态后执行相同投影。更新的手动 lint 可重新发现并展示同一 finding，损坏或缺少验证结果的 completed job 不得误隐藏。

Research finding 的 immutable `snapshot_json` 必须无损覆盖 finding identity 所需字段：除既有 type/page/description/source 外，v2 语义身份还保存可选 `targetSlug + evidence[]`；字段保持可选以兼容旧 v1 snapshot。仓储写入与 view 读取都从 snapshot 重算 finding ID，任一字段漂移继续 fail-closed。

**Fix scope**：`remediationContext` 存在时只从指定、同 subject、completed lint job 解析所选 ID；确定性检查仍新鲜重扫，但只消费 ID 命中的 `missing-frontmatter/broken-link`，语义侧只消费 ID 命中的 `missing-crossref/contradiction`。工具 read/search/inspect/source evidence 保持 subject-wide，`updatePage/patchPage/linkEnsure(source)` 写侧收窄到所选 findings 对应页面。无 context 的旧 `/api/fix` 继续保持全量 Fix 行为。

**Research scope**：finding 分支必须同时携带稳定 `findingIds` 与当前 `lintJobId`；`research-scope.ts::resolveTopicsFromFindingIds()` 精确读取该 subject 的 completed lint 快照，并要求全部 ID 属于可 Research 的 `coverage-gap` 或 `thin-page`，混入其他类型则整体拒绝。topic 分支保持通用手动/Backlog 入口；旧数组下标协议已退役。通过统一 remediation 入口创建的 Research job 同样携带规范化 context，供刷新恢复与状态推导。

### Research approval provenance Phase 2C

`research-service.ts` 完成查询与 triage 后，不再把 job `resultJson.candidates` 当批准事实，而是用稳定 run/candidate ID 持久化候选快照、finding 快照、topics 与 queries；客户端与审批链路只将 job result 的 `runId` 作为权威定位，兼容字段不能参与批准。`research-approval-service.ts` 将存储行严格映射为脱敏 `ResearchRunView`，批准 API 只接受 candidate ID、expectedVersion 与 idempotency key；repo 在单个 `IMMEDIATE` transaction 内 CAS run、写 approval、冻结 selected/rejected decision、建立每候选 delivery 并创建唯一 `research-import` coordinator。

`research-import-service.ts` 只接受 run/approval/subject ID，URL 必须回读服务端候选快照。每条 delivery 用 claim token + lease CAS；抓取后在同一事务重验 token，再完成 source get-or-create、sourceId 回写和 child Ingest 入队。child params 的 `researchProvenance` 由服务端注入，通用 Ingest API 不接受客户端 provenance。`research-provenance-reconciler.ts` 汇总 coordinator/child 终态，物化 source、Ingest job、operation IDs、touched pages、commit SHA 与安全错误；finding run 至少一条导入成功后唯一入队 verification lint，并用 exact finding ID 或稳定 locus 物化 `fixed/residual/unverifiable`。worker 终态 hook、启动扫描和维护 tick 共用同一幂等对账原语，补偿取消与崩溃窗口。工作台手动重试 failed child 时，`research-approval-service::retryResearchIngestJob` 先精确对账，再由 repo 在一个 IMMEDIATE transaction 内恢复同一 job、delivery 与 run；job ID、attempt 与 checkpoint 保留，已取消、source 缺失、lineage 不匹配或 verification 已物化时 fail-closed。

Health 前端刷新时按 subject 读取 active jobs，并可从 queued 或 awaiting-approval plan 的原 Research job ID 恢复 run。Research job 完成后先从 result 提取 `runId`，再 GET 持久化 view；批准只提交 candidate ID，网络结果不确定时 GET 同一 run 对账并保留同一 selection 的幂等键。`importing/verifying` 轮询 run，终态失效 pages、active-jobs 与 lint snapshot。普通关闭不等同 dismiss，显式忽略走独立 API。切换 subject/scope 会同步作废旧请求、候选 view 与幂等键。All Subjects 只构造只读 plans，不允许执行。

### `curate-service.ts` 🆕 — 任务类型 `'curate'`

**Tool-loop 驱动**的 subject 结构策展。`params { scope: 'pages'|'subject'; slugs?: string[]; subjectId }`。

**流程**：

1. 解析 scope + seedSet：`scope:'pages'`（auto）→ seed = params.slugs，再用 `expandScopeWithNeighbors` 扩展本-subject 邻居；`scope:'subject'`（manual）→ 全 subject 非 meta 页，seedSet=null（无 seed 过滤）。
2. 读取 scope 内每页元数据（slug/title/summary/tags/bodyChars，不喂正文——模型用 `wiki.read` 自取）。
3. 令 `allowedSet = seed + 本 subject 一跳邻居`，装配 `createCurateGuard({ seedSet, allowedSet, caps })` + `buildCurateToolContext`，按 mode 解析 profile 后将同一 allowedSet 交给 `ToolExecutionPolicy`：manual 为 read/search/inspect/merge/split/metadata.patch/link.ensure/create/delete；auto 为 read/search/inspect/merge/split/metadata.patch/link.ensure，无 list/create/delete。
4. 调 `generateTextWithTools('curate', { system: CURATE_AGENTIC_SYSTEM_PROMPT, messages, tools, maxSteps: 40 })` 驱动工具循环；模型自驱读页，在已有唯一自然锚点上补/调一个链接或调整 metadata，也可执行既有结构操作；所有写临界区 job-local 串行，guard 鉴权后调 page-ops 内核 + emit 事件。
5. guard.totals() 非零则 enqueue embed-index。
6. 按当前 `jobId + subjectId` 的 applied operations 执行共享确定性后置校验；无 operation 返回 clean，残留或校验异常返回 `completed + residual`，不回滚或重放写入。带 remediation context 时，从其精确 completed lint 快照按稳定 ID 恢复 orphan worklist，并生成逐 finding `perFindingOutcomes`：校验异常或无法归因的 residual 全 failed；其余 residual 按 `pageSlug / relatedSlugs` 只标记相关 orphan（同页多条保守同结果）；未出现在权威 `postcondition.scope.touchedSlugs`（旧报告回退 created/updated/deleted 并集）的 orphan 一律 skipped，实际触达且无对应 residual 才是 fixed。旧/manual Curate 无 worklist，状态层继续使用 job-level 兼容判定。

**护栏（`createCurateGuard`，`wiki/curate-plan.ts`）**：
- caps 计数器：merge≤5 / split≤5 / delete≤5 / create≤5 / update≤5；metadata patch 与 link ensure 成功后均记一次 update，失败不计数。
- allowedSet 强制：read/search 过滤 scope 外页；merge 两端都必须在 allowedSet 且至少一端是 seed；split 必须同时位于 allowedSet 与 seedSet；manual 删除也不得越过 allowedSet；metadata 的 slug 与 link 的 source 必须在 allowedSet，跨主题 target 只验证、不扩大写 scope。
- auto 禁 list/create/delete：三个工具均不进入 profile；Guard 另外固定拒绝 auto delete/create，形成纵深防御。
- 保护页：index/log 不可 merge/split/delete（slug 集合 = `page-identity::META_PAGE_SLUGS` 单一源）。

**事件**：`curate:start` / `curate:agent:start`（进入工具循环前，报候选页数/mode/caps）/ `curate:tool`（每次工具调用，`toolActivityLine` 渲染成可读一行，经 `generateTextWithTools` 的 `onToolCall` 回调触发）/ `curate:merge`（merge 执行前）/ `curate:split`（split 执行前）/ `curate:delete`（delete 执行前）/ `curate:create`（create 成功后）/ `curate:skip`（guard 拒绝）/ `curate:verify:start` / `curate:verify:complete` / `curate:complete`。

**`curate-tools.ts`**（新增）— worker 侧 `ToolContext` 构造：
- `buildCurateToolContext(subject, { guard, jobId, emit })` — read/search 与 merge/split/create/delete/metadata/link 写能力统一经 Guard，并注入 subject evidence reader；compile policy 用同一 allowedSet 过滤 scope 外证据。所有写操作串行执行，防止并发调用越过 cap；Auto 仍无 list/create/delete。

### `fix-service.ts` 🆕 — 任务类型 `'fix'`

一键修复 lint findings。`params { subjectId }`。**Spec 3 阶段2 改造为 tool-loop**。

**工作清单构建**（`buildFixWorklist`，纯函数 `fix-deterministic.ts`）：
- **确定性 findings**：调 `runDeterministicChecksForSubject(subjectId)`（新鲜重扫，不依赖快照），取 `missing-frontmatter` + `broken-link` 类型。
- **语义 findings**：调 `selectLatestFindings(subjectId)`（最近 completed lint 快照），取 `missing-crossref` + `contradiction` 类型。
- `orphan` / `stale-source` / `coverage-gap` 不在修复范围。

**流程（两阶段）**：

1. **阶段1（确定性补 frontmatter）**：`fixMissingFrontmatter(slug, doc, now)` 纯函数批量填补缺失 frontmatter 字段（title/summary/tags/created），一次 Saga commit 提交所有受影响页（1 commit）。broken-link 在此阶段跳过（需 LLM 判断语义意图）。
2. **阶段2（LLM 工具循环修复）**：对剩余 findings 按页分组→按 `buildSubjectReportLines` 格式组装诊断清单，调 `generateTextWithTools('fix', { system: FIX_AGENTIC_SYSTEM_PROMPT, messages, tools, maxSteps: FIX_MAX_STEPS (60) })`：
   - 工具集按 finding 选择最小 profile：只有 broken-link/missing-crossref 时使用 `fix:links`（read/search/inspect、source.search/read、`wiki.link.ensure`）；含 contradiction 时使用 `fix:contradiction`，额外开放 patch/update。两者都无 list/create/metadata patch，页面 roster 已直接注入 Prompt。
   - `createFixGuard({ caps: { writes: Math.max(20, 本轮 loop 内不同 pageSlug 数 × 2) } })`（硬护栏）：写次数 cap + 保护页（index/log）+ 忠实度 `checkRewriteFidelity(…, FIDELITY_PROFILES.fix)`（`wiki/rewrite-fidelity.ts`，需现有正文，护栏不读盘；floor 0.8）。
   - broken-link/missing-crossref 只允许用 `wiki.link.ensure` 在现有唯一自然锚点上 link/unlink/retarget，禁止新建 Related 段落或用通用 patch 绕过；只有 contradiction profile 才能 `wiki.patch`/`wiki.update`。每次写操作一个 commit。
   - 所有写操作在单个 Fix job 内串行，cap 的检查→执行→record 是同一临界区；失败不计数且不阻塞后续写。校验失败/护栏拒绝时工具返回 ok:false + reason，模型物理越不过。
3. **写后定向校验与逐 finding 归因**：`operation-scope-collector` 从 applied operations 提取实际变更范围；`postcondition-verifier` 检查 broken/dangling links、新 orphan 与悬空 page_sources；原 `contradiction/missing-crossref` 在确有写入时经 `fix-semantic-postcondition` 复用 lint 路由单次无工具复检。任何不确定性保守 residual，不触发 worker retry。`fix-service` 再以实际 worklist + postcondition 生成 `perFindingOutcomes`：校验异常时全 failed；同 `type + pageSlug` 残留（同页同类多条也保守全失败）只标记相关 finding；语义校验失败只污染语义 finding；未出现在权威 `scope.touchedSlugs`（旧报告回退 created/updated/deleted 并集）的 finding 一律 skipped，实际触达且无对应 residual 才是 fixed，禁止用批次总 writes 推断未触达项已修复。

**事件**：`fix:start` / `fix:deterministic`（阶段1 commit）/ `fix:agent:start`（进入阶段2 工具循环前，报 finding 数/受影响页数）/ `fix:tool`（每次工具调用，`toolActivityLine` 渲染成可读一行，经 `generateTextWithTools` 的 `onToolCall` 回调触发）/ `fix:page`（单页阶段2 工具循环修复，仅有值的 success）/ `fix:create`（create 工具成功）/ `fix:skip`（工具拒绝 / LLM 无可修）/ `fix:verify:start` / `fix:verify:complete` / `fix:complete`。

完成后 UI 自动入队 verification lint（`health-view` 在 job completed 事件后携带原 lint 与 remediation job ID 触发），只刷新确定性结果并协调原语义 findings，不重新做开放式发现；用户手动重跑 Health check 才执行 discovery。该验证仍不替代当前 Fix Job 的定向 postcondition。

### `reenrich-service.ts` 🆕 — 任务类型 `'re-enrich'`

手动重新增益：现有页正文即忠实层，直接当 draft，跑**三阶段流水线** `reenrichSteps()`：

1. **`supplement`**（`skillId:'reenrich-supplement'`，新 step kind）——画像驱动正文缺口补全。`runtime/supplement-page.ts::runPageSupplement` 逐页调 skill 产候选 → `supplement-guard.ts::checkSupplementFidelity` 确定性护栏校验 → 不过则把违规项拼回输入重写一次 → 仍不过则**回落原文**（退化为「只叠 callout」，与改造前等价，不阻断后续阶段）。
2. **`ingest-enricher`**（fanout，复用 ingest 增益层）——叠 `[!type]` callout。
3. **`verify`**（复用 P3 联网核查/自检降级）。

`buildReenrichInitialInput` 把现有正文 seed 进 `writerOutputs`（enricher 的 `injectPriorPageAs:'draftContent'` 据此取用）；同时把 `buildProfileHint(getProfileOrDefault(LOCAL_USER_ID))` 的输出作 `profileHint` 传给 supplement 阶段。

**预算**：读取现有正文后用 `countTokens` + `estimateIngestCost(..., inline=true)` 复用三轮内容流水线成本模型；估算总成本超过 `agentMaxTokensPerJob` 时在任何 LLM 调用前 fail-fast，否则通过 `estimatePerPageTokens` 注入每阶段预扣。禁止回退到单页 `maxTokensPerJob / 1`，否则第一阶段产生任意实际消费后，第二阶段都会因“实际消费 + 整份预算预扣”伪超限。

**画像仅作探针**（`buildProfileHint`）：读取单租户画像（`LOCAL_USER_ID`）的 `backgroundSummary` + `stylePrefs`（readingLevel/verbosity/exampleDensity），拼成一句话提示——**只用来定位读者大概率不懂的概念，补充内容本身必须写成中性、对任何读者都普遍适用的讲解**；这是与 Cognitive Lens（读时按读者重塑讲法）的宪法边界：canonical 正文永远中性，读者专属讲法只在读时发生。无背景资料时回落「中级读者」中性假设。

**忠实度护栏**（`supplement-guard.ts::checkSupplementFidelity`，薄转发到统一模块 `wiki/rewrite-fidelity.ts::checkRewriteFidelity(…, FIDELITY_PROFILES.supplement)`，T1.4）——因允许「插入 + 局部改写」无法逐字比对，用组合式软护栏，floor=0.95：
- 不缩水：正文字数不得跌破原文 95%；
- 不丢失原有 wikilink（`linkRule:'preserve'`）——允许新增链接，但不许丢失原文已有的链接目标（早期版本反过来禁止新增，T1.4 改为对齐"改写不得丢事实"的统一语义）；
- 标题不减（`preserveHeadings`）：原文每个标题（级别+文字）须在候选正文原样出现；
- frontmatter 不变（`preserveFrontmatter`）：frontmatter 数据对象深度相等（JSON 规范序列化比对）。
全过才算通过；任一违规都会被收进 `violations[]` 用于重写反馈。

即便 subject `augmentationLevel` 为 `off` 也强制按 `standard` 跑（用户显式触发语义）。

emit `reenrich:start` 后进入 pipeline（supplement 阶段失败回落时额外 emit `reenrich:supplement-fallback`）；流水线完成后经 `commitPending` 收口提交（不重写 index/log）。**成熟度信号并入正文增长**：`deriveMaturityUpdate` 除原有 callout 增量外，新增 `proseGrowthIncrement(draftContent, finalContent)`（正文增长折算）一并计入 `newIncrement`，防止「多补正文少加 callout」被误判无进展。

需要 `reenrich-supplement v1` / `ingest-enricher v6` / `ingest-verifier v2` / `ingest-verifier-triage v2` / `ingest-verifier-apply v3`（不满足则 fail-fast；未修改的内置 `ingest-enricher` v4/v5 会在 worker 启动时安全升级，用户改版继续保留）。

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
  6. Route Handler 里：先 `resolveSubjectFromRequest(request, { required: true, body })` → `queue.enqueue('<name>', params, subject.id)`（签名为 `enqueue(type, params?, subjectId?)`）。
- **复用 merge/split 执行逻辑**：不要在新 service 里重复 LLM+Saga 逻辑；调用 `wiki/page-ops.ts::executePageMerge` / `executePageSplit`（无 emit/enqueue，由调用方自行发事件/入队 embed）。

- **emit 事件规范**（供前端 SSE 消费）：
  - `job:started` / `job:completed` / `job:failed` / `job:retrying` 由 `worker.ts` 自动发射。
  - Service 内的业务事件建议命名 `ingest:planning` / `ingest:writing-page` / `ingest:committing` 等，便于前端 UX 映射。

## 测试与质量

已覆盖（`__tests__/`，vitest，以纯函数与编排为主）：既有 ingest/lint/query/re-enrich/Health 编排；Query agentic 覆盖空库仍执行跨 Subject 工具循环、正常空答案回落、非流式工具失败透传，以及流式 error/iterator 异常的单一错误终态；Fix/Curate 精确 profile、allowedSet、串行 cap、metadata/link 窄写与单次 embedding；PendingAction 覆盖 strict payload/hash、preview 零写入、批准重算、stale 刷新、系统页/canonical slug、防误 enqueue、原子 finalizer 与恢复重试；Research 覆盖 run/view、原子批准、租约 delivery、source/child 唯一入队、Ingest lineage、验证对账、取消/崩溃补偿与 Health 状态恢复；真实 SQLite Worker 集成测试覆盖 Saga 业务事件、failed 状态与 `job:failed` 的唯一顺序。数据库侧另有真实临时 SQLite migration/约束/事务回滚测试。ingest pipeline 另见 `src/server/agents/runtime/__tests__/`。

## 常见问题 (FAQ)

- **两个 ingest 任务能并发吗？**
  能。worker 按 `app_settings.ingestConcurrency`（默认 2，范围 1–4）并发调度 Ingest；非 Ingest job 独占。真正写 vault/git 时仍由 `vault-mutex` 串行保护。
- **LLM 生成了无效 wikilink 怎么办？**
  `validateChangeset` 会捕获（通过 `extractWikiLinks` 再次解析）；失败则整个 changeset 被拒绝。
- **如何调试 ingest 失败？**
  1. 查 `jobs` 表 `status='failed'` 的记录；
  2. 查对应 `job_events` 表里的 `data_json`（含 `finishReason`、`usage`、`cause`）；
  3. 查 worker 控制台日志；ingest pipeline 详细 step 事件在 SSE `agent:step-*` 事件流中。

## 相关文件清单

```
src/server/services/
├── finding-identity.ts   # 🆕 Health finding 稳定 ID（SHA-256）与快照去重
├── remediation-router.ts # 🆕 九类 finding → 服务端处置 plan 的纯路由
├── remediation-context.ts # 🆕 任务 provenance 规范化、解析与幂等匹配
├── remediation-service.ts # 🆕 统一处置校验、去重与既有 workflow 委托
├── remediation-status.ts # 🆕 有界关联 job 扫描与 HealthSnapshot 状态推导
├── research-scope.ts     # 🆕 稳定 findingIds + lintJobId 的 Research 范围解析
├── research-provenance.ts # Research 稳定候选/selection/finding 快照纯规则
├── research-approval-service.ts # run view、批准/忽略服务与安全错误映射
├── research-import-service.ts # 候选租约抓取、source+child Ingest 原子调度
├── research-provenance-reconciler.ts # delivery lineage、验证 lint 与终态对账
├── ingest-service.ts    # 多阶段 LLM 摄入（分片自适应流水线）
├── ingest-prep.ts       # 预检/预算/常量纯函数
├── query-service.ts     # 问答 + save-to-wiki + 多轮记忆（agentic 工具循环）
├── query-tools.ts       # current/cross Subject 只读 ToolContext（wiki/source evidence + 可选 web.search）+ 复合身份 AccessedPages
├── image-insert-service.ts # 已批准 canonical 选区单图生成 + 页面/资产原子 Saga
├── workflow-tools.ts    # active Subject job 脱敏状态 + re-enrich/research/cancel 计划与取消通知
├── pending-action-payload.ts # 审批 payload strict normalize/canonical hash
├── pending-action-service.ts # preview/approve/reject 状态机与 stale 重算
├── pending-action-finalizer.ts # embed/workflow job + cancel 与 action applied 原子最终化
├── pending-action-maintenance.ts # TTL/崩溃恢复/finalizer 重试/GC
├── conversation-title.ts # 确定性会话标题派生纯函数
├── lint-service.ts      # 全库 lint 扫描
├── lint-verification.ts # 修后验证：校验 baseline/remediation 关联并单调协调 findings
├── curate-service.ts    # 🆕 agent 策展（curate 任务：tool-loop 驱动，generateTextWithTools + buildCurateToolContext + CurateGuard）
├── curate-tools.ts      # worker 侧 ToolContext：evidence reader + 写能力经 guard 把守
├── fix-service.ts       # 🆕 一键修复 lint findings（fix 任务：确定性阶段1 + LLM 阶段2 tool-loop）
├── fix-deterministic.ts # 🆕 纯函数：fixMissingFrontmatter / buildFixWorklist / buildSubjectReportLines / createFixGuard（写 cap + 保护页；忠实度已收编到 wiki/rewrite-fidelity.ts）
├── fix-tools.ts         # worker 侧 ToolContext：evidence reader + 写能力经 guard 鉴权后调 page-ops
├── reenrich-enqueue.ts  # 🆕 纯函数 validateReenrichTarget + enqueueReenrich 入队 helper（供对话工具触发）
├── page-write.ts        # 共享 plan/direct 包装：系统页保护 + create（可贯通 worker jobId）/update/patch/delete/metadata/link + direct embed 回填
├── reenrich-service.ts  # 🆕 手动重新增益（re-enrich 任务：复用增益流水线、跳过 writer）
├── embedding-enqueue.ts # 无 handler 副作用的 embed-index 持久化 helper（可嵌套事务）
├── embedding-service.ts # 向量嵌入索引（embed-index 任务，Saga 外独立）（⑧）
├── maintenance-policy.ts # 🆕 纯函数：递减回报间隔策略（SPACING_LADDER / countCallouts / nextMaturity，P5；T1.8 起 nextMaturity 质量优先——qualityDelta<=0 时体量信号清零 + staleSource 前置阻断毕业）
├── page-quality-signal.ts # 🆕 T1.8：re-enrich 单页质量信号取数（IO 层，确定性零 LLM）——countPageDeterministicFindings（单页 broken-link+frontmatter）/ pageHasStaleSources（复用 lint-deterministic 单页判定，不跑全库）
└── maintenance-scheduler.ts # sweep 页面选取（runMaintenanceSweep，P5；可按 Subject ID 集合过滤，缺省全量）
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-07-17 | `query-intent` 收口为统一结构化分类器：普通写入、直接 Re-enrich、选区配图和重置共用一次 `query` schema 调用；删除意图正则，增加 request/reset-confirmation 上下文收窄与保守失败回退 |
| 2026-07-17 | Ask AI canonical 选区新增 `wiki.image.insert` 提案、`workflow-image-insert-start` 审批与 `image-insert` worker；完整块锚点重定位、stable HEAD、取消 rollback、页面/资产同 Changeset 与 applied operation 恢复均已覆盖 |
| 2026-07-17 | 选区配图最初从正则迁移为结构化 LLM 二分类；现已并入 `classifyQueryIntent` 统一契约，route 仍结合可信 canonical selection 决定 `imageInsertEnabled`，普通 propose 不携带配图工具 |
| 2026-07-16 | re-enrich 生图可靠性修复：enricher v6 的页面身份改由运行时注入，Unicode slug 可安全关联 asset；视觉主题无现有位图时明确触发生图，已有位图不重复 |
| 2026-07-16 | enrich 接入 `image.generate` 图片工具；asset 与页面同一 Saga 提交，工具经 `ingest:image` 独立路由调用 Gemini 3.1 Flash Image |
| 2026-07-16 | Tags 工作台接入 `tag-batch` PendingAction：独立 strict schema、NULL conversation 的 Subject-scoped 恢复和原子在途去重；批准重算 Vault 标签计划并复用 expectedPreHead/Saga/finalizer，Query 工具 schema 保持不变 |
| 2026-07-16 | Ask AI 单页 re-enrich 命令增加确定性控制面短路：解析当前页/显式 slug 后直接持久化 workflow PendingAction，复合句、教程、否定或缺目标仍走既有 Query 语义 |
| 2026-07-16 | Maintenance sweep 接入全局 `maintenanceScope`：worker 读取 `all | subjects` 设置，调度器只从范围内到期页按既有 priority/上限入队，状态 API 与其保持同口径 |
| 2026-07-16 | 修复 re-enrich 单页三阶段预算预扣误用完整 job 上限：复用 ingest 内容成本估算做启动前预检与每阶段预扣，避免首个 supplement 后稳定伪报 `3M + actual / 3M` |
| 2026-07-15 | Research child Ingest 支持工作台原位续传：重试前精确对账，job/delivery/run 在同一事务恢复，保留 checkpoint/attempt 与既有 lineage；取消、缺源、证据错配和 verification 后状态拒绝恢复 |
| 2026-07-15 | 修复 Health 处置投影只隐藏 fixed 的契约偏差：Tidy/Fix 完成任务内验证及 Research provenance 到达验证终态后直接移除关联 finding，failed/skipped 真实结果保留在近期摘要；损坏结果 fail-closed |
| 2026-07-15 | Health 处置改为 postcondition 驱动的快照投影：Fix/Curate 直接消费逐 finding outcome；Research 导入后只目标化复核原 coverage-gap/thin-page 并原子物化终态，不再创建 verification lint；旧 verifying run 继续兼容对账 |
| 2026-07-15 | Semantic Lint 对 AI SDK JSON/schema 输出失败启用 1 次定向重试；最终失败事件保存脱敏 `finishReason/detail`，不落模型原始输出或 Wiki 正文 |
| 2026-07-15 | 修复 Research finding immutable snapshot 与 v2 identity 契约断裂：snapshot 可选保存 targetSlug/evidence，coverage-gap/contradiction 可无损重算 ID，旧 v1 snapshot 保持兼容 |
| 2026-07-15 | Health 修后验证收敛：Lint 拆分 discovery/verification；Fix/Curate 自动闭环校验 baseline/remediation 关联，只重跑确定性检查并协调原语义 findings，不再因同一 vault 的开放式复检漂移制造新 findings；并发同基线处置聚合完成结果 |
| 2026-07-15 | Health 修复收敛：语义 Lint 增加 target/evidence 结构化契约、vault 原文与 wikilink 真实性过滤、调用点 temperature=0；语义 finding identity 升级 v2 并保留历史 v1 fallback，避免全库复检因假阳性与 description 漂移不断制造“新问题” |
| 2026-07-14 | Saga/Worker 失败边界：真实 SQLite 集成测试锁定业务事件 → failed 状态 → job:failed，并验证 CAS/fencing 未命中不发布虚假终态事件；Services 编排测试清单收口 |
| 2026-07-14 | Query 编排边界：非流式工具失败原样抛出且不做 citation/coverage；流式 error part 统一抛给 Route 单点收口，失败请求不再伪装成空答案成功或错误记录 coverage gap；正常空流 fallback 行为保持 |
| 2026-07-14 | Citation 标题解析按复合身份隔离：`extractCitationsFromAnswer` 的 title candidate key 加入目标 Subject，多个 Subject 存在同名标题时仍能解析各自已读页面，不再因全局歧义丢失全部引用 |
| 2026-07-14 | 页面身份迁移 Phase 3D：Query 明确 move/rename-slug 意图后只生成 `wiki.move` PendingAction；批准重算 plan 并复用页面 Saga/finalizer，迁移 alias、引用、source sidecar 与全部 slug 派生缓存；无新增 LLM task，示例配置不变 |
| 2026-07-14 | Workflow 控制 Phase 3C：新增 active Subject 脱敏 status、re-enrich/research/cancel 计划；Query 只生成 PendingAction，start/cancel 与 action applied 原子收口，取消复用事件与 Research provenance 对账；无新增 LLM task，示例配置不变 |
| 2026-07-14 | History 工具 Phase 3B：新增 `history-tools.ts` 复用 operations/git/revert/Saga；Query 注入 list/diff 与回滚预览，PendingAction 支持 `history-revert` 的 fresh/stale/apply/恢复最终化；无新增 LLM task，示例配置不变 |
| 2026-07-14 | 跨 Subject 只读 Phase 3A：Query 新增 Subject 列举、显式跨主题混合检索与正文读取；active 空库不再提前阻断；访问与 citation 使用复合身份，Save-to-Wiki References 保留跨主题 wikilink；无新增 LLM task，示例配置不变 |
| 2026-07-14 | Query Save-to-Wiki Phase 2D：`saveQueryAsPage` 删除自建 slug/frontmatter/changeset 路径，改调可贯通真实 job ID 的 shared create command；与 `wiki.create` 统一唯一 slug、Saga 和 embedding，页面 citations 只写 References、不污染 raw `sources`；applied operation 恢复避免 worker 重试重复建页；无新增 LLM task，示例配置不变 |
| 2026-07-14 | Research 批准溯源 Phase 2C：持久化 run/candidate/finding 快照，candidate ID + version + idempotency 原子批准；`research-import` coordinator 以租约逐条导入并注入 child Ingest lineage，终态对账物化 operation/page/commit 与 verification finding；Health 从 run view 恢复批准、导入、验证和终态，旧 resultJson 仅作兼容回退；无新增 LLM task，示例配置不变 |
| 2026-07-13 | Wiki 窄写 Phase 2B：Fix links 收缩为 `wiki.link.ensure`，contradiction 保留 patch/update；Curate auto/manual 增加 metadata/link 窄写与串行 update cap；Query preview/approve 支持两个新 operation，真实写工具仍不可见；PendingAction CHECK 兼容迁移，并以原子 finalizer 保证 embed job 与 applied 同进退、崩溃可重试；LLM 示例配置不变 |
| 2026-07-12 | Health 修复闭环 Phase 2A：新增稳定 finding identity、九类纯 remediation router、统一执行与幂等 context、`MAX_REMEDIATION_JOBS=200` 状态恢复；Fix 精确消费所选 scope，Research 接受 `coverage-gap / thin-page` 的 `findingIds + lintJobId`，并与前端 active-job 恢复及 lint 复检形成闭环 |
| 2026-07-12 | Phase 1C：新增 operation scope collector、共享确定性 postcondition verifier、Fix 单次语义复检与统一报告编排；Fix / Curate 都返回 `postconditionStatus + postcondition`，residual/校验异常保持 Job completed 且不重放写入 |
| 2026-07-11 | Wiki 审批闭环 Phase 1B：Query 按 read/propose 动态编译工具，propose 仅生成持久化预览；pending-action-service 负责 hash/TTL/原子批准/陈旧刷新/恢复，re-enrich 在批准时才入队；复用 query task，LLM 示例配置不变 |
| 2026-07-10 | Wiki 证据工具 Phase 1A：Query 实际只读工具补齐 `wiki.inspect/source.search/source.read` 与可继续 `wiki.list`；Fix links/contradiction 获得页面和来源证据；Curate Auto/Manual 获得 scope 内 inspect；三类 context 复用 subject evidence reader，stale-source 判定迁入 `sources/source-staleness.ts` 供 lint/inspect 共用 |
| 2026-07-10 | 工具治理 Phase 0：Query 固定 query:read 且 ToolContext 不含写能力；Fix 按 finding 选择 links/contradiction profile 并移除 list/create；Curate 使用 mode profile + allowedSet，Auto 无 list/create/delete，读写 scope 由 compile policy 与 Guard 双重强制；ingest/re-enrich 的 commitPending 统一从 agents/runtime 导入 |
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
| 2026-06-25 | 工具体系收敛：`query-tools.ts` 改用共享 `createBuiltinToolRegistry`（`agents/tools/registry.ts`），删内联 `tool()` 孤岛；新增 `buildQueryToolContext(subject, accessed)` 构造 `ToolContext`；`wiki.read/search/list` 工具定义来自 `agents/tools/builtin/wiki-*.ts` 单一源；双 runner（`streamTextWithTools`/`generateTextWithTools`）保留 |
| 2026-06-28 | 对话触发 Re-enrich：新增 `reenrich-enqueue.ts`（纯函数 `validateReenrichTarget` + `enqueueReenrich` 入队 helper，供 `wiki.reenrich` 对话工具触发）；`query-tools.ts::buildQueryToolContext` 新增 `reenrich` 能力（注入来自 `enqueueReenrich`）；删除 `/api/re-enrich` 路由（入口改为对话工具） |
| 2026-06-27 | Cognitive Lens：新增 `reshape-service.ts`（整页/段级重塑）+ `apply-signal.ts`；均为读侧，不写 vault/不经 Saga |
| 2026-06-30 | 新增 `page-write.ts`（`validateDeleteTarget` 删除守卫单一真实源 + `deletePageInSubject`/`createPageInSubject`，同步 Saga+embed 回填，供 DELETE 路由 DRY 复用与 `wiki.delete`/`wiki.create` 对话工具复用） |
| 2026-06-30 | `curate-service` 由 triage→confirm→execute 结构化流水线改造为 tool-loop 驱动：`generateTextWithTools('curate')` + `buildCurateToolContext` + `createCurateGuard` 硬护栏；新增 `curate-tools.ts`（worker 侧 ToolContext，读已提交 vault + 写能力经 guard 鉴权后调 page-ops 内核 + emit 事件）；退休 triage/confirm 三套 schema+prompt |
| 2026-06-30 | curate follow-up：auto 模式不再解析 `wiki.create` 工具（按 `seedSet===null` 条件化 `resolve`，省模型试探步数；`guard.canCreate` 仍兜底）；`['index','log']` 保护页常量统一为 `wiki/page-identity::META_PAGE_SLUGS` 单一源（`curate-service`/`page-write`/`lint-deterministic`/`reenrich-enqueue` 不再各持副本）|
| 2026-06-30 | Fix tool-loop（Spec 3）：`fix-service` 阶段2 由逐页 `generateStructuredOutput('fix')` 改为 `generateTextWithTools('fix')` 自驱 `wiki.update`/`wiki.create`；新增 `fix-tools.ts::buildFixToolContext`（读侧同构 curate-tools + 写经 `createFixGuard`+忠实度护栏调 page-ops 内核）；`fix-deterministic` 加 `createFixGuard`、退休关联页提取（`findRelatedPageSlugs`/`mentions`/`MAX_RELATED_PAGES`）；`fix-prompt` 退休逐页 `FixPageSchema` 三件套、新增 agentic prompt；每写一次一 commit |
| 2026-07-01 | reenrich-service 加画像驱动正文补全 supplement 首阶段（`reenrich-supplement` skill + `runPageSupplement` 护栏 + `buildProfileHint` 探针提示 + `deriveMaturityUpdate` 并入正文增长）；流水线三步（supplement→enricher→verify），仅 re-enrich，ingest 不变 |
| 2026-07-06 | T1.8 成熟度信号质量化：`nextMaturity` 新增 `qualityDelta`/`staleSource` 输入，质量优先——`qualityDelta<=0` 时体量信号（callout+正文增长折算）清零，纯长肉不再续命，直接走 saturation；`staleSource=true` 时前置阻断毕业（也不快进间隔，留在当前档）。新增 `page-quality-signal.ts`（IO 层，单页确定性 findings 计数 + 单页 stale 判定，均不跑全库）；`lint-deterministic.ts` 抽出可复用的 `checkStaleSourcesForPage`；`reenrich-service.ts::deriveMaturityUpdate` 改纯函数（qualityDelta/staleSource 由调用方在 handler 里用 `page-quality-signal` 算好传入），quality 分量 = 单页确定性 findings「修复前−修复后」+ 本轮 `ctx.citedSources` 新增证据条数（未接入 verify 结构化"修订计数"，因 apply 只回传最终正文不单独暴露修了几处——用引用证据数作确定性代理，零额外 LLM 调用）；`page_maturity` 表结构不动（质量信号现场重算，无迁移）|
| 2026-07-06 | T1.4 统一保真护栏：`fix-tools.ts`（profile `fix`，floor 0.5→0.8）与 `reshape-service.ts`（profile `reshape`，新增长度 floor 0.8）改调 `wiki/rewrite-fidelity.ts::checkRewriteFidelity`；`fix-deterministic.ts::bodyShrankTooMuch` 退役（收编）；`supplement-guard.ts::checkSupplementFidelity` 收编为薄转发（profile `supplement`），链接规则由「禁止新增」改为「禁止丢失」（preserve）|
| 2026-07-17 | Reshape 从 canonical 保真护栏中移除，整页改走带 `image_generate` 的工具流；生图二进制暂存于请求结果，完整成功后由 API 与 Markdown 原子持久化 |
| 2026-07-17 | Reshape 成功判定收紧：工具流必须产出非空 Markdown；服务解析 Markdown 图片节点，只持久化本次生成且被最终正文实际引用的 rendition 资产，并拒绝未知资产 ID |
| 2026-07-07 | T3.2 Ask AI 未命中 → 待研究队列 + 联网检索：`generateQueryCitations` 二次结构化输出 schema 加 `coverageSufficient`/`suggestedResearchQuestion`（`query-prompt.ts`），不足或空库短路时 best-effort 写入 `research-backlog-repo`；新增只读 `web.search` 工具（`agents/tools/builtin/web-search.ts`，包装 `search/web-search.ts::webSearch`，`sideEffect:'none'`），仅 `isWebSearchConfigured()` 为真时经新导出的 `resolveQueryTools()` 注入 query 工具集（未配置时模型不可见）；`ToolContext` 加可选 `webSearch?`，`query-tools.ts::buildQueryToolContext` 接入；`QUERY_AGENTIC_SYSTEM_PROMPT` 补 web 结果标注纪律（不得与 wiki 引用混淆）|
| 2026-07-07 | 新增 `research-service.ts`（任务类型 `'research'`，T3.1）：缺口/主题→联网研究→候选清单，只发现不写入。三阶段：`generateStructuredOutput('research:queries')` 生成 query → `web-search.ts::webSearch` 逐条搜索 → `generateStructuredOutput('research:triage')` 打分（失败降级为按排名取前 3 未评分）；query/候选去重截断与 triage 纯函数收在 `src/lib/research-plan.ts`。最初的 findings 位置索引和客户端 URL 直提交流程已分别被 Phase 2A 稳定 ID 与 Phase 2C 专用 candidate ID 批准/coordinator 取代 |
| 2026-07-06 | T2.1 ingest finalize 去 LLM 化：`finalizeIngest` 不再调 `ingest-indexer`，改用 `wiki/meta-pages.ts` 纯函数 `renderIndexPage`/`renderLogPage` 确定性渲染 index/log（按 tag 分组+标题排序+`[[slug\|Title]]`；log 保留最近 50 条、新条目在前，解析既有 log 正文 bullet 行还原历史）；`MIN_SKILL_VERSIONS` 去掉 `ingest-indexer` 项，skill 文件已删（`examples/skills/ingest-indexer.md`）；`llm-config.example.json` 去掉 `ingest:indexer` 路由项。索引每页 tags 优先取本次 `ctx.pending` 内容实际写入的 frontmatter，未触碰页沿用 DB 既有 tags。动机：原方案每次 ingest 都要把全 subject 页清单塞进 prompt，页数上几百后单调膨胀直至超上下文窗口且重复付费——目录/日志本质是数据库可确定性派生的数据 |
| 2026-07-07 | Ask AI 内联引用 + 确定性解析：引用生成从"模型二次结构化输出 `generateQueryCitations`"改为"prompt 纪律要求模型正文内联 `[[slug]]` + 流后确定性解析"——新增 `citation-extract.ts::extractCitationsFromAnswer`（`extractWikiLinks` 解析答案 ∩ `accessed.bodies` 已读页，过滤幻觉链接）+ `pickExcerpt`（词重叠定位 + 原文偏移切片，excerpt 恒为页面原文字面子串），零额外 LLM 调用；`streamAgenticQuery`/`runQuery` 流末同步调用。coverage 判定与引用解耦为独立异步小调用：新增 `assessCoverageInBackground(subject, question, answer)`（fire-and-forget，只喂问题+答案，走 `CoverageSchema`/`COVERAGE_SYSTEM_PROMPT`），`false` 时仍走 `recordCoverageGap` 写 backlog；退役 `generateQueryCitations`/`QueryCitationsSchema`/`[unverified]` 前缀机制；`done` 事件不再携带 `coverageSufficient` |
| 2026-07-09 | 新增 `page-write.ts::updatePageInSubject`（校验目标页存在 + 非保护页 `META_PAGE_SLUGS`（终审发现的保护不对称补丁，对齐 `validateDeleteTarget`/fix 的 `createFixGuard`）+ 忠实度护栏 `FIDELITY_PROFILES.fix` + 调 `executePageUpdate`（支持改标题）+ `enqueueEmbedIndex`）；`query-tools.ts::buildQueryToolContext` 接入 `updatePage`（委托上述函数）；`query-service.ts::BASE_QUERY_TOOL_NAMES` 追加 `'wiki.update'`——问答（Ask AI）首次获得改写页面标题+正文的能力；`QUERY_AGENTIC_SYSTEM_PROMPT` 补 "Updating a page" 确认纪律（与 `wiki_delete` 一致，须后续轮确认）|
| 2026-07-10 | 新增 `wiki.patch` 局部更新工具：`page-write.ts::patchPageInSubject`（同 `updatePageInSubject` 的 META 保护 + `enqueueEmbedIndex`，但委托 `wiki/page-ops.ts::executePagePatch`，**不接忠实度护栏**——old_string/new_string 精确唯一替换天然风险面小于整页重写）；`fix-tools.ts::buildFixToolContext` 与 `query-tools.ts::buildQueryToolContext` 均接入 `patchPage`；`query-service.ts::BASE_QUERY_TOOL_NAMES` 追加 `'wiki.patch'`；fix/Ask AI 两侧 prompt 补写作指导：局部改动优先 `wiki.patch`，仅整页重写/改标题才用 `wiki.update` |
| 2026-07-09 | 任务日志可读性改进：`fix-service`/`curate-service` 新增 `fix:agent:start`/`fix:tool`、`curate:agent:start`/`curate:tool` 事件（`generateTextWithTools` 新增 `onToolCall?` 回调，配合新增 `lib/tool-activity.ts::toolActivityLine` 把工具调用渲染成可读一行）；`lint-service` 新增导出 `summarizeFindings`，`lint:semantic:start` 补 `pageCount`/`model`，`lint:semantic:done`/`lint:complete` 补 `bySeverity`/`byType` 分类统计。spec/plan 见 `docs/superpowers/{specs,plans}/2026-07-09-job-log-clarity*` |

---

_生成时间：2026-04-22 00:25:29_

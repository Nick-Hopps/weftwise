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
  2. 根据 `resolveQueryMode(question)` 选择 `query:read` 或 `query:propose`；两者都有只读 evidence，只有 propose 额外获得 `wiki.preview_change`，再由必传 `ToolExecutionPolicy` 编译；
  3. 用 `streamTextWithTools('query', { system, messages, tools, maxSteps: QUERY_MAX_STEPS })` 驱动工具循环；
  4. 返回 `{ stream, accessed }`（`accessed` 供事后 `accessedToContext` 生成引用上下文）。
- `runQuery(question, subject, currentPageSlug?)` — 非流式 agentic 问答：
  1. 调 `subjectHasContent(subject.id)` 空 subject 短路守卫；空库直接返回 `NO_QUERY_CONTEXT_ANSWER`；
  2. 同样走 `generateTextWithTools` 工具循环；
  3. 引用改为**流后确定性解析**（零 LLM 二次调用）：`extractCitationsFromAnswer(answer, accessed, subject.slug)`（`citation-extract.ts`）。

引用不再靠模型二次结构化输出生成，而是靠 prompt 纪律 + 确定性解析（退役 `generateQueryCitations`/`QueryCitationsSchema`/`[unverified]` 前缀机制）：

- `QUERY_AGENTIC_SYSTEM_PROMPT` 新增 CITE INLINE 纪律——模型在答案正文中每条基于 wiki 内容的陈述后内联标注 `[[slug]]`（必须是本轮工具已读过的页的精确 slug），未标注的陈述视为无引用；
- `extractCitationsFromAnswer(answer, accessed, subjectSlug)`（`citation-extract.ts`，纯函数）：`extractWikiLinks` 解析答案全文（标题也可兜底解析到 slug）→ 目标 slug ∩ `accessed.bodies`（真正 `wiki_read` 过的页，过滤幻觉链接/未读页）→ 按 slug 去重（取首次出现锚点句）；`pickExcerpt(anchorText, pageBody)` 用词重叠打分（中英通用分词：latin 词 + CJK 双字 bigram）在页面正文按句界切出 1-3 句作 excerpt，**恒为页面原文字面子串**（按偏移切片，不重新生成文本）；
- 流式分支（`streamAgenticQuery` + `/api/query`）与 `runQuery` 均在**流结束后**同步调用此解析，聊天 UI 正文内联 `[[slug]]` 由前端渲染层直接渲染成 wikilink，不再需要模型额外产出 citations 数组；
- coverage 判定与引用解析解耦，改为**流后异步 fire-and-forget 小调用**：`assessCoverageInBackground(subject, question, answer)` 只喂问题+答案（不喂 accessed 上下文），走 `CoverageSchema`/`COVERAGE_SYSTEM_PROMPT`/`buildCoverageUserPrompt`（`query-prompt.ts`）判定 `coverageSufficient`；`false` 时经 `recordCoverageGap` best-effort 写入 `research-backlog-repo.create`（source='ask-ai'；`try/catch` 包裹，写入失败/异常只 `console.error` 不影响已返回的问答响应，也不阻塞响应本身）；`done` 事件不再携带 `coverageSufficient`（T3.2 引入时曾同步携带，现已异步化）；
- `resolveQueryTools(mode)` — `query:read` 只有 `wiki.list/search/read/inspect`、`source.search/read` 与可选 `web.search`；`query:propose` 仅额外开放 `wiki.preview_change`（`sideEffect:'propose'`）。两者都不暴露 reenrich/create/update/patch/delete 实际写工具，也不把对话历史里的口头确认当授权；
- 任务 `save-to-wiki`：同时支持 `params.subjectId`（来自 body）与 `job.subjectId`（来自 enqueue），走 changeset 写入对应 subject。

`NO_QUERY_CONTEXT_ANSWER` 常量 —— 空 subject 短路时的兜底回答（同时触发 backlog 写入）。
`QUERY_MAX_STEPS = 6` 常量 —— 工具循环最大步数，防 runaway。

**`query-tools.ts`**（新增）— subject-scoped 工具上下文，经共享 registry 解析实际 ToolDef：
- `buildQueryToolContext(subject, accessed, options?)` — 默认严格只读；只有传入已校验 conversationId 时才注入 `previewChange` 与 `onPendingAction`。预览调用 `pending-action-service`，不会写 vault/index/git，也不会为 re-enrich 入队。
- `createAccessedPages()` — 创建 `AccessedPages` 对象（页面 `meta/bodies` 两个 Map + 仅保存 `{sourceId,chunkId?}` 的 `sourceRefs` Map）；来源正文/excerpt 不进入引用上下文。
- `accessedToContext(subject, accessed)` — 把已访问页转为 `QueryContextPage[]` 供引用生成。
- `subjectHasContent(subjectId)` — 确定性检查：`pagesRepo.getAllPages(subjectId).some(p => !pagesRepo.isMetaPage(p))`；只计非 meta 页，空 subject 或仅含 meta 页时返 false，消灭"宏观问题报不存在文档"误报。

### `pending-action-service.ts` — 对话写入审批状态机

创建预览时规范化并哈希服务端 payload，页面操作只生成 plan/diff；re-enrich 只预览“调度动作”，批准前不创建 job。批准时原子 claim、复算 hash 与 plan，并在 Saga 锁内核对预览 `preHead`；陈旧则返回刷新后的 pending action，匹配才 apply 或 enqueue。worker 启动及每分钟调用 `maintainPendingActions()` 完成 TTL、崩溃恢复和 30 天 GC。该能力复用现有 `query` LLM task，不新增模型路由，因此 `llm-config.example.json` 无需更新。

### `lint-service.ts` — 任务类型 `'lint'`

扫 pages + links → 调 LLM 产出 `LintFinding[]`，补 subject 上下文与稳定 ID 后写回 `result_json` 供前端展示。九类 finding：
`broken-link` / `orphan` / `missing-frontmatter` / `stale-source` / `contradiction` / `missing-crossref` / `coverage-gap` / `orphan-source` / `thin-page`（见 `contracts.ts`）。

> 默认 **subject-scoped**（`params.subjectId` 必填）；`{ allSubjects: true }` 显式触发全量。deterministic 与 semantic 两阶段都按 subjectId 扫描。

`stale-source` 的缺失/哈希变化规则统一由 `sources/source-staleness.ts::isSourceStale` 提供，lint 与 `wiki.inspect` 共用，避免两份判定漂移。

**事件补充统计**（纯函数 `summarizeFindings`，按 severity/type 计数 + 拼一句可读摘要文本）：`lint:semantic:start` 携带 `pageCount`/`model`（本次将跑语义分析的页数 + 模型标签）；`lint:semantic:done`/`lint:complete` 携带 `bySeverity`/`byType`（`lint:complete` 另带 `totalFindings`），日志文案附带形如 `(2 critical, 3 warning; missing-crossref×2)` 的分类摘要。

### Health remediation Phase 2A — identity、router 与状态闭环

**稳定身份（`finding-identity.ts`）**：`findingId()` 对 `lint-finding:v1 / subjectId / type / pageSlug / sourceId|sourceFilename / 规范化 description` 的 NUL 分隔 tuple 做 SHA-256，产出 64 位小写 hex；description 先做 NFKC、换行统一、空白折叠与 trim。`identifyFindings()` 按计算 ID 去重并保留首次顺序。`lint-service` 写新快照和 `lint-latest::selectLatestFindings()` 读取新旧快照都重算同一身份，不信任持久化 JSON 内的 ID，也不依赖 findings 数组位置。

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

**状态恢复（`remediation-status.ts`）**：`buildHealthSnapshot()` 将当前 lint、router plan 和带 `remediationContext` 的近期 jobs 合成为 `HealthSnapshot`。`MAX_REMEDIATION_JOBS = 200`；API 先用 `queue.listRecent(..., 200)` 有界取数，builder 再按 `createdAt + id` 排序并只保留最后 200 条，subject + finding ID 组成内部 key，避免 All Subjects 同 ID 串扰。状态规则：无 job 使用 router 的 `awaiting-approval/skipped`；pending/running 或写任务完成但晚于当前 lint 为 `queued`；Research 有合法 candidates 为 `awaiting-approval`、无候选为 `skipped`、非法结果为 `failed`。新 Fix / Curate 的 `resultJson.perFindingOutcomes` 对每个稳定 ID 严格记录 `fixed | failed | skipped`，当前与已消失 finding 均优先读取自己的值，因此部分成功不会被批次整体 residual 污染；目标键缺失、容器损坏或值未知时回退既有 job-level 保守判定，兼容旧 Fix / Curate job。旧任务的 job-level 规则仍为：只有后置校验 clean、语义 clean/not-needed 且有写入才是 `fixed`，零写入是 `skipped`，residual/语义失败/坏结果是 `failed`。已从后续 lint 消失的非 Research finding 只进入 `recentOutcomes`，不重新进入 findings。

**Fix scope**：`remediationContext` 存在时只从指定、同 subject、completed lint job 解析所选 ID；确定性检查仍新鲜重扫，但只消费 ID 命中的 `missing-frontmatter/broken-link`，语义侧只消费 ID 命中的 `missing-crossref/contradiction`。工具 read/search/inspect/source evidence 保持 subject-wide，只有 `updatePage/patchPage` 写侧收窄到所选 findings 对应页面。无 context 的旧 `/api/fix` 继续保持全量 Fix 行为。

**Research scope**：finding 分支必须同时携带稳定 `findingIds` 与当前 `lintJobId`；`research-scope.ts::resolveTopicsFromFindingIds()` 精确读取该 subject 的 completed lint 快照，并要求全部 ID 属于可 Research 的 `coverage-gap` 或 `thin-page`，混入其他类型则整体拒绝。topic 分支保持通用手动/Backlog 入口；旧数组下标协议已退役。通过统一 remediation 入口创建的 Research job 同样携带规范化 context，供刷新恢复与状态推导。

Health 前端刷新时还会按 subject 依次读取 pending、running jobs：合法 `fix` / `curate` / `research` job 都可恢复对应 SSE 与 busy 状态；只有 context 完整且 `action` 与 workflow 匹配时才标记为 remediation 来源，否则作为 manual workflow 恢复。唯 Re-ingest 必须是 `ingest` job 且带严格匹配 `action:'re-ingest'` 的 context 才恢复。终态同时失效 active-jobs 与 lint snapshot，Fix/Curate/Re-ingest 完成后重跑 lint，形成“执行 → 恢复 → 复检 → 状态”闭环。All Subjects 只构造只读 plans，不允许执行。

### `curate-service.ts` 🆕 — 任务类型 `'curate'`

**Tool-loop 驱动**的 subject 结构策展。`params { scope: 'pages'|'subject'; slugs?: string[]; subjectId }`。

**流程**：

1. 解析 scope + seedSet：`scope:'pages'`（auto）→ seed = params.slugs，再用 `expandScopeWithNeighbors` 扩展本-subject 邻居；`scope:'subject'`（manual）→ 全 subject 非 meta 页，seedSet=null（无 seed 过滤）。
2. 读取 scope 内每页元数据（slug/title/summary/tags/bodyChars，不喂正文——模型用 `wiki.read` 自取）。
3. 令 `allowedSet = seed + 本 subject 一跳邻居`，装配 `createCurateGuard({ seedSet, allowedSet, caps })` + `buildCurateToolContext`，按 mode 解析 profile 后将同一 allowedSet 交给 `ToolExecutionPolicy`：manual 为 read/search/inspect/merge/split/create/delete；auto 仅 read/search/inspect/merge/split，无 list/create/delete。
4. 调 `generateTextWithTools('curate', { system: CURATE_AGENTIC_SYSTEM_PROMPT, messages, tools, maxSteps: 40 })` 驱动工具循环；模型自驱读页、自行决策并调写工具；每次写工具调用经 guard 鉴权后调 page-ops 内核 + emit 事件。
5. guard.totals() 非零则 enqueue embed-index。
6. 按当前 `jobId + subjectId` 的 applied operations 执行共享确定性后置校验；无 operation 返回 clean，残留或校验异常返回 `completed + residual`，不回滚或重放写入。带 remediation context 时，从其精确 completed lint 快照按稳定 ID 恢复 orphan worklist，并生成逐 finding `perFindingOutcomes`：校验异常或无法归因的 residual 全 failed；其余 residual 按 `pageSlug / relatedSlugs` 只标记相关 orphan（同页多条保守同结果）；未出现在权威 `postcondition.scope.touchedSlugs`（旧报告回退 created/updated/deleted 并集）的 orphan 一律 skipped，实际触达且无对应 residual 才是 fixed。旧/manual Curate 无 worklist，状态层继续使用 job-level 兼容判定。

**护栏（`createCurateGuard`，`wiki/curate-plan.ts`）**：
- caps 计数器：merge≤5 / split≤5 / delete≤5 / create≤5；超限时工具返回 ok:false + reason，模型物理越不过。
- allowedSet 强制：read/search 过滤 scope 外页；merge 两端都必须在 allowedSet 且至少一端是 seed；split 必须同时位于 allowedSet 与 seedSet；manual 删除也不得越过 allowedSet。
- auto 禁 list/create/delete：三个工具均不进入 profile；Guard 另外固定拒绝 auto delete/create，形成纵深防御。
- 保护页：index/log 不可 merge/split/delete（slug 集合 = `page-identity::META_PAGE_SLUGS` 单一源）。

**事件**：`curate:start` / `curate:agent:start`（进入工具循环前，报候选页数/mode/caps）/ `curate:tool`（每次工具调用，`toolActivityLine` 渲染成可读一行，经 `generateTextWithTools` 的 `onToolCall` 回调触发）/ `curate:merge`（merge 执行前）/ `curate:split`（split 执行前）/ `curate:delete`（delete 执行前）/ `curate:create`（create 成功后）/ `curate:skip`（guard 拒绝）/ `curate:verify:start` / `curate:verify:complete` / `curate:complete`。

**`curate-tools.ts`**（新增）— worker 侧 `ToolContext` 构造：
- `buildCurateToolContext(subject, { guard, jobId, emit })` — read/search 与写能力保留既有 Guard；同时注入 subject evidence reader。当前 profile 只暴露 `wiki.inspect`，compile policy 用同一 allowedSet 令 scope 外 inspect 返回空结果；Auto 仍无 list/create/delete。

### `fix-service.ts` 🆕 — 任务类型 `'fix'`

一键修复 lint findings。`params { subjectId }`。**Spec 3 阶段2 改造为 tool-loop**。

**工作清单构建**（`buildFixWorklist`，纯函数 `fix-deterministic.ts`）：
- **确定性 findings**：调 `runDeterministicChecksForSubject(subjectId)`（新鲜重扫，不依赖快照），取 `missing-frontmatter` + `broken-link` 类型。
- **语义 findings**：调 `selectLatestFindings(subjectId)`（最近 completed lint 快照），取 `missing-crossref` + `contradiction` 类型。
- `orphan` / `stale-source` / `coverage-gap` 不在修复范围。

**流程（两阶段）**：

1. **阶段1（确定性补 frontmatter）**：`fixMissingFrontmatter(slug, doc, now)` 纯函数批量填补缺失 frontmatter 字段（title/summary/tags/created），一次 Saga commit 提交所有受影响页（1 commit）。broken-link 在此阶段跳过（需 LLM 判断语义意图）。
2. **阶段2（LLM 工具循环修复）**：对剩余 findings 按页分组→按 `buildSubjectReportLines` 格式组装诊断清单，调 `generateTextWithTools('fix', { system: FIX_AGENTIC_SYSTEM_PROMPT, messages, tools, maxSteps: FIX_MAX_STEPS (60) })`：
   - 工具集按 finding 选择最小 profile：只有 broken-link/missing-crossref 时使用 `fix:links`（read/search/inspect、source.search/read、patch）；含 contradiction 时使用 `fix:contradiction`，额外开放 update。两者都无 list/create，页面 roster 已直接注入 Prompt。
   - `createFixGuard({ caps: { writes: Math.max(20, 本轮 loop 内不同 pageSlug 数 × 2) } })`（硬护栏）：写次数 cap + 保护页（index/log）+ 忠实度 `checkRewriteFidelity(…, FIDELITY_PROFILES.fix)`（`wiki/rewrite-fidelity.ts`，需现有正文，护栏不读盘；floor 0.8）。
   - 模型自驱读页后优先调 `wiki.patch` 精确修复链接；只有 contradiction profile 才能整页 `wiki.update`。每次写操作一个 commit。
   - LLM 可自行决策并发修复多页；校验失败/护栏拒绝时工具返回 `ok:false + reason`，模型物理越不过。
3. **写后定向校验与逐 finding 归因**：`operation-scope-collector` 从 applied operations 提取实际变更范围；`postcondition-verifier` 检查 broken/dangling links、新 orphan 与悬空 page_sources；原 `contradiction/missing-crossref` 在确有写入时经 `fix-semantic-postcondition` 复用 lint 路由单次无工具复检。任何不确定性保守 residual，不触发 worker retry。`fix-service` 再以实际 worklist + postcondition 生成 `perFindingOutcomes`：校验异常时全 failed；同 `type + pageSlug` 残留（同页同类多条也保守全失败）只标记相关 finding；语义校验失败只污染语义 finding；未出现在权威 `scope.touchedSlugs`（旧报告回退 created/updated/deleted 并集）的 finding 一律 skipped，实际触达且无对应 residual 才是 fixed，禁止用批次总 writes 推断未触达项已修复。

**事件**：`fix:start` / `fix:deterministic`（阶段1 commit）/ `fix:agent:start`（进入阶段2 工具循环前，报 finding 数/受影响页数）/ `fix:tool`（每次工具调用，`toolActivityLine` 渲染成可读一行，经 `generateTextWithTools` 的 `onToolCall` 回调触发）/ `fix:page`（单页阶段2 工具循环修复，仅有值的 success）/ `fix:create`（create 工具成功）/ `fix:skip`（工具拒绝 / LLM 无可修）/ `fix:verify:start` / `fix:verify:complete` / `fix:complete`。

完成后 UI 自动重跑 lint（`health-view` 在 job completed 事件后触发），该全量体检只负责刷新 Health findings，不替代当前 Fix Job 的定向 postcondition。

### `reenrich-service.ts` 🆕 — 任务类型 `'re-enrich'`

手动重新增益：现有页正文即忠实层，直接当 draft，跑**三阶段流水线** `reenrichSteps()`：

1. **`supplement`**（`skillId:'reenrich-supplement'`，新 step kind）——画像驱动正文缺口补全。`runtime/supplement-page.ts::runPageSupplement` 逐页调 skill 产候选 → `supplement-guard.ts::checkSupplementFidelity` 确定性护栏校验 → 不过则把违规项拼回输入重写一次 → 仍不过则**回落原文**（退化为「只叠 callout」，与改造前等价，不阻断后续阶段）。
2. **`ingest-enricher`**（fanout，复用 ingest 增益层）——叠 `[!type]` callout。
3. **`verify`**（复用 P3 联网核查/自检降级）。

`buildReenrichInitialInput` 把现有正文 seed 进 `writerOutputs`（enricher 的 `injectPriorPageAs:'draftContent'` 据此取用）；同时把 `buildProfileHint(getProfileOrDefault(LOCAL_USER_ID))` 的输出作 `profileHint` 传给 supplement 阶段。

**画像仅作探针**（`buildProfileHint`）：读取单租户画像（`LOCAL_USER_ID`）的 `backgroundSummary` + `stylePrefs`（readingLevel/verbosity/exampleDensity），拼成一句话提示——**只用来定位读者大概率不懂的概念，补充内容本身必须写成中性、对任何读者都普遍适用的讲解**；这是与 Cognitive Lens（读时按读者重塑讲法）的宪法边界：canonical 正文永远中性，读者专属讲法只在读时发生。无背景资料时回落「中级读者」中性假设。

**忠实度护栏**（`supplement-guard.ts::checkSupplementFidelity`，薄转发到统一模块 `wiki/rewrite-fidelity.ts::checkRewriteFidelity(…, FIDELITY_PROFILES.supplement)`，T1.4）——因允许「插入 + 局部改写」无法逐字比对，用组合式软护栏，floor=0.95：
- 不缩水：正文字数不得跌破原文 95%；
- 不丢失原有 wikilink（`linkRule:'preserve'`）——允许新增链接，但不许丢失原文已有的链接目标（早期版本反过来禁止新增，T1.4 改为对齐"改写不得丢事实"的统一语义）；
- 标题不减（`preserveHeadings`）：原文每个标题（级别+文字）须在候选正文原样出现；
- frontmatter 不变（`preserveFrontmatter`）：frontmatter 数据对象深度相等（JSON 规范序列化比对）。
全过才算通过；任一违规都会被收进 `violations[]` 用于重写反馈。

即便 subject `augmentationLevel` 为 `off` 也强制按 `standard` 跑（用户显式触发语义）。

emit `reenrich:start` 后进入 pipeline（supplement 阶段失败回落时额外 emit `reenrich:supplement-fallback`）；流水线完成后经 `commitPending` 收口提交（不重写 index/log）。**成熟度信号并入正文增长**：`deriveMaturityUpdate` 除原有 callout 增量外，新增 `proseGrowthIncrement(draftContent, finalContent)`（正文增长折算）一并计入 `newIncrement`，防止「多补正文少加 callout」被误判无进展。

需要 `reenrich-supplement v1` / `ingest-enricher v4` / `ingest-verifier v2` / `ingest-verifier-triage v2` / `ingest-verifier-apply v3`（不满足则 fail-fast 提示删除旧 skill 文件重播种；`reenrich-supplement` 是新文件，首次启动自动播种，无需手动删）。

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

已覆盖（`__tests__/`，vitest，以纯函数与编排为主）：`lint-deterministic`（broken-link/orphan 取数收敛后行为不变）、`maintenance-policy` / `maintenance-scheduler`、`ingest-prep` / `ingest-service` / `ingest-finalize-sources` / `ingest-augmentation-steps`、`embedding-service`、`fix-deterministic`、`lint-latest`、`reenrich-input` / `reenrich-maturity`、`conversation-title`、`query-tools`（subjectHasContent / buildQueryToolContext / accessedToContext / 工具 execute 路径）、`query-service-agentic`（streamAgenticQuery / runQuery 空库守卫）、`citation-extract`（`extractCitationsFromAnswer` 幻觉链接过滤/去重、`pickExcerpt` 原文字面子串切片，8 用例）。ingest pipeline 另见 `src/server/agents/runtime/__tests__/`。

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
├── finding-identity.ts   # 🆕 Health finding 稳定 ID（SHA-256）与快照去重
├── remediation-router.ts # 🆕 九类 finding → 服务端处置 plan 的纯路由
├── remediation-context.ts # 🆕 任务 provenance 规范化、解析与幂等匹配
├── remediation-service.ts # 🆕 统一处置校验、去重与既有 workflow 委托
├── remediation-status.ts # 🆕 有界关联 job 扫描与 HealthSnapshot 状态推导
├── research-scope.ts     # 🆕 稳定 findingIds + lintJobId 的 Research 范围解析
├── ingest-service.ts    # 多阶段 LLM 摄入（分片自适应流水线）
├── ingest-prep.ts       # 预检/预算/常量纯函数
├── query-service.ts     # 问答 + save-to-wiki + 多轮记忆（agentic 工具循环）
├── query-tools.ts       # subject-scoped 只读 ToolContext（wiki/source evidence + 可选 web.search）+ AccessedPages + subjectHasContent
├── conversation-title.ts # 确定性会话标题派生纯函数
├── lint-service.ts      # 全库 lint 扫描
├── curate-service.ts    # 🆕 agent 策展（curate 任务：tool-loop 驱动，generateTextWithTools + buildCurateToolContext + CurateGuard）
├── curate-tools.ts      # worker 侧 ToolContext：evidence reader + 写能力经 guard 把守
├── fix-service.ts       # 🆕 一键修复 lint findings（fix 任务：确定性阶段1 + LLM 阶段2 tool-loop）
├── fix-deterministic.ts # 🆕 纯函数：fixMissingFrontmatter / buildFixWorklist / buildSubjectReportLines / createFixGuard（写 cap + 保护页；忠实度已收编到 wiki/rewrite-fidelity.ts）
├── fix-tools.ts         # worker 侧 ToolContext：evidence reader + 写能力经 guard 鉴权后调 page-ops
├── reenrich-enqueue.ts  # 🆕 纯函数 validateReenrichTarget + enqueueReenrich 入队 helper（供对话工具触发）
├── page-write.ts        # 共享写工具内核：validateDeleteTarget（删除守卫单一真实源）+ deletePageInSubject / createPageInSubject / updatePageInSubject / patchPageInSubject（Saga + embed 回填，供 DELETE 路由与 wiki.delete/wiki.create/wiki.update/wiki.patch 对话工具复用；update 接忠实度护栏，patch 委托 executePagePatch 不接）
├── reenrich-service.ts  # 🆕 手动重新增益（re-enrich 任务：复用增益流水线、跳过 writer）
├── embedding-service.ts # 向量嵌入索引（embed-index 任务，Saga 外独立）（⑧）
├── maintenance-policy.ts # 🆕 纯函数：递减回报间隔策略（SPACING_LADDER / countCallouts / nextMaturity，P5；T1.8 起 nextMaturity 质量优先——qualityDelta<=0 时体量信号清零 + staleSource 前置阻断毕业）
├── page-quality-signal.ts # 🆕 T1.8：re-enrich 单页质量信号取数（IO 层，确定性零 LLM）——countPageDeterministicFindings（单页 broken-link+frontmatter）/ pageHasStaleSources（复用 lint-deterministic 单页判定，不跑全库）
└── maintenance-scheduler.ts # 🆕 纯函数：sweep 页面选取（runMaintenanceSweep，P5）
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
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
| 2026-06-27 | Cognitive Lens：新增 `reshape-service.ts`（`reshapePageBody` 整页重塑——`streamTextResponse` 收全文→`checkLinkSubset` 保真→失败重写一次→二次失败回落 canonical；`reshapeSection` 段级）+ `apply-signal.ts`（信号→最近窗口→`applySignalsToStyle` reducer→达阈值才 upsert 画像并自增 version）。均为读侧，不写 vault/不经 Saga |
| 2026-06-30 | 新增 `page-write.ts`（`validateDeleteTarget` 删除守卫单一真实源 + `deletePageInSubject`/`createPageInSubject`，同步 Saga+embed 回填，供 DELETE 路由 DRY 复用与 `wiki.delete`/`wiki.create` 对话工具复用） |
| 2026-06-30 | `curate-service` 由 triage→confirm→execute 结构化流水线改造为 tool-loop 驱动：`generateTextWithTools('curate')` + `buildCurateToolContext` + `createCurateGuard` 硬护栏；新增 `curate-tools.ts`（worker 侧 ToolContext，读已提交 vault + 写能力经 guard 鉴权后调 page-ops 内核 + emit 事件）；退休 triage/confirm 三套 schema+prompt |
| 2026-06-30 | curate follow-up：auto 模式不再解析 `wiki.create` 工具（按 `seedSet===null` 条件化 `resolve`，省模型试探步数；`guard.canCreate` 仍兜底）；`['index','log']` 保护页常量统一为 `wiki/page-identity::META_PAGE_SLUGS` 单一源（`curate-service`/`page-write`/`lint-deterministic`/`reenrich-enqueue` 不再各持副本）|
| 2026-06-30 | Fix tool-loop（Spec 3）：`fix-service` 阶段2 由逐页 `generateStructuredOutput('fix')` 改为 `generateTextWithTools('fix')` 自驱 `wiki.update`/`wiki.create`；新增 `fix-tools.ts::buildFixToolContext`（读侧同构 curate-tools + 写经 `createFixGuard`+忠实度护栏调 page-ops 内核）；`fix-deterministic` 加 `createFixGuard`、退休关联页提取（`findRelatedPageSlugs`/`mentions`/`MAX_RELATED_PAGES`）；`fix-prompt` 退休逐页 `FixPageSchema` 三件套、新增 agentic prompt；每写一次一 commit |
| 2026-07-01 | reenrich-service 加画像驱动正文补全 supplement 首阶段（`reenrich-supplement` skill + `runPageSupplement` 护栏 + `buildProfileHint` 探针提示 + `deriveMaturityUpdate` 并入正文增长）；流水线三步（supplement→enricher→verify），仅 re-enrich，ingest 不变 |
| 2026-07-06 | T1.8 成熟度信号质量化：`nextMaturity` 新增 `qualityDelta`/`staleSource` 输入，质量优先——`qualityDelta<=0` 时体量信号（callout+正文增长折算）清零，纯长肉不再续命，直接走 saturation；`staleSource=true` 时前置阻断毕业（也不快进间隔，留在当前档）。新增 `page-quality-signal.ts`（IO 层，单页确定性 findings 计数 + 单页 stale 判定，均不跑全库）；`lint-deterministic.ts` 抽出可复用的 `checkStaleSourcesForPage`；`reenrich-service.ts::deriveMaturityUpdate` 改纯函数（qualityDelta/staleSource 由调用方在 handler 里用 `page-quality-signal` 算好传入），quality 分量 = 单页确定性 findings「修复前−修复后」+ 本轮 `ctx.citedSources` 新增证据条数（未接入 verify 结构化"修订计数"，因 apply 只回传最终正文不单独暴露修了几处——用引用证据数作确定性代理，零额外 LLM 调用）；`page_maturity` 表结构不动（质量信号现场重算，无迁移）|
| 2026-07-06 | T1.4 统一保真护栏：`fix-tools.ts`（profile `fix`，floor 0.5→0.8）与 `reshape-service.ts`（profile `reshape`，新增长度 floor 0.8）改调 `wiki/rewrite-fidelity.ts::checkRewriteFidelity`；`fix-deterministic.ts::bodyShrankTooMuch` 退役（收编）；`supplement-guard.ts::checkSupplementFidelity` 收编为薄转发（profile `supplement`），链接规则由「禁止新增」改为「禁止丢失」（preserve）|
| 2026-07-07 | T3.2 Ask AI 未命中 → 待研究队列 + 联网检索：`generateQueryCitations` 二次结构化输出 schema 加 `coverageSufficient`/`suggestedResearchQuestion`（`query-prompt.ts`），不足或空库短路时 best-effort 写入 `research-backlog-repo`；新增只读 `web.search` 工具（`agents/tools/builtin/web-search.ts`，包装 `search/web-search.ts::webSearch`，`sideEffect:'none'`），仅 `isWebSearchConfigured()` 为真时经新导出的 `resolveQueryTools()` 注入 query 工具集（未配置时模型不可见）；`ToolContext` 加可选 `webSearch?`，`query-tools.ts::buildQueryToolContext` 接入；`QUERY_AGENTIC_SYSTEM_PROMPT` 补 web 结果标注纪律（不得与 wiki 引用混淆）|
| 2026-07-07 | 新增 `research-service.ts`（任务类型 `'research'`，T3.1）：缺口/主题→联网研究→候选清单，只发现不写入（零 vault/DB 写入）。三阶段：`generateStructuredOutput('research:queries')` 生成 query（失败→job 失败）→ `web-search.ts::webSearch` 逐条搜索（`allSettled`，单条失败只跳过）→ `generateStructuredOutput('research:triage')` 打分（失败降级为按排名取前 3 未评分）；纯函数收在 `src/lib/research-plan.ts`（零 server 依赖，与候选弹窗共用同一份 `defaultChecked` 等纯函数；query/候选去重截断、triage 应用/降级排序）。最初的 findings 位置索引协议已在 Phase 2A 被稳定 `findingIds + lintJobId` 取代。产出只落 job `resultJson.candidates`，确认后走现成 `POST /api/ingest { urls }`（零改动）|
| 2026-07-06 | T2.1 ingest finalize 去 LLM 化：`finalizeIngest` 不再调 `ingest-indexer`，改用 `wiki/meta-pages.ts` 纯函数 `renderIndexPage`/`renderLogPage` 确定性渲染 index/log（按 tag 分组+标题排序+`[[slug\|Title]]`；log 保留最近 50 条、新条目在前，解析既有 log 正文 bullet 行还原历史）；`MIN_SKILL_VERSIONS` 去掉 `ingest-indexer` 项，skill 文件已删（`examples/skills/ingest-indexer.md`）；`llm-config.example.json` 去掉 `ingest:indexer` 路由项。索引每页 tags 优先取本次 `ctx.pending` 内容实际写入的 frontmatter，未触碰页沿用 DB 既有 tags。动机：原方案每次 ingest 都要把全 subject 页清单塞进 prompt，页数上几百后单调膨胀直至超上下文窗口且重复付费——目录/日志本质是数据库可确定性派生的数据 |
| 2026-07-07 | Ask AI 内联引用 + 确定性解析：引用生成从"模型二次结构化输出 `generateQueryCitations`"改为"prompt 纪律要求模型正文内联 `[[slug]]` + 流后确定性解析"——新增 `citation-extract.ts::extractCitationsFromAnswer`（`extractWikiLinks` 解析答案 ∩ `accessed.bodies` 已读页，过滤幻觉链接）+ `pickExcerpt`（词重叠定位 + 原文偏移切片，excerpt 恒为页面原文字面子串），零额外 LLM 调用；`streamAgenticQuery`/`runQuery` 流末同步调用。coverage 判定与引用解耦为独立异步小调用：新增 `assessCoverageInBackground(subject, question, answer)`（fire-and-forget，只喂问题+答案，走 `CoverageSchema`/`COVERAGE_SYSTEM_PROMPT`），`false` 时仍走 `recordCoverageGap` 写 backlog；退役 `generateQueryCitations`/`QueryCitationsSchema`/`[unverified]` 前缀机制；`done` 事件不再携带 `coverageSufficient` |
| 2026-07-09 | 新增 `page-write.ts::updatePageInSubject`（校验目标页存在 + 非保护页 `META_PAGE_SLUGS`（终审发现的保护不对称补丁，对齐 `validateDeleteTarget`/fix 的 `createFixGuard`）+ 忠实度护栏 `FIDELITY_PROFILES.fix` + 调 `executePageUpdate`（支持改标题）+ `enqueueEmbedIndex`）；`query-tools.ts::buildQueryToolContext` 接入 `updatePage`（委托上述函数）；`query-service.ts::BASE_QUERY_TOOL_NAMES` 追加 `'wiki.update'`——问答（Ask AI）首次获得改写页面标题+正文的能力；`QUERY_AGENTIC_SYSTEM_PROMPT` 补 "Updating a page" 确认纪律（与 `wiki_delete` 一致，须后续轮确认）|
| 2026-07-10 | 新增 `wiki.patch` 局部更新工具：`page-write.ts::patchPageInSubject`（同 `updatePageInSubject` 的 META 保护 + `enqueueEmbedIndex`，但委托 `wiki/page-ops.ts::executePagePatch`，**不接忠实度护栏**——old_string/new_string 精确唯一替换天然风险面小于整页重写）；`fix-tools.ts::buildFixToolContext` 与 `query-tools.ts::buildQueryToolContext` 均接入 `patchPage`；`query-service.ts::BASE_QUERY_TOOL_NAMES` 追加 `'wiki.patch'`；fix/Ask AI 两侧 prompt 补写作指导：局部改动优先 `wiki.patch`，仅整页重写/改标题才用 `wiki.update` |
| 2026-07-09 | 任务日志可读性改进：`fix-service`/`curate-service` 新增 `fix:agent:start`/`fix:tool`、`curate:agent:start`/`curate:tool` 事件（`generateTextWithTools` 新增 `onToolCall?` 回调，配合新增 `lib/tool-activity.ts::toolActivityLine` 把工具调用渲染成可读一行）；`lint-service` 新增导出 `summarizeFindings`，`lint:semantic:start` 补 `pageCount`/`model`，`lint:semantic:done`/`lint:complete` 补 `bySeverity`/`byType` 分类统计。spec/plan 见 `docs/superpowers/{specs,plans}/2026-07-09-job-log-clarity*` |

---

_生成时间：2026-04-22 00:25:29_

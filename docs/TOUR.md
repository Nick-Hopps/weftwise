# weftwise 代码导览

> 目标读者：从零熟悉本项目的开发者。建议按顺序阅读，每步先读"为什么"，再打开文件看指定代码段。全程约 1–2 天。
>
> 行号基于 `main`（2026-07-26，v0.16.0）。文件与函数名是稳定锚点，行号可能小幅漂移——对不上时以函数名为准。

**阅读节奏**（共 17 步）：1–4 步建立全局与数据模型；5–6 步是全项目最关键的两条不变量（链接语义 + 写事务）；7–8 步基础设施；9–13 步主业务流与治理；14–16 步接口与前端；第 17 步闭环自测。

---

## 阶段 A · 打地基（第 1–4 步）

### 第 1 步 · 项目全景：`AGENTS.md` + `package.json`

**看什么**
- `AGENTS.md`（根目录，`CLAUDE.md` 只是指向它的一行）— 重点读"三、架构总览"的进程图 + "关键架构决策"表 + "四、模块索引"
- `package.json` 的 scripts 段：`dev:all`（同时拉起 Next.js 和 worker）、`db:rebuild`、`eval:retrieval`、`test`

**为什么从这里看**：本项目最大的认知前提是**双进程架构**——Web/API 进程只做"入队 + 读"，所有 LLM 长任务由独立 worker 执行，两者通过共享的 vault 目录 + SQLite 通信。不先建立这个心智模型，后面所有代码都会看错位置。

**读完应理解**：数据流主干是 `读资料 → LLM 规划 → 校验 → 写 vault → SQLite 索引 → git 提交`；为什么需要 Saga 事务（fs+SQLite+git 凑不出 ACID）；每个模块目录下都有一份 `CLAUDE.md`，是该模块的权威说明。

---

### 第 2 步 · 领域契约：`src/lib/contracts.ts`（1166 行）

**看什么**（不要通读，按下面锚点跳）
- `Subject`（L9–18）、`WikiPage`（L121–131）、`WikiLink`（L133–139）
- `Job`（L265–278）— 注意 10 种 `type` 联合、租约/心跳字段，这是 worker 可靠性的基础
- `ChangesetEntry`（L741–755）与 `Changeset`（L757–768）— 注意 `preHead/postHead/status` 是 Saga 回滚的锚点；`auxiliary/assetFor/attachments` 让 sidecar 与图片资产也纳入同一事务；`mutationEpoch` 用于同步写的乐观并发
- `LintFinding`（L597）/ `HealthSnapshot`（L680）— 九类 finding 与体检快照
- `PendingActionView`（L958）— 对话写入的审批态
- `AppSettings`（L1075–1113）+ 同段的一堆 `*Schema`/`DEFAULT_*` 常量 — 全 app 单实例设置的唯一契约

**为什么**：全项目所有领域类型集中在这一个文件（避免循环依赖与漂移），是阅读其余代码的"词汇表"。

**读完应理解**：每个核心实体长什么样；`Changeset` 记录 git HEAD 前后指针是为了崩溃恢复；agent/维护/联网搜索等运行参数都是 `app_settings` 表里的数据，不是环境变量。

---

### 第 3 步 · 数据库 Schema：`src/server/db/schema.ts`（518 行）+ `db/repos/`

**看什么**
- `pages`（L34–53）— **复合主键 `(subject_id, slug)` + `path UNIQUE`**，这是多主题隔离的核心设计
- `page_aliases`（L55–70）— slug 迁移后的旧身份映射（`wiki.move` 的兼容层）
- `jobs`（L117–132）— `leaseExpiresAt / heartbeatAt / attemptCount` 对应队列租约机制
- `operations`（L143–153）— Saga 变更集的持久化落点，worker 重启后据此回滚未完成事务
- `ingest_checkpoints`（L155–167）— ingest 断点续传（逐块摘要 / plan / 逐页产物）
- `pending_actions`（L190–229）— 对话写入审批状态机（注意 `operation` 的 CHECK 约束）
- `page_embeddings`（L231–245）+ `page_maturity`（L247–263）— 向量索引与"递减回报"维护节律
- Research provenance 五表（L329–501）— `research_runs / run_findings / approvals / candidates / candidate_ingests`，看一眼复合外键与唯一索引即可，细节留到第 13 步
- `llm_usage`（L503–518）— 每次 LLM 调用一行，`subject_id` 可空以保留历史未归因用量
- 顺带浏览 `db/repos/` 的文件名（17 个 repo）——**所有 SQL 都在这一层**，service/route 不写裸 SQL

**为什么**：DB 是 vault 的"可重建索引缓存"，schema 直接反映领域模型与并发设计。

**读完应理解**：跨 subject 同名 slug 为何合法；jobs 表如何同时充当队列；`operations` 表为何存在（crash recovery）；哪些表是"可从 vault 重建"的（`npm run db:rebuild` 的边界）。

---

### 第 4 步 · 语义基石：`src/server/wiki/wikilinks.ts` + `page-identity.ts`

**看什么**
- `maskCodeBlocks()`（L46–52）— 解析前先屏蔽代码块
- `parseLinkInner()`（L68–93）— `[[subject:Page|alias#section]]` 的拆解逻辑
- `extractWikiLinks()`（重载签名 L101–109，实现 L110–158）— 注意需要 `currentSubjectSlug` + `titleResolver`
- `resolveWikiLinkTarget()`（L160–173）— 全项目**唯一**的 wikilink 解析入口
- `page-identity.ts`：`parseWikiPath / wikiPathFor / normalizeSlug / META_PAGE_SLUGS / GENERAL_SUBJECT_SLUG`

**为什么**：前端渲染、indexer、lint、agent 工具、changeset 校验全部复用这一份实现；这是项目明文规定的"不得复刻"模块。`META_PAGE_SLUGS`（`index`/`log`）同样是单一真实源——保护页判定不许各处各写一份。

**读完应理解**：`[[Page]]` 默认本 subject，`[[other-subject:Page]]` 显式跨主题；任何涉及链接或 slug 的功能都必须经过这两个文件。

---

## 阶段 B · 核心不变量（第 5–6 步）

### 第 5 步 · Saga 事务核心：`src/server/wiki/wiki-transaction.ts`（540 行）

**看什么**（按执行顺序读）
1. `createChangeset()`（L41–62）— 纯内存构造，不碰 fs/DB；`captureSubjectMutationEpoch()`（L64–82）给同步写领版本号
2. `validateChangeset()`（L84–303）— 四段校验：subject 存在（L90）→ 路径归属本 subject（L97，含 sidecar/asset 的专用路径与 base64 大小限制）→ 逐条 frontmatter + wikilink 语法（L166）→ 链接目标存在性（L205，把本次 create 也算进已知 slug）
3. `applyChangeset()`（L305–469）— **黄金路径**：抢 vault 锁 → `assertCanApply` + `expectedPreHead` 复核 → 写 `operations(status='pending')` → 写 fs → SQLite 单事务（`indexer.ts::indexTouchedPages` + `page_sources`）→ git commit（message 含 `[subject:<slug>]`）→ commit 成功后才写 sidecar（L424 注释解释了为什么放在最后）→ `status='applied'`
4. `rollbackChangeset()`（L471–528）— 补偿路径：git 强制回到 `preHead` → 显式清理未跟踪的新建文件（L479 注释）→ 撤销本次新插入的 `page_sources` → reindex → `status='rolled-back'`（幂等）

**配套**：`vault-mutex.ts` — `acquireVaultLock()`（L302）是**进程内互斥队列 + 跨进程文件锁**（vault 同级 `.vault.lock`）；`isStaleLock()`（L78）/ `inspectVaultLock()`（L102）处理崩溃残留。Next.js 路由与 worker 分属两个进程，只有文件锁能保证同一时刻只有一个进程在执行 Saga。

**为什么**：这是全项目最关键的不变量——任何 wiki 写入都必须走这条链路，不能绕过。

**读完应理解**：四步顺序与失败分支；为何 rollback 必须幂等（worker 可能在任意点崩溃后重放）；为什么 sidecar 写入失败不回滚已提交的 changeset。

---

### 第 6 步 · 任务队列与 Worker：`src/server/jobs/` + `worker-entry.ts`

**看什么**
- `queue.ts`（89 行，通读）：`enqueue()`（L4）、`claim()`（L12，原子 `pending→running` 并写租约）、`getOrCreateJobAtomic()`（L58）与 `reingestSourceAtomic()`（L64，幂等去重）、`reclaimExpired()`（L70）、`requestCancel()`/`isCancelRequested()`（L74/L78，协作式取消）
- `worker.ts`：常量段（L34–39，`MAX_RETRIES=2` / 30s 心跳 / 60s 维护 tick / job_events 保留 7 天）、`isRetryableError()`（L149，只重试瞬时错误）、`decideJobFailureAction()`（L188）、**`decideClaim()`（L207–217，纯函数：仅 ingest 之间可并发、非 ingest 独占）**、`runJob()`（L222–301）、`startWorker()`（L303–381，轮询 + 维护 tick：清 job_events/operations/usage、PendingAction TTL、Research 对账、维护 sweep）
- `worker-entry.ts`：L32–41 通过副作用 import 注册 **10 个 service handler**（正好对应 `Job.type` 的 10 种）；`bootRuntime()`（L45–61）构建 skill/tool registry；`main()`（L63–213）启动序列：初始化 DB → seed `general` → FTS 自愈 → **回收过期租约 → 回滚 pending operations** → sidecar 对账 → 启动轮询 → 注册优雅关停

**为什么**：理解"长任务为何可靠"——租约 + 心跳 + 启动时补偿，是双进程架构的另一半。`decideClaim` 是并发模型的全部：Ingest 有界并发（上限读 `app_settings.ingestConcurrency`，1–4），其余任务独占。

**读完应理解**：一个 job 从入队到完成/失败/重试/取消的完整生命周期；worker 重启时如何把上一次崩溃的 Saga 收拾干净；并发只发生在 Ingest 之间，而写 vault 仍被 vault-mutex 串行化。

---

## 阶段 C · 基础设施（第 7–8 步）

### 第 7 步 · LLM 多供应商路由：`src/server/llm/`

**看什么**
- `task-router.ts::resolveTask()`（L13–88）— 三层合并：`defaults < task config < call-site override`，输出 provider profile + model + CallSettings
- `provider-registry.ts`：`generateStructuredOutput()`（L111–202，包 `generateObject()` + zod schema + 超时/外部 AbortSignal 合并 + schema 失败定向重试）、`streamTextWithTools()`（L255）/ `generateTextWithTools()`（L313，两个工具循环 runner，后者带 `onToolCall` 回调供任务日志用）、`recordCallUsage()`（L27，写 `llm_usage`）、`startCancelPolling()`（L51，把 job 取消标记接到 AbortSignal）、`generateEmbeddings()`（L412）

**为什么**：项目铁律是"LLM 只许产出结构化对象或经受控工具循环写入，禁止直出 markdown 文件"，这几个函数就是该铁律的实现点；新增任何 LLM 任务类型都从这里接入（`llm-config.json` + `LLMTaskSchema` + prompt）。

**读完应理解**：`llm-config.json` 的配置如何被解析成实际模型调用；结构化输出与工具循环两条路径的区别；取消与超时如何贯穿到 provider 层；用量为什么能按 subject 归因。

---

### 第 8 步 · 检索层：`src/server/search/`

**看什么**（五个文件都很短，全读）
- `vector-math.ts`（51 行）：`encodeVector/decodeVector`（Float32 BLOB）、`cosineSimilarity`、`rrfMerge()`（L38）
- `semantic-search.ts`（19 行）：`semanticSearch()` 向量 topK
- `hybrid-retrieval.ts`（24 行）：`RRF_K=60` / `VEC_K=10` 常量 + `hybridRankSlugs()`（L10，FTS + 向量 RRF 合并；未配置 embedding 时退化为纯 FTS）
- `web-search.ts`（91 行）：`isWebSearchConfigured()` / `webSearch()` / `extractContent()`（Tavily，配置实时读 `app_settings`）
- `eval-metrics.ts`：`recallAtK` / `reciprocalRank` / `summarizeEval` 纯函数

**为什么**：检索被三处复用——Ask AI 工具循环、ingest fanout 的"相关既有页裁剪"、lint/curate 的邻居扩展。另有硬性纪律：**改动 `search/**` 或其参数必须附 `npm run eval:retrieval` 前后对比数字**（recall@5/10 + MRR）。

**读完应理解**：混合检索的合并方式与降级路径；为什么向量表可以随时重建（`content_hash + model` 判过期）。

---

## 阶段 D · 主业务流与治理（第 9–13 步）

### 第 9 步 · Ingest 流水线：`src/server/services/ingest-service.ts`（512 行）

**看什么**
- `buildIngestSteps()`（L74–95）— **纯函数，一眼看清整条流水线**：（大文件才有的 map 逐块摘要）→ `ingest-planner` sequence → `ingest-writer` fanout → （`level!=='off'` 才有的 `ingest-enricher` fanout + `verify`）
- `registerHandler('ingest')`（L97–343）— 通读，重点看：源加载与 URL 登录态 grant（L113–144）→ `prepareIngest` 预清洗+切块（L147）→ 断点续传（L157–174，URL 源每次重抓并清旧 checkpoint）→ **预算预检 fail-fast**（L176–190）→ skill 版本守卫（L199–213）→ 组装 `AgentContext`（L218–239，注意 `estimateFanoutReserve` 与 `retrieveRelevantPages` 两个注入）
- `finalizeIngest()`（L380–437）— service 层收口：`wiki/meta-pages.ts` 纯函数确定性渲染 index/log（**不走 LLM**）→ 把 `ctx.citedSources` 经 `extractContent` + `buildWebSourceImports`（L455）导入为网页 source → `commitPending` 一次原子提交
- 配套：`ingest-prep.ts`（预算/切块常量与估算纯函数）、`sources/source-loader.ts`（上传文件 vs URL 链接两种输入）、`sources/source-store.ts`（hash 去重 + sidecar）

**为什么**：这是项目的"主业务流"——知识进入 wiki 的主入口，也是 multi-agent runtime 的主要调用方。

**读完应理解**：一份 PDF/网页从提交到变成多个 wiki 页面的完整阶段划分；为什么所有内容 agent 都只读、提交统一由 service 层做；断点续传与预算预检各自防的是什么。

---

### 第 10 步 · Multi-Agent Runtime 与工具治理：`src/server/agents/`

**先读 `src/server/agents/CLAUDE.md`**（有完整流水线 ASCII 图），再看代码：

- `runtime/orchestrator.ts::runPipeline()`（L35–263）— 四种 step 类型：`sequence`（L43，carry 上下文 + plan 检查点）、`map`（L60，semaphore 并发块摘要）、`fanout`/`verify`/`supplement`（L118，共用骨架，逐项预扣预算 + 逐页检查点 + `ctx.pending` 按 path last-write-wins upsert）
- `runtime/agent-loop.ts::runAgentLoop()`（L33–169）— 单 agent 循环；三条执行路径（纯结构化 / 工具循环 / 有 tools + 有 schema 的"组合路径 + 合成 finish 工具"），以及一堆 provider 兼容修复（`recoverStructuredOutput` / `repairToolCallArgs`）
- `runtime/budget.ts`、`overlay-vault.ts`、`checkpoint.ts`、`verify-page.ts`、`supplement-page.ts`、`commit-pending.ts` — 各看一眼导出签名
- `skills/`：`builtin-manifest.ts`（8 个内置 skill 文件清单 + 可升级/retired 的 SHA-256 白名单）、`loader.ts::loadSkillsFromDir()`（skill 就是 `.md`：frontmatter + outputSchema + markdown 正文当 system prompt）、`registry.ts`（播种到 `vault/.llm-wiki/skills/`，只自动升级 hash 精确匹配的原版，用户改版永远保留）
- `tools/`：`builtin/index.ts::createBuiltinToolRegistry()`（L35–67，**30 个 builtin tool，进程无关无单例**）、`profiles.ts`（`ToolProfileId` L4–13 共 **9 个 profile**，`PROFILES` L69–135，`resolveToolProfile`/`createToolExecutionPolicy`/`profileForIngestSkill`）、`compile.ts::compileToolSet()`（policy 必传：过滤 profile 外工具、拒绝未允许的 sideEffect、校验 subject 与 job capability、包裹 page scope、脱敏审计）、`evidence-reader.ts`（确定性证据读取层）

**为什么**：pipeline step 是数据、runtime 是解释器；而 `profiles.ts` + `compile.ts` 是**运行时授权边界**——"谁能写、能写哪些页、要不要审批"由这一层强制，不靠 prompt 自觉。

**读完应理解**：fanout 的 overlay 快照隔离如何让多个 writer 并行而不互相污染；一个 skill 想调新工具需要同时改哪几处；为什么 ingest 的 agent 一个写工具都没有。

---

### 第 11 步 · 对话写入审批闭环：`query-service.ts` + `pending-action-service.ts`

**看什么**
- `services/query-service.ts`：`resolveQueryTools()`（L57，按 mode 决定工具面）、`streamAgenticQuery()`（L159，流式工具循环）、`runQuery()`（L202）、`saveQueryAsPage()`（L230）、`registerHandler('save-to-wiki')`（L339）
- `services/query-intent.ts` — 每轮先用一次结构化 LLM 分类 `read / propose / direct-reenrich / image-insert / reset-*`，**没有自然语言正则**
- `services/query-tools.ts` — `buildQueryToolContext()`（默认严格只读；只有传入已校验 conversationId 才注入 preview 与 `onPendingAction`）、`createAccessedPages()`（跨 subject 用复合身份键，避免同名 slug 串显）
- `services/citation-extract.ts::extractCitationsFromAnswer()` — 流后确定性解析：答案里的 `[[slug]]` ∩ 本轮真正读过的页；`pickExcerpt` 保证摘录恒为页面原文子串（零额外 LLM 调用）
- `services/pending-action-service.ts`：`createPendingActionPreview()`（L276）与四个同族 preview 入口（tag-batch / history-revert / workflow / image-insert）、`approvePendingAction()`（L613，原子 claim + 复算 hash + HEAD 变化则刷新预览要求重批）、`rejectPendingAction()`（L824）
- `services/pending-action-finalizer.ts` — job insert / cancel 与 `action='applied'` 在同一 SQLite IMMEDIATE 事务里落地

**为什么**：Ask AI 能改 wiki，但**模型永远拿不到直接执行的写工具**——它只能生成持久化的 PendingAction，由独立的批准 API 重新规划后执行。这是与第 5 步 Saga 并列的第二条安全不变量。

**读完应理解**：propose 与真实写入之间的隔离带在哪；预览为什么会 stale（HEAD/payload hash）；引用为什么不可能是幻觉链接。

---

### 第 12 步 · Health 闭环：lint → remediation → Fix / Curate / Research

**看什么**（这一步只求看懂骨架，细节读 `services/CLAUDE.md`）
- `lint-service.ts::runLintJob()`（L85）+ `lint-deterministic.ts` + `lint-semantic.ts` + `lint-semantic-validation.ts` — 确定性扫描 + 语义发现；**语义输出必须带 `targetSlug + evidence[{pageSlug, quote}]`，并由服务端对当前 vault 做第二次事实校验**，证不出来的直接丢
- `finding-identity.ts::findingId()`（L23）— finding 稳定 ID（v1 描述哈希 / v2 结构化元组，SHA-256）
- `remediation-router.ts::routeFinding()`（L24）— 九类 finding → 服务端 `RemediationPlan` 的**纯函数**（不读 DB、不入队）
- `remediation-service.ts::remediate()`（L45）— 统一执行入口：CAS 校验 `lintJobId` → 稳定 ID 校验 → 原子 get-or-create 去重 → 委托 fix/curate/research/re-ingest
- `remediation-status.ts::buildHealthSnapshot()`（L38）— 有界读 jobs + Research run，把已完成验证的 finding 投影出快照
- `fix-service.ts` / `curate-service.ts` — 两条 tool-loop 工作流，重点看 `createFixGuard` / `createCurateGuard`（caps + 保护页 + 忠实度护栏）与 `postcondition-verifier.ts` 的写后定向校验
- `research-service.ts::runResearchJob()`（L183）→ `research-approval-service.ts` → `research-import-service.ts` → `research-provenance-reconciler.ts` — 联网研究的"只发现 → 稳定候选快照 → 原子批准 → 租约逐条导入 → 终态对账"四段

**为什么**：这是"知识库自我维护"的全部机制，也是项目里状态机最密的一块。它示范了本项目处理不确定性的统一姿势：**LLM 只提议，服务端确定性校验与物化**。

**读完应理解**：一条 finding 从被发现到被修复/被忽略要经过哪些 ID 与 CAS 校验；为什么 Fix 完成后不再自动跑一次全库 lint（改为消费 `perFindingOutcomes`）。

---

### 第 13 步 · 读侧个性化：Cognitive Lens + 维护节律

**看什么**（可略读，理解边界即可）
- `services/reshape-service.ts` + `apply-signal.ts` + `api/lens/[...slug]/route.ts` — 读时按读者画像重塑讲法，**纯读侧：不写 vault、不经 Saga**，产物落 `page_renditions`
- `services/reenrich-service.ts` — 手动重新增益（写侧）：三阶段 `supplement → enricher → verify`；`buildProfileHint()` 把画像**只当探针**用来定位读者可能不懂的概念，补充内容本身必须中性
- `services/maintenance-policy.ts`（`SPACING_LADDER` / `nextMaturity` 递减回报节律）+ `maintenance-scheduler.ts::runMaintenanceSweep()`

**为什么**：这里有一条容易被违反的宪法边界——**canonical 正文永远中性，读者专属讲法只在读时发生**。写侧（re-enrich）用画像只是为了选题，不是为了改语气。

**读完应理解**：Lens 与 re-enrich 的分工；`page_maturity` 如何决定一个页面下次何时被自动重新增益。

---

## 阶段 E · 接口与前端（第 14–16 步）

### 第 14 步 · API Route 标准模式：`src/app/api/ingest/route.ts` + `middleware/subject.ts`

**看什么**
- `api/ingest/route.ts`（162 行，通读）：`requireAuth`（L16）→ `requireCsrf`（L18）→ 分支解析 multipart / JSON / **URL 批量**（L76–111）→ `resolveSubjectFromRequest`（L133）→ `acquireSubjectWriteLease` + `persistSourceAndEnqueueIngest`（L137–143）→ 立即返回 **202 + jobId**（L145）
- `middleware/subject.ts::resolveSubjectFromRequest()`（L49–93）— 解析优先级：`?subjectId` > `?s=` > body > cookie `wiki_subject` > general 兜底；`required:true` 时缺失直接 400
- 顺带扫一眼 `src/app/CLAUDE.md` 的路由总表（当前 53 个 `route.ts`，含 pending-actions / health/remediations / research-runs / jobs 的 retry & url-auth）

**为什么**：这一个文件就是所有写接口的模板；subject 解析的"服务端唯一真实源"也在这里体现。

**读完应理解**：写接口三件套（auth + csrf + subject）；为什么 Route Handler 里看不到任何 LLM 调用与 git 操作；所有 Route 必须 `export const runtime = 'nodejs'`（better-sqlite3 不兼容 Edge）。

---

### 第 15 步 · 前端状态与数据获取：store / api-fetch / hooks

**看什么**
- `src/stores/ui-store.ts`（329 行）：`UIState`（L28 起，注意 `currentSubjectId/Slug`、Ask AI 悬浮面板状态、`pendingChatReference` 选区信箱）、`setCurrentSubject()`（L298–305，**同步写 cookie** 让服务端可读）、persist 配置（L307–328，`version: 6` + `partialize`）、`migratePersisted()`（L139–200，v1→v6 逐档迁移）
- `src/lib/api-fetch.ts`：`apiFetch()`（L14，自动带 cookie / API key）、`useApiFetch()`（L80–96，**GET 自动注入 `?subjectId=`**；POST 仍由调用方在 body 里显式带）
- `src/hooks/use-job-stream.ts::useJobStream()`（L34 起）— SSE 订阅 `/api/jobs/{id}/events`，`Last-Event-Id` 续播 + 终态门闩（`terminalRef`，防止已结束的 job 被重新订阅）
- 顺带浏览 `src/hooks/` 其余文件名：`use-current-subject` / `use-switch-subject` / `use-lens` / `use-profile` / `use-text-selection` / `use-lint-summary`

**为什么**：前端与后端 subject 体系的对接点就在前两个文件；长任务进度如何实时到达 UI 在第三个文件闭环。

**读完应理解**：subject 在 store（内存）与 cookie（服务端可读）间的双写同步；为什么禁止手写 `fetch('/api/...')`；持久化设置（如 `wikiLanguage`）为什么**不**镜像进 Zustand。

---

### 第 16 步 · 三联布局与 Ask AI：`src/components/layout/`

**看什么**
- `shell.tsx`（137 行，通读）：Header（L77）+ 可拖拽 Sidebar（L81–96，拖拽 L38–62）+ main（L115–121，**双击空白唤起 Ask AI**，L64–73 是命中判定）+ 仅 wiki 路由展示的 docked ContextPanel（L124–131）+ `AskAiFloatingPanel`（L134）
- `ask-ai-floating-panel.tsx` — 桌面 fixed 悬浮 + 拖动/resize；移动端退化为 Bottom Sheet
- `context-panel-context-tab.tsx` — 页面检查器（backlinks / frontmatter / 迷你图）；注意 Ask AI 已从这里搬走，Context 面板现在是纯检查器
- `header.tsx`（SubjectSwitcher ⌘O、命令面板、Settings）、`sidebar.tsx`（目录树 + Sources 列表）
- `src/components/shared/{global-job-tracker,jobs-panel}.tsx` — 聚合任务面板：轮询 running+pending，每 running 行独立 SSE

**为什么**：这是 "The Triad" UX 原型的当前形态，串起前面所有 store 状态；任务面板是第 6 步 worker 并发模型在 UI 上的直接投影。

**读完应理解**：页面如何由布局组件 + Zustand 状态组合；正文选区/双击如何变成一次带引用的提问；多个并发 Ingest 在 UI 上如何各自追踪。

---

## 第 17 步 ·（收尾自测）跟踪两条完整链路

不读新文件，在脑中（或加日志）走一遍，验证理解。

**链路一：一次 Ingest**

```
提交文件/URL → /api/ingest（auth → csrf → subject → 写 source + 入队, 202 + jobId）
  → worker decideClaim → claim → ingest handler
      加载源（URL 现抓）→ 预清洗 + 切块 → 载入 checkpoint → 预算预检 → skill 版本守卫
  → runPipeline：map 逐块摘要 → planner → writer fanout ×N → enricher fanout ×N → verify ×N
      （全程只往 ctx.pending 暂存，无任何写盘工具；逐页落 checkpoint）
  → finalizeIngest：meta-pages 纯函数渲染 index/log + 导入被引网页源
  → commitPending → createChangeset → validateChangeset
  → 抢 vault 锁 → 写 fs → SQLite tx（indexTouchedPages + page_sources）→ git commit "[subject:xxx]" → 释放锁
  → 入队 embed-index（+ 可选 curate）→ job complete → SSE → use-job-stream → UI 更新
```

**链路二：一次对话写入**

```
Ask AI 提问 → /api/query（auth/csrf/subject）
  → classifyQueryIntent 一次结构化分类 → 按 mode 解析 profile + policy → compileToolSet
  → 工具循环（只读证据工具 + preview 提案工具）→ 生成 PendingAction 持久化 → pending-action SSE
  → 用户点批准 → /api/pending-actions/[id]/approve
      原子 claim → 复算 payload hash → 重新规划 plan → expectedPreHead 复核
      → 页面类走 Saga（同链路一后半段）/ workflow 类走 finalizer 原子入队
  → 缓存失效 + UI 刷新
```

能不翻文档复述这两条链 + 每步对应的文件，导览即完成。

---

## 附 A · 阅读顺序速查

| 步 | 主题 | 文件 | 关键锚点 |
|---|---|---|---|
| 1 | 全景 | `AGENTS.md`, `package.json` | 进程图、决策表、`dev:all` |
| 2 | 契约 | `src/lib/contracts.ts` | L9 / L265 / L741–768 / L1075 |
| 3 | Schema | `src/server/db/schema.ts` + `db/repos/` | L34 / L117 / L143 / L190 / L329 |
| 4 | Wikilink & 身份 | `wiki/wikilinks.ts`, `wiki/page-identity.ts` | L46–173 |
| 5 | Saga | `wiki/wiki-transaction.ts`, `wiki/vault-mutex.ts` | L41–528 / L302 |
| 6 | 队列/Worker | `jobs/{queue,worker}.ts`, `worker-entry.ts` | queue 全文 / worker L207–381 / entry L32–213 |
| 7 | LLM 路由 | `llm/{task-router,provider-registry}.ts` | L13–88 / L111–202, L255–384 |
| 8 | 检索 | `search/*.ts`（5 个文件，共 ~230 行） | 全读 |
| 9 | Ingest | `services/ingest-service.ts`, `ingest-prep.ts` | L74–95（先看）/ L97–343 / L380–437 |
| 10 | Agents & 工具治理 | `agents/`（先读其 `CLAUDE.md`） | orchestrator L35–263 / profiles L4–135 / compile |
| 11 | 对话写入审批 | `services/{query-service,query-tools,pending-action-service}.ts` | L57–339 / L276–824 |
| 12 | Health 闭环 | `services/{lint,remediation-*,fix,curate,research-*}` | routeFinding L24 / remediate L45 / buildHealthSnapshot L38 |
| 13 | 读侧个性化 | `services/{reshape,reenrich,maintenance-*}-service.ts` | 边界为主 |
| 14 | API 模式 | `api/ingest/route.ts`, `middleware/subject.ts` | L15–162 / L49–93 |
| 15 | 前端数据 | `stores/ui-store.ts`, `lib/api-fetch.ts`, `hooks/use-job-stream.ts` | L139–328 / L80–96 / L34+ |
| 16 | 布局 UI | `components/layout/shell.tsx` 等 | L16–137 |
| 17 | 自测 | —（两条链路复述） | — |

---

## 附 B · 边看边跑

```bash
npm run dev:all          # Next.js + worker 一起起（开发必用）
npm test                 # vitest 全量（315 个测试文件 / 2186 用例）
npm run test:report      # 生成本地测试用例 HTML 报告
npm run eval:retrieval   # 检索基线（改 search/** 时必跑，附前后对比）
npm run db:rebuild       # 从 vault 全量重建 SQLite 缓存（跑前先停 worker）
```

读某个模块时，配套翻它 `__tests__/` 下的测试——本项目的纯函数（wikilinks / changeset 校验 / decideClaim / routeFinding / meta-pages / fidelity 护栏）几乎都有单测，测试往往比代码更快说明契约边界。

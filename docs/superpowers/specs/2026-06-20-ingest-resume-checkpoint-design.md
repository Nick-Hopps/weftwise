# Ingest 断点续传 + 重试设计

> 日期：2026-06-20
> 状态：已确认，待写实现计划
> 范围：仅 `ingest` 任务流水线（不动 query / lint）

---

## 一、背景与问题

书本级文本量的 ingest 一旦中途失败，当前**没有任何复用机制**：worker 的 `requeue` 虽保留 job ID，但 handler 会从头重跑整条流水线（解析 → 切块 → chunk 摘要 → planner → writer×N → reviewer），已经成功产出的昂贵 LLM 产物全部丢弃重算。对一整本书来说这是巨量 token 浪费。

三段昂贵 LLM 工作：

1. **chunk 摘要**（map 步，N 次调用）——仅大文件路径触发；
2. **planner 出 plan**（1 次大上下文调用）；
3. **writer 逐页生成**（fanout，N 次调用，**最贵**）。

最后 reviewer 一次性 `commit_changeset`（Saga 事务）。

目标（Nick 确认）：

- **断点续传**：失败后在"已成功处理"的基础上再次执行，跳过已完成产物；
- **续传粒度 = 页级**：逐 chunk 摘要、逐页 writer 产出都能单独跳过——100 页里第 73 页失败，重试只补未写页；
- **重试按钮**：失败时一键重跑；入口**跨刷新持久**——书本级长任务关掉标签页再回来仍能重试。

---

## 二、现状数据流（事实基础）

`ingest-service.ts::registerHandler('ingest', ...)`：

1. `loadCleanText` 解析源文件 → `cleanText`；
2. `prepareIngest([{sourceId, filename, cleanText}])` → 切块（确定性纯函数，零 token），构建 `chunkStore`（块全文）/ `chunkRefs` / `outline`；`updateSourceChunks` 落 sidecar；
3. 预算预检：`estimateIngestCost(...) > agentMaxTokensPerJob` 则 throw（fail-fast）；
4. 构建 `AgentContext`（`types.ts:86`），含 `pending:{entries:[]}`、`overlay`、`chunkStore`、`budget`；
5. `runPipeline({ steps, resolveSkill, ctx, initialInput })`（`orchestrator.ts:25`）按 step 顺序执行：
   - `[大文件] map` `ingest-chunk-summarizer` × N：逐块摘要写回 `carry.chunkRefs`；
   - `sequence` `ingest-planner`：产 `plan.pages[]`（带 `sourceRefs`）；
   - `fanout` `ingest-writer` × N：每页产出一个 changeset entry，并入 `ctx.overlay` + `ctx.pending.entries`；
   - `sequence` `ingest-reviewer`：读全部 writer 产出 → `commit_changeset`（提交 `pending ∪ input.entries`）。

**关键事实——所有中间产物都是内存态，失败即丢：**

| 产物 | 存放 | 失败后 |
|------|------|--------|
| chunk 摘要 | `carry.chunkRefs[].content`（内存） | 丢 |
| plan | `carry.plan`（内存） | 丢 |
| writer 每页产出 | `ctx.pending.entries`（内存） | 丢 |
| chunkStore（块全文） | `ctx.chunkStore`（内存） | 重建（确定性，零 token，**无所谓**） |

更糟：fanout 的 `runWithSemaphore`（`orchestrator.ts:218`）首个 writer 报错即 `failed=true` 停止派发并抛出，`for (const r of results)` 那段 push pending 的逻辑根本到不了——**单页失败连已完成页都一起丢**。

worker 重试（`worker.ts:112-122`）：仅瞬时错误（timeout/429/...）自动 `requeue` 同一 job ID；业务错误（`BudgetExceededError`/`WriterConflictError`/`AgentCancelled`/`SubjectError`）不重试。无论哪种，requeue 后 handler 都从头重跑。

前端：`dashboard-ingest-panel.tsx` 经 `use-job-stream`（SSE）显示状态；失败仅显示 "Ingest failed" + "Ingest another source"（reset），**无重试**。`queue.requeue` 存在但无 API 暴露。

---

## 三、确定性前提（断点 key 稳定性的事实基础）

页级续传要求"同一 job 重试时各产物的 key 完全一致"，否则缓存命中失效。已核实：

- **chunk id = `c${i}`**（`source-chunker.ts:80`，按源内顺序生成，注释明确"源内顺序稳定"）；
- 源内容按 `sourceId` 不可变（source-store 持久化）；
- `cleanSourceText` / `chunkText` / `gpt-tokenizer` 全是纯函数/确定性。

→ 重试时 `prepareIngest` 重跑得到**字节一致**的 `chunkStore`，key `${sourceId}:c${i}` 稳定。
→ `plan` 一旦缓存，重试直接复用同一份 plan，writer 页面的 `path` 因而也稳定 → `writer-page:<path>` key 稳定。

唯一的跨运行确定性要求落在 chunk id 上（已满足）；plan / writer 的 key 稳定性由"缓存 plan 本身"保证。

---

## 四、方案选型

| 方案 | 做法 | 取舍 | 结论 |
|------|------|------|------|
| **A. SQLite 检查点表** | 新增 `ingest_checkpoints` 表，每个产物一行；增量 upsert，成功即删 | 与 `job_events` 同属"job 运行态、不可重建"先例；WAL 崩溃安全；事务化 upsert；删除简单 | **采用** |
| B. Vault JSON sidecar | 写 `vault/.llm-wiki/checkpoints/<subject>/<jobId>.json` | 每页完成都重写整块 JSON（书本级=频繁大写）；并发 writer 写同文件需锁；中途崩溃易损坏；过度持久（检查点本是临时态） | 否决 |
| C. 渐进式 git 提交 | 丢 Saga 一次性提交，每页写一次 vault | 与 Saga"全或无"、"仅 reviewer 可写"边界、跨页 wikilink 校验全冲突，高风险 | 否决 |

**采用 A**：检查点是 job 生命周期内的临时运行态，成功即销毁，天然属 SQLite（与 `job_events` 一类，非 vault 权威源）。增量逐产物写入最省、最安全。

---

## 五、详细设计

### A. 检查点存储

**新表**（`db/schema.ts`，drizzle 迁移经 `db:generate` + `db:migrate`）：

```
ingest_checkpoints
  job_id      TEXT NOT NULL      -- 关联 jobs.id（同 job_events，不设硬 FK 约束以与现有风格一致）
  kind        TEXT NOT NULL      -- 'chunk-summary' | 'plan' | 'writer-page'
  key         TEXT NOT NULL      -- chunk: `${sourceId}:c${i}` | plan: '' | writer-page: plan page 的 slug（确定性身份，见下）
  data_json   TEXT NOT NULL      -- 产物 payload（见下）
  created_at  TEXT NOT NULL
  PRIMARY KEY (job_id, kind, key)
```

各 kind 的 `data_json`：

- `chunk-summary` → `{ summary: string }`
- `plan` → planner 步骤的完整输出对象（`{ plan: {...}, ...carryThrough 之外的 planner 产出 }`）
- `writer-page` → `{ action, path, content }`（即 `ChangesetEntry` 骨架，writer v3 扁平输出）；**按 plan page 的 `slug` 存取**，而非 writer 输出的 `path`——查缓存发生在 writer 运行**之前**，只能用输入 plan page 的稳定身份；writer 输出 `path = wiki/<subjectSlug>/<slug>.md`（writer skill 规则 1）由 slug 确定性派生，但绝不能依赖 LLM 一定回显正确 path 来命中缓存

**新 repo** `db/repos/checkpoints-repo.ts`：

```ts
getCheckpoints(jobId): { kind: string; key: string; data: unknown }[]
putCheckpoint(jobId, kind, key, data): void   // INSERT OR REPLACE
deleteCheckpoints(jobId): void
getProgress(jobId): { plan: boolean; chunkSummaries: number; writerPages: number }  // 给 UI / 预检折减
```

### B. 恢复感知的 orchestrator

在 `AgentContext`（`types.ts:86`）新增可选句柄：

```ts
checkpoint?: CheckpointHandle;
```

`CheckpointHandle`（内存索引 + 落盘双写，构建于 handler，封装 checkpoints-repo）：

```ts
interface CheckpointHandle {
  getChunkSummary(key: string): string | undefined;
  putChunkSummary(key: string, summary: string): void;
  getPlan(): unknown | undefined;
  putPlan(output: unknown): void;
  getWriterPage(slug: string): ChangesetEntry | undefined;   // slug = plan page 身份
  putWriterPage(slug: string, entry: ChangesetEntry): void;
  hasAny(): boolean;
  progress(): { plan: boolean; chunkSummaries: number; writerPages: number };
}
```

构建时一次性 `getCheckpoints(jobId)` 载入内存索引（避免每次查询命中 DB）；各 `put*` 同步写内存 + 落盘。`ctx.checkpoint` 为 `undefined` 时 orchestrator 行为与现状完全一致（向后兼容、便于测试）。

orchestrator 在每个 LLM 调用点"先查后跑"：

- **map（`orchestrator.ts:42`）**：对每个 `item`，先 `ckpt.getChunkSummary(item.key)`；命中则直接 `return {...item, content: summary}`（**跳过 LLM**）；否则跑 summarizer，成功后 `ckpt.putChunkSummary(item.key, summary)` **立即落盘**再返回。
  - 单块失败降级为空摘要的现有逻辑保留；空摘要**不落盘**（下次重试仍尝试补摘要）。

- **planner（sequence，`orchestrator.ts:33`）**：进入该 step 前先 `ckpt.getPlan()`；命中则把它当作 `runAgentLoop` 的 `r.output`（**跳过 LLM**），其余合并逻辑（`carryThrough`）不变；否则跑 planner，成功后 `ckpt.putPlan(r.output)`。
  - 命中缓存 plan 时 `carry` 的重建：`carryThrough` 的来源是 `initialInput`（`existingPages`/`outline`/`languageDirective`/`subjectSlug`/`chunkRefs`/`sources`），每次运行确定性重建，故 `carry = { ...pickKeys(carry, carryThrough), ...cachedPlan }` 与正常跑出来的结构一致。

- **writer（fanout，`orchestrator.ts:94`）**：对每个 plan page，先 `ckpt.getWriterPage(item.slug)`（用**输入 plan page 的 slug**，因查缓存在 writer 运行前）；命中则跳过 `runAgentLoop`，直接把缓存 entry 用于后续 merge / overlay / pending（**跳过 LLM**）；否则跑 writer，**在每个 writer 完成的瞬间**（`runWithSemaphore` 的 `fn` 内、barrier 之前）`ckpt.putWriterPage(item.slug, entry)` 立即落盘。
  - 因即时落盘，fail-fast 中止时已完成 + 在飞（Promise 已 resolve）的页都已持久化 → 重试只补未写页。
  - merge 阶段的 `WriterConflictError` 去重检测照旧（缓存页同样参与，保证一致性）。

> 改动集中在 orchestrator 的三个 step 分支 + `runWithSemaphore` 的 `fn`；`runPipeline` 签名不变（`ctx` 内多一个可选 `checkpoint`）。

### C. handler 恢复触发 + 成功清理

`ingest-service` handler：

1. 解析 + `prepareIngest`（**始终重跑**，零 token，重建稳定 key 的 chunkStore）；
2. 构建 `CheckpointHandle`（载入 `getCheckpoints(job.id)`）挂到 `ctx.checkpoint`；
3. 若 `ckpt.hasAny()`：emit `ingest:resuming`，带 `progress()` 摘要（如 `plan 已缓存 / 80 块摘要 / 40 页已写`）；
4. **恢复期把已缓存的 writer 页预热进 `ctx.overlay` + `ctx.pending.entries`**——保证即使本次没有任何新 writer 运行（全部命中缓存），reviewer 仍能看到全部页面并提交；
5. `runPipeline(...)` 自然跳过已完成项；
6. **成功返回前** `deleteCheckpoints(job.id)`（reviewer commit 成功 = handler return 成功）。

> 注：reviewer 步**永远重跑**——它的修正页 / index / log 不进检查点（reviewer 相对一本书是廉价的一次调用）。reviewer 失败时检查点保留（仅 handler 成功 return 才删），下次重试 reviewer 从缓存的 writer 页重读再提交。

### D. 预算预检的恢复折减

`estimateIngestCost` 估的是**整本**成本。恢复时若不折减，预算近临界的书会被预检反复拦在门外（尤其当上次失败正是 `BudgetExceededError`）。

设计：预检在恢复态按已缓存产物**折减估算**——

```
remaining ≈ estimateIngestCost(full)
            − cachedChunkSummaries × PER_CHUNK_OVERHEAD_TOKENS
            − cachedWriterPages 的近似单页成本
            − (plan 已缓存 ? planner 预留 : 0)
```

折减是保守下界即可（宁可放行后由 `BudgetTracker` 运行期兜底）。这样一本接近预算上限的书可以跨多次重试逐步写完。`getProgress(jobId)` 提供折减所需计数。

### E. 重试 API

新增 `POST /api/jobs/[id]/retry`（`src/app/api/jobs/[id]/retry/route.ts`）：

- `requireAuth(request)` + `requireCsrf(request)`；
- `queue.get(id)` 校验存在；`status === 'failed'`；`type === 'ingest'`（v1 仅 ingest，其余 422）；
- `queue.requeue(id)`（无条件——刻意绕过 `isRetryableError`，让用户能手动重试 `BudgetExceededError` 等业务失败；配合断点，重试实际消耗更少）；
- emit `job:retrying`（让正在监听的 SSE 客户端切回 streaming）；
- 返回 202 + 更新后的 job。

### F. 前端：按钮 + 跨刷新持久

- **重试按钮**：`dashboard-ingest-panel.tsx` 失败块（`isFailed`）加「重试（从断点继续）」→ `POST /api/jobs/{jobId}/retry` → 成功后用**同一 jobId** 重新订阅 SSE（`use-job-stream` 的 `reset` + 重新 set jobId）。
- **跨刷新持久（面板恢复）**：dashboard 挂载时若无活动 job，查 `GET /api/jobs?status=failed&type=ingest`（当前 subject，取最近一条）；若存在则把面板恢复成"失败·可重试"态。
- **进度展示**：扩展 `GET /api/jobs/[id]`（及 list）响应附 `checkpointProgress: { plan, chunkSummaries, writerPages } | null`（来自 `getProgress`），按钮文案显示"从断点继续（40/100 页已完成）"。无检查点时按钮仍可点（退化为全新跑，仍正确）。
- **SSE**：`use-job-stream` 已订阅 `job:retrying`；确认 `job:retrying` 把 `status` 切回 `streaming`（当前仅 `job:failed`/`job:completed` 显式改 status，需补 `job:retrying → streaming`）。

### G. 自动重试复用

worker 的瞬时错误自动 `requeue(job.id)`（`worker.ts:122`）复用同一 handler → 自动从断点恢复，**零额外改动**。

---

## 六、关键决策（已与 Nick 确认）

1. **writer 失败语义 = fail-fast + 即时落盘**：保留现有 fail-fast（首个 writer 报错即中止派发并抛出），但每页完成瞬间已落盘，故已完成 + 在飞页全保住，重试只补未写页。
   - *备选（v1 不做）*：continue-on-error（写完所有能写的页再统一报缺失）——更耐操，但要处理"部分书 + 跨页 wikilink 校验"，复杂度不值当。
2. **设置漂移容忍**：重试复用已产出产物，不把"失败后改的语言/模型"回灌到已完成页；要干净重跑则重新上传文件（生成新 job / 新 sourceId）。
   - *未来可加*「丢弃断点重开」次按钮（调 `deleteCheckpoints` 后 requeue）。
3. **存储 = SQLite 检查点表**（方案 A），非 vault sidecar。

---

## 七、正确性、失效与回滚

- **断点作用域 = job**。重试 = requeue 同一 job = 同一 `sourceId` = 同一源内容 → 确定性切块 → key 全稳定（见 §三）。
- **重新上传文件** = 新 sourceId/新 job，与旧检查点无关，自然全新跑。
- **skill 版本守卫**（`ingest-service.ts:100`）照旧：skill 降级到 min 以下直接 throw，不受断点影响。
- **Saga 回滚不变**：reviewer commit 失败时，既有的 `rollbackChangeset` + worker-entry 启动期 `operations` pending 回滚保证 vault/SQLite 一致；检查点仅在 handler 成功 return 时删除，故失败的 commit 不会误删断点。
- **WriterConflictError 在恢复态**：缓存的 plan 若含重复 slug，重试仍会冲突——属 plan 级缺陷，手动重试无法自愈，需「丢弃断点重开」（未来）或重新上传。v1 接受。

---

## 八、数据流时序（恢复场景示例）

某本书：80 块、map 已全摘要、plan 已出、100 页中 40 页已写，第 41 页 writer 报错 → job failed（检查点：80 chunk-summary + 1 plan + 40 writer-page）。

用户点「重试」：

1. `POST /api/jobs/{id}/retry` → `requeue` → worker `claim` 同一 job；
2. handler：解析 + `prepareIngest`（重建 chunkStore，零 token）；载入检查点；emit `ingest:resuming`（plan✓ / 80 摘要 / 40 页）；预热 40 页进 overlay+pending；
3. map：80 块全部命中 → **0 次 LLM**；
4. planner：命中 plan → **0 次 LLM**；
5. fanout：40 页命中跳过，**仅跑剩余 60 页**（含上次失败的第 41 页）；每页完成即落盘；
6. reviewer：从全部 100 页（40 缓存 + 60 新）重读 → commit；
7. 成功 → `deleteCheckpoints(job.id)`。

净省：80 摘要 + 1 plan + 40 页 的 LLM 成本不再重复支付。

---

## 九、测试策略

- **checkpoints-repo**：upsert 幂等（同 key 覆盖）、`getCheckpoints` 还原、`deleteCheckpoints` 清空、`getProgress` 计数。
- **CheckpointHandle**：内存索引与落盘一致；`hasAny`/`progress` 正确。
- **orchestrator 恢复**（扩 `runtime/__tests__/`）：
  - map：命中缓存跳过 summarizer；未命中跑后落盘；
  - planner：命中 plan 跳过且 `carry` 重建结构正确；
  - fanout：命中页跳过；**部分失败保留已完成页**（mock 第 K 个 writer 抛错，断言前 K-1 页 + 在飞页已落盘）；
  - `checkpoint===undefined` 时行为与现状一致（回归保护）。
- **handler**：恢复载入检查点 + 预热 pending/overlay；成功删除检查点；reviewer commit 失败时检查点保留。
- **retry API**：非 failed / 非 ingest 拒绝；failed ingest 正确 requeue。
- **预检折减**：恢复态估算扣减已缓存产物。

---

## 十、非目标（v1 不做）

- continue-on-error 的 writer 容错（保留 fail-fast）。
- 「丢弃断点重开」次按钮（仅留接口空间）。
- 全局任务列表页 / 历史所有任务的重试入口（仅做"最近一条失败 ingest 面板恢复"）。
- query / lint 的断点续传（仅 ingest）。
- reviewer 产出（修正页 / index / log）的检查点（reviewer 永远重跑）。
- 跨 job 共享检查点 / 内容级去重。

---

## 十一、涉及文件清单

**新增**

```
src/server/db/repos/checkpoints-repo.ts        # 检查点 CRUD + getProgress
src/server/agents/runtime/checkpoint.ts        # CheckpointHandle（内存索引 + 落盘双写）
src/app/api/jobs/[id]/retry/route.ts           # POST 手动重试
（迁移）drizzle/xxxx_ingest_checkpoints.sql      # db:generate 产物
```

**修改**

```
src/server/db/schema.ts                        # ingest_checkpoints 表
src/server/agents/types.ts                     # AgentContext.checkpoint? + CheckpointHandle 接口
src/server/agents/runtime/orchestrator.ts      # map/planner/fanout 三分支 + runWithSemaphore fn 即时落盘
src/server/services/ingest-service.ts          # 构建 ckpt / 预热 pending+overlay / resuming 事件 / 成功清理 / 预检折减
src/server/services/ingest-prep.ts             # estimateIngestCost 增加恢复折减入参（或新 helper）
src/server/jobs/events.ts 无改动；use-job-stream.ts  # job:retrying → streaming
src/app/api/jobs/route.ts、[id]/route.ts        # 响应附 checkpointProgress
src/app/(app)/_components/dashboard-ingest-panel.tsx  # 重试按钮 + 挂载时恢复失败 ingest
```

---

## 十二、对既有约束的符合性核对

- ✅ Saga 顺序与"仅 reviewer 可 commit"边界不变（断点只缓存读路径产物，写入仍只由 reviewer 触发）。
- ✅ subject 贯通：检查点按 job 存，job 自带 `subjectId`；retry API 不新解析 subject（沿用 job 既有 subjectId）。
- ✅ "SQLite 仅作可重建缓存"哲学：检查点是 job 运行态、成功即删、不进 vault，与 `job_events` 同类，不破坏 vault 权威源模型。
- ✅ 写接口鉴权：retry API 走 `requireAuth` + `requireCsrf`。
- ✅ 向后兼容：`ctx.checkpoint` 可选，缺省时 orchestrator 行为与现状一致。

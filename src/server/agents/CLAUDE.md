[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **agents**

# `src/server/agents/` — Multi-agent Runtime

## 模块职责

为长任务提供**多 agent 流水线执行环境**。核心动机：ingest 任务的四阶段内容工作流（规划 → 生成 → 增益 → 核查）在单次 LLM 调用中难以保证质量与可控性，需要独立 agent 角色分工、互相交接上下文、并受统一预算约束。

> **2026-06-21 重构**：原第五阶段 tool-using `ingest-reviewer`（`generateText` + `commit_changeset` 工具循环）在 packyapi 的 openai-compatible 转译下工具死循环（反复读 index/log 却不消费、永不 commit → 撞 maxSteps），已删除。索引/日志生成下沉为**无 tools 的 `ingest-indexer` 结构化输出**，**commit 上移回 service 层**（`ingest-service.ts::finalizeIngest` → `commitPending`）。详见根 `CLAUDE.md` Changelog 2026-06-21。
>
> **2026-07-06（T2.1）重构**：`ingest-indexer` skill 本身也已移除——index/log 改为 `wiki/meta-pages.ts` 纯函数确定性渲染（不再有任何 LLM 调用）。动机：原方案每次 ingest 都要把**全 subject 页清单**塞进 indexer 的 prompt，页数上几百后单调膨胀直至超上下文窗口，且每次都要重复付一遍 token；目录/日志本质是可从数据库+本次运行信息确定性派生的数据。详见根 `CLAUDE.md` Changelog 2026-07-06。

当前启用范围：**仅 `ingest` 任务**。其余任务（`query` / `lint`）仍走 `services/` 内的直接 LLM 调用。

---

## 流水线总览

```
ingest-service.ts
        │
        ▼ runPipeline(jobId, subject, sources, ctx)
  orchestrator.ts
        │
        ├── [大文件路径] map: skill 'ingest-chunk-summarizer' × N chunks
        │     └── 逐块定位性摘要，全文从 ctx.chunkStore 注入，summary 写回 chunkRefs
        │
        ├── step 1: skill 'ingest-planner'  (sequence)
        │     └── tools: wiki.read, wiki.search
        │
        ├── step 2: fanout skill 'ingest-writer' × N pages  (fanout)
        │     └── tools: wiki.read, wiki.search
        │       每个 writer entry 暂存进 ctx.pending（+overlay 读隔离）
        │       忠实层散文：只产出与原文忠实对应的 markdown 正文，不含 callout
        │       checkpointAs: 'writer-page'
        │
        ├── step 3: fanout skill 'ingest-enricher' × N pages  (fanout)
        │     └── 结构化输出（generateObject，无 tools）
        │       读取 step 2 的页面内容（injectPriorPageAs），叠加 [!type] callout 增益层
        │       callout 类型：intuition / example / quiz / background / diagram / pitfall
        │       ctx.pending 按 path upsert（last-write-wins，覆盖 writer 产出）
        │       checkpointAs: 'enricher-page'
        │
        ├── step 4: verify (kind:'verify') × N pages  ——P3 联网核查（⑨）
        │     └── runtime/verify-page.ts::runPageVerification（全程 generateObject 无 tools）
        │       读取 step 3 的页面内容（injectPriorPageAs:'content'），逐页两段式：
        │         ① triage skill 'ingest-verifier-triage' → { doubtfulClaims:[{excerpt,query,reason}] }
        │         ② 编排层 Tavily 搜索（query 去重+上限3+Promise.allSettled）
        │         ③ apply skill 'ingest-verifier-apply' → 证据驱动改 callout + citedSources
        │       降级：未配置/triage 空/零证据 → 既有 'ingest-verifier'(v2) 自检 或 passthrough
        │       provenance：citedSources 累积进 ctx.citedSources；URL 追加进页 frontmatter sources
        │       ctx.pending 按 path upsert（last-write-wins，覆盖 enricher 产出）
        │       checkpointAs: 'verifier-page'
        │       搜索后端配置在全局设置 app_settings（settings-repo::getWebSearchConfig）
        │
        ▼  runPipeline 返回（不在 agent 内提交）
  ────────────────────────────────────────────────────
  ingest-service.ts :: finalizeIngest（service 层收口）
        │
        ├── wiki/meta-pages.ts：确定性渲染（T2.1，不再走 LLM）
        │     └── renderIndexPage(pages, opts) / renderLogPage(entries, opts)
        │         输入: 全 subject 页清单(existing ∪ plan, 排除 meta，tags 优先取
        │               ctx.pending 内本次实际写入内容的 frontmatter) + 现有 log 解析出的历史条目
        │         输出: { indexMd, logMd }（不进页正文、无 LLM 调用、无工具循环）
        │
        └── commitPending(ctx, [index.md, log.md])
                    commit = ctx.pending ∪ [index, log]（按 path 去重）
                              │
                              ▼
                    wiki-transaction Saga
                    (validate → fs → SQLite → git)
```

**写入边界**：流水线内的 agent（Planner / Writer / Enricher / Verifier）**全部为结构化输出，无任何写盘工具**——它们只把页面暂存进 `ctx.pending`。真正的 commit 由 **service 层**（`finalizeIngest` → `runtime/commit-pending.ts::commitPending`）在流水线结束后执行，符合"写操作经 services → wiki-transaction"的 Saga 契约。builtin registry 不再注册任何通用 commit 或动态 dispatch 工具。

**执行路径分支**（`compile.ts` + `agent-loop.ts`）：
- **有 tools + 有 outputSchema → 组合路径**：`compileToolSet` 额外合成 `finish` 工具（`FINISH_TOOL_NAME`）；agent-loop 末步触发 `finish` 时由 `synthesizeFinishTool(schema, capture)` 捕获结构化输出，`experimental_prepareStep` 在最后一步强制结束循环。planner / writer 走此路径，既能在循环中调 `wiki.read/search`，又能在收尾时产出结构化结果。
- **无 tools + 有 outputSchema → `generateObject` 路径**：enricher / verifier 等纯结构化输出 skill 走此路径，`generateStructuredResult` 直接调用，无工具循环。（`indexer` 已于 T2.1 移除，不再是 skill——index/log 改由 service 层纯函数确定性渲染）
- **`createBuiltinToolRegistry()` 进程无关**：ingest worker 与 query runner 各自构造包含 17 个 builtin 的 registry（无参、无全局单例）；`ToolContext` 差异由 `compileToolSet` 调用方注入，不在 registry 工厂层。
- **`ToolProfile + ToolExecutionPolicy` 是运行时授权边界**：所有 runner 先解析 profile，再把必传 policy 交给 `compileToolSet`；编译器过滤 profile 外工具、拒绝未允许 sideEffect、校验 subject，Fix/Curate 写工具还必须有匹配 job type 的 capability；存在 `allowedPageSlugs` 时包装 read/search/inspect/source-page-filter/list 与写上下文，`wiki.link.ensure` 只按 source page 判写 scope，跨主题 target 仅作存在性验证。审计回调记录 profile/sideEffect/subject/目标页，但会递归遮盖 body/content/markdown/text/excerpt/patch 及 metadata 值。Query 按意图使用 `query:read` 或 `query:propose`，后者只多 `wiki.preview_change` 提案能力、不含任何实际写工具；`fix:links` 只用 `wiki.link.ensure`，`fix:contradiction` 才额外开放 patch/update；Curate 两种 profile 均可在 allowedSet 内使用 link/metadata 窄写；ingest 只使用 planner/writer 只读 profile。

**暂存提交**：每个内容阶段（writer → enricher → verifier）的页面均由 orchestrator 暂存进 `ctx.pending`；同一 path 的 upsert 采用 **last-write-wins**（后一阶段覆盖前一阶段产出）。`commitPending` 提交 `pending ∪ [index.md, log.md]`（按 path 去重、supplied 覆盖）。`index.md` / `log.md`（meta 页）由 `wiki/meta-pages.ts` 纯函数渲染，所有内容页随 `pending` 自动提交——T2.1 起索引/日志根本不再有 LLM 调用（此前是无 tools 结构化输出，不接触页正文；现在连该调用也去掉了），从根本上杜绝巨量提示词随页数增长与工具循环风险。

**跨阶段注入**：fanout step 可携带 `injectPriorPageAs`，orchestrator 将上一阶段对应 path 的 `content` 注入到当前阶段的输入，实现 writer → enricher → verifier 逐层内容传递。

---

## 入口与启动

`ingest-service.ts` 调用：

```ts
import { runPipeline } from '@/server/agents/runtime/orchestrator';

await runPipeline(job.id, subject, parsedSources, promptCtx);
```

agent-loop 的实例化发生在 `orchestrator.ts` 内部，每个 skill step 独享一个 loop 实例，共享同一个 `BudgetTracker`。

Worker 启动时（`worker-entry.ts`）会调用 `seedSkillFiles()`，将 `examples/skills/` 下的内置 skill YAML 复制到 `vault/.llm-wiki/skills/`，**已存在的文件不会覆盖**（用户自定义安全）。

---

## 子模块说明

### `types.ts`

所有 agent 内部类型定义（`AgentStep` / `SkillDef` / `ToolCall` / `BudgetSnapshot` / `CitedSource`<⑨> 等）+ `AgentContext.citedSources?: Map<string, CitedSource>`（⑨ 核查累积桶，仅 ingest 注入）。不依赖 `contracts.ts`（单向依赖，agents 消费 contracts，不反向注入）。

### `runtime/`

| 文件 | 职责 |
|------|------|
| `agent-loop.ts` | 单个 agent 的 tool-call 驱动循环；调用 `llm/provider-registry::resolveModel(route)` 获取模型，循环执行直到 stop 或 budget 超限 |
| `orchestrator.ts` | 按 step 顺序驱动多个 agent-loop；管理 context 传递（上一 step 的输出作为下一 step 的 user prompt 前缀）；捕获 emit 事件写 SSE；支持 sequence（carryThrough/omitFromInput）/fanout/map 三种 step；map 用于大文件逐块摘要；chunkStore 块路由（relevantChunks 按 planner sourceRefs 注入）；step 支持 `checkpointAs`（'plan'/'writer-page'/'enricher-page'/'verifier-page'/'chunk-summary'），命中检查点跳过 LLM（也跳过 T1.5 预扣），每页完成即落盘；fanout step 可携带 `injectPriorPageAs`，自动将上一阶段对应 path 的 content 注入当前阶段输入；亦可携带 `injectExistingPageForUpdate`（仅 writer step 启用），当本页 slug 命中 `existingPages`（=更新已有页）时经 `ctx.overlay.readPage` 注入现有正文 `existingPageContent`，供 writer 增量并入而非覆盖（⑤）；命中该注入时 writer 产物额外经 `merge-update-fidelity.ts::reconcileMergeUpdateFidelity` 校验（T1.4，违规→重写一次→仍违规→保守拼接回落）；`ctx.pending` 按 path upsert（last-write-wins，后阶段覆盖前阶段）；T1.5 起 fanout/verify/supplement 分支的每一项在派发前先 `ctx.budget.reserve(perItemEstimate)` 预扣、`finally` 里 `settle` 释放（成功/失败都会释放），防止并发 fanout 在任何一页记账前就全体击穿 `assertWithin` 闸门；单项预扣量优先取 `ctx.estimateFanoutReserve?.(itemCount)`（ingest 注入，复用 `ingest-prep.ts::estimatePerPageTokens`），未注入时回退 `maxTokensPerJob / itemCount` 均分估算 |
| `budget.ts` | `createBudgetTracker`（job 级 token）+ `createRunStepTracker`（单实例 step）；超限抛 `BudgetExceededError`；T1.5 起 tracker 额外提供 `reserve(estimated)`/`settle(handle, actual)` 预扣 API，维持不变式 `tokensUsed + reserved <= maxTokensPerJob`（`assertWithin` 判定时一并计入 reserved）；额度不足时 `reserve()` 排队等待其他预留 `settle` 释放，若排队后即便所有在飞预留都结算完仍不够则拒绝并抛 `BudgetExceededError`；`settle` 只释放预留、不重复记账（真实消费仍由 `chargeTokens` 单一入口计入，避免双计） |
| `overlay-vault.ts` | 读写隔离层：agent 读操作走 vault 快照，写操作累积为内存 diff，commit 时才一次性落地 |
| `checkpoint.ts` | `loadCheckpoint(jobId)` → `IngestCheckpoint`；内存索引 + 落盘双写（checkpoints-repo）；挂于 `AgentContext.checkpoint?`，缺省时 orchestrator 行为不变。kinds：chunk-summary/plan/writer-page/enricher-page/verifier-page/`supplement-page`（re-enrich 专用，`getSupplementPage/putSupplementPage`）+ `cited-sources`（⑨ 续传补源：整张 `CitedSource[]` 单 blob，`getCitedSources/putCitedSources`，`verify-page` record 后 persist、`ingest-service` pipeline 前 rehydrate） |
| `verify-page.ts` | `runPageVerification({ resolveSkill, ctx, input }): Promise<AgentRunResult>`（⑨）——逐页两段式联网核查：triage→编排层 `webSearch`→apply / 降级到 `ingest-verifier`(v2) 自检 / triage 空时 passthrough；apply 的 citedSources URL 经 `parseFrontmatter/serializeFrontmatter` 确定性追加进页 frontmatter `sources`，并累积进 `ctx.citedSources`（按 url 去重、合并 citedBy、fallbackContent 取匹配 snippet）。全程无 tools |
| `supplement-page.ts` | `runPageSupplement({ skill, ctx, input }): Promise<AgentRunResult>`——re-enrich 专用，画像探针驱动正文缺口补全：调 skill（`reenrich-supplement`）产候选 → `supplement-guard.ts::checkSupplementFidelity` 4 项确定性护栏校验 → 不过则把 `violations[]` 拼回输入重写一次 → 仍不过则回落原文 passthrough（emit `reenrich:supplement-fallback`，不阻断后续阶段）。共用 fanout 骨架（`orchestrator.ts` 的 `kind:'supplement'` 分支），仅「每项计算」不同 |

### `skills/`

| 文件 | 职责 |
|------|------|
| `builtin-manifest.ts` | 当前内置 skill 文件清单 + retired ID/历史 SHA-256；worker 启动时原版残留删除、用户改版归档，loader 对 retired ID 永久 tombstone |
| `schema.ts` | `SkillFrontmatterSchema`（zod，`.strict()`）：定义 skill YAML frontmatter 合法结构（id / name / description / version / tools / canDispatch / model? / outputSchema? / budget?；system prompt 是 markdown 正文，非 frontmatter 字段）|
| `loader.ts` | `loadSkillsFromDir(dir)` — 解析 vault skill，并在读取前跳过 retired ID |
| `registry.ts` | `buildSkillRegistry` 按 manifest 播种、不覆盖用户文件；`retireBuiltinSkillFiles` 对 retired 文件执行 hash 删除或改版归档；内存 registry 供 agent-loop 查 skill |

### `tools/`

| 文件 | 职责 |
|------|------|
| `registry.ts` | `ToolRegistry` — 工具集合容器；每个 step 初始化一个 registry，按 skill 配置决定挂载哪些工具；`createBuiltinToolRegistry()` 工厂函数进程无关地构造内置工具集（ingest worker / query runner 各自调用，无共享单例） |
| `evidence-reader.ts` | subject-scoped 确定性证据读取层：页面关系/来源/健康、source chunk 检索与窗口读取、keyset page list；可 import repos/source store，不依赖 AI SDK |
| `evidence-results.ts` | 纯契约 helper：scope 外与不存在页共用的空 `WikiInspection`，不加载 DB |
| `tool-context.ts` | `ToolContext` 接口定义（读证据 + 可选 `conversationId/previewChange/onPendingAction` + metadata/link 窄写等 worker 能力）；不再暴露原始 `AgentContext` 逃生舱。Query propose 只注入预览服务，Fix/Curate 实际写能力仍按 profile 与 Guard 限制 |
| `profiles.ts` | 八个 `ToolProfile` + `resolveToolProfile/createToolExecutionPolicy/profileForIngestSkill`；集中声明 runner 工具 allowlist、允许 sideEffect、审批标记与可选 page scope/job capability。Query 永无真实写工具；Fix links/contradiction 和 Curate auto/manual 使用精确不同的写面 |
| `compile.ts` | `compileToolSet(toolDefs, ctx, { policy, ... })` — policy 必传；过滤工具、校验 sideEffect/subject/job capability、包装 page scope，并把脱敏后的 profile/sideEffect/subject/pageSlugs 送入审计回调。`synthesizeFinishTool` 仍仅作为 provider 收尾适配器 |
| `builtin/wiki-read.ts` | `wiki.read` — 通过 `ToolContext.readPage` 读取 wiki 页面内容（取代旧 `vault-read.ts`） |
| `builtin/wiki-search.ts` | `wiki.search` — 通过 `ToolContext.search` 做 FTS5 搜索（取代旧 `vault-search.ts`） |
| `builtin/wiki-list.ts` | `wiki.list` — title/updated keyset cursor 分页，默认 50、最大 100，支持 tag 筛选 |
| `builtin/wiki-inspect.ts` | `wiki.inspect` — 页面元数据、出链/反链、关联来源与轻量健康摘要；不返回正文 |
| `builtin/source-search.ts` | `source.search` — 当前 subject 解析后 chunks 的确定性检索，excerpt 单条/总量受限 |
| `builtin/source-read.ts` | `source.read` — 按 chunk 或逻辑文本 offset/limit 读取解析后来源窗口，不读取原始二进制 |
| `builtin/wiki-update.ts` | `wiki.update` — 通过 `ToolContext.updatePage` 更新页面标题/正文，改标题联动 relink（`sideEffect:'update'`，仅 `fix:contradiction` profile） |
| `builtin/wiki-patch.ts` | `wiki.patch` — 通过 `ToolContext.patchPage` 做 old_string/new_string 精确替换（`sideEffect:'update'`，仅 `fix:contradiction` profile） |
| `builtin/wiki-metadata-patch.ts` | `wiki.metadata.patch` — 只改 title/summary/tags/aliases，正文逐字保留（`sideEffect:'update'`，仅 Curate profile） |
| `builtin/wiki-link-ensure.ts` | `wiki.link.ensure` — 对 source 页维护唯一一个 link/unlink/retarget，target 只验证不写入（`sideEffect:'update'`，Fix/Curate profile） |
| `builtin/web-search.ts` | `web.search` — 只读联网检索，通过 `ToolContext.webSearch` 包装 `search/web-search.ts::webSearch`（`sideEffect:'none'`，仅 query runner 在 `isWebSearchConfigured()` 为真时解析注入）（T3.2）|
| `builtin/wiki-preview-change.ts` | `wiki.preview_change` — 生成 create/update/patch/delete/reenrich/metadata-patch/link-ensure 审批预览（`sideEffect:'propose'`，仅 `query:propose`）；返回 actionId，不执行 Saga 或入队 |

---

## 对外接口

```ts
// orchestrator.ts
export async function runPipeline(
  jobId: string,
  subject: Subject,
  sources: ParsedSource[],
  ctx: PromptContext,
): Promise<PipelineResult>

// skills/loader.ts
export async function loadSkill(id: string): Promise<SkillDef>
export async function seedSkillFiles(): Promise<void>

// runtime/budget.ts
export function createBudgetTracker(budget: AgentBudget): BudgetTracker   // job 级 token
export function createRunStepTracker(maxSteps: number): RunStepTracker    // 单实例 step
```

---

## Agent 设置（`app_settings`）

4 个 agent runtime 配置 key，由 `settings-repo.ts` 读写，**每次 `runPipeline` 调用时实时读取**（无需重启 worker）：

| Key | 默认值 | 说明 |
|-----|--------|------|
| `agentMaxSteps` | `25` | **单个 agent 实例**内的最大 tool-call 轮次（2026-06 起从 job 级改为实例级；job 级总量防线由 token 预算承担） |
| `agentMaxTokensPerJob` | `1200000` | 单个 job 的 token 总预算（in + out）；P2 三轮内容阶段后默认预算由 500k 提升至 1.2M |
| `agentMaxParallelSubAgents` | `3` | fanout writer step 的最大并发数 |
| `agentTaskRouterMode` | `'frontmatter-override'` | skill LLM 选择策略（`frontmatter-override` = skill YAML 的 `model:` 块优先；`task-router-only` = 仅用 `llm-config.json`）|

---

## Skill 文件格式

Skill YAML 存放于 `vault/.llm-wiki/skills/<id>.yaml`（可被用户直接编辑）：

```yaml
id: ingest-planner
system_prompt: |
  You are a wiki planner ...
tools:
  - wiki.read
  - wiki.search
model:                 # 可选；frontmatter 模型覆盖，对应 llm-config.json::tasks."ingest:planner"
  temperature: 0.1
```

内置 skill 模板来自 `examples/skills/`，worker 启动时播种到 vault，**不覆盖用户已有文件**。

---

## 扩展指南

- **新增 builtin tool**：在 `tools/builtin/` 新建文件，实现 `ToolDef` interface，在 `tools/registry.ts` 注册为内置工具；按需在 skill YAML 的 `tools:` 列表中声明。
- **新增 skill**：在 `examples/skills/` 添加 YAML 文件（会随 worker 启动播种到 vault）；需要自定义 LLM 时在 `llm-config.json::tasks` 添加 `"<pipeline>:<stage>": { ... }` 节（如 `"ingest:planner"`）。
- **新增 pipeline**：在 `orchestrator.ts` 添加新的 step 序列；目前 `runPipeline` 的 step 顺序硬编码在 orchestrator，未来可抽为配置（Phase 2 考虑）。
- **接入新任务类型（如 query / lint）**：在对应 service 文件末尾调用 `runPipeline` 替换直接 LLM 调用；需要创建对应 skill YAML 文件。

---

## 测试与质量

```
src/server/agents/runtime/__tests__/
src/server/agents/skills/__tests__/
src/server/agents/tools/builtin/__tests__/
```

关键覆盖点：

- `BudgetTracker`：step 超限抛 `BudgetExceededError`；token 累加准确。
- `OverlayVault`：读取命中内存 diff；commit 时 diff 正确合并到真实 vault。
- `runtime/commit-pending.ts::commitPending`：合并 `pending ∪ supplied` 调用 Saga；重复提交 / 空集报错；它是 service-level 内部函数，不进入模型工具注册表。
- Orchestrator step 顺序：planner 输出传入 writer context；writer 扁平 entry 累积进 `ctx.pending`。
- Tool registry/Profile/compile：17 个 builtin 精确注册；Query 只读/提案面、Fix/Curate 窄写面、job capability、allowedSet 与审计脱敏均有回归；`dispatch.skill` / `commit_changeset` 明确不可达。
- 窄写 ToolDef：metadata/link schema、成功/缺能力失败、source-only scope、工具活动脱敏与 Query preview operation 均有覆盖。

---

## 常见问题 (FAQ)

- **谁负责 commit？为什么不在 agent 内？**
  流水线内所有 agent 都是结构化输出（无写盘工具），只往 `ctx.pending` 暂存。commit 由 service 层 `finalizeIngest` 在流水线结束后统一执行（`commitPending`）。这样写操作回归 services → wiki-transaction 的 Saga 契约，也避免了原 reviewer 用工具循环 commit 在 openai-compatible 供应商上的死循环/巨量参数问题。

- **budget 超限后 job 会怎样？**
  `BudgetExceededError` 被 orchestrator 捕获，触发 `rollbackChangeset`（如已有部分写入）并以 `status='failed'` 结束 job，`error_json` 中记录 budget snapshot。该错误标记为不可重试（避免无限消耗 token）。

- **Skill YAML 改了需要重启 worker 吗？**
  不需要。`loadSkill(id)` 在每次 `runPipeline` 调用时重新读文件（无进程级缓存，文件修改即时生效）。

- **如何在 llm-config.json 中为特定 skill 指定模型？**
  在 `tasks` 节中添加 `"ingest:planner": { "model": "...", "temperature": 0.1 }`（key 由 `agent-loop::skillTaskKey` 从 skill id `ingest-planner` 派生）。`resolveTask` 与 skill YAML 的 `model:` 块合并（config < frontmatter-override 顺序）。

---

## 相关文件清单

```
src/server/agents/
├── types.ts                        # 内部类型定义
├── runtime/
│   ├── agent-loop.ts               # 单 agent tool-call 循环
│   ├── orchestrator.ts             # 多 step 流水线驱动（含 checkpointAs 逐页续传）
│   ├── budget.ts                   # BudgetTracker
│   ├── overlay-vault.ts            # 读写隔离层
│   ├── checkpoint.ts               # IngestCheckpoint 句柄（内存索引 + 落盘双写）
│   ├── verify-page.ts              # runPageVerification（⑨ 联网核查）
│   ├── supplement-page.ts          # 🆕 runPageSupplement（re-enrich 专用，画像探针驱动正文补全 + 护栏 + 重写一次 + 回落原文）
│   ├── supplement-guard.ts         # 🆕 checkSupplementFidelity 纯函数（4 项确定性护栏：不缩水/不臆造wikilink/标题不减/frontmatter不变）
│   ├── commit-pending.ts           # service-level 暂存提交入口（非模型工具）
│   └── __tests__/
├── skills/
│   ├── builtin-manifest.ts         # 当前内置清单 + retired ID/历史 hash tombstone
│   ├── schema.ts                   # SkillSchema (zod)
│   ├── loader.ts                   # loadSkill + seedSkillFiles
│   ├── registry.ts                 # SkillRegistry
│   └── __tests__/
└── tools/
    ├── registry.ts                 # ToolRegistry + createBuiltinToolRegistry()
    ├── tool-context.ts             # ToolContext 接口（不暴露 AgentContext）
    ├── evidence-reader.ts          # subject-scoped 页面/来源证据读取 + page keyset 分页
    ├── evidence-results.ts         # 纯空结果契约 helper
    ├── profiles.ts                 # runner allowlist + ToolExecutionPolicy
    ├── compile.ts                  # policy 强制编译 / synthesizeFinishTool
    └── builtin/
        ├── wiki-read.ts            # wiki.read（取代旧 vault-read.ts）
        ├── wiki-search.ts          # wiki.search（取代旧 vault-search.ts）
        ├── wiki-list.ts            # wiki.list
        ├── wiki-inspect.ts         # wiki.inspect
        ├── source-search.ts        # source.search
        ├── source-read.ts          # source.read
        ├── wiki-preview-change.ts  # wiki.preview_change（仅 query:propose，零直接写入）
        ├── wiki-update.ts          # wiki.update（sideEffect:'update'，仅 fix:contradiction）
        ├── wiki-patch.ts           # wiki.patch（sideEffect:'update'，仅 fix:contradiction）
        ├── wiki-metadata-patch.ts  # wiki.metadata.patch（仅 Curate，正文不可写）
        ├── wiki-link-ensure.ts     # wiki.link.ensure（Fix/Curate，单链接确定性维护）
        ├── wiki-reenrich.ts        # wiki.reenrich（兼容定义；Phase 0 profile 不暴露）
        ├── wiki-delete.ts          # wiki.delete（sideEffect:'destructive'，仅 curate:manual）
        ├── wiki-create.ts          # wiki.create（sideEffect:'create'，仅 curate:manual）
        ├── wiki-merge.ts           # 🆕 wiki.merge（写动作工具，sideEffect:'merge'，仅 curate runner）
        ├── wiki-split.ts           # 🆕 wiki.split（写动作工具，sideEffect:'split'，仅 curate runner）
        └── __tests__/
```

---

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-07-13 | Wiki 窄写工具 Phase 2B：registry 新增 `wiki.metadata.patch` / `wiki.link.ensure`；Fix links 由通用 patch 收缩为 link ensure，contradiction 保留 patch/update；Curate auto/manual 增加 metadata/link 窄写与 update cap；Query 仍只持有 `wiki.preview_change`，真实窄写工具不进入 Query profile |
| 2026-07-11 | Wiki 审批闭环 Phase 1B：新增 `query:propose` profile 与 `wiki.preview_change`（sideEffect propose）；Query 按保守意图分类在 read/propose 间切换，两个 profile 均无 create/update/patch/delete/reenrich 实际写工具，批准由独立 API 消费服务端 actionId |
| 2026-07-10 | Wiki 证据工具 Phase 1A：builtin registry 新增 `wiki.inspect`、`source.search`、`source.read`；`evidence-reader` 统一 subject-scoped 页面/来源证据与 `wiki.list` keyset 分页；compile policy 在分页前注入 allowedSet、scope 外 inspect 返回空结果、source page filter 越界报错；审计递归脱敏 `content/excerpt` |
| 2026-07-10 | 工具治理 Phase 0：新增八个 ToolProfile 与必传 ToolExecutionPolicy；compileToolSet 开始过滤 allowlist、校验 sideEffect/subject、强制 page scope 并输出审计字段；Query 收缩为只读；删除不可达的通用提交和动态 dispatch ToolDef，commitPending 迁到 runtime 内部函数；新增 builtin skill manifest 与 hash tombstone，原版 retired 文件删除、用户改版归档 |
| 2026-04-27 | 初始化（Phase 1）：orchestrator + skill loader + tool registry + MCP client pool；ingest 切换为 planner→writer×N→reviewer 流水线 |
| 2026-06-20 | 断点续传：新增 `checkpoint.ts`（IngestCheckpoint 句柄）；`AgentContext.checkpoint?` 可选字段；`PipelineStep.checkpointAs` 逐页续传（命中检查点跳过 LLM，writer 完成即落盘）|
| 2026-06-20 | P2 双层增益：新增 enricher（`[!type]` callout 增益层）+ verifier（参数化自检，结构化输出无 tools）fanout 步骤；orchestrator pending last-write-wins upsert + 跨阶段 injectPriorPageAs 注入；checkpoint 扩展 enricher-page/verifier-page 类型；DEFAULT_AGENT_MAX_TOKENS_PER_JOB 500k→1.2M（CONTENT_STAGE_FACTOR=3）|
| 2026-06-21 | 删除 tool-using `ingest-reviewer`（packyapi openai-compatible 上工具死循环）：新增无 tools 的 `ingest-indexer`（结构化输出 `{indexMd, logMd}`）；commit 抽出 `commitPending` 并上移到 `ingest-service::finalizeIngest`（service 层收口，符合 Saga 契约）；流水线由 5 阶段收敛为 4 内容阶段 + service finalize；`commit_changeset` tool 降级为 `commitPending` 薄包装（已无 skill 引用）|
| 2026-06-22 | 增量合并：fanout step 加 `injectExistingPageForUpdate`，writer 更新已有页时 orchestrator 确定性注入现有正文 `existingPageContent`（`buildFanoutInput` 改 async），writer skill v5 并入新材料而非覆盖、planner skill v3 强化复用 slug（⑤）|
| 2026-06-22 | P3 联网核查（⑨）：verifier 阶段由 fanout 'ingest-verifier' 改为 `verify` step kind → 新 `runtime/verify-page.ts::runPageVerification` 逐页两段式（triage `ingest-verifier-triage` → 编排层 Tavily 搜索 → apply `ingest-verifier-apply`），全程 generateObject 无 tools（绕开 packyapi 工具死循环）；未配置/零证据降级既有 `ingest-verifier`(v2) 自检；新增 `CitedSource` 类型 + `AgentContext.citedSources`；`commit_changeset`/`commitPending` 接受第三参 webSources（network 引用源 links+extraStagePaths）|
| 2026-06-22 | ⑨ fast-follow（闭合终审 I-1）：`IngestCheckpoint` 加 `getCitedSources/putCitedSources`（checkpoint kind `'cited-sources'` 单 blob）；`verify-page` record 后同步 persist、`ingest-service` pipeline 前 rehydrate `ctx.citedSources`——崩溃续传命中 verifier-page 检查点跳过 verify 的页，其网页 source 仍被完整导入 |
| 2026-06-24 | 移除 MCP 功能（冗余死代码）：删除 `tools/mcp/`（config/transport/client-pool/tool-bridge）+ `mcp-config.json` + `@modelcontextprotocol/sdk` 依赖 + `agentMcpLifecycle` 设置（contracts/settings-repo/API/UI）。判定依据：agent-loop 仅解析 skill 显式声明的工具，而所有内置 skill 都不声明 `mcp.*`；且项目已主动放弃 tool-using agent（packyapi openai-compatible 工具死循环），MCP 工具永不可被调用。`ToolSource` union 去掉 `'mcp'` |
| 2026-06-25 | 工具体系收敛：新增 `tool-context.ts`（`ToolContext` 接口）+ `compile.ts`（`compileToolSet`/`synthesizeFinishTool`/`FINISH_TOOL_NAME`）；`vault-read/vault-search` 重命名为 `wiki-read/wiki-search`，新增 `wiki-list`；`ToolDef` 统一吃 `ToolContext`；`createBuiltinToolRegistry()` 工厂进程无关化；组合路径（有 tools+有 schema→`finish` 收尾）/纯结构化路径（无 tools+有 schema→`generateObject`）分支明确 |
| 2026-06-28 | 对话触发 Re-enrich：新增 `tools/builtin/wiki-reenrich.ts`（`wiki.reenrich` 写动作工具，`sideEffect:'enqueue'`，先确认后执行、fire-and-forget）；`tool-context.ts` 的 `ToolContext` 接口新增可选 `reenrich?(slug): Promise<{jobId:string}>` 能力（仅 query runner 注入，ingest agent 不可用）；`ToolDef.sideEffect` 联合类型扩展 `'enqueue'`；`builtin/` 文件清单补 `wiki-reenrich.ts` |
| 2026-06-30 | 对话创建/删除：新增 `tools/builtin/wiki-delete.ts`（`wiki.delete`，`sideEffect:'destructive'`，系统提示规定须后续轮确认、禁同轮执行）+ `tools/builtin/wiki-create.ts`（`wiki.create`，`sideEffect:'create'`）；`ToolContext` 新增 `deletePage?`/`createPage?` 写能力（仅 query runner 注入）；`ToolDef.sideEffect` 联合类型扩展 `'destructive'`/`'create'`；query runner 解析并注入两工具 + 系统提示加写动作确认纪律 |
| 2026-06-30 | Curate tool-loop：新增 `tools/builtin/wiki-merge.ts`（`wiki.merge`，`sideEffect:'merge'`）+ `tools/builtin/wiki-split.ts`（`wiki.split`，`sideEffect:'split'`）；`ToolContext` 新增 `mergePages?(targetSlug, sourceSlug)` / `splitPage?(slug, hint?)` 写能力（仅 curate runner 注入）；`ToolDef.sideEffect` 联合类型扩展 `'merge'`/`'split'`；curate runner 经 `buildCurateToolContext`（`services/curate-tools.ts`）注入七工具（read/search/list/merge/split/delete/create）并驱动 `generateTextWithTools('curate')` tool-loop |
| 2026-06-26 | 路由 key 统一：新增 `agent-loop::skillTaskKey(id)`（`ingest-planner`→`ingest:planner`），`resolveSkillModel` 改用之，task key 由 `skill:ingest-xxx` 改为 `ingest:xxx`（id/文件名不变）；配合移除内置 `ingest` task。文档修正：skill frontmatter 字段是 `model:`（非 `llm_override:`，schema `.strict()` 拒未知键）、router mode 值 `task-router-only`（非 `config-only`）|
| 2026-06-30 | Fix tool-loop：新增 `tools/builtin/wiki-update.ts`（`wiki.update`，`sideEffect:'update'`，委托 `executePageUpdate`）；`ToolContext` 新增 `updatePage?`（仅 fix runner 注入）；`ToolDef.sideEffect` 扩 `'update'`（Spec 3）|
| 2026-07-07 | T3.2：新增 `tools/builtin/web-search.ts`（`web.search`，`sideEffect:'none'`，只读，包装 `search/web-search.ts::webSearch`）；`ToolContext` 新增可选 `webSearch?(query)`（仅 query runner 在 `isWebSearchConfigured()` 为真时注入，未配置时工具不出现在解析结果中）|
| 2026-07-01 | 新增 `supplement` step kind + `runtime/supplement-page.ts::runPageSupplement`（re-enrich 专用，画像探针驱动正文缺口补全，共用 fanout 骨架、4 项确定性护栏 + 重写一次 + 回落原文）；`supplement-guard.ts` 护栏纯函数；checkpoint 加 `supplement-page` kind |
| 2026-07-06 | T1.5 token 预算预扣制：`BudgetTracker` 新增 `reserve(estimated)`/`settle(handle, actual)`，维持不变式 `tokensUsed+reserved<=maxTokensPerJob`（`assertWithin` 一并计入 reserved），修掉并发 fanout 击穿 `maxTokensPerJob` 的问题（原先所有并发实例都在任何一页记账前通过 assertWithin 闸门）；`orchestrator.ts` 的 fanout/verify/supplement 分支在派发每一项前 `reserve`、`finally` 里 `settle`（跳过检查点命中项）；单项预扣量取 `ctx.estimateFanoutReserve?.(itemCount)`（ingest 复用 `ingest-prep.ts::estimatePerPageTokens`，与 `reduceCostForResume` 共用 `FANOUT_SHARE` 常量），未注入时回退均分估算 |
| 2026-07-06 | T1.6 WriterConflict 与检查点顺序修复：`orchestrator.ts` fanout/verify/supplement 分支用请求级 `claimedPaths`（path→slug）表把同 path 冲突检测提前到 `checkpoint.put` 之前——写入前撞见已认领 path 时不写自己且撤销先认领者已落盘条目；resume 读缓存命中同 path 冲突时丢弃后到者缓存条目（`emit('ingest:warn', ...)`）重新生成而非原样复现冲突。`IngestCheckpoint` 新增 `deleteStagePage(kind, slug)`（`checkpoint.ts` 内存+DB 双删，`checkpoints-repo.deleteCheckpoint` 新增）；`WriterConflictError` 抛出时机/分类不变，只消灭死锁重试 |
| 2026-07-06 | T1.4 ingest merge-update 接入统一保真护栏：新增 `runtime/merge-update-fidelity.ts::reconcileMergeUpdateFidelity`，`orchestrator.ts` writer fanout 分支在 `injectExistingPageForUpdate` 命中且注入了 `existingPageContent` 时接入——writer 产物违规（相对现有正文丢链接/丢标题/塌缩超 15%，`wiki/rewrite-fidelity.ts` profile `merge-update`）→ 把 violations 拼进指令重写一次 → 仍违规 → 保守回落：保留现有正文 + 文末追加整段重写草稿（`---` 分隔，确定性拼接、零 token）+ emit `ingest:warn`；create 语义（无 existingPageContent）不受影响 |
| 2026-07-06 | T2.1 index/log 去 LLM 化：移除 `ingest-indexer` skill（`examples/skills/ingest-indexer.md` 已删）+ `MIN_SKILL_VERSIONS` 去掉该项；`finalizeIngest` 改调 `wiki/meta-pages.ts` 纯函数 `renderIndexPage`/`renderLogPage` 确定性渲染。原因：原方案每次 ingest 都要把全 subject 页清单塞进 indexer prompt，页数上几百后单调膨胀直至超上下文窗口，且目录/日志本质是数据库可确定性派生的数据。finalize 阶段现在零 LLM 调用 |
| 2026-07-06 | T2.2 fanout existingPages 检索式子集注入：`orchestrator.ts::buildFanoutInput` 不再把**全量** existingPages 塞进每一个 writer/enricher/verify fanout 调用（O(N·M) token，N=现有页数、M=本次 fanout 页数），改为经新纯函数 `selectRelevantExistingPagesForFanout` 每页裁剪为「检索 top-K（默认 `EXISTING_PAGES_FANOUT_TOP_K=20`）∪ 该页 title/summary/上一阶段草稿中出现的 wikilink 目标（`wikilinks.ts::extractWikiLinks` 单一真实源）∪ 自身条目（update 语义必在）」；检索经新增 `AgentContext.retrieveRelevantPages?` 依赖注入（ingest-service 注入 `search/hybrid-retrieval.ts::hybridRankSlugs`，FTS+向量 RRF，未配置嵌入自动回落纯 FTS），未注入/抛错/零命中时优雅降级为最小集合（自身+wikilink 目标），不使 fanout 失败。**不变**：planner（sequence 阶段）仍拿全量 existingPages（判定复用哪个已有 slug 需要全局视野）；本次 fanout 内的兄弟页信息本就经 `plan: carry.plan` 整体透传给每页，未重复放进 existingPages 子集，无需改动。**已知代价**：existingPages 自此按页裁剪、不再跨页恒定，此前"共享前缀在前"设计给 DeepSeek 前缀缓存带来的 existingPages 部分复用收益让位于 token 节省（`plan` 字段仍恒定，该部分前缀缓存收益不受影响）。skill 输入契约形状不变（仍是 slug/title/summary/tags 数组），未 bump 各 ingest skill 版本 |
| 2026-07-10 | 新增 `wiki.patch` 局部更新工具：`ToolContext.patchPage`（fix + query runner 均注入）→ `services/page-write.ts::patchPageInSubject` → `wiki/page-ops.ts::executePagePatch`（纯函数 `applyPatchEdits` 逐组 old_string/new_string 精确唯一替换，任一组失败整批不落盘，仿 Claude Code Edit 工具语义）委托 `executePageUpdate` 继承 Saga/坏链拒绝/单 commit；`sideEffect:'update'`；**不接忠实度护栏**（局部替换天然受限，风险面小于整页重写）；prompt 指导优先 `wiki.patch`、仅整页重写时才用 `wiki.update` |
| 2026-07-09 | `wiki.update` 支持改标题：`executePageUpdate` 新增 `title?` 参数，改标题时联动 `relink.ts::rewriteBacklinkText` 重写本 subject 内引用旧标题的文本（新增返回字段 `referencesUpdated`）；`ToolContext.updatePage` 注入范围从"仅 fix runner"扩展为"fix + query runner"——问答（Ask AI）首次获得 `wiki_update` 能力（经 `services/page-write.ts::updatePageInSubject` 包装：忠实度护栏复用 `FIDELITY_PROFILES.fix` + `enqueueEmbedIndex`）；`QUERY_AGENTIC_SYSTEM_PROMPT` 补 "Updating a page" 确认纪律（与 `wiki_delete` 一致，须后续轮确认）。spec 见 `docs/superpowers/specs/2026-07-09-wiki-update-title-query-tool-design.md` |

---

_生成时间：2026-04-27_

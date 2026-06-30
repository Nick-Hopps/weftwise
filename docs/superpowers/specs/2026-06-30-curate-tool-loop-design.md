# Curate（Tidy structure）改造为 tool-loop agent（Spec 2）— 设计文档

> 日期：2026-06-30
> 主题：把 `curate` 任务从「triage→confirm→execute 结构化流水线」改造为**自驱 tool-loop agent**——模型读页后自行调用 `wiki.merge`/`wiki.split`/`wiki.delete`/`wiki.create` 完成结构整理。「Agentic Wiki Tools」三阶段计划的 **Spec 2**（Spec 1=对话创建/删除已并入 main）。

---

## 〇、承接 Spec 1 与 Initiative 背景

Spec 1（`2026-06-30-agentic-wiki-write-tools-design.md`，已并入 main）建立了共享语义级写工具内核：`wiki/page-ops.ts` 的 `executePageMerge/Split/Delete/Create` + builtin 工具 `wiki.create`/`wiki.delete` + `ToolContext` 写能力 + 对话循环接入。**架构前提**：供应商已迁移、不再走 packyapi，tool-loop 现为一等公民（详见根 CLAUDE.md Changelog 2026-06-30 与项目记忆）。

本 Spec 把 `curate`（Health 页 "Tidy structure" 手动触发 + ingest 后 `agentAutoCurate` 自动入队）从结构化流水线改造为 tool-loop。Spec 3 再改 `fix`。

**当前 curate（被替换对象）**：`curate-service.ts` 三段式——
1. **triage**（只读元数据 → `CurateTriageSchema` 候选 merge/split 清单）；
2. **confirm**（逐候选读全文 → go/no-go）；
3. **execute**（复用 `executePageMerge/Split`，逐条一个 commit）。
护栏：保护页 index/log、caps（merge≤5/split≤5）、auto 路径 seed 限制（候选须含本次 ingest 改动页）、逐候选错误隔离。

---

## 一、目标与决策

**目标**：模型在一个工具循环里**读页 → 判断 → 直接调写工具**完成整理，替代 triage/confirm 两段式结构化输出。triage/confirm 的质量门退化为模型「行动前先 `wiki.read` 看正文」的自我推理。

**已确认决策**：
1. **Harness = 轻量 `generateTextWithTools`**（provider-registry，进程无关，worker 直接调），非完整 agent-loop/orchestrator runtime（curate 单一目的，budget/checkpoint/overlay 过度）。
2. **auto + manual 都走 tool-loop**；自动路径（无人在环）安全靠**工具层硬护栏**（决策 3），非系统提示软约束。
3. **工具集**：`wiki.read` / `wiki.search` / `wiki.list`（只读，已有）+ `wiki.merge` / `wiki.split` / `wiki.delete` / `wiki.create`（写）。`wiki.merge`/`wiki.split` 为本 Spec 新增（包装既有 page-ops 内核）；`wiki.delete`/`wiki.create` 来自 Spec 1。

**非目标**：不改 `fix`（Spec 3）；不改 page-ops 执行内核（Spec 1 已建）；不动对话循环（chat 工具集不加 merge/split）；不引入 token 预算 tracker（maxSteps + 写护栏即足够边界）。

---

## 二、关键架构决策

### 决策 1：worker 侧 curate tool-loop（`generateTextWithTools`）

`curate-service.ts::runCurateJob` 改为：

```
resolve subject + parse params(scope, slugs)
compute scopeSlugs:
  - scope==='pages'(auto): seed=slugs∖meta; scopeSlugs=expandScopeWithNeighbors(seed, links, …)（保留）
  - scope==='subject'(manual): 全 subject 非 meta 页
seedSet = scope==='pages' ? new Set(seed) : null
guard = createCurateGuard({ seedSet, caps:{merge:5,split:5,delete:5,create:5} })
ctx = buildCurateToolContext(subject, { guard, emit, jobId })
tools = compileToolSet(curateToolDefs, ctx)        // read/search/list + merge/split/delete/create
emit('curate:start', …scopeSlugs.length)
若 scopeSlugs.length < 2 → emit complete，提前返回
await generateTextWithTools('curate', { system: CURATE_AGENTIC_SYSTEM_PROMPT,
    messages:[{role:'user', content: buildCurateAgenticUserPrompt(scopeMetas, promptCtx, {auto:!!seedSet})}],
    tools, maxSteps: CURATE_MAX_STEPS })
if (guard.totals().writes > 0) enqueueEmbedIndex(subject.id)
emit('curate:complete', …guard.totals())
```

- 模型拿到 **scope 内页清单**（slug/title/summary，不含正文），用 `wiki.read` 自行取正文后决策。
- `CURATE_MAX_STEPS`（常量，默认 **40**）：bound 读取轮次；写次数由 guard 硬上限（≤5×4）真正兜底。

### 决策 2：新增 `wiki.merge` / `wiki.split` 工具 + ToolContext 能力

`agents/tools/builtin/wiki-merge.ts` / `wiki-split.ts`（镜像 `wiki-delete.ts`，`sideEffect:'merge'`/`'split'`，`ToolDef.sideEffect` 联合新增二字面量）：

```ts
// wiki.merge
input  : { targetSlug, sourceSlug }       // 把 source 融入 target，删除 source
output : { ok, mergedSlug, deletedSlug, referencesRepointed, message }
// wiki.split
input  : { slug, hint? }                  // 把一页拆成多页（恰一主承接页）
output : { ok, primarySlug, pageSlugs, message }
```

handler 调 `ctx.mergePages?`/`ctx.splitPage?`（缺失→优雅 `ok:false`；抛错→catch 为 `ok:false`），与 Spec 1 两工具同构。

`tools/tool-context.ts::ToolContext` 新增可选：
```ts
mergePages?(targetSlug: string, sourceSlug: string):
  Promise<{ mergedSlug: string; deletedSlug: string; referencesRepointed: number }>;
splitPage?(slug: string, hint?: string):
  Promise<{ primarySlug: string; pageSlugs: string[]; referencesRepointed: number }>;
```
（与既有 `deletePage?`/`createPage?` 并列，worker curate runner 注入；query/ingest 不注入。）

### 决策 3：工具层硬护栏 `createCurateGuard`（auto 安全的核心）

新增纯工厂（落 `wiki/curate-plan.ts`，**替换**被退休的 `applyDecisionCaps`/`restrictToSeed`）：

```ts
interface CurateCaps { merge: number; split: number; delete: number; create: number }
interface GuardDecision { ok: boolean; reason?: string }   // reason 面向模型/emit
createCurateGuard(opts: { seedSet: Set<string> | null; caps: CurateCaps }): {
  canMerge(aSlug, bSlug): GuardDecision;   // 计数<cap && (seedSet=null || seed∋a||b) && 非保护页 && a!==b
  canSplit(slug): GuardDecision;           // 计数<cap && (seedSet=null || seed∋slug) && 非保护页
  canDelete(slug): GuardDecision;          // 计数<cap && (seedSet=null || seed∋slug) && 非保护页
  canCreate(): GuardDecision;              // seedSet!=null(auto) → deny('create 仅手动策展允许'); 否则 计数<cap
  record(op: 'merge'|'split'|'delete'|'create'): void;   // 成功后自增计数
  totals(): { merge; split; delete; create; writes }
}
```

- **caps**：每类操作独立计数器，达上限后 `can*` 返回 `{ok:false, reason:'reached the limit of N <op>s'}` → 工具拒 → 模型收到拒绝消息继续/收尾。**模型物理上越不过**。
- **seed 强制**（auto，`seedSet!=null`）：merge/split/delete 的目标 slug 必须 ∈ seedSet（本次 ingest 改动页），否则 deny。手动（`seedSet=null`）放行全 scope。
- **create 在 auto 路径直接禁**（新页无既有 slug，seed 约束无法映射；auto 只做「整理改动页」不「凭空造页」）。手动允许（capped）。
- **保护页**：merge/split/delete 命中 index/log → deny（与 `validateDeleteTarget`/page-ops 双重把守）。

guard 在 `buildCurateToolContext` 的能力实现里被调用：`mergePages` impl 先 `guard.canMerge(...)`，deny → throw(reason)（工具 catch 成 `ok:false` + emit `curate:skip`）；allow → `executePageMerge` → `guard.record('merge')` → emit `curate:merge`。delete/split/create 同构。

> **为何护栏在工具层而非提示**：auto 路径无人确认，软提示不可信；计数器 + seed 检查是确定性闸门，即便模型「想」越界也被代码拦下。系统提示仍叮嘱保守，但不作为安全边界。

### 决策 4：事件（SSE）兼容

保留现有 `curate:*` 事件词汇（前端 `use-job-stream` 已注册）：
- `runCurateJob` emit `curate:start`（scope 计数）/ `curate:complete`（`guard.totals()`）。
- 能力实现 emit `curate:merge` / `curate:split` / `curate:delete`<新> / `curate:create`<新>（成功）/ `curate:skip`（guard deny 或工具执行失败，带 reason）。
- 去掉 `curate:plan`（无 triage 阶段）。前端对未出现的事件无害（事件是追加式）；如需要在 Spec 2 顺带给 `use-job-stream` 注册 `curate:delete`/`curate:create`（沿用既有 toast/pill 映射）。

### 决策 5：系统提示 `CURATE_AGENTIC_SYSTEM_PROMPT`（保守、无人确认）

新增（替换 triage/confirm 三套 prompt）：保守 wiki 策展员；给定 scope 内页清单；**行动前必须 `wiki.read` 看正文**；可——合并近重复页（`wiki.merge`）、拆分过载页（`wiki.split`）、删除确为冗余/空/已被并入的页（`wiki.delete`）、（仅手动）新建有价值的枢纽页（`wiki.create`）；**拿不准就不动**（保守优先，宁可少整理）；不碰 index/log；操作有数量上限且（auto）仅限本次改动页，达限/被拒就停止；这是后台任务、**无人工确认**，故每步都要自我把关。`buildCurateAgenticUserPrompt(scopeMetas, ctx, {auto})` 注入语言指令 + subject 段 + scope 页清单 + auto/manual 模式提示（auto：「只整理改动相关页，不新建页」）。

### 决策 6：退休的代码

- `curate-prompt.ts`：删 `CurateTriageSchema`/`CurateMergeConfirmSchema`/`CurateSplitConfirmSchema` + 三套 system prompt + 三个 builder；新增 `CURATE_AGENTIC_SYSTEM_PROMPT` + `buildCurateAgenticUserPrompt`。
- `curate-plan.ts`：删 `applyDecisionCaps` / `restrictToSeed`（被 guard 取代）；**保留** `expandScopeWithNeighbors`；新增 `createCurateGuard` + 类型。
- `curate-service.ts`：三段式编排整体重写为 tool-loop 驱动（决策 1）。
- `'curate'` LLM task 与 `/api/curate` 路由、`agentAutoCurate` 自动入队**不变**（仍 `generateTextWithTools('curate', …)` 路由该 task）。

---

## 三、文件清单

**新增**：
```
src/server/agents/tools/builtin/wiki-merge.ts          # wiki.merge 工具
src/server/agents/tools/builtin/wiki-split.ts          # wiki.split 工具
src/server/services/curate-tools.ts                    # buildCurateToolContext（worker 侧 read/search/list + merge/split/delete/create 能力，注入 guard+emit）
src/server/agents/tools/builtin/__tests__/wiki-merge.test.ts
src/server/agents/tools/builtin/__tests__/wiki-split.test.ts
```

**修改**：
```
src/server/agents/types.ts                  # ToolSideEffect += 'merge' | 'split'
src/server/agents/tools/tool-context.ts     # ToolContext += mergePages? / splitPage?
src/server/agents/tools/builtin/index.ts    # 注册 wiki-merge / wiki-split
src/server/llm/prompts/curate-prompt.ts     # 退休 triage/confirm；加 CURATE_AGENTIC_SYSTEM_PROMPT + builder
src/server/wiki/curate-plan.ts              # 退休 applyDecisionCaps/restrictToSeed；加 createCurateGuard；保留 expandScopeWithNeighbors
src/server/wiki/__tests__/curate-plan.test.ts  # 改测 createCurateGuard（caps/seed/create-deny/protected）+ expandScopeWithNeighbors 保留
src/server/services/curate-service.ts       # 重写为 tool-loop 驱动
src/lib/tool-activity.ts                    # 加 wiki_merge(🔗/Merging)/wiki_split(✂️/Splitting) 映射
src/hooks/use-job-stream.ts                 # 注册 curate:delete / curate:create（若未泛化）
docs/* CLAUDE.md（agents/services/wiki/llm + 根 changelog）
```

---

## 四、测试策略

- `createCurateGuard`（纯函数，重点）：
  - caps：第 N+1 次 `canMerge`/`canSplit`/`canDelete`/`canCreate` 返回 deny；`record` 正确累加；`totals()` 准确。
  - seed（seedSet!=null）：目标含 seed→allow；不含→deny('seed')。seedSet=null→全放行。
  - create：seedSet!=null→deny；null→受 cap 约束。
  - protected：index/log 目标→deny。
  - merge a===b→deny。
- `expandScopeWithNeighbors`：保留原测试（行为不变）。
- `wiki.merge`/`wiki.split` 工具 handler：能力存在→透传；缺失→`ok:false`；抛错→`ok:false`（镜像 wiki-delete 测试）。
- `curate-service`：scope 解析（auto seed+邻居 / manual 全库）+ guard 装配；以 mock 的 `generateTextWithTools` + page-ops 验证「工具被 guard 把守、emit 词汇正确」。LLM 自驱内容不单测（沿用项目惯例）。
- 不为 LLM 决策质量写测试。

---

## 五、关键不变量与风险

**不变量**：
- 每次 merge/split/delete/create = 一个 Saga commit，记入 History **可逐条回滚**。
- 保护页 index/log 永不被结构操作触及（guard + validateDeleteTarget + page-ops 三重）。
- 写次数硬上限（≤5×4/任务）+ auto seed 限制：**模型无法越界**，与提示无关。
- subject 隔离：scope/工具全程本 subject。
- `validateChangeset` 仍拦坏链（page-ops 内核）。

**风险**：
- *auto 自驱删除更激进*（旧 auto 只 merge/split，新增 delete）：靠 seed 限制（仅改动页）+ cap≤5 + 保守提示 + git 可回滚兜底；create 在 auto 直接禁进一步缩小面。
- *无 confirm 质量门*：tool-loop 用「读全文后行动」替代；保守提示 + 模型实际看正文，质量预期不低于旧 confirm，但依赖模型判断——hard caps 限制 blast radius。
- *maxSteps 耗尽未收尾*：generateTextWithTools 到 maxSteps 自然停；已执行的写各自已 commit（无半成品），emit complete 给真实计数。
- *token 成本*：scope 大时读多页耗 token；maxSteps=40 + 写 caps 限制；后续可按 scope 大小动态调（YAGNI，本 Spec 固定常量）。

---

## 六、Rollout

无 DB 迁移、无 schema 变更、无新 job 类型（`curate` 任务复用）。`/api/curate` 与 `agentAutoCurate` 自动入队不变。`ToolSideEffect` 加字面量、`ToolContext` 加可选能力均向后兼容。需确保 `generateTextWithTools('curate', …)` 在 worker 进程可用（provider-registry 进程无关，已被 ingest/embedding 间接验证）。retire 的 triage/confirm 是纯删除（无运行期引用残留即可）。

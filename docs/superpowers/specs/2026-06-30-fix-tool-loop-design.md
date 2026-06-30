# Fix → Tool-loop 改造设计（Agentic Wiki Tools Spec 3）

> **状态**：设计已批准，待写实现计划。
> **前置**：Spec 1（对话 create/delete 工具）✅、Spec 2（curate→tool-loop）✅ 均已并入 main。本 spec 是「Agentic Wiki Tools」三阶段的收官。

## 一、背景与目标

Health 页「Fix issues」触发的 `fix` 任务（`fix-service.ts`）当前是「**确定性阶段1 + 逐页结构化输出阶段2**」：

- 阶段1：`missing-frontmatter` 走纯函数 `fixMissingFrontmatter` 批量补齐，1 个 Saga commit。
- 阶段2：把 `broken-link` / `missing-crossref` / `contradiction` 按页分组，逐页调 `generateStructuredOutput('fix', FixPageSchema, …)`，附「全局诊断报告 + 启发式提取的关联页正文」只读上下文；`proceed` 自我门控、`validateChangeset` 拦坏链、`bodyShrankTooMuch` 忠实度护栏，每页 1 commit。

阶段2 的「预先塞关联页 + 每次只能改当前页」是机械约束：模型拿不到它真正想看的页、且无法为一个 contradiction 同时修两页。

**目标**：把阶段2 改造为**自驱 tool-loop**——模型自己 `wiki.read/search/list` 取证、自行决定改哪些页、调 `wiki.update` / `wiki.create` 修复。沿用 Spec 2 在 curate 上验证过的「**确定性 pre-pass + tool-loop + 工具层硬护栏**」范式。

**非目标**：不改 lint 检查本身；不扩大可修 finding 类型（`orphan`/`stale-source`/`coverage-gap` 仍不修）；不给 fix 删除页的能力（删/合/拆属 curate 的结构策展职责）；`wiki.update` 不支持改标题（标题/slug 变更属重命名语义，超出修复范围）。

## 二、关键决策（已确认）

| 决策 | 选择 | 理由 |
|------|------|------|
| 确定性 frontmatter 阶段 | **保留为 tool-loop 前的确定性 pre-pass**（1 commit） | `missing-frontmatter` 是纯机械补字段、无判断；用 LLM 不划算。与 curate「确定性护栏 + LLM loop」分工一致 |
| tool-loop 写工具集 | **update + create**（不含 delete） | 修复语义=补链/改写/和解（update）+ 补建缺失页（create）。删页属 curate 职责；自动修复里给 delete 误删风险高 |
| `wiki.update` 内核范围 | **正文 + 摘要 + tags，不改标题** | fix 几乎不需要改标题；改标题/slug 属重命名语义。内核保持精简，复用面更广 |
| `fix:*` 事件命名 | 沿用现有 `fix:start/deterministic/page/skip/warn/complete`；update→`fix:page`、create→`fix:create`、guard 拒绝→`fix:skip` | 前端 `use-job-stream` 仅需补 `fix:create`，改动最小 |
| 写次数 cap | `max(20, worklist 页数 × 2)` | fix 总是手动触发，cap 仅作 runaway backstop，按 worklist 规模给足，正常不会触顶 |

## 三、架构

`runFixJob` 流程（替换现阶段2，阶段1 与收尾基本不变）：

```
1. 工作清单（不变）
   buildFixWorklist(新鲜重扫确定性 ∪ 最近 lint 快照语义)
   → partitionFindings → { frontmatter, loop, ignored }
        frontmatter = missing-frontmatter
        loop        = broken-link / missing-crossref / contradiction

2. pre-pass（不变）：确定性补 frontmatter
   fixMissingFrontmatter(...) × N → 一个 Saga commit → emit fix:deterministic

3. tool-loop（新）
   guard = createFixGuard({ caps })
   ctx   = buildFixToolContext(subject, { guard, jobId, emit })
   tools = compileToolSet(resolve(['wiki.read','wiki.search','wiki.list','wiki.update','wiki.create']), ctx)
   await generateTextWithTools('fix', {
     system:   FIX_AGENTIC_SYSTEM_PROMPT,
     messages: [{ role:'user', content: buildFixAgenticUserPrompt(reportLines, roster, ctx) }],
     tools, maxSteps: FIX_MAX_STEPS,
   })

4. 收尾（不变）
   guard.totals().writes > 0 → enqueueEmbedIndex(subject.id)
   emit fix:complete（fixed/skipped/failed/byType 由 guard 计数）
   UI 在 job completed 后自动重跑 lint（前端既有逻辑，不改）
```

每次写工具调用 = 一个独立 git commit（update/create 内核各自 `createChangeset → validate → apply`），逐条可回滚；pre-pass 另算一个 commit。

## 四、组件与接口

### 4.1 新建基建（Spec 1 当时推迟的 update 一族）

**`wiki/page-ops.ts` 新增 `executePageUpdate`**（与 create/delete/merge/split 内核同构：无 emit、无 enqueue，仅 LLM-free 的确定性拼装 + Saga）：

```ts
export async function executePageUpdate(
  jobId: string,
  subject: Subject,
  params: { slug: string; body: string; summary?: string; tags?: string[] },
): Promise<{ updatedSlug: string }>
```

行为：
1. `readPageInSubject(subject.slug, slug)`，不存在 → 抛错。
2. 确定性拼 frontmatter：保留原 `title`/`created`，`tags`/`summary` 按入参覆盖（未传则保留原值），正文换成 `params.body`，`stampSystemFrontmatter` 盖 `updated`。
3. `createChangeset(update) → validateChangeset`：
   - `!valid`（含跨主题坏链 errors）→ 抛错。
   - `validation.warnings` 含 `Unresolved wikilink:` 项 → 抛错（单页更新留下坏链视为修复未完成）。
4. `applyChangeset`，返回 `{ updatedSlug }`。

> 设计取舍：把「不留坏链」直接做进内核——单页更新里残留的同主题 unresolved-wikilink（validateChangeset 仅记 warning、`valid` 仍为 true）等同坏链，故内核在该 warning 上也抛错。这把现 fix-service「拒残链」的严格度内聚进通用原语（对未来对话式 `wiki.update` 复用同样合理：引导模型「先建目标页再链接」），fix wrapper 无需二次校验。`executePageCreate` 维持原状（仅 `valid` 把关）不在本 spec 改动范围。

**`agents/tools/builtin/wiki-update.ts` — `wiki.update` 工具**（mirror `wiki-create.ts`）：

```ts
InputSchema  = { slug: string, body: string(无 frontmatter), summary?: string, tags?: string[] }
OutputSchema = { ok: boolean, updatedSlug: string|null, message: string }
sideEffect   = 'update'
handler: ctx.updatePage 缺失 → ok:false 优雅报错；否则委托 ctx.updatePage(input)，异常转 ok:false + message
```

工具 description 明确：body 不含 frontmatter（系统管理 frontmatter）；只能引用已存在页的 `[[wikilink]]`，坏链会被拒；用于修复诊断报告里列出的问题。

**`agents/tools/tool-context.ts` + `agents/types.ts`**：
- `ToolContext` 新增可选 `updatePage?(input: { slug: string; body: string; summary?: string; tags?: string[] }): Promise<{ updatedSlug: string; unresolvedWikilinks: string[] }>`（仅 fix runner 注入；其余 runner 不传 → 工具 ok:false）。
- `ToolSideEffect` 联合类型新增 `'update'`。

### 4.2 fix 工具上下文 `services/fix-tools.ts`（新）

`buildFixToolContext(subject, { guard, jobId, emit }): ToolContext`，mirror `curate-tools.ts`：

- **读侧**（与 curate-tools / query-tools 同构）：`readPage`=已提交 vault、`search`=`hybridRankSlugs`、`listPages`=过滤 meta（上限 200）。
- **写侧**：
  - `updatePage(input)`：先 `guard.canWrite()`（cap 检查）+ `guard.canEditPage(input.slug)`（保护页检查），任一 deny → `emit('fix:skip', …)` + 抛错（工具层 catch 转 ok:false，reason 透传模型）。
    - 忠实度：在调内核前读现有正文，若 `bodyShrankTooMuch(原正文, input.body)` → emit `fix:warn` + 抛错（拒绝，不提交）。
    - allow 且通过忠实度 → 调 `executePageUpdate`（内核负责坏链/残链一律抛错、不落盘；抛出的 reason 经工具层转 ok:false 透传模型，供下一轮自纠）。
    - 成功 → `guard.record('update')` + emit `fix:page`。
  - `createPage(input)`：`guard.canWrite()` deny → skip+抛错；allow → `executePageCreate`（内核已 `validateChangeset` 拦跨主题坏链 errors）→ `guard.record('create')` + emit `fix:create`。

### 4.3 fix 护栏 `createFixGuard`（扩展 `services/fix-deterministic.ts`，纯逻辑/无 I/O）

mirror `wiki/curate-plan.ts::createCurateGuard`，但 fix 总是手动触发 → **无 seed 限制**：

```ts
export interface FixGuard {
  canWrite(): { ok: boolean; reason?: string };       // 写次数未达 cap
  canEditPage(slug: string): { ok: boolean; reason?: string }; // 非 meta 保护页
  record(op: 'update' | 'create'): void;
  totals(): { update: number; create: number; writes: number };
}
export function createFixGuard(opts: { caps: { writes: number } }): FixGuard
```

- `canWrite`：`writes >= caps.writes` → ok:false（runaway backstop）。
- `canEditPage`：`META_PAGE_SLUGS.has(slug)`（复用 Spec 2 follow-up 落地的单一源常量）→ ok:false（禁改 index/log）。
- 忠实度（`bodyShrankTooMuch`）放在 fix-tools wrapper（需现有正文，guard 不读盘）。

### 4.4 Prompt：`llm/prompts/fix-prompt.ts`

- **退休**：`FixPageSchema` / `FIX_SYSTEM_PROMPT` / `buildFixPageUserPrompt`（逐页结构化输出三件套）。
- **新增**：
  - `FIX_AGENTIC_SYSTEM_PROMPT`：定位为「保守的 wiki 修复者」，规则——逐条对照诊断清单修复；改一页前先 `wiki.read` 它（contradiction 还要读相关页）；只用 `wiki.update`/`wiki.create`；坏链/残链会被拒（工具返回 ok:false 时按 reason 自纠或跳过）；忠实正文、不大段删内容；改完停止调用工具并简述所做修改。
  - `buildFixAgenticUserPrompt(reportLines, roster, ctx)`：注入语言/subject 指令 + 用 `buildSubjectReportLines` 渲染的诊断清单（按页分组的 `<type>: <截断描述>`）+ 页清单 roster（供模型选 crossref 目标）。

### 4.5 `services/fix-service.ts` 重写

- 删除阶段2 的逐页 `generateStructuredOutput` 循环及其关联页注入逻辑。
- 保留：参数解析、阶段1 确定性 frontmatter（1 commit）、`fixed/skipped/failed/byType` 统计（改由 guard.totals + emit 事件累计）、`enqueueEmbedIndex`、`fix:complete`。
- 新增：装配 guard + `buildFixToolContext` + 工具集，驱动 `generateTextWithTools('fix', …)`。
- 模块级 `createBuiltinToolRegistry().resolve(['wiki.read','wiki.search','wiki.list','wiki.update','wiki.create'])`（fix 工具集固定 5 个，无 auto/manual 区分，故静态解析；guard caps 才在 `runFixJob` 内按 worklist 规模算）。

### 4.6 `fix-deterministic.ts` 增删

- **保留**：`fixMissingFrontmatter`、`partitionFindings`、`buildFixWorklist`、`bodyShrankTooMuch`、`buildSubjectReportLines`（+ `REPORT_DESC_MAX`）。
- **退休**：`findRelatedPageSlugs`、`mentions`、`MAX_RELATED_PAGES`（关联页改由模型自驱 `wiki.read`/`wiki.search` 获取，无需启发式预提取）。
- **新增**：`createFixGuard` + `FixGuard` 接口。
- `partitionFindings` 的 `llm` 桶语义不变（仍是 `LLM_FIX_TYPES`），仅在 service 里改名引用为 `loop`（可选，纯可读性）。

### 4.7 前端

- `src/hooks/use-job-stream.ts`：在已注册的 `fix:*` 事件基础上补 `fix:create`。其余（`fix:start/deterministic/page/skip/warn/complete`）已注册，无需改。
- 无新 API、无 DB 迁移。Health 页「Fix issues」入口与完成后自动重跑 lint 均不变。

## 五、数据流与安全

- **每写一次一个 git commit**：update/create 内核各自 `createChangeset → validate → apply`，逐条可回滚；pre-pass 一个 commit。
- **坏链护栏**：内核 `validateChangeset` 拦截跨主题坏链（errors→reject）；fix wrapper 额外拒「留下未解析 wikilink」（沿用现 fix-service 严格度，reason 透传模型自纠）。两道关合起来保证修复不会引入/残留坏链。
- **越界防护**：禁改 meta 页（`META_PAGE_SLUGS`）；写 cap + `maxSteps` 双重 bound 防 runaway。
- **忠实度**：`bodyShrankTooMuch`（正文塌缩 >50% 拒绝），防模型借「修复」之名删内容。
- **额外收益**：tool-loop 可为一个 contradiction **同时改两页**（现 per-page 流水线做不到）；可按需读任意相关页取证（现仅注入启发式预提取的关联页）。

## 六、文件清单

| 动作 | 文件 |
|------|------|
| 新增 | `src/server/agents/tools/builtin/wiki-update.ts` |
| 新增 | `src/server/services/fix-tools.ts` |
| 改 | `src/server/wiki/page-ops.ts`（+`executePageUpdate`）|
| 改 | `src/server/agents/tools/tool-context.ts`（+`updatePage?`）|
| 改 | `src/server/agents/types.ts`（`ToolSideEffect` +`'update'`）|
| 改 | `src/server/services/fix-service.ts`（重写阶段2 为 tool-loop）|
| 改 | `src/server/services/fix-deterministic.ts`（+`createFixGuard`，退休关联页提取）|
| 改 | `src/server/llm/prompts/fix-prompt.ts`（退休逐页三件套，新增 agentic prompt）|
| 改 | `src/hooks/use-job-stream.ts`（+`fix:create`）|
| 改 | `src/lib/tool-activity.ts`（加 `wiki_update` → ✏️ 图标/动词映射，与 create/delete/merge/split 一致）|
| 改 | 模块文档 `src/server/wiki/CLAUDE.md` / `src/server/services/CLAUDE.md` / `src/server/agents/CLAUDE.md` / `src/lib/CLAUDE.md` + 根 changelog |

## 七、测试

| 单元 | 覆盖 |
|------|------|
| `wiki/__tests__/page-ops-update.test.ts`（新） | `executePageUpdate`：正常更新（保 title/created、盖 updated、覆盖 tags/summary）；引入跨主题坏链 → 抛错不提交；留下同主题 unresolved-wikilink → 抛错不提交 |
| `services/__tests__/fix-deterministic.test.ts`（扩展） | `createFixGuard`：写 cap 耗尽 deny；`canEditPage('index')` deny；`record`/`totals` 累加准确。保留对 `fixMissingFrontmatter`/`partition`/`worklist`/`bodyShrankTooMuch` 的既有断言 |
| `services/__tests__/fix-service.test.ts`（新，mirror `curate-service.test.ts`） | pre-pass 命中 → 1 个确定性 commit；tool-loop 驱动 `generateTextWithTools('fix')`；工具集含 `wiki_update`/`wiki_create`；emit `fix:start`/`fix:complete`；worklist 空 → 不调 LLM 提前 complete |
| `agents/tools/builtin/__tests__/wiki-update.test.ts`（新） | `updatePage` 注入时正常 ok:true；ctx 缺 `updatePage` → ok:false 优雅报错 |

## 八、Rollout

无需删 skill 文件（fix 不走 ingest skill 体系，prompt 在 `fix-prompt.ts` 代码内）；无 DB 迁移。合并即生效。

# Agent 驱动的页面策展（merge/split 内化）— 设计文档

> 日期：2026-06-23
> 主题：把逐页手动 merge/split 收敛为 agent 自动决策的「页面策展（curation）」能力

---

## 一、背景与目标

当前 wiki 阅读页（`frontmatter-display.tsx`）在标题行同时渲染 **Merge / Split / Edit** 三个按钮。Merge/Split 由用户手动触发：选目标页 → 异步 `merge`/`split` job → LLM 融合/拆分 + `relink` 重链 + Saga 提交。

**问题**：合并/拆分本质是"知识库结构维护"决策，让用户手动判断"哪两页该合、哪页该拆"既割裂又容易漏。本项目的愿景是"读到的东西自动组织成知识网络"，结构维护理应由 agent 承担。

**目标**：

1. 阅读页只保留一个 **Edit** 按钮，去掉逐页 Merge/Split 按钮与对话框。
2. merge/split 升级为 **agent 自动决策**的策展能力，两条触发路径共用一套实现：
   - **自动**：ingest 成功提交后，自动对本次受影响页 + 邻近页做一次保守策展（受设置开关控制）。
   - **手动**：Health 体检页加「整理结构」入口，对整个 subject 做一次深度策展。
3. 执行层复用现有 merge/split 逻辑（LLM 内容生成 + `relink` + Saga），不重写。

**非目标（v1 明确不做）**：

- 策展结果的预览 / dry-run / 人工逐条审批。手动全库 pass 直接执行，靠 ⑥ 版本历史逐条 revert 兜底。
- 跨 subject 的合并/拆分（策展只在单 subject 内）。
- 语义相似度驱动的候选检测（v1 由 LLM 读元数据判断；向量召回是后续增强）。

---

## 二、关键架构决策

### 决策 1：service-level curator，不进 agent runtime

`src/server/agents/`（orchestrator + agent-loop + tool registry）**仅 ingest 启用**，且团队已在 2026-06-21 刻意删除 tool-using reviewer——packyapi 的 openai-compatible 转译下工具调用循环会死循环。现有 `lint` / `merge` / `split` / `query` 全部是 **service + 直接 `generateStructuredOutput`（无 tools）**。

curator 沿用同一模式：新建 `curate-service.ts`，直接调 `generateStructuredOutput`，**不引入 agent runtime**。"agent 决定何时 merge/split" 的语义由"LLM 用结构化输出产决策、确定性代码执行"承载，而非多 agent 工具循环。这是最一致、最安全、最少新增面的选择。

### 决策 2：复用执行层，抽成纯函数

把 `merge-service.ts` / `split-service.ts` 的核心主体抽到新模块 `src/server/wiki/page-ops.ts`：

```ts
executePageMerge(jobId, subject, { targetSlug, sourceSlug }, emit?): Promise<MergeResult>
executePageSplit(jobId, subject, { sourceSlug, hint }, emit?): Promise<SplitResult>
```

- 函数体直接来自现有 service：读页 → `generateStructuredOutput('merge'/'split')` → 确定性拼装 frontmatter → `repointLinksToPage` 重链自身 + 本 subject 内 backlink 源页 → `createChangeset → validateChangeset → applyChangeset`。
- **保留** `merge`/`split` 两个 LLM task（prompt/schema 完全不动）。
- `merge`/`split` 作为 **job type 与 handler 删除**；逻辑全部迁入 `page-ops.ts`。

### 决策 3：triage → confirm 两段式

沿用 verifier 的成熟范式（triage → 取证 → apply），避免把整库正文塞进单次 LLM 调用爆 token：

1. **Triage**：只喂 scope 内各页**元数据**（slug / title / summary / tags / 正文字数）→ 产出候选操作清单：`{ merges: [{aSlug, bSlug, reason}], splits: [{slug, reason}] }`。保守。
2. **Confirm**：对每个候选载入**完整正文** → 确认 go/no-go + 补全参数（merge 选哪页作存活 `target`；split 给 `hint`），或否决。
3. **Execute**：逐条确认项调 `executePageMerge` / `executePageSplit`，**每条一个独立 Saga commit**（⑥ 历史里可逐条 revert）。

自动路径 scope 小，候选集天然很少；手动全库路径靠 triage 用元数据先收窄，再 confirm 仅对候选取正文，保证可扩展。

---

## 三、组件设计

### 3.1 执行层：`src/server/wiki/page-ops.ts`（新）

- `executePageMerge(jobId, subject, params, emit?)`：迁移 `merge-service::runMergeJob` 主体。`emit` 可选（curate 复用同一 emit）。返回 `{ mergedSlug, deletedSlug, referencesRepointed }`。
- `executePageSplit(jobId, subject, params, emit?)`：迁移 `split-service::runSplitJob` 主体。返回 `{ sourceSlug, pageSlugs, primarySlug, referencesRepointed }`。
- 不在函数内 `enqueueEmbedIndex`（由调用方统一收口，避免一次 curate pass 触发 N 次 embed 回填）。

### 3.2 curate-service：`src/server/services/curate-service.ts`（新）

`runCurateJob(job, emit)` 流程：

1. **解析 scope**：`params.scope === 'pages'` → 用 `params.slugs`；`'subject'` → `pagesRepo.getAllPages(subjectId)` 全部。两种都排除 meta 页（`index` / `log`，复用 `PROTECTED_SYSTEM_PAGES`）。
2. **扩展邻居（仅 `scope:'pages'`）**：把 scope 内各页的反向链接源页 + 正向链接目标页并入，让"新页 vs 已有页"的合并候选可见。去重、仍排除 meta。
3. **Triage**：`generateStructuredOutput('curate', CurateTriageSchema, ...)`，输入 scope 内各页元数据。
4. **Confirm**：逐候选载入正文 → `generateStructuredOutput('curate', CurateConfirmSchema, ...)`。可逐条调用（实现简单、天然可并发；v1 串行即可）。
5. **执行上限**：单次 pass 截断到 merge ≤ 5、split ≤ 5（硬编码常量）。超出部分丢弃并 `emit('curate:warn', ...)`，**不无声截断**。
6. **逐条执行 + 重校验**：每条执行前重新读当前页状态——目标页/源页是否仍存在（可能被前一条操作删除或改名）、merge `target≠source`。失效则 `emit('curate:skip', ...)` 跳过，解决决策间串扰（如 merge 删了 B 后又有决策引用 B）。
7. **收口**：所有操作完成后 `enqueueEmbedIndex(subjectId)` 一次；`emit('curate:complete', ...)` 汇总（X 合并 / Y 拆分 / Z 引用重链 / W 跳过）。
8. `registerHandler('curate', runCurateJob)`；worker-entry 加 `import './services/curate-service'`。

**事件**：`curate:start` / `curate:plan`（候选数）/ `curate:merge` / `curate:split` / `curate:skip` / `curate:warn` / `curate:complete`。

### 3.3 LLM task 与 prompt：`src/server/llm/prompts/curate-prompt.ts`（新）

- `config-schema.ts::BUILTIN_LLM_TASKS` 加 `'curate'`（triage 与 confirm 共用同一路由配置）。
- `CurateTriageSchema`：`{ merges: {aSlug, bSlug, reason}[], splits: {slug, reason}[] }`。
- `CurateConfirmSchema`（merge）：`{ proceed: boolean, targetSlug?: string, reason: string }`。
- `CurateConfirmSchema`（split）：`{ proceed: boolean, hint?: string, reason: string }`。
- `buildCurateTriageUserPrompt(pages, ctx)` / `buildCurateConfirmUserPrompt(candidate, fullBodies, ctx)`：注入 `PromptContext`（语言指令 + subject name/slug）。
- system prompt 强调保守策略：**仅在两页明显冗余/高度重叠时提议 merge；仅在单页明显过大且覆盖多个独立主题时提议 split**；wikilink 字节级保真（执行层已保证，prompt 不产正文，无需重复）。

### 3.4 触发接线

**自动（ingest 收尾）**：`ingest-service::finalizeIngest` 在 `commitPending` 成功后，若 `settings-repo::getAgentAutoCurate() === true`：

```ts
queue.enqueue('curate', { scope: 'pages', slugs: touchedSlugs, subjectId }, subjectId);
```

`touchedSlugs` = 本次 ingest 实际写入/更新的内容页 slug（来自 pending entries 的 path 解析，排除 index/log）。失败不影响 ingest 本身的成功（fire-and-forget 入队）。

**手动（Health 页）**：新 `POST /api/curate/route.ts`：

```ts
requireAuth → requireCsrf → resolveSubjectFromRequest({ required: true, body })
→ queue.enqueue('curate', { scope: 'subject', subjectId: subject.id }, subject.id)
→ 202 { jobId, subjectId }
```

`components/health/health-view.tsx` 加「整理结构」按钮 → `useApiFetch` POST `/api/curate` → `useJobStream` 跟踪 → 完成失效相关 React Query key（pages / health / history）。

### 3.5 设置 `agentAutoCurate`

- `config/env.ts` 或常量处加 `DEFAULT_AGENT_AUTO_CURATE = true`。
- `settings-repo.ts`：加 `KEY_AGENT_AUTO_CURATE = 'agentAutoCurate'` + `getAgentAutoCurate()`（布尔，缺省 true）+ `setAgentAutoCurate()`。
- `GET/PUT /api/settings` 透传该 key。
- 设置面板 agent 区加一行开关「Ingest 后自动整理结构」。

---

## 四、契约与数据改动

- `lib/contracts.ts`：
  - `Job.type` 去掉 `'merge' | 'split'`，加 `'curate'`。
  - 更新 operation type 注释（merge/split 现以 `curate` 类型出现在 ⑥ 历史中——curate-service 的每个 changeset 在 curate jobId 下，operations-repo LEFT JOIN jobs 取到的 type 即 `'curate'`）。
- **零 DB 迁移**：`jobs.type` 是字符串列；不存在 `'merge'`/`'split'` 的历史 job 影响（即便有，仅历史展示用，handler 缺失会 fail 但属历史数据）。
- 前端：
  - `use-job-stream`（或事件注册处）把 merge/split 事件替换为 curate 事件。
  - history 页 type→label 映射加 `curate`（去掉 merge/split 或保留作历史标签——保留更稳妥）。

---

## 五、删除清单

| 类型 | 文件 |
|------|------|
| UI 按钮 | `components/wiki/merge-button.tsx`、`components/wiki/split-button.tsx` |
| UI 对话框 | `components/wiki/merge-dialog.tsx`、`components/wiki/split-dialog.tsx` |
| 阅读页接线 | `components/wiki/frontmatter-display.tsx` 去掉 MergeButton/SplitButton（保留 Edit） |
| 路由 | `app/api/merge/route.ts`、`app/api/split/route.ts` |
| handler | `services/merge-service.ts`、`services/split-service.ts`（逻辑迁入 `wiki/page-ops.ts`）+ worker-entry 两条 import |

**保留**：`llm/prompts/merge-prompt.ts`、`llm/prompts/split-prompt.ts`、`wiki/relink.ts`、`wiki/split-plan.ts`、`merge`/`split` LLM task。

---

## 六、安全与保守策略

- 永不触碰保护页（`index` / `log`），triage 输入即排除。
- merge 自校验 `targetSlug !== sourceSlug`；执行前重校验两页仍存在。
- 决策间串扰：逐条执行前重读状态，失效跳过。
- 操作上限（merge ≤ 5 / split ≤ 5 每 pass），超出截断 + 显式告警。
- triage system prompt 强约束保守度，降低误合并/误拆分概率。
- 手动全库 pass 自动执行不预览，依赖 ⑥ 历史逐条 revert 作为回退路径。

---

## 七、测试策略

- `wiki/page-ops.ts`：沿用现有 merge/split service 的测试用例（如有），改为调用抽取后的函数，确认无行为回归。
- `curate-service.ts` 纯逻辑：
  - scope 扩展（pages → +邻居 → 去重 → 排除 meta）。
  - 决策重校验跳过（源页被前一条删除时跳过）。
  - 上限截断（超过 N 条丢弃并告警）。
- `curate-prompt.ts`：triage / confirm schema 解析。

---

## 八、推广步骤（rollout）

- 无 DB 迁移、无需删 vault 文件（curator 不用 agent skill YAML）。
- 需在 `llm-config.json::tasks` 按需加 `"curate": { ... }`（缺省走 defaults，可选）。
- `agentAutoCurate` 缺省 true，部署即生效；用户可在设置面板关闭。

---

## 九、开放问题 / 后续增强

- 向量相似度驱动的 merge 候选召回（替代纯 LLM 元数据判断）。
- 策展预览 / 人工审批（v1 不做）。
- 自动策展的更细粒度阈值设置（字数阈值、相似度阈值）。

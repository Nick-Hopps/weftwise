# Wiki 工具面与工作流治理重构 — 设计 Spec

日期：2026-07-10  
状态：Phase 0–2 已完成；Phase 3 执行中（Phase 3A–3C 已实现）

## 一、背景

当前 Wiki 已具备一套较完整的页面操作工具：读取、搜索、枚举、创建、整页更新、局部更新、删除、重新增益、合并、拆分和联网搜索。Ingest、Ask AI、Fix、Curate、Research、Re-enrich 也已经形成各自的执行路径。

但现有工具面存在结构性失衡：**写能力强于观察能力，Prompt 约束强于运行时约束，工作流入口多于闭环状态**。

具体表现为：

1. Fix / Curate 能修改、合并、拆分、删除页面，却看不到页面关联的原始来源、完整出入链拓扑和历史差异；
2. Ask AI 每轮默认注入全部页面写工具，写操作确认依赖系统提示和对话历史，没有服务端可验证的审批凭证；
3. `ToolDef.sideEffect` 已区分 `create/update/destructive/...`，但 `compileToolSet` 只负责转换 schema 和执行 handler，不消费该字段做权限判断；
4. Auto Curate 虽然计算了 `seed + neighbors`，但 `wiki.list` / `wiki.search` 仍可看到整个 subject，写守卫也没有要求所有目标都位于允许范围内；
5. Health 能发现 `orphan/stale-source/coverage-gap/orphan-source/thin-page`，Fix 却统一忽略，没有路由到 Curate、Research、Re-ingest 或 Re-enrich；
6. `dispatch.skill`、`commit_changeset` 仍注册为工具，但前者必然报错，后者已无 pipeline 使用；当前 vault 还可能残留已经退役的内置 skill；
7. `save-to-wiki` 与 `wiki.create` 分别维护页面创建逻辑，行为已经出现 slug 冲突策略、标签、来源和 embedding 回填上的漂移。

本设计把工具系统从“共享注册表 + Prompt 自律”重构为“**证据优先、最小授权、可预览、可审批、可验证、可恢复**”的能力体系。

## 二、目标

1. 让 Agent 在修改 Wiki 前能看到足够的页面关系、来源证据和影响范围；
2. 将 Ask AI 写操作从 Prompt 级确认升级为服务端强制审批状态机；
3. 按 runner 和 intent 动态装配工具，避免无关工具常驻模型上下文；
4. 收紧 Auto Curate 的读取范围和写入范围，避免 scope 只停留在提示词；
5. 把 Health finding 路由到正确的修复工作流，形成可追踪闭环；
6. 删除不可达工具和退役内置资产，保持注册表、运行时和 vault 一致；
7. 保留现有 Saga、subject 隔离、worker 串行和 git History 不变式。

## 三、非目标

- 不把所有 API 包装成模型工具；
- 不允许模型直接调用任意 changeset commit；
- 不在本设计中开放跨 subject 写入；
- 不把 Ingest、Research、Re-enrich 的固定编排步骤改造成自由工具循环；
- 不在第一阶段实现 slug/path 迁移；
- 不取消现有 History 页面和人工编辑页面；
- 不让 `wiki.inspect` 或来源工具绕过 subject 隔离。

## 四、设计原则

### 4.1 工具只承载“模型必须动态决策”的能力

满足以下条件才注册为模型工具：

1. 模型需要根据中间结果决定是否调用以及调用目标；
2. 输入、输出和副作用可以严格结构化；
3. 服务端能够确定性校验、限制和回滚；
4. 不是固定必经步骤。

因此：

- 搜索、读取来源、检查链接、精确修改适合工具；
- commit、索引渲染、fanout、checkpoint、后置校验留在 Service / Orchestrator；
- `finish` 是 provider 协议适配器，不进入业务工具注册表；
- Research / Re-enrich / Ingest 是 workflow command，不继续扩张 `wiki.*` 页面命名空间。

### 4.2 读、提案、执行三层分离

```text
读取层（无副作用）
  wiki.read/search/list/inspect
  source.search/read
  history.list/diff

提案层（不写 vault）
  wiki.preview_change
  → 生成 PendingAction + 精确 diff + payloadHash

执行层（写 vault）
  用户显式批准 PendingAction
  → API 直接消费已保存 payload
  → Saga 写入
  → 后置校验
```

模型可以生成提案，但不能把“我认为用户已经同意”当作执行权限。

### 4.3 权限必须由运行时强制

`ToolDef.sideEffect` 从展示性元数据升级为编译和执行时策略输入。任何写工具必须同时满足：

- 当前 `ToolProfile` 允许该工具名；
- 当前 runner 允许该 `sideEffect`；
- query 写操作拥有未过期、未消费、subject 和 payload 均匹配的 approval；
- worker 写操作拥有 job 类型对应的 capability，并通过现有 Guard。

Prompt 仍描述操作纪律，但不再承担授权职责。

## 五、目标架构

### 5.1 能力分层

```text
┌─────────────────────────────────────────────────────────────┐
│ Query / Fix / Curate / Ingest Runner                        │
└───────────────────────────┬─────────────────────────────────┘
                            │ resolveToolProfile(profile, ctx)
┌───────────────────────────▼─────────────────────────────────┐
│ Tool Policy                                                 │
│ · tool allowlist                                            │
│ · allowed sideEffects                                      │
│ · subject / page scope                                     │
│ · approval / job capability                                │
└───────────────────────────┬─────────────────────────────────┘
                            │ compileToolSet
┌───────────────────────────▼─────────────────────────────────┐
│ Model-facing Tools                                          │
│ read → inspect → source evidence → preview                  │
└───────────────────────────┬─────────────────────────────────┘
                            │ approved execution
┌───────────────────────────▼─────────────────────────────────┐
│ Service Commands / Page Ops / Wiki Transaction              │
│ validate → apply → SQLite → git → postcondition verification│
└─────────────────────────────────────────────────────────────┘
```

### 5.2 ToolProfile

新增 `src/server/agents/tools/profiles.ts`：

```ts
export type ToolProfileId =
  | 'query:read'
  | 'query:propose'
  | 'fix:links'
  | 'fix:contradiction'
  | 'curate:auto'
  | 'curate:manual'
  | 'ingest:planner'
  | 'ingest:writer';

export interface ToolProfile {
  id: ToolProfileId;
  tools: readonly string[];
  allowedSideEffects: readonly ToolSideEffect[];
  requiresApproval: boolean;
}
```

`resolveToolProfile(profileId, context)` 只返回当前上下文真正可用的工具；联网未配置时继续剔除 `web.search`。

初始 profile：

| Profile | 工具 |
|---|---|
| `query:read` | `wiki.list/search/read/inspect`、`source.search/read`、`subject.list`、`wiki.search_cross_subject/read_cross_subject`、可选 `web.search` |
| `query:propose` | `query:read` + `wiki.preview_change` + `history.revert`（预览仍只写 active Subject） |
| `fix:links` | `wiki.search/read/inspect`、`source.search/read`、`wiki.patch` |
| `fix:contradiction` | `fix:links` + `wiki.update` |
| `curate:auto` | `wiki.search/read/inspect`、`wiki.merge/split`；P1 再加 `wiki.link.ensure`、`wiki.metadata.patch` |
| `curate:manual` | `curate:auto` + `wiki.create/delete` |
| `ingest:planner` | `wiki.read/search` |
| `ingest:writer` | `wiki.read/search` |

`wiki.list` 从 Fix 和 Curate 移除：Fix 已注入 roster；Curate 已注入 scope 页面元数据。Ask AI 继续保留。

### 5.3 compile policy

`compileToolSet` 新增必传策略：

```ts
export interface ToolExecutionPolicy {
  profileId: ToolProfileId;
  allowedSideEffects: ReadonlySet<ToolSideEffect>;
  subjectId: string;
  allowedPageSlugs?: ReadonlySet<string>;
  jobCapability?: { jobId: string; jobType: Job['type'] };
}
```

编译阶段：

- 工具不在 profile allowlist：不进入 `ToolSet`；
- `sideEffect` 不在 `allowedSideEffects`：启动时抛配置错误，禁止静默降级；
- query profile 不直接编译 create/update/delete/merge/split 等实际写工具，只编译 `wiki.preview_change/history.revert` 两个提案工具；
- worker profile 可以编译写工具，但执行 handler 时仍必须通过 Guard。

执行阶段：

- read/search/list/inspect 必须使用 policy 中的 subject 与 allowed page scope；
- 写工具 handler 不自行推断授权；
- `onToolCall` 事件记录 profile、sideEffect、subjectId、目标页和结果。

## 六、P0：观察与证据工具

### 6.1 `wiki.inspect`

新增 `src/server/agents/tools/builtin/wiki-inspect.ts`。

输入：

```ts
{
  slug: string;
  include?: Array<'links' | 'backlinks' | 'sources' | 'health'>;
}
```

输出：

```ts
{
  found: boolean;
  page: null | {
    slug: string;
    title: string;
    summary: string;
    tags: string[];
    updatedAt: string;
  };
  outgoing: Array<{
    subjectSlug: string;
    slug: string;
    title: string | null;
    context: string;
    resolved: boolean;
  }>;
  backlinks: Array<{
    subjectSlug: string;
    slug: string;
    title: string;
  }>;
  sources: Array<{
    id: string;
    filename: string;
    originUrl: string | null;
    parsedAt: string | null;
    stale: boolean;
  }>;
  health: {
    brokenLinks: number;
    inboundCount: number;
    outboundCount: number;
    sourceCount: number;
  };
}
```

约束：

- 不返回正文，正文仍由 `wiki.read` 提供，避免每次检查重复注入长文本；
- meta 页默认不可见；
- 同 subject 只返回当前 subject 页面，跨 subject 链只返回显式链接目标的最小元数据；
- `allowedPageSlugs` 存在时，scope 外 slug 返回 `found:false`，不泄露元数据；
- 复用 `pagesRepo.getBacklinks/getAllLinks`、`sourcesRepo.getSourcesForPage` 和单页 stale 检查，不复制 wikilink 解析逻辑。

### 6.2 `source.search`

新增 `src/server/agents/tools/builtin/source-search.ts`。

输入：

```ts
{
  query: string;
  pageSlug?: string;
  sourceIds?: string[];
  limit?: number; // 1..10，默认 5
}
```

行为：

- `pageSlug` 存在时只搜索该页关联 sources；
- `sourceIds` 存在时校验所有 source 均属于当前 subject；
- 两者都缺失时搜索当前 subject 的全部 source；
- 读取 sidecar chunks，使用确定性词项相关度排序；P0 不为 source 新增 embedding 表；
- 单条 excerpt 最多 2,000 字符，总输出最多 12,000 字符；
- PDF 使用 ingest 后的 sidecar chunks，不直接把二进制或整本解析文本传给模型。

输出：

```ts
{
  hits: Array<{
    sourceId: string;
    filename: string;
    chunkId: string;
    heading: string;
    excerpt: string;
    score: number;
  }>;
}
```

### 6.3 `source.read`

新增 `src/server/agents/tools/builtin/source-read.ts`。

输入：

```ts
{
  sourceId: string;
  chunkId?: string;
  offset?: number;
  limit?: number; // 默认 8,000，最大 20,000 字符
}
```

规则：

- source 必须属于当前 subject；
- 优先读取 sidecar chunk；没有 chunkId 时读取受限窗口；
- 返回 `nextOffset` 和 `truncated`，支持模型按需继续；
- HTML 使用清洗/解析后的 chunk，不把可执行 HTML 注入模型；
- 所有访问通过 `onAccess` 记录 sourceId/chunkId，供回答引用和审计。

### 6.4 `wiki.list` 扩展

不新增第二个 browse 工具，直接扩展现有 schema：

```ts
{
  cursor?: string;
  limit?: number;       // 默认 50，最大 100
  tag?: string;
  sort?: 'title' | 'updated';
}
```

输出增加 `nextCursor`。移除“list every page”的提示词承诺；当前固定截断 200 页的行为退役。

## 七、P0：PendingAction 与审批状态机

### 7.1 数据结构

新增 `pending_actions` 表：

```text
id                TEXT PRIMARY KEY
conversation_id   TEXT NOT NULL
subject_id        TEXT NOT NULL
operation         TEXT NOT NULL
payload_json      TEXT NOT NULL
payload_hash      TEXT NOT NULL
preview_json      TEXT NOT NULL
status            TEXT NOT NULL   -- pending/approved/executing/applied/rejected/expired/failed
created_at        TEXT NOT NULL
expires_at        TEXT NOT NULL
approved_at       TEXT
applied_at        TEXT
operation_id      TEXT            -- 成功后的 History operation id
error_json        TEXT
```

约束：

- 一次 action 只允许从 `pending → approved → executing → applied|failed`；
- `pending → rejected|expired` 后不可复活；
- approval 与执行使用 SQLite 原子条件更新抢占，防重复点击；
- 默认 30 分钟过期；
- payload hash 使用 canonical JSON 的 SHA-256；
- conversation、subject、operation 和 payload 均进入 hash；
- GC 保留 30 天，applied action 的长期审计落在 operations / git History。

### 7.2 `wiki.preview_change`

新增 query-only 工具，`sideEffect:'propose'`。`ToolSideEffect` 增加 `'propose'`。

P0 支持：

```ts
type PreviewInput =
  | { operation: 'create'; payload: CreatePageInput }
  | { operation: 'update'; payload: UpdatePageInput }
  | { operation: 'patch'; payload: PatchPageInput }
  | { operation: 'delete'; payload: { slug: string } }
  | { operation: 'reenrich'; payload: { slug: string } };
```

工具执行：

1. 校验目标、保护页、subject、坏链和忠实度；
2. 生成候选 changeset，但不调用 `applyChangeset`；
3. 计算统一 diff、受影响页、引用更新数、断链风险和摘要；
4. 保存 PendingAction；
5. 返回 `actionId + preview`；
6. SSE 发出 `pending-action` 事件，前端渲染明确的“确认 / 取消”按钮。

返回：

```ts
{
  actionId: string;
  operation: string;
  summary: string;
  affectedPages: Array<{ slug: string; action: 'create' | 'update' | 'delete' }>;
  diff: string;
  warnings: string[];
  expiresAt: string;
}
```

### 7.3 页面操作拆分为 plan/apply

为了让 preview 与 apply 使用同一份确定性逻辑，`page-ops.ts` 的 create/update/patch/delete 拆为：

```ts
planPageCreate(...): PlannedPageOperation
planPageUpdate(...): PlannedPageOperation
planPagePatch(...): PlannedPageOperation
planPageDelete(...): PlannedPageOperation

applyPlannedPageOperation(plan): Promise<AppliedPageOperation>
```

现有 `executePageXxx` 保留为兼容薄包装：`plan → apply`。preview 只调用 plan；审批 API 对保存的 payload 重新 plan，并验证新 hash/当前 HEAD 后再 apply，不能直接信任旧 preview 中的 changeset。

`PlannedPageOperation` 记录 `preHead`。审批时 HEAD 已变化则重新生成 preview，并把 action 退回 `pending`，要求用户重新确认，禁止静默套用陈旧 diff。

### 7.4 审批 API

新增：

- `GET /api/pending-actions?conversationId=...`
- `POST /api/pending-actions/[id]/approve`
- `POST /api/pending-actions/[id]/reject`

写接口必须 `requireAuth + requireCsrf + resolveSubjectFromRequest(required:true)`。

`approve` 直接执行已保存 action，不再开启模型工具循环。单纯在对话里输入“好的”“继续”不构成审批；UI 必须提交明确 actionId。

### 7.5 Query 工具面收缩

Ask AI 默认只编译 `query:read`。当用户明确提出 create/update/patch/delete/reenrich 或 History 回滚意图时，runner 切换为 `query:propose`，模型只能调用 `wiki.preview_change/history.revert` 生成审批预览，看不到实际写工具。

现有 `wiki.create/update/patch/delete/reenrich` 保留给 worker / 兼容路径，但从 Query `BASE_QUERY_TOOL_NAMES` 移除。审批 API 最终调用共享 Service command，不通过模型工具 handler。

## 八、P0：Curate 与 Fix 边界收紧

### 8.1 Auto Curate scope 变成硬边界

`createCurateGuard` 新增 `allowedSet`：

```ts
createCurateGuard({
  seedSet,
  allowedSet, // seed + 本 subject 一跳邻居
  caps,
})
```

规则：

- read：scope 外 slug 返回 missing；
- search：先检索，再过滤为 allowedSet；
- list：Auto Curate 不注入；
- merge：两个目标都必须在 allowedSet，且至少一个位于 seedSet；
- split：目标必须同时位于 allowedSet 和 seedSet；
- delete：Auto Curate 不注入；
- create：保持仅 manual；
- meta 页继续禁止。

Auto Curate 暂时保留 merge/split，但执行前必须 `wiki.read + wiki.inspect`；来源不同且各有独立证据的页面禁止 merge。

### 8.2 工具描述去除 runner-specific 授权文本

共享 `wiki.create/delete/...` 的 description 只描述能力、输入和后果，不再写“仅在用户上一轮确认后调用”等 runner-specific 规则。

原因：同一个 `wiki.delete` 同时用于 Query 和 Curate；Query 需要用户审批，Curate 是后台 job，自相矛盾的 description 会污染模型选择。授权规则统一由 ToolProfile、approval state 和 worker Guard 实施。

### 8.3 Fix 按 finding 类型选择写工具

- 工作清单只有 `broken-link/missing-crossref`：使用 `fix:links`，只提供 `wiki.patch`；
- 含 `contradiction`：使用 `fix:contradiction`，额外提供 `wiki.update`；
- `wiki.list` 移除，复用 Prompt 已注入的 roster；
- contradiction 修改前必须读取两个页面，并至少调用一次 `source.search`；找不到来源证据时跳过，不根据模型常识裁决。

### 8.4 自动后置验证

Fix / Curate 每次 job 完成前由 Service 固定执行 targeted postcondition verification，不注册模型工具：

- 重新检查 touched pages 的断链；
- 检查 merge/split 后所有入链目标；
- 检查 touched pages 是否产生新 orphan；
- 检查 page_sources 是否仍指向存在的 source；
- 对 Fix 重新计算目标 findings 是否消失。

失败策略：

- 单次页面操作自身已是 Saga 原子提交，不自动回滚之前已成功且合法的独立操作；
- job 本身仍使用既有 `completed` 状态，`resultJson.postconditionStatus` 标记为 `clean | residual`，并保存 residual findings；
- UI 明确显示“修改已提交，但仍有 N 项需要处理”；
- 不让模型在尾部自由调用通用 commit 或 rollback。

## 九、P1：知识网络窄写工具

### 9.1 `wiki.metadata.patch`

仅更新 `title/summary/tags/aliases`，不要求传完整正文：

```ts
{
  slug: string;
  title?: string;
  summary?: string;
  tags?: string[];
  aliases?: string[];
}
```

约束：

- 至少提供一个变更字段；
- title 变化复用现有 relink；
- tags 去空、去重、限制单项长度和总数量；
- aliases 不得与同 subject 其他 page slug/title/alias 冲突；
- 正文逐字保留；
- Saga 单 commit；
- Query 仍走 preview/approval；Curate 可经 Guard 直接调用。

### 9.2 `wiki.link.ensure`

用于维护一条明确关系，替代 Curate 使用任意正文改写：

```ts
{
  sourceSlug: string;
  targetSubjectSlug?: string;
  targetSlug: string;
  oldString: string;
  displayText?: string;
  mode: 'link' | 'unlink' | 'retarget';
}
```

语义：

- `oldString` 必须在 source body 中唯一匹配；
- `link` 把该片段包装成已验证目标的 wikilink；
- `unlink` 只移除 wikilink 标记，保留显示文本；
- `retarget` 保留显示文本并替换目标；
- 不负责自动生成“Related”段落；找不到自然锚点时返回失败；
- 复用 `resolveWikiLinkTarget` 和 `executePagePatch`；
- Query 走 preview；Fix / Curate 经各自 Guard 使用。

## 十、P1：Health remediation router

新增 `src/server/services/remediation-router.ts`，把 finding 映射到负责的 workflow，不让 Fix 静默忽略：

| Finding | 处理路径 |
|---|---|
| `missing-frontmatter` | Fix 确定性修复 |
| `broken-link` | Fix `wiki.link.ensure` / `wiki.patch` |
| `missing-crossref` | Fix `wiki.link.ensure` |
| `contradiction` | Fix + source evidence |
| `orphan` | 生成 Curate/link 建议，不自动删除 |
| `stale-source` | 创建 Re-ingest 建议或任务 |
| `coverage-gap` | Research → 候选确认 → Ingest |
| `orphan-source` | Retry ingest 或确认删除 source |
| `thin-page` | Re-enrich；来源不足时转 Research |

返回统一状态：

```ts
type RemediationStatus =
  | 'fixed'
  | 'queued'
  | 'awaiting-approval'
  | 'skipped'
  | 'failed';
```

每条 finding 需要稳定 ID。Research 不再使用 lint findings 数组下标作为 `gapIds`；finding ID、research job、候选审批、ingest job 和最终 touched pages 串成一条 provenance 链。

## 十一、P2：跨主题、历史与工作流命令

### 11.1 跨主题只读工具

- `subject.list`：返回 subject id/slug/name/description/pageCount；
- `wiki.search_cross_subject`：显式 opt-in，结果始终带 subjectSlug；
- 不修改现有 `wiki.search` 的 current-subject 语义；
- Query 回答跨 subject 内容时使用 `[[subject:slug]]`，引用解析同步支持；
- P2 不开放跨 subject create/update/delete。

### 11.2 History 工具

- `history.list({ slug?, limit? })`；
- `history.diff({ operationId })`；
- `history.revert` 仍走 PendingAction + 明确审批；
- 复用现有 operations/git diff/revert，不复制实现。

### 11.3 Workflow 命令

把 `wiki.reenrich` 迁移为：

- `workflow.reenrich.start`；
- `workflow.research.start`；
- `workflow.status`；
- `workflow.cancel`。

所有 start/cancel 都属于 `sideEffect:'enqueue'` 或 `'destructive'`，Query 下先生成 PendingAction。旧 `wiki.reenrich` 保留一个版本的 alias，记录 deprecation 日志后删除。

### 11.4 `wiki.move` 延后

slug/path 迁移涉及：

- vault 文件路径；
- pages 复合主键；
- wiki_links source/target；
- page_sources；
- embeddings / maturity / renditions；
- page_aliases；
- History 和旧链接兼容。

它必须作为独立 spec 实现，不与本次 P0/P1 混在一起。

## 十二、冗余清理与迁移

### 12.1 删除 `dispatch.skill`

- 从 builtin registry 删除；
- 删除 `builtin/dispatch-skill.ts` 及测试；
- `ToolSource` 移除 `'dispatch'`，只保留 `'builtin'`；
- dynamic fanout 继续由 orchestrator 内部实现。

### 12.2 删除 `commit_changeset` ToolDef

- 把 `commitPending` 移到 `src/server/agents/runtime/commit-pending.ts`；
- ingest / re-enrich service 改从新位置导入；
- 删除 `commitChangesetTool`、输入输出 tool schema 和 registry 注册；
- 保留并迁移 `commitPending` 的 service-level 测试；
- `ToolSideEffect` 移除 `'commit'`；
- `ToolContext.agent` 若无其他消费者则删除。

### 12.3 内置 Skill tombstone

新增内置 skill manifest：

```ts
export const BUILTIN_SKILLS = { ... };
export const RETIRED_BUILTIN_SKILLS = ['ingest-indexer'];
```

Worker 启动时：

- 只自动删除 retired skill 且其内容 hash 匹配任一历史内置模板的文件；
- 用户已修改的同名文件不删除，移动到 `.llm-wiki/skills-retired/<id>-<timestamp>.md` 并 emit warning；
- loader 不注册 retired ID，即使文件仍存在；
- 本次清理当前 vault 残留的 `ingest-indexer.md`。

### 12.4 统一页面创建路径

`saveQueryAsPage` 不再自行拼 changeset，改复用共享 create plan/apply：

- 保留 `query-answer` tag 和 References 正文模板；
- 明确 slug 冲突策略：保存回答与 `wiki.create` 均采用唯一 slug 后缀；
- 写后统一 enqueue embedding；
- 来源字段区分 `page citations` 与 `raw source IDs`，不再把页面 slug 混入 raw source 语义；
- UI 的“保存回答”仍保留，不等于删除该产品能力。

## 十三、错误处理与审计

### 13.1 错误类型

新增稳定错误码：

- `TOOL_NOT_ALLOWED`
- `SIDE_EFFECT_NOT_ALLOWED`
- `PAGE_OUT_OF_SCOPE`
- `SOURCE_OUT_OF_SCOPE`
- `ACTION_EXPIRED`
- `ACTION_ALREADY_CONSUMED`
- `ACTION_STALE_PREVIEW`
- `ACTION_PAYLOAD_MISMATCH`
- `POSTCONDITION_FAILED`

模型看到可修复错误消息，日志和 API 同时保留错误码。

### 13.2 审计字段

每次工具调用至少记录：

```ts
{
  profileId,
  tool,
  sideEffect,
  subjectId,
  pageSlugs,
  actionId?,
  jobId?,
  durationMs,
  outcome,
}
```

不记录完整页面正文和完整 source chunk，避免 job_events 膨胀；payload 只存于受控 pending_actions，History 继续保存 changeset。

## 十四、实施阶段

### Phase 0：清理与硬边界

1. 删除 `dispatch.skill` 和 `commit_changeset` ToolDef；
2. 迁移 `commitPending`；
3. 加 ToolProfile + compile policy；
4. Query 默认只读工具；
5. 收紧 Auto Curate allowedSet，移除其 `wiki.list/delete`；
6. 清理 retired skill。

### Phase 1：证据与审批

1. `wiki.inspect`；
2. `source.search/read`；
3. `wiki.list` 分页；
4. PendingAction 表、preview 工具、确认 UI/API；
5. create/update/patch/delete/reenrich query 路径切到 preview → approve；
6. Fix/Curate targeted postcondition verification。

### Phase 2：闭环维护

1. `wiki.metadata.patch`；
2. `wiki.link.ensure`；
3. Health remediation router + stable finding ID；
4. Research approval provenance；
5. 统一 save-to-wiki 创建路径。

### Phase 3：扩展能力

1. subject/cross-subject read tools（Phase 3A 已完成）；
2. history tools（Phase 3B 已完成）；
3. workflow start/status/cancel（Phase 3C 已完成）；
4. `wiki.move` 单独立项。

## 十五、测试策略

### 15.1 工具与策略

- ToolProfile 精确返回 allowlist；
- 未允许 sideEffect 在 compile 阶段失败；
- scope 外 read/search/inspect 不泄露页面；
- Query profile 永远不包含实际写工具；
- web 未配置时继续不注入 `web.search`。

### 15.2 Inspect / Source

- 正反链、跨主题链、断链、来源和 stale 状态准确；
- source 只能访问当前 subject；
- pageSlug/sourceIds 过滤正确；
- chunk/excerpt/总输出字符上限生效；
- HTML 不返回可执行原文。

### 15.3 PendingAction

- preview 零 vault/SQLite pages/git 副作用；
- approve 单次消费；
- 重复点击、过期、subject 不匹配、payload hash 不匹配均拒绝；
- HEAD 变化触发 stale preview，不执行旧 payload；
- approve 成功产生 Saga operation 和 git commit；
- reject 后不可 approve；
- CSRF/auth 完整覆盖。

### 15.4 Curate / Fix

- Auto Curate 读不到 allowedSet 外页面；
- merge 两端都受 allowedSet 限制；
- Auto profile 无 list/delete/create；
- link finding profile 无 `wiki.update`；
- contradiction 没有 source evidence 时不改写；
- postcondition residual findings 正确写入 job result。

### 15.5 迁移

- `commitPending` 行为与迁移前一致；
- retired 原版 skill 自动删除；
- retired 用户改版 skill 归档、不丢数据；
- `save-to-wiki` 与 `wiki.create` slug/embedding 行为一致。

## 十六、验收标准

1. builtin registry 中不存在 `dispatch.skill`、`commit_changeset`；
2. Ask AI 普通问答看不到任何实际写工具；
3. 所有对话写操作都能展示精确 diff，并只能通过显式 actionId 审批执行；
4. `ToolDef.sideEffect` 被 compile/runtime policy 实际消费；
5. Fix contradiction 能读取页面关联原始来源；
6. Auto Curate 无法读取或修改 allowedSet 外页面，也不能直接 create/delete；
7. Health 的每类 finding 都有明确 remediation 状态，不再静默 ignored；
8. Fix/Curate 完成后都有 targeted postcondition 结果；
9. retired `ingest-indexer` 不再出现在 SkillRegistry；
10. `save-to-wiki` 与对话创建共用同一页面创建内核；
11. 全部写入仍满足 subject 隔离、Saga、vault mutex、SQLite 索引和 git History 不变式。

## 十七、已考虑并否决的替代

### 17.1 继续依赖 Prompt 确认

否决。Prompt 可以约束模型行为，不能证明具体 payload 已被用户批准，也无法防止历史截断、歧义确认或 Prompt Injection。

### 17.2 给每个 API 都加同名工具

否决。会扩大工具选择空间和攻击面，把确定性编排错误地交给模型。

### 17.3 保留 `commit_changeset` 作为高级逃生舱

否决。它绕过窄工具语义和 runner Guard；当前也没有真实消费者。高级内部能力应是函数，不应注册给模型。

### 17.4 让 Curate 使用通用 `wiki.patch` 维护链接和标签

否决。通用正文 patch 的能力面过宽；P1 使用 `wiki.link.ensure` 和 `wiki.metadata.patch` 表达窄意图。

### 17.5 把整份 source 直接加入 Fix Prompt

否决。书本级来源会造成上下文膨胀；按页关联、按 query 检索、按 chunk 读取更符合工具调用模型。

### 17.6 一次性实现所有阶段

否决。审批状态机、来源工具、Curate 边界和跨主题能力风险不同，必须按 Phase 独立交付和验收。

## 十八、影响文件预估

### P0/P1 核心

```text
src/server/agents/types.ts
src/server/agents/tools/compile.ts
src/server/agents/tools/profiles.ts                 # 新增
src/server/agents/tools/tool-context.ts
src/server/agents/tools/builtin/index.ts
src/server/agents/tools/builtin/wiki-inspect.ts     # 新增
src/server/agents/tools/builtin/source-search.ts    # 新增
src/server/agents/tools/builtin/source-read.ts      # 新增
src/server/agents/tools/builtin/wiki-preview-change.ts # 新增
src/server/agents/runtime/commit-pending.ts         # 从 builtin 迁移
src/server/services/query-service.ts
src/server/services/query-tools.ts
src/server/services/fix-service.ts
src/server/services/fix-tools.ts
src/server/services/curate-service.ts
src/server/services/curate-tools.ts
src/server/services/remediation-router.ts           # P1 新增
src/server/wiki/page-ops.ts
src/server/wiki/curate-plan.ts
src/server/wiki/postcondition.ts                    # 新增
src/server/db/schema.ts
src/server/db/repos/pending-actions-repo.ts         # 新增
src/app/api/pending-actions/**                      # 新增
src/components/chat/**                              # PendingAction 确认 UI
```

### 文档同步

- `src/server/agents/CLAUDE.md`
- `src/server/services/CLAUDE.md`
- `src/server/wiki/CLAUDE.md`
- `src/server/db/CLAUDE.md`
- `src/app/CLAUDE.md`
- 根 `CLAUDE.md`
- `CHANGELOG.md`

本 Spec 是工具与工作流治理的总设计。每个 Phase 实施前可以拆出独立 plan，但后续 plan 不得改变这里确定的三条核心边界：**模型不直接获得通用提交能力、Query 写入必须消费显式审批、自动工作流的 scope 必须由运行时强制。**

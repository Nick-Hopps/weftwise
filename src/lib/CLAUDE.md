[根目录](../../CLAUDE.md) > [src](../) > **lib**

# `src/lib/` — 共享工具与契约

## 模块职责

存放**前后端共用**的小工具与类型定义。任何 `src/*` 模块都可以从这里 import。原则：**不依赖 Next.js runtime、不依赖 DB、不依赖 LLM**。

## 相关文件清单

| 文件 | 说明 |
|------|------|
| `contracts.ts` | **全应用领域类型单一真实源**：Subject/Wiki/Job/Source/Health/Changeset/Conversation，以及 PendingAction 与 Research run/candidate/approval/delivery/provenance 前后端契约 |
| `cn.ts` | `tailwind-merge + clsx` 合并器（`cn(...)`） |
| `slug.ts` | URL-safe slug 工具（与 `server/wiki/page-identity.ts` 配合） |
| `path-display.ts` | 路径展示纯函数：安全解码 URL slug，并优先匹配页面元数据标题 |
| `api-fetch.ts` | 客户端 `fetch` 封装 + `useApiFetch()` hook（自动注入 `?subjectId`，POST 由调用方在 body 中显式带） |
| `markdown-client.ts` | 客户端 markdown 解析（供 hover peek 等轻量场景）；`[[subject:page]]` 跨主题语法的渲染镜像，跨主题链接 href 用 `?s=<subject-slug>` query；已接入 `remark-gfm`，支持表格/删除线/任务列表/自动链接（所有共用 `renderMarkdown()` 的消费方一并获得该能力） |
| `tags.ts` | Tags 工作台纯分析：标签摘要/覆盖率/格式变体/组合筛选，以及 `buildTagReviewQueue` / `filterTagReviewQueue` 即时投影格式变体、非重复单次标签与未标记页面；不持久化 Review 状态 |
| `wiki-citation.ts` | Ask AI 引用纯函数：citation → 可点击 `/wiki/<slug>?s=` 路径，以及保存回答时的 current/cross Subject wikilink |
| `chat-reference.ts` | Ask AI 用户消息引用纯函数：把本轮 Passage 绑定到当前 Subject/page，过滤空摘录并限制最多 40 条，供即时消息展示与 API 持久化共用 |
| `selection-text.ts` | 🆕 正文选区文本纯函数：`normalizeSelectionText`（trim/空→null）/`truncateForContext`（4000 字符上限）/`selectionRefId`（djb2 哈希去重）/`findNearestHeadingText`（`HeadingScanNode` 结构子集，供 `hooks/use-text-selection` 消费） |
| `search-snippet.ts` | 搜索片段纯函数：只解析 FTS 生成的受控 `<mark>` 对，返回普通/高亮文本段供 React 安全渲染；其他 HTML 与损坏标记保持普通文本 |
| `ask-ai-floating-panel.ts` | Ask AI 悬浮工作面纯逻辑：锚点定位、受控尺寸最小/最大约束、窗口变化时矩形回收、移动 Sheet 下滑关闭阈值 |
| `subject-nav.ts` | 🆕 subject 切换的可记忆路径判定与 query 拼接：`isRememberablePath`（`/wiki/*` / `/sources/*` 判定）/ `withSubjectParam`（`?s=<subject-slug>` 拼接） + 单测 |
| `job-started-event.ts` | 客户端后台任务启动事件契约：必须携带 `jobId/type/label/queueStatus`；PendingAction workflow 映射真实 job 类型，ingest 专属 UI 用 `isIngestJobStarted` 过滤 |
| `error-format.ts` | 🆕 `describeErrorMessage(error)`：AI SDK `RetryError` 最后一次尝试自身 message 为空时，补上 `.lastError` 的 message/cause，避免真实原因丢失；`server/jobs/worker.ts` 与 `server/db/repos/jobs-repo.ts::failJob` 共用 |
| `theme/read-theme-vars.ts` | 从 `document.documentElement` 读 CSS 变量（主题同步） |

## 对外接口（关键类型）

### `contracts.ts` 导出

```ts
SubjectId      = string  // uuid 或 'subject-general' / 'subject-<uuid>' legacy 形式
Subject        { id: SubjectId, slug, name, description, createdAt, updatedAt }
WikiPage       { subjectId, slug, title, path, summary, contentHash, tags, createdAt, updatedAt }
WikiLink       { subjectId, sourceSlug, targetSubjectId, targetSlug, context }
Job            { id, type: 'ingest'|'lint'|'save-to-wiki'|'embed-index'|'curate'|'re-enrich'|'fix'|'research'|'research-import'|'image-insert', status, subjectId: SubjectId|null,
                 paramsJson, resultJson, createdAt, startedAt, completedAt,
                 leaseExpiresAt, heartbeatAt, attemptCount }
JobEvent       { id, jobId, type, message, dataJson, createdAt }
Source         { id, subjectId, filename, contentHash, parsedAt, metadataJson }
IngestResult   { pagesCreated: string[], pagesUpdated: string[],
                 linksAdded: number, commitSha: string }
WikiCitation  { pageSlug, excerpt, subjectSlug? }
UserMessageReference { pageSlug, pageTitle?, subjectSlug, section, excerpt }
QueryResult    { answer, citations: WikiCitation[], savedAsPage }
LintFinding    { type, severity, pageSlug, description, suggestedFix }
EnrichedLintFinding { ...LintFinding, id, subjectId, subjectSlug }
RemediationAction { type: 'fix'|'curate'|'research'|'re-ingest'|'review-source', label, destructive:false, href? }
RemediationPlan { findingId, workflow, status, actions, reason, jobId? }
HealthSnapshot { ...LintLatestResult, remediations: Record<findingId,RemediationPlan>, recentOutcomes: Record<string,RemediationStatus> }
PostconditionScope { jobId, subjectId, createdSlugs, updatedSlugs, deletedSlugs, touchedSlugs, operationIds }
PostconditionFinding { type, severity, pageSlug|null, description, relatedSlugs? }
PostconditionReport { status: 'clean'|'residual', checkedAt, scope, residualFindings, semanticStatus, verificationError }
ChangesetEntry { action: 'create'|'update'|'delete', path, content }
Changeset      { id, jobId, subjectId, subjectSlug, entries, preHead, postHead,
                 status: 'pending'|'applied'|'rolled-back' }
HistoryEntry   { id, sha, date, type: string, message, affectedPages: HistoryAffectedPage[], status: 'applied'|'reverted' }
HistoryAffectedPage { slug, action: 'create'|'update'|'delete' }
HistoryListInput/Result { slug?, limit? } / { entries }
HistoryDiffInput/Result { operationId } / { operationId, status, affectedPages, diff }
Conversation   { id, subjectId, title, createdAt, updatedAt }
ConversationMessage { id, conversationId, role: 'user'|'assistant', content, references: UserMessageReference[]|null, citations: WikiCitation[]|null, createdAt }
MetadataPatchInput { slug, title?, summary?, tags?, aliases? }
LinkEnsureInput { sourceSlug, targetSubjectSlug?, targetSlug, oldString, displayText?, mode:'link'|'unlink'|'retarget' }
PendingActionOperation = 'create'|'update'|'patch'|'delete'|'move'|'reenrich'|'metadata-patch'|'link-ensure'|'history-revert'|'workflow-reenrich-start'|'workflow-research-start'|'workflow-image-insert-start'|'workflow-cancel'
PreviewChangeInput { operation, payload } // discriminated union；Query 只提交预览，不持有真实写工具
MovePageInput { slug, newSlug } // 当前 Subject canonical 页面身份迁移
WorkflowStatusResult { found, job: null|{ jobId,type,status,cancelled,createdAt,startedAt,completedAt,attemptCount } }
SelectionAnchorInput { sourceKind:'canonical'|'reshape', quote, section, blockStart, blockEnd }
PersistedMarkdownBlockAnchor { start, end, markdown, prefix, suffix, quote, section }
ImageGenerateInput { prompt, alt, aspectRatio?, style? }
WorkflowPreviewInput { operation:'workflow-reenrich-start'|'workflow-research-start'|'workflow-image-insert-start'|'workflow-cancel', payload }
ResearchRunView { id, subjectId, researchJobId, origin, status, version, findings, candidates, approval, verificationLintJobId, ... }
ResearchCandidateView { ...ResearchCandidateSnapshot, decision, delivery }
ResearchCandidateDeliveryView { status, sourceId, ingestJobId, operationIds, touchedPages, commitSha, attemptCount, error }
researchProvenance job param { runId, approvalId, candidateId } // 仅服务端注入 child Ingest params
```

> **扩展规则**：
> - 任何需要跨 server/client 共享的类型，都应定义在这里而非 server 某处；
> - 不要 import `server/*` 或任何 node-only 包（这里可能被 client bundle 打包）。

#### Health finding 与处置契约（Phase 2A）

- `EnrichedLintFinding.id` 是 64 位小写 SHA-256 hex。服务端以 `lint-finding:v1 + subjectId + type + pageSlug + (sourceId ?? sourceFilename ?? '') + normalizedDescription` 生成；description 依次执行 Unicode NFKC、换行统一、连续空白折叠和 trim。`severity`、`suggestedFix`、`failedJobId`、`subjectSlug` 与数组位置不参与身份。
- 新 lint 快照写入和历史快照读取都调用同一 identity 算法；读取时不信任 JSON 内已有 ID，并按计算后的 ID 去重、保留首次出现顺序。因此排序、筛选、序列化和旧快照补算不会改变 ID；LLM 改写 description 则会形成新身份。
- `RemediationStatus` 为 `fixed | queued | awaiting-approval | skipped | failed`；`RemediationPlan` 由服务端提供 workflow、状态、原因、动作和可选关联 `jobId`，客户端不得按 finding type 猜测替代动作。
- `RemediationAction.destructive` 当前恒为 `false`。`delete-source` 不属于通用 action union；orphan-source 删除继续走专用 API 与二次确认。
- `HealthSnapshot` 扩展 `LintLatestResult`：`remediations` 以当前 finding ID 索引逐条 plan，`recentOutcomes` 记录已从新快照消失的近期处置结果；`RemediationContext` 用 `{ lintJobId, findingIds, action }` 把任务绑定到来源快照和 subject 范围。

#### Research 批准与 provenance 契约（Phase 2C）

- `ResearchRunStatus` 覆盖 `awaiting-approval/importing/verifying/completed/partial/failed/dismissed/empty`；run view 是审批、导入和验证 UI 的唯一事实源，discovery job result 只以 `runId` 作为权威定位，兼容摘要不参与批准。
- candidate ID 由 run + normalized URL 稳定派生；批准只提交 ID、expectedVersion 与 idempotency key，不提交 URL。`ResearchApiError` 可携带当前 run 供 stale/幂等冲突恢复。
- delivery view 暴露安全 lineage（source/child job/operation/touched page/commit）和脱敏错误，不暴露 claim token、lease 或原始敏感异常。
- `researchProvenance` job param 只允许 Research coordinator 写入 child Ingest；公共 `/api/ingest` contract 不接受该字段。

### `api-fetch.ts`

约定所有客户端 HTTP 调用都通过它，以统一错误处理与 auth：

```ts
// 通用版（适合 SSR / 没有 subject 的场景）
apiFetch<T>(path: string, init?: RequestInit): Promise<T>
// - 默认 credentials: 'include'
// - 如果响应 !ok，抛带 status/body 的 Error

// 客户端组件首选：自动注入 subjectId
useApiFetch(): typeof apiFetch
// - GET 自动在 URL 上注入 ?subjectId=<currentSubjectId>
// - SUBJECT_AGNOSTIC 路径用 exact + prefix 双匹配自动跳过注入
//   覆盖 /api/subjects/[id] / /api/jobs/[id] / /api/jobs/[id]/events 等
// - POST/PUT/PATCH 由调用方在 body 中显式带 subjectId（防止隐式注入到不该带的字段）
```

### `cn.ts`

```ts
cn(...classValues) = twMerge(clsx(...))
```

所有组件写法：`<div className={cn('base', isActive && 'active', props.className)} />`。

## 扩展指南

- **新增工具**：只添加"纯函数"。一旦需要访问 `process.env` / fs / DB / LLM，就该放到 `src/server/*`。
- **新增共享类型**：放 `contracts.ts`；若已庞大，可拆为 `contracts/<domain>.ts` 并在 `contracts/index.ts` re-export。
- **主题相关**：CSS 变量定义在 `src/app/globals.css`，读取走 `theme/read-theme-vars.ts`。

## 测试与质量

- 建议单测：`slug.ts` 的各种输入（空串、全空白、Unicode、超长）。
- `api-fetch`：错误体非 JSON 的降级路径。

## 常见问题 (FAQ)

- **为什么 slug 工具在 lib 和 server 都有？**
  - `lib/slug.ts` —— 客户端也需要的纯字符串工具（如搜索输入框预览）。
  - `server/wiki/page-identity.ts` —— 需要感知 vault 路径规则、与文件系统约定绑定的服务端版本。
  保持两处语义对齐；必要时合并到 `lib/` 再在 server 层扩展。

## 相关文件清单

```
src/lib/
├── contracts.ts            # 领域类型单一真实源
├── cn.ts                   # 类名合并
├── slug.ts                 # URL-safe slug
├── path-display.ts         # 安全解码路径 slug 并解析页面展示标题
├── api-fetch.ts            # 客户端 fetch 封装
├── markdown-client.ts      # 客户端 markdown 渲染
├── tags.ts                 # 标签目录、组合筛选与 Review 清理队列纯分析
├── chat-reference.ts       # Ask AI 用户消息 Passage → Subject/page 引用
├── selection-text.ts       # 🆕 正文选区文本纯函数（归一化/截断/id/最近标题）
├── tool-activity.ts        # 工具活动语义图标键、纯文本日志与参数脱敏（只显示 slug/字段名/mode，不泄露值或锚点）
├── job-started-event.ts    # 客户端后台任务启动事件的真实 type/label/queueStatus 契约
├── error-format.ts         # 🆕 describeErrorMessage：补全 RetryError 丢失的真实原因
└── theme/
    └── read-theme-vars.ts  # 读取 CSS 变量
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-07-18 | `tool-activity.ts` 将 emoji 映射改为稳定语义图标键，worker 事件只写可复制纯文本；`markdown-client.ts` 为 callout 注入 Lucide 图标并在渲染期兼容剥离历史标题 emoji，不改写 vault |
| 2026-07-17 | `ask-ai-floating-panel.ts` 新增桌面工作面 resize 尺寸约束与视口矩形适配，保证右/下/双轴调整及窗口变化后仍完整可操作 |
| 2026-07-17 | contracts 新增 `UserMessageReference`（含可选页面标题快照）与 `ConversationMessage.references`；`chat-reference.ts` 统一把发送 Passage 绑定到当前 Subject/page，供用户消息即时展示和持久化恢复 |
| 2026-07-17 | contracts 新增结构化选区、持久化 Markdown 块锚点、图片请求、`workflow-image-insert-start` 与 `image-insert` job；job-started event 保留真实图片任务类型 |
| 2026-07-16 | 新增 `path-display.ts::displayTitleForSlug`，为面包屑安全解码 URL slug 并兼容页面标题匹配 |
| 2026-07-16 | `tags.ts` 新增即时 `TagReviewQueue`：格式变体按使用次数、标准 kebab-case、名称稳定选择推荐目标；变体与 singleton 去重，补充未标记页、问题计数和跨分区搜索 |
| 2026-07-16 | 新增 `job-started-event.ts`：统一 ingest/re-enrich/research/save-to-wiki 的启动事件元数据，禁止全局 tracker 与 Ingest UI 按 jobId 猜类型 |
| 2026-07-14 | 页面身份迁移 Phase 3D：contracts 新增 `MovePageInput`、PendingAction `move` 与 Changeset `movedFromPath/auxiliary` marker；tool activity 只摘要旧新 slug |
| 2026-07-14 | Workflow 控制 Phase 3C：contracts 新增脱敏 workflow status 与三类 preview 输入/operation；tool activity 新增 status/start/cancel 安全摘要，旧 `wiki.reenrich` 改 Planning 语义 |
| 2026-07-14 | History 工具 Phase 3B：contracts 新增 History list/diff/revert 工具契约，并把 PendingAction operation 扩展到 `history-revert`；不改变既有 HistoryEntry JSON |
| 2026-07-14 | 跨 Subject 只读 Phase 3A：contracts 新增跨主题工具输入输出与可选 `WikiCitation.subjectSlug`；`wiki-citation.ts` 统一聊天跳转和 Save-to-Wiki wikilink 序列化；旧 citation JSON 继续兼容 |
| 2026-07-14 | contracts 新增 Research run/finding/candidate/approval/delivery/provenance 行与 view 契约、API error code、`research-import` job type；candidate ID 批准与服务端注入 Ingest lineage 取代客户端 URL 直提交流程 |
| 2026-07-13 | contracts 新增 metadata/link 窄写输入结果，并把 PendingAction operation/preview 扩展到 `metadata-patch` / `link-ensure`；tool-activity 增加两种工具的安全摘要，metadata 值与链接锚点不进入活动日志 |
| 2026-07-12 | Health 修复闭环 Phase 2A：`EnrichedLintFinding` 增加稳定 `id`；新增 `RemediationStatus / Workflow / Action / Plan / Context` 与 `HealthSnapshot` 共享契约，彻底移除数组位置身份语义 |
| 2026-04-22 | 初始化 |
| 2026-04-25 | Subject：contracts 增加 `Subject` / `SubjectId` 与 `subjectId` 字段；`useApiFetch()` hook 自动注入 subjectId；markdown-client 跨主题 `?s=` href |
| 2026-06-22 | contracts 新增 `HistoryEntry` / `HistoryAffectedPage` 类型（⑥ 版本历史/diff）|
| 2026-06-22 | contracts 新增 `Conversation` / `ConversationMessage` 类型（⑦ 对话持久化 + 多轮记忆）|
| 2026-06-22 | contracts 加 `WebSearchProviderSchema/WebSearchApiKeySchema/WebSearchMaxResultsSchema` + 默认值 + `WebSearchProvider` 类型；`AppSettings`/`AppSettingsSchema` 加 `webSearchProvider/webSearchApiKey/webSearchMaxResults`（⑨ verifier 联网核查搜索后端配置）|
| 2026-06-23 | `Job.type` 移除 `'merge'|'split'`，新增 `'curate'`（merge/split 内化为 curate 子步骤，不再是独立 job 类型）；`AppSettings` 加 `agentAutoCurate: boolean`（默认 true，控制 ingest finalize 后是否自动入队 curate scope:'pages'）|
| 2026-06-28 | 对话触发 Re-enrich：新增 `tool-activity.ts`（`toolActivityIcon/toolActivityVerb/summarizeToolArgs` 纯函数，client + query route 共用单一源，支持 `wiki.reenrich` 映射 ✨/Re-enriching）|
| 2026-06-27 | Cognitive Lens：contracts 加 `StylePrefs`（+ 4 个枚举别名 Lens{ReadingLevel,Verbosity,ExampleDensity,Formality}）与 `UserProfileDTO`（client 侧纯类型；server zod 真源在 `server/profile/style.ts`，由该处编译期双向断言守卫两者一致）|
| 2026-06-30 | `tool-activity.ts` 补 `wiki_create`(➕)/`wiki_delete`(🗑) 工具名→图标/动词映射，供对话创建/删除页面工具的 chat UI 活动展示 |
| 2026-06-30 | 新增 `selection-text.ts`（选区文本归一化/截断/id 派生/最近标题提取纯函数 + `HeadingScanNode`），供选中正文文本悬浮追问按钮使用；spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-selection-ask-floating-button* |
| 2026-06-30 | `tool-activity.ts` 补 `wiki_merge`(🔗)/`wiki_split`(✂️) 映射，供 curate tool-loop 工具活动的 chat UI 展示 |
| 2026-06-30 | `tool-activity.ts` 补 `wiki_update`(✏️) 映射，供 fix tool-loop 工具活动展示 |
| 2026-07-09 | 新增 `error-format.ts::describeErrorMessage`，修复 AI SDK `RetryError` 最后一次尝试 message 为空时真实原因丢失的问题（`server/jobs/worker.ts` + `server/db/repos/jobs-repo.ts::failJob` 接入） |
| 2026-07-09 | `markdown-client.ts::renderMarkdown()` 接入 `remark-gfm`，支持表格/删除线/任务列表/自动链接；供 Ask AI 表格渲染使用，所有共用该函数的消费方（chat、Wiki 阅读页正文、source-viewer 等）一并获得该能力 |
| 2026-07-12 | contracts 新增 Fix / Curate 写后定向校验共享契约：`PostconditionScope` / `PostconditionFinding` / `PostconditionReport`，供 Service resultJson、SSE 与 Health UI 共用 |

---

_生成时间：2026-04-22 00:25:29_

[根目录](../../CLAUDE.md) > [src](../) > **lib**

# `src/lib/` — 共享工具与契约

## 模块职责

存放**前后端共用**的小工具与类型定义。任何 `src/*` 模块都可以从这里 import。原则：**不依赖 Next.js runtime、不依赖 DB、不依赖 LLM**。

## 相关文件清单

| 文件 | 说明 |
|------|------|
| `contracts.ts` | **全应用领域类型单一真实源**：`Subject / SubjectId / WikiPage / WikiLink / Job / JobEvent / Source / IngestResult / QueryResult / LintFinding / Changeset / ChangesetEntry / Conversation / ConversationMessage` |
| `cn.ts` | `tailwind-merge + clsx` 合并器（`cn(...)`） |
| `slug.ts` | URL-safe slug 工具（与 `server/wiki/page-identity.ts` 配合） |
| `api-fetch.ts` | 客户端 `fetch` 封装 + `useApiFetch()` hook（自动注入 `?subjectId`，POST 由调用方在 body 中显式带） |
| `markdown-client.ts` | 客户端 markdown 解析（供 hover peek 等轻量场景）；`[[subject:page]]` 跨主题语法的渲染镜像，跨主题链接 href 用 `?s=<subject-slug>` query |
| `selection-text.ts` | 🆕 正文选区文本纯函数：`normalizeSelectionText`（trim/空→null）/`truncateForContext`（4000 字符上限）/`selectionRefId`（djb2 哈希去重）/`findNearestHeadingText`（`HeadingScanNode` 结构子集，供 `hooks/use-text-selection` 消费） |
| `subject-nav.ts` | 🆕 subject 切换的可记忆路径判定与 query 拼接：`isRememberablePath`（`/wiki/*` / `/sources/*` 判定）/ `withSubjectParam`（`?s=<subject-slug>` 拼接） + 单测 |
| `theme/read-theme-vars.ts` | 从 `document.documentElement` 读 CSS 变量（主题同步） |

## 对外接口（关键类型）

### `contracts.ts` 导出

```ts
SubjectId      = string  // uuid 或 'subject-general' / 'subject-<uuid>' legacy 形式
Subject        { id: SubjectId, slug, name, description, createdAt, updatedAt }
WikiPage       { subjectId, slug, title, path, summary, contentHash, tags, createdAt, updatedAt }
WikiLink       { subjectId, sourceSlug, targetSubjectId, targetSlug, context }
Job            { id, type: 'ingest'|'lint'|'save-to-wiki'|'curate'|'embed-index', status, subjectId: SubjectId|null,
                 paramsJson, resultJson, createdAt, startedAt, completedAt,
                 leaseExpiresAt, heartbeatAt, attemptCount }
JobEvent       { id, jobId, type, message, dataJson, createdAt }
Source         { id, subjectId, filename, contentHash, parsedAt, metadataJson }
IngestResult   { pagesCreated: string[], pagesUpdated: string[],
                 linksAdded: number, commitSha: string }
QueryResult    { answer, citations: { pageSlug, excerpt }[], savedAsPage }
LintFinding    { type, severity, pageSlug, description, suggestedFix }
ChangesetEntry { action: 'create'|'update'|'delete', path, content }
Changeset      { id, jobId, subjectId, subjectSlug, entries, preHead, postHead,
                 status: 'pending'|'applied'|'rolled-back' }
HistoryEntry   { id, sha, date, type: string, message, affectedPages: HistoryAffectedPage[], status: 'applied'|'reverted' }
HistoryAffectedPage { slug, action: 'create'|'update'|'delete' }
Conversation   { id, subjectId, title, createdAt, updatedAt }
ConversationMessage { id, conversationId, role: 'user'|'assistant', content, citations: {pageSlug,excerpt}[]|null, createdAt }
```

> **扩展规则**：
> - 任何需要跨 server/client 共享的类型，都应定义在这里而非 server 某处；
> - 不要 import `server/*` 或任何 node-only 包（这里可能被 client bundle 打包）。

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
├── api-fetch.ts            # 客户端 fetch 封装
├── markdown-client.ts      # 客户端 markdown 渲染
├── selection-text.ts       # 🆕 正文选区文本纯函数（归一化/截断/id/最近标题）
├── tool-activity.ts        # 🆕 工具活动展示：toolActivityIcon/toolActivityVerb/summarizeToolArgs（client+server 共用，`wiki.reenrich` 映射 ✨，`wiki.create` 映射 ➕，`wiki.delete` 映射 🗑，`wiki.merge` 映射 🔗，`wiki.split` 映射 ✂️）
└── theme/
    └── read-theme-vars.ts  # 读取 CSS 变量
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
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

---

_生成时间：2026-04-22 00:25:29_

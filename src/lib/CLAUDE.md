[根目录](../../CLAUDE.md) > [src](../) > **lib**

# `src/lib/` — 共享工具与契约

## 模块职责

存放**前后端共用**的小工具与类型定义。任何 `src/*` 模块都可以从这里 import。原则：**不依赖 Next.js runtime、不依赖 DB、不依赖 LLM**。

## 相关文件清单

| 文件 | 说明 |
|------|------|
| `contracts.ts` | **全应用领域类型单一真实源**：`Subject / SubjectId / WikiPage / WikiLink / Job / JobEvent / Source / IngestResult / QueryResult / LintFinding / Changeset / ChangesetEntry` |
| `cn.ts` | `tailwind-merge + clsx` 合并器（`cn(...)`） |
| `slug.ts` | URL-safe slug 工具（与 `server/wiki/page-identity.ts` 配合） |
| `api-fetch.ts` | 客户端 `fetch` 封装 + `useApiFetch()` hook（自动注入 `?subjectId`，POST 由调用方在 body 中显式带） |
| `markdown-client.ts` | 客户端 markdown 解析（供 hover peek 等轻量场景）；`[[subject:page]]` 跨主题语法的渲染镜像，跨主题链接 href 用 `?s=<subject-slug>` query |
| `theme/read-theme-vars.ts` | 从 `document.documentElement` 读 CSS 变量（主题同步） |

## 对外接口（关键类型）

### `contracts.ts` 导出

```ts
SubjectId      = string  // uuid 或 'subject-general' / 'subject-<uuid>' legacy 形式
Subject        { id: SubjectId, slug, name, description, createdAt, updatedAt }
WikiPage       { subjectId, slug, title, path, summary, contentHash, tags, createdAt, updatedAt }
WikiLink       { subjectId, sourceSlug, targetSubjectId, targetSlug, context }
Job            { id, type: 'ingest'|'lint'|'save-to-wiki'|'merge'|'split', status, subjectId: SubjectId|null,
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
HistoryEntry   { operationId, type: string, affectedPages: HistoryAffectedPage[], timestamp, status }
HistoryAffectedPage { slug, title, action: 'create'|'update'|'delete' }
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
└── theme/
    └── read-theme-vars.ts  # 读取 CSS 变量
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |
| 2026-04-25 | Subject：contracts 增加 `Subject` / `SubjectId` 与 `subjectId` 字段；`useApiFetch()` hook 自动注入 subjectId；markdown-client 跨主题 `?s=` href |
| 2026-06-22 | contracts 新增 `HistoryEntry` / `HistoryAffectedPage` 类型（⑥ 版本历史/diff）|

---

_生成时间：2026-04-22 00:25:29_

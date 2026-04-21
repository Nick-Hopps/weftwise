[根目录](../../CLAUDE.md) > [src](../) > **lib**

# `src/lib/` — 共享工具与契约

## 模块职责

存放**前后端共用**的小工具与类型定义。任何 `src/*` 模块都可以从这里 import。原则：**不依赖 Next.js runtime、不依赖 DB、不依赖 LLM**。

## 相关文件清单

| 文件 | 说明 |
|------|------|
| `contracts.ts` | **全应用领域类型单一真实源**：`WikiPage / WikiLink / Job / JobEvent / Source / IngestResult / QueryResult / LintFinding / Changeset / ChangesetEntry` |
| `cn.ts` | `tailwind-merge + clsx` 合并器（`cn(...)`） |
| `slug.ts` | URL-safe slug 工具（与 `server/wiki/page-identity.ts` 配合） |
| `api-fetch.ts` | 客户端 `fetch` 封装，自动处理 auth header / cookie / 错误文本 |
| `markdown-client.ts` | 客户端 markdown 解析（供 hover peek 等轻量场景） |
| `theme/read-theme-vars.ts` | 从 `document.documentElement` 读 CSS 变量（主题同步） |

## 对外接口（关键类型）

### `contracts.ts` 导出

```ts
WikiPage       { slug, title, path, summary, contentHash, tags, createdAt, updatedAt }
WikiLink       { sourceSlug, targetSlug, context }
Job            { id, type: 'ingest'|'lint'|'save-to-wiki', status, paramsJson,
                 resultJson, createdAt, startedAt, completedAt,
                 leaseExpiresAt, heartbeatAt, attemptCount }
JobEvent       { id, jobId, type, message, dataJson, createdAt }
Source         { id, filename, contentHash, parsedAt, metadataJson }
IngestResult   { pagesCreated: string[], pagesUpdated: string[],
                 linksAdded: number, commitSha: string }
QueryResult    { answer, citations: { pageSlug, excerpt }[], savedAsPage }
LintFinding    { type, severity, pageSlug, description, suggestedFix }
ChangesetEntry { action: 'create'|'update'|'delete', path, content }
Changeset      { id, jobId, entries, preHead, postHead,
                 status: 'pending'|'applied'|'rolled-back' }
```

> **扩展规则**：
> - 任何需要跨 server/client 共享的类型，都应定义在这里而非 server 某处；
> - 不要 import `server/*` 或任何 node-only 包（这里可能被 client bundle 打包）。

### `api-fetch.ts`

约定所有客户端 HTTP 调用都通过它，以统一错误处理与 auth：

```ts
apiFetch<T>(path: string, init?: RequestInit): Promise<T>
// - 默认 credentials: 'include'
// - 如果响应 !ok，抛带 status/body 的 Error
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

---

_生成时间：2026-04-22 00:25:29_

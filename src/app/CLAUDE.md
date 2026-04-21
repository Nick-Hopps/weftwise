[根目录](../../CLAUDE.md) > [src](../) > **app**

# `src/app/` — Next.js App Router

## 模块职责

承载整个应用的路由层与 HTTP 接口层。包括两部分：

1. **页面路由**（`(app)/` 路由组）— 基于 Shell 布局的用户界面。
2. **API 路由**（`api/`）— Next.js Route Handlers，对外暴露 REST 接口。所有写操作都**只做入队**，长任务交给独立 worker。

## 入口与启动

| 文件 | 作用 |
|------|------|
| `layout.tsx`（根）| 应用根 layout，注入全局 `<html>` / `<body>` / providers |
| `(app)/layout.tsx` | 带 `Shell` + `ErrorBoundary` 的主应用布局 |
| `(app)/page.tsx` | Dashboard 首页（空态 / 有内容两种布局） |
| `(app)/wiki/[...slug]/page.tsx` | 动态 wiki 页面（SSR 渲染 + `PageRenderer`） |
| `globals.css` | Tailwind + 自定义 CSS 变量（设计 token） |

## 对外接口 —— `src/app/api/*`

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/ingest` | POST | 接受 multipart/form-data 或 JSON（`text` + `filename`），存原始源到 `vault/sources/`，入队 `ingest` 任务；返回 `{ jobId, sourceId }` |
| `/api/query` | POST | 直接同步调用 query-service（或入队 `save-to-wiki`）；用于 Chat UI |
| `/api/lint` | POST | 入队 `lint` 任务；返回 `jobId` |
| `/api/jobs` | GET | 列出任务（支持 `status` / `type` filter） |
| `/api/jobs/[id]` | GET | 取单个任务详情 |
| `/api/jobs/[id]/events` | GET (SSE) | Server-Sent Events 流，供前端实时追踪任务进度；支持 `Last-Event-Id` 续播 |
| `/api/pages` | GET | 列出所有 wiki 页面（排除 `meta` tag） |
| `/api/pages/[...slug]` | GET | 读取单个页面（包含 frontmatter、body、backlinks） |
| `/api/search` | GET | FTS5 全文搜索（`?q=...`） |
| `/api/graph` | GET | 返回图视图需要的节点 + 边数据 |
| `/api/session` | POST | 使用 `WIKI_API_KEY` 换取 HttpOnly `wiki_session` cookie |
| `/api/reset` | POST | **危险**操作：清空 vault + SQLite（需 auth + CSRF） |

> **鉴权约定**：所有 **写** 或 **敏感读** 路由都在顶部调 `requireAuth(request)`；浏览器发起的 POST 还要调 `requireCsrf(request)`（Origin 校验）。SSE 因 EventSource 不能发 header，允许 `?apiKey=` query 兜底（见 `src/server/middleware/auth.ts:55`）。

## 关键依赖与配置

- 所有 Route Handler 文件必须显式 `export const runtime = 'nodejs'`（better-sqlite3 不兼容 Edge）。
- 使用 `@/server/...` 调用后端逻辑；**禁止**在客户端组件中直接 import `@/server/*`。
- `(app)/page.tsx` 是 **Server Component**，通过 `pagesRepo.getAllPages()` 同步读 SQLite；首次渲染即完成。

## 扩展指南

- **新增写操作 API**：
  1. 新建 `src/app/api/<name>/route.ts`；
  2. 顶部加 `export const runtime = 'nodejs'`；
  3. 先 `requireAuth` 再 `requireCsrf`；
  4. **不要**在这里跑 LLM 或 git；调 `queue.enqueue(...)` 即可，并在对应 `src/server/services/*` 注册 handler。
- **新增页面**：在 `(app)/` 下新建目录或文件；默认会套用 `Shell` 布局。私有子组件放 `_components/`。

## 相关文件清单

```
src/app/
├── layout.tsx
├── globals.css
├── (app)/
│   ├── layout.tsx
│   ├── page.tsx                         # Dashboard
│   ├── wiki/[...slug]/page.tsx          # Wiki 渲染
│   └── _components/
│       ├── dashboard-hero.tsx
│       └── dashboard-ingest-panel.tsx
└── api/
    ├── ingest/route.ts
    ├── query/route.ts
    ├── lint/route.ts
    ├── jobs/route.ts
    ├── jobs/[id]/route.ts
    ├── jobs/[id]/events/route.ts        # SSE
    ├── pages/route.ts
    ├── pages/[...slug]/route.ts
    ├── search/route.ts
    ├── graph/route.ts
    ├── session/route.ts
    └── reset/route.ts
```

## 常见问题 (FAQ)

- **为什么 /api/ingest 不等 LLM 结束？**
  Route Handler 生命周期（尤其在 serverless / standalone 部署）对长连接不友好。解法是：POST → 入队 → 立即返回 `jobId` → 前端用 SSE 追踪。
- **SSE 断线怎么办？**
  `use-job-stream` hook 带自动重连（最多 5 次，2s 间隔），并用 `Last-Event-Id` 续播；服务端在 `job_events` 表中持久化所有事件。

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化：根据实际路由结构生成文档 |

---

_生成时间：2026-04-22 00:25:29_

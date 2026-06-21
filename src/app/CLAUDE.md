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
| `(app)/page.tsx` | Dashboard 首页（按 `currentSubject` 过滤，空态 / 有内容两种布局） |
| `(app)/wiki/[...slug]/page.tsx` | 动态 wiki 页面（SSR）：`?s=<slug>` 优先于 cookie；找不到页时通过 `findPageInOtherSubjects` 渲染"是否在其他 subject"提示 |
| `(app)/subjects/page.tsx` | 🆕 Subject 管理页：卡片网格 + 创建 / 重命名 / 删除（当前激活 + 非空 subject 都禁用删除并 hover 提示原因；slug 通过 `?new=1` 自动展开创建表单） |
| `(app)/health/page.tsx` | 🆕 知识库体检中心：触发 lint（当前 subject / 全量）+ 按严重度分组展示 findings + 跳转到对应页（只读，自动修复见后续特性）|
| `(app)/wiki/[...slug]/edit/page.tsx` | 🆕 页面在线编辑：`@uiw/react-md-editor` 编辑整文件 markdown，保存走 `PUT /api/pages`（Saga 重索引）后跳回读页 |
| `(app)/tags/page.tsx` | 🆕 标签索引：列出当前 subject 所有 tag + 页计数（客户端聚合 /api/pages）|
| `(app)/tags/[tag]/page.tsx` | 🆕 单标签页：列出带该 tag 的页 |
| `globals.css` | Tailwind + 自定义 CSS 变量（设计 token） |

## 对外接口 —— `src/app/api/*`

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/subjects` | GET / POST | 🆕 列出 subjects / 创建（`{ slug, name, description? }`，slug `^[a-z0-9][a-z0-9-]*$`，冲突 409） |
| `/api/subjects/[id]` | GET / PATCH / DELETE | 🆕 详情 / 重命名（仅 name & description）/ 删除（pageCount>0 → 409） |
| `/api/ingest` | POST | 接受 multipart/form-data 或 JSON（`subjectId` + `text` + `filename`），存原始源到 `vault/raw/<subject>/`，入队 `ingest` 任务；返回 `{ jobId, sourceId }` |
| `/api/query` | POST | 直接同步调用 query-service（或入队 `save-to-wiki`）；body 必填 `subjectId`；用于 Chat UI |
| `/api/lint` | POST | 入队 `lint` 任务（默认 subject-scoped，`{ allSubjects: true }` 显式触发全量）；返回 `jobId` |
| `/api/lint/latest` | GET | 返回当前 subject（或 `?allSubjects=1` 全量）最近一次 completed lint job 的 findings 快照（含 bySeverity 计数）；从未跑过返回 `{ jobId:null, findings:[] }` |
| `/api/merge` | POST | 校验 `{ targetSlug, sourceSlug }`（A≠B、非 meta、A/B 均存在，否则 400/404）后入队 `merge` 任务（把 source 合并进 target、删 source、重链）；返回 202 + `{ jobId }` |
| `/api/split` | POST | 校验 `{ sourceSlug, hint? }`（非 meta、源页存在，否则 400/404）后入队 `split` 任务（把源页拆成 N 个新页、删源页、引用重指主页）；返回 202 + `{ jobId }` |
| `/api/jobs` | GET | 列出任务（支持 `status` / `type` / `subjectId` filter） |
| `/api/jobs/[id]` | GET | 取单个任务详情 |
| `/api/jobs/[id]/events` | GET (SSE) | Server-Sent Events 流，供前端实时追踪任务进度；支持 `Last-Event-Id` 续播 |
| `/api/pages` | GET | 列出 wiki 页面（按 `?subjectId` 过滤，排除 `meta` tag） |
| `/api/pages/[...slug]` | GET | 读取单个页面（含 frontmatter、body、backlinks）；404 时返回 `otherSubjects: [{subjectId, slug, title}]` 提示；响应含整文件 raw 字段（供编辑器加载）|
| `/api/pages/[...slug]` | PUT | 改整文件 markdown（Saga 重索引）。若 frontmatter 标题变化且 `refreshReferences`(默认 true)，同事务把本 subject 内以旧标题书写的 `[[Old Title]]` 引用重写为新标题（排除自引用页），返回 `referencesUpdated` 计数；slug/URL/文件不动 |
| `/api/search` | GET | FTS5 全文搜索（`?q=...&subjectId=...`） |
| `/api/graph` | GET | 返回图视图需要的节点 + 边数据（`?subjectId=...`） |
| `/api/session` | POST | 使用 `WIKI_API_KEY` 换取 HttpOnly `wiki_session` cookie |
| `/api/reset` | POST | **危险**操作：默认全量重置（保留 general 不删）；带 `subjectId` 时仅删该 subject 的 SQLite 行 + vault 子目录（需 auth + CSRF） |

> **鉴权约定**：所有 **写** 或 **敏感读** 路由都在顶部调 `requireAuth(request)`；浏览器发起的 POST 还要调 `requireCsrf(request)`（Origin 校验）。SSE 因 EventSource 不能发 header，允许 `?apiKey=` query 兜底（见 `src/server/middleware/auth.ts:55`）。
>
> **Subject 解析约定**：所有 subject-scoped 路由顶部调 `resolveSubjectFromRequest(request, { required, body })`。优先级：`?subjectId=` UUID > `?s=` slug > body subjectId/Slug > cookie `wiki_subject` > general 兜底；`required:true` 时缺失返回 400。

## 关键依赖与配置

- 所有 Route Handler 文件必须显式 `export const runtime = 'nodejs'`（better-sqlite3 不兼容 Edge）。
- 使用 `@/server/...` 调用后端逻辑；**禁止**在客户端组件中直接 import `@/server/*`。
- `(app)/page.tsx` 是 **Server Component**，通过 `pagesRepo.getAllPages()` 同步读 SQLite；首次渲染即完成。

## 扩展指南

- **新增写操作 API**：
  1. 新建 `src/app/api/<name>/route.ts`；
  2. 顶部加 `export const runtime = 'nodejs'`；
  3. 先 `requireAuth` 再 `requireCsrf`；
  4. 解析 body 后 `resolveSubjectFromRequest(request, { required: true, body })`；error 非空直接 `return error`；
  5. **不要**在这里跑 LLM 或 git；调 `queue.enqueue(<type>, subject.id, params)` 即可，并在对应 `src/server/services/*` 注册 handler。
- **新增页面**：在 `(app)/` 下新建目录或文件；默认会套用 `Shell` 布局。私有子组件放 `_components/`。

## 相关文件清单

```
src/app/
├── layout.tsx
├── globals.css
├── (app)/
│   ├── layout.tsx
│   ├── page.tsx                         # Dashboard（按 currentSubject 过滤）
│   ├── wiki/[...slug]/page.tsx          # Wiki 渲染（?s= 优先）
│   ├── subjects/page.tsx                # 🆕 Subject 管理页
│   └── _components/
│       ├── dashboard-hero.tsx
│       └── dashboard-ingest-panel.tsx
└── api/
    ├── subjects/route.ts                # 🆕 GET 列表 / POST 创建
    ├── subjects/[id]/route.ts           # 🆕 GET / PATCH / DELETE
    ├── ingest/route.ts
    ├── query/route.ts
    ├── lint/route.ts
    ├── lint/latest/route.ts
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
| 2026-04-25 | Subject：新增 `/api/subjects` + `(app)/subjects` 管理页；既有路由全部 subject 化（`resolveSubjectFromRequest`） |

---

_生成时间：2026-04-22 00:25:29_

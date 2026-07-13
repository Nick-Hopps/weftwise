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
| `(app)/subjects/page.tsx` | 🔀 Subject 管理页：可点卡片网格（点主体=切换并进入工作区，右上 gear=打开统一编辑弹窗）+ 友好空态；创建/编辑/删除收敛到全局 `SubjectDialog`（不再有内联表单/`window.confirm`/`?new=1`）|
| `(app)/health/page.tsx` | 🆕 知识库体检中心：触发 lint（当前 subject / 全量）+ 按严重度分组展示 findings + 跳转到对应页（含 "Fix issues" 一键修复入口 + "Research backlog" 待研究问题队列区块，T3.2）|
| `(app)/history/page.tsx` | 🆕 操作时间线：当前 subject 写操作倒序（类型/受影响页/时间戳，仿 /health /tags），单次操作可展开查看 unified diff + 回滚按钮（前向 Saga 还原） |
| `(app)/wiki/[...slug]/edit/page.tsx` | 🆕 页面在线编辑：`@uiw/react-md-editor` 编辑整文件 markdown，保存走 `PUT /api/pages`（Saga 重索引）后跳回读页 |
| `(app)/tags/page.tsx` | 🆕 标签索引：列出当前 subject 所有 tag + 页计数（客户端聚合 /api/pages）|
| `(app)/tags/[tag]/page.tsx` | 🆕 单标签页：列出带该 tag 的页 |
| `globals.css` | Tailwind + 自定义 CSS 变量（设计 token） |

## 对外接口 —— `src/app/api/*`

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/subjects` | GET / POST | 🆕 列出 subjects / 创建（`{ slug, name, description? }`，slug `^[a-z0-9][a-z0-9-]*$`，冲突 409） |
| `/api/subjects/[id]` | GET / PATCH / DELETE | 🆕 详情 / 重命名（仅 name & description）/ 删除（级联清理 DB+vault；`general` / 有入站跨主题引用 → 409） |
| `/api/ingest` | POST | 接受 multipart/form-data（`subjectId` + `text` + `filename`），存原始源到 `vault/raw/<subject>/` + 入队 `ingest` 任务；返回 `{ jobId, sourceId }`；或 JSON `{ urls: string[], subjectId }` 批量 URL（≤20，路由内同步抓取），每 URL 独立 ingest job；202 部分成功 `{ results: [{url, jobId?, sourceId?, error?}], subjectId, subjectSlug }` 或 422 全失败 `{ error, results }` |
| `/api/query` | POST | Chat 流式问答：按问题解析 `read/propose` 模式；propose 只开放 `wiki.preview_change` 生成审批预览，通过 `event: pending-action` SSE 推送，绝不直接写入；也支持入队 `save-to-wiki` |
| `/api/pending-actions` | GET | 按 `conversationId` 列出当前 subject 审批操作，供聊天刷新恢复；会话不存在/跨 subject 统一 404 |
| `/api/pending-actions/[id]/approve` | POST | 批准服务端持久化的预览；忽略客户端 operation/payload，锁内复核 HEAD 后同步执行页面 Saga 或仅入队 re-enrich；陈旧预览 409 返回刷新 action |
| `/api/pending-actions/[id]/reject` | POST | 拒绝仍为 pending 的审批操作；幂等边界与 subject 隔离由 service/repo 状态机保证 |
| `/api/lint` | POST | 入队 `lint` 任务（默认 subject-scoped，`{ allSubjects: true }` 显式触发全量）；返回 `jobId` |
| `/api/lint/latest` | GET | 返回当前 subject（或 `?allSubjects=1` 全量）最近一次 completed lint 的完整 `HealthSnapshot`；先有界读取近期 jobs，再按 subject 批量读取关联 Research run view 交给纯 builder 映射审批/导入/验证终态，避免 N+1；从未跑过返回完整空快照，All Subjects plans 只读 |
| `/api/health/remediations` | POST | Phase 2A 统一处置入口：`{ subjectId, lintJobId, findingIds, action:'fix'\|'curate'\|'research'\|'re-ingest' }`；服务端重新校验当前 subject 最新 lint、稳定 ID 与 router action，原子去重后委托既有 workflow；202 返回 `{ jobId, deduplicated }` |
| `/api/curate` | POST | 校验 `{ subjectId }` 后入队 `curate` 任务（对当前 subject 全量页面做 agent 策展：tool-loop 自驱 `wiki.merge/split/delete/create`，`createCurateGuard` 硬护栏 caps 各≤5）；返回 202 + `{ jobId }` |
| `/api/fix` | POST | 入队 `fix` 任务修复当前 subject lint findings（确定性+LLM 两阶段）；返回 202 + `{ jobId }` |
| `/api/research` | POST | 入队 `research` 任务（缺口/薄页/主题→联网研究候选快照，只发现不写入）；body 二选一 `{ findingIds, lintJobId, subjectId }` 或 `{ topic, subjectId }`；完成后持久化 run/candidate/finding evidence，job result 只用 `runId` 定位；旧 `gapIds` 400，web search 未配置 422 |
| `/api/research-runs/[id]` | GET | 按 required subject 读取脱敏 `ResearchRunView`；包含稳定 candidate ID、批准、逐 candidate delivery lineage 与逐 finding 验证结果，跨 subject/不存在统一 404 |
| `/api/research-runs/[id]/approve` | POST | 只接受 `{ candidateIds, expectedVersion, idempotencyKey, subjectId }`；candidate ID 必须为稳定 64 位 hex，服务端回读 URL 快照；原子 CAS 批准并创建唯一 `research-import` coordinator，首次 202、幂等 replay 200 |
| `/api/research-runs/[id]/dismiss` | POST | 显式忽略仍为 awaiting-approval 的 run；普通 UI 关闭不会调用；写请求要求 auth + CSRF + required subject |
| `/api/research-backlog` | GET | 🆕 T3.2：列出当前 subject 待研究问题队列（`?status=open\|researched\|dismissed` 过滤，缺省返回全部） |
| `/api/research-backlog/[id]` | PATCH | 🆕 T3.2：更新一条待研究问题状态（`{ status, researchJobId? }`）；跨 subject/不存在 → 404 |
| `/api/sources/[id]/reingest` | POST | 🆕 孤儿 source 重摄入：有可续传 failed job → requeue（checkpoint 续传）；查无 job/completed/cancelled → 新建 ingest job；已被页面引用 409 `already-referenced`、在途 409 `in-flight`；source 本身已被删（`id` 查无）404 |
| `/api/sources/[id]` | DELETE | 🆕 删除孤儿 source（零关联守卫 409 `already-referenced`；同源查询 active 优先，故即使存在更新 terminal，只要任意旧 pending/running 仍返回 409 `in-flight`）：vault 锁内删 raw 文件+sidecar（best-effort）→ 删 sources 行 → git commit `[subject:<slug>]` |
| `/api/jobs/[id]/retry` | POST | ingest workbench 通用重试：仅普通 failed Ingest；cancelled、source 已删除或携带服务端 `researchProvenance` 的 Research child 均 409，后者只能由 run coordinator/reconciler 恢复，避免绕过候选状态机 |
| `/api/history` | GET | 列出当前 subject 操作时间线（rowid DESC，类型/受影响页/时间，status=applied 或 reverted） |
| `/api/history/[id]/diff` | GET | 单次操作的 unified diff（从 preHead → postHead）；404 未知/跨 subject |
| `/api/history/[id]/revert` | POST | 回滚操作（前向 Saga 还原：从 preHead 重建 inverse changeset、apply、commit）；requireAuth+requireCsrf+resolveSubject；404 未知/跨 subject，409 已回滚，422 校验失败 |
| `/api/jobs` | GET | 列出任务（支持 `status` / `type` / `subjectId` filter） |
| `/api/jobs/[id]` | GET | 取单个任务详情 |
| `/api/jobs/[id]/events` | GET (SSE) | Server-Sent Events 流，供前端实时追踪任务进度；支持 `Last-Event-Id` 续播 |
| `/api/pages` | GET | 列出 wiki 页面（按 `?subjectId` 过滤，排除 `meta` tag） |
| `/api/pages/[...slug]` | GET | 读取单个页面（含 frontmatter、body、backlinks）；404 时返回 `otherSubjects: [{subjectId, slug, title}]` 提示；响应含整文件 raw 字段（供编辑器加载）|
| `/api/pages/[...slug]` | DELETE | 删除单个页面；DRY 复用 `services/page-write.ts::validateDeleteTarget`（守卫：`general`/`index`/`log` meta 页禁删，404 不存在）+ `executePageDelete`（Saga 事务 + embed 回填 enqueue）；响应附 `brokenBacklinks: number`（原来指向被删页的同-subject 链接数，供调用方提示用户清理）|
| `/api/pages/[...slug]` | PUT | 改整文件 markdown（Saga 重索引）。若 frontmatter 标题变化且 `refreshReferences`(默认 true)，同事务把本 subject 内以旧标题书写的 `[[Old Title]]` 引用重写为新标题（排除自引用页），返回 `referencesUpdated` 计数；slug/URL/文件不动 |
| `/api/search` | GET | FTS5 全文搜索（`?q=...&subjectId=...`） |
| `/api/graph` | GET | 返回图视图需要的节点 + 边数据（`?subjectId=...`） |
| `/api/conversations` | GET | 🆕 列出当前 subject 会话（`updated_at DESC, rowid DESC`）|
| `/api/conversations/[id]` | GET / PATCH / DELETE | 🆕 读单个会话含 messages / 重命名（仅 title）/ 删除（跨 subject→404，PATCH 空 title→400）|
| `/api/query` | POST | 默认流式分支扩展：body 加 `conversationId?`（无/跨 subject 静默当新会话防泄漏）→ 载末 8 条历史注入 prompt → 流末 best-effort 落库 → done 回传 `{subjectId, conversationId}`；save-as-page/save-to-wiki 模式不持久化 |
| `/api/session` | POST | 使用 `WIKI_API_KEY` 换取 HttpOnly `wiki_session` cookie |
| `/api/reset` | POST | **危险**操作：默认全量重置（保留 general 不删）；带 `subjectId` 时仅删该 subject 的 SQLite 行 + vault 子目录；两种模式都按外键顺序清理 Research provenance 五表（需 auth + CSRF） |

### `POST /api/health/remediations` 错误契约

- `400`：`invalid-json`、`invalid-body`、`invalid-lint-job-id`、`invalid-action`、`invalid-finding-count`（1–100）、`invalid-finding-id`（64 位小写 hex）、`invalid-reingest-scope`（Re-ingest 必须恰好一个带 sourceId 的 finding）或 `action-not-allowed`。
- `401/403`：沿用 Auth / CSRF 拒绝；subject 解析错误直接透传。
- `409 stale-snapshot`：`lintJobId` 已不是当前快照，或任一 ID 已消失/属于其他 subject；批量请求整体拒绝，不部分入队。
- `409 source-not-found | already-referenced | in-flight | requeue-conflict`：Re-ingest 来源前提或原子 requeue 冲突；同 remediation context 的在途任务则成功返回原 `jobId` 与 `deduplicated:true`。
- `422 web-search-not-configured`：Research 所需 Web Search 未配置。
- `500 internal-error`：未知服务编排异常，响应不泄漏内部错误细节。

请求中的 `lintJobId` 是 compare-and-set token；`findingIds` 在服务端去重排序后写入 `job.paramsJson.remediationContext`。`review-source` 是只读导航，不允许提交到此端点；orphan-source 删除也不属于通用 remediation action。

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
  5. **不要**在这里跑 LLM 或 git；调 `queue.enqueue(<type>, params, subject.id)`（签名为 `enqueue(type, params?, subjectId?)`）即可，并在对应 `src/server/services/*` 注册 handler。
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
│   ├── health/page.tsx                  # 🆕 知识库体检中心
│   ├── history/page.tsx                 # 🆕 操作时间线（⑥）
│   ├── tags/page.tsx                    # 🆕 标签索引
│   ├── tags/[tag]/page.tsx              # 🆕 单标签页
│   └── _components/
│       ├── dashboard-hero.tsx
│       └── dashboard-ingest-panel.tsx
└── api/
    ├── subjects/route.ts                # 🆕 GET 列表 / POST 创建
    ├── subjects/[id]/route.ts           # 🆕 GET / PATCH / DELETE
    ├── history/route.ts                 # 🆕 GET 列表（⑥）
    ├── history/[id]/route.ts            # 🆕 GET diff（⑥）
    ├── history/[id]/revert/route.ts     # 🆕 POST 回滚（⑥）
    ├── ingest/route.ts
    ├── query/route.ts
    ├── lint/route.ts
    ├── lint/latest/route.ts
    ├── health/remediations/route.ts       # 🆕 Phase 2A 统一 Health 处置入口
    ├── curate/route.ts                  # 🆕 POST 入队 curate（agent 策展）
    ├── fix/route.ts                     # 🆕 POST 入队 fix（一键修复 lint findings）
    ├── research/route.ts                # 联网研究：稳定 finding scope 或自由 topic
    ├── research-runs/[id]/route.ts      # Research run view
    ├── research-runs/[id]/approve/route.ts # candidate ID 原子批准
    ├── research-runs/[id]/dismiss/route.ts # 显式忽略
    ├── jobs/route.ts
    ├── jobs/[id]/route.ts
    ├── jobs/[id]/events/route.ts        # SSE
    ├── jobs/[id]/retry/route.ts         # 🆕 POST 重试（含 source 存在性校验，防重试已删 source 的孤儿 job）
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
| 2026-07-14 | Research 批准溯源 Phase 2C：新增 run 读取/批准/忽略 API，批准只接受稳定 candidate ID + version + idempotency key；`lint/latest` 批量注入 run 状态；通用 Ingest route 拒绝客户端 provenance，Research child 禁止独立 retry，coordinator cancel 后立即对账；reset/subject 删除覆盖 provenance 五表 |
| 2026-07-12 | Health 修复闭环 Phase 2A：`GET /api/lint/latest` 升级为完整 `HealthSnapshot`；新增 `POST /api/health/remediations` 统一校验、幂等执行入口；`POST /api/research` 改用稳定 `findingIds + lintJobId` 并接受 `coverage-gap / thin-page`，旧数组下标协议退役 |
| 2026-07-11 | Wiki 审批闭环 Phase 1B：`/api/query` 新增 read/propose 模式与 `pending-action` SSE；新增 pending-actions 列表/批准/拒绝三个 subject-scoped API，写请求均 requireAuth+CSRF，批准只消费服务端预览而不信任客户端 payload |
| 2026-04-22 | 初始化：根据实际路由结构生成文档 |
| 2026-04-25 | Subject：新增 `/api/subjects` + `(app)/subjects` 管理页；既有路由全部 subject 化（`resolveSubjectFromRequest`） |
| 2026-06-22 | 新增 `(app)/history/page.tsx` + `/api/history*` 三个路由（GET 列表、GET diff、POST 回滚），支持前向 Saga 还原（⑥ 版本历史/diff）|
| 2026-06-22 | 新增 `/api/conversations` + `/api/conversations/[id]` 四个路由（GET 列表、GET/PATCH/DELETE 详情）；`POST /api/query` 默认流式支持 conversationId 多轮 + 落库（⑦ 对话持久化 + 多轮记忆）|
| 2026-06-23 | 删除 `/api/merge` 和 `/api/split` 路由（逐页按钮已移除）；新增 `POST /api/curate`（全 subject agent 策展，入队 curate 任务）；merge/split LLM 逻辑内化为 page-ops 供 curate-service 调用 |
| 2026-06-24 | 新增 `POST /api/fix`（入队 fix 任务，一键修复 lint findings）；`(app)/health/page.tsx` 加 "Fix issues" 入口 |
| 2026-06-28 | 对话触发 Re-enrich：删除 `/api/re-enrich` 路由（`src/app/api/re-enrich/route.ts`）；触发入口改为 Ask AI 对话中的 `wiki.reenrich` 写工具；`POST /api/query` route 导入 `summarizeToolArgs` 从 `@/lib/tool-activity` 共用工具名摘要 |
| 2026-06-27 | Cognitive Lens：新增 `GET /api/lens/[...slug]`（独立顶层路由——catch-all 不能内嵌；JSON 一次性响应，缓存优先，未配置/异常优雅回落 canonical，四态 source=cache/generated/canonical/fallback）+ `GET/PUT /api/profile`（画像读写，PUT 走 auth+csrf）+ `POST /api/profile/signals`（反馈信号，body 显式带 subjectId）；`DELETE /api/subjects/[id]` 删 subject 后清理其重塑缓存（`renditions-repo.deleteBySubject`）；新增 `middleware/user.ts::resolveUserId`（单租户占位，恒返回 'local'）|
| 2026-06-28 | Subject 体验重做：`(app)/subjects/page.tsx` 改可点卡片+gear+空态；创建/编辑/删除迁到全局 `SubjectDialog`（`src/components/subjects/`），切换器 "New subject…" 改唤起弹窗（删 `?new=1`）。零 API 改动 |
| 2026-06-29 | Subject 级联删除：`DELETE /api/subjects/[id]` 改为级联删除——`subjectsRepo.deleteWithContents(id)` 单事务清全部 subject-scoped 行 + `fs.rmSync` 删 vault `wiki\|raw\|.llm-wiki/sources/<slug>` + `commitVaultChanges`；守卫 `general`→409 `protected`、有入站跨主题引用→409 `has-inbound-refs`、不存在→404；移除旧 `deleteIfEmpty`/`renditions-repo` 调用。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-29-subject-cascade-delete* |
| 2026-06-30 | `DELETE /api/pages/[...slug]` DRY 重构：改用 `services/page-write.ts::validateDeleteTarget`（守卫单一真实源）+ `executePageDelete`（Saga+embed 回填）；响应新增 `brokenBacklinks: number`（同-subject 内原指向被删页的链接数，供 chat UI 提示清理）。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-agentic-wiki-write-tools* |
| 2026-07-03 | Ingest URL 输入：`POST /api/ingest` 新增 JSON `{ urls: string[] }` 批量分支（≤20，路由内同步抓取 HTML/Markdown/TXT 转 raw source），每 URL 独立 ingest job；202 部分成功/422 全失败；新增 sources/url-fetcher（协议/超时10s/5MB/content-type 守卫）+ url-ingest（校验+allSettled 编排）+ lib/url-list；workbench 加 URL tab；流水线逻辑零改动。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-03-ingest-url-input* |
| 2026-07-07 | T3.2 Ask AI 未命中 → 待研究队列：新增 `GET /api/research-backlog`（列出当前 subject 待研究问题，可按 status 过滤）+ `PATCH /api/research-backlog/[id]`（更新状态/回填 researchJobId，requireAuth+CSRF+resolveSubject，跨 subject/不存在→404）；`(app)/health/page.tsx` 新增 "Research backlog" 区块（逐条 Research 复用现成 `POST /api/research` topic 分支 / Dismiss）；`POST /api/query` 流式 `done` 事件新增 `coverageSufficient` 透传 |
| 2026-07-09 | 修复 orphan-source Delete 与 Retry 竞态：`POST /api/jobs/[id]/retry`（ingest workbench 通用重试，与 orphan-source 专用的 `/api/sources/[id]/reingest` 是两条独立路径）此前不校验 job 引用的 source 是否还在，Health 页删完源文件后若经此端点重试会立即 requeue、worker 在 `loadCleanText` 报 "Source file not found"；补上与 reingest 端点一致的存在性校验（解析 `job.paramsJson.sourceId` → `sourcesRepo.getSource` 查无则 409 友好提示，不 requeue）。 |

---

_生成时间：2026-04-22 00:25:29_

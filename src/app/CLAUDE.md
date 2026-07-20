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
| `(app)/health/page.tsx` | 🆕 知识库体检工作台：触发 lint（当前 subject / 全量）+ 摘要带 + 类型筛选 + 按严重度分组的紧凑 findings 列表 + 逐条/批量处置（含可折叠的自定义 Research 与页面底部 Research backlog）|
| `(app)/history/page.tsx` | 🆕 操作时间线：当前 subject 写操作倒序（类型/受影响页/时间戳，仿 /health /tags），单次操作可展开查看 unified diff + 回滚按钮（前向 Saga 还原） |
| `(app)/wiki/[...slug]/edit/page.tsx` | 🆕 页面在线编辑：`@uiw/react-md-editor` 编辑整文件 markdown，保存走 `PUT /api/pages`（Saga 重索引）后跳回读页 |
| `(app)/tags/page.tsx` | 标签工作台：当前 Subject 标签覆盖统计、可搜索/排序目录和 Review 治理（Rename/Merge/Delete 服务端预览审批）|
| `(app)/tags/[tag]/page.tsx` | 标签组合浏览：页面摘要列表、相关标签叠加、AND/OR、搜索与排序 |
| `globals.css` | Tailwind + 自定义 CSS 变量（设计 token） |

## 对外接口 —— `src/app/api/*`

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/subjects` | GET / POST | 🆕 列出 subjects / 创建（`{ slug, name, description? }`，slug `^[a-z0-9][a-z0-9-]*$`，冲突 409） |
| `/api/subjects/[id]` | GET / PATCH / DELETE | 🆕 详情 / 重命名（仅 name & description）/ 删除（级联清理 DB+vault；`general` / 有入站跨主题引用 → 409） |
| `/api/sources` | GET | 无 `slug` 时返回左侧 Sources 轻量列表：URL Source 使用 worker 已持久化的网页标题/描述（未抓取时标题回退 hostname），普通文件回退 filename；带 `slug` 时返回页面 Sources 分栏文档 DTO，URL Source 同时携带有界本地阅读正文与截断状态 |
| `/api/usage` | GET | app 级 LLM 用量统计；`window=7d\|30d\|all` 控制时间范围，可选 `subjectId` 精确筛选项目；未知项目返回 400，缺省项目包含历史/全局未归因记录 |
| `/api/ingest` | POST | 接受 multipart/form-data（`subjectId` + `text` + `filename`），存原始源到 `vault/raw/<subject>/` + 入队 `ingest` 任务；返回 `{ jobId, sourceId }`；或 JSON `{ urls: string[], subjectId }` 批量 URL（≤20），只持久化规范化网页链接与 source sidecar，不下载 raw HTML；每 URL 独立 ingest job，worker 执行时临时抓取并解析；202 部分成功 `{ results: [{url, jobId?, sourceId?, error?}], subjectId, subjectSlug }` 或 422 全失败 `{ error, results }` |
| `/api/query` | POST | Chat 流式问答：每轮先由统一结构化 LLM 分类 `read/propose/direct-reenrich/image-insert/reset-*` 与可选页面目标，服务端再按可信 page/selection/context 收窄能力；可选 `messageReferences` 只接收章节/摘录，必须同时提供 `pageSlug`，服务端用当前 Subject/page 补全身份并从页面仓库读取标题快照后随用户消息持久化。明确单页 re-enrich 直接创建 PendingAction，canonical 选区配图才进入独立 `image-insert` mode，工具面仅为只读工具加 `wiki.image.insert`，Reshape 确定性拒绝。重置请求以 `reset-confirmation` SSE 进入二次确认，后续 body 用 `intentContext:'reset-confirmation'` 复用同一分类入口；确认后前端仍调用受鉴权/CSRF/Subject 守卫的 `/api/reset`。分类失败时普通请求回退 read、重置确认回退 unclear。三种 Query mode 均可跨 Subject 只读、读取 active Subject History 与脱敏 workflow status；也支持两种 subject-scoped `save-to-wiki` 入队模式，Route 不直接写 vault |
| `/api/pending-actions` | GET | 按 `conversationId` 列出当前 subject 审批操作，供聊天刷新恢复；会话不存在/跨 subject 统一 404 |
| `/api/pending-actions/[id]/approve` | POST | 批准服务端持久化的预览；忽略客户端 operation/payload，重新规划后执行页面/move/History Saga，或原子 start/cancel workflow job；选区配图批准时重新验证 canonical 块锚点并启动 `image-insert`，批准前零生图；陈旧预览 409 返回刷新 action |
| `/api/pending-actions/[id]/reject` | POST | 拒绝仍为 pending 的审批操作；幂等边界与 subject 隔离由 service/repo 状态机保证 |
| `/api/tag-actions` | GET / POST | Tags 工作台审批恢复 / 创建批量治理预览；POST 接受 `{ action:'rename'|'merge'|'delete', sourceTag, targetTag?, subjectId }`，只持久化无 conversation 的 `tag-batch` PendingAction，不直接写 Vault |
| `/api/lint` | POST | 入队 `lint` 任务；默认 subject-scoped discovery，`{ allSubjects: true }` 显式全量发现；显式 verification body 暂留旧客户端兼容，Health 处置终态不再调用；返回 `jobId + mode` |
| `/api/lint/latest` | GET | 返回当前 subject（或 `?allSubjects=1` 全量）最近一次 completed lint 的完整 `HealthSnapshot`；有界读取近期 jobs 与关联 Research run 后，直接投影掉 baseline 之后已完成处置验证的 finding，并按当前 `sources/page_sources` 过滤已删除或已重新关联的 `orphan-source`；真实 fixed/failed/skipped 结果进入近期摘要，并重算 severity；从未跑过返回完整空快照，All Subjects plans 只读 |
| `/api/health/remediations` | POST | Phase 2A 统一处置入口：`{ subjectId, lintJobId, findingIds, action:'fix'\|'curate'\|'research'\|'re-ingest' }`；服务端重新校验当前 subject 最新 lint、稳定 ID 与 router action，原子去重后委托既有 workflow；202 返回 `{ jobId, deduplicated }` |
| `/api/curate` | POST | 校验 `{ subjectId }` 后入队 `curate` 任务（对当前 subject 全量页面做 agent 策展：tool-loop 自驱 `wiki.merge/split/delete/create`，`createCurateGuard` 硬护栏 caps 各≤5）；返回 202 + `{ jobId }` |
| `/api/fix` | POST | 入队 `fix` 任务修复当前 subject lint findings（确定性+LLM 两阶段）；返回 202 + `{ jobId }` |
| `/api/research` | POST | 入队 `research` 任务（缺口/薄页/主题→联网研究候选快照，只发现不写入）；body 二选一 `{ findingIds, lintJobId, subjectId }` 或 `{ topic, subjectId }`；完成后持久化 run/candidate/finding evidence，job result 只用 `runId` 定位；旧 `gapIds` 400，web search 未配置 422 |
| `/api/research-runs/[id]` | GET | 按 required subject 读取脱敏 `ResearchRunView`；包含稳定 candidate ID、批准、逐 candidate delivery lineage 与逐 finding 验证结果，跨 subject/不存在统一 404 |
| `/api/research-runs/[id]/approve` | POST | 只接受 `{ candidateIds, expectedVersion, idempotencyKey, subjectId }`；candidate ID 必须为稳定 64 位 hex，服务端回读 URL 快照；原子 CAS 批准并创建唯一 `research-import` coordinator，首次 202、幂等 replay 200 |
| `/api/research-runs/[id]/reselect` | POST | 导入阶段失败且尚未 verification 的 run 可携带 `{ expectedVersion, subjectId }` 回到候选选择；事务内归档失败审批/delivery、解冻原候选并 CAS 回 `awaiting-approval`，不重新搜索或接受客户端 URL |
| `/api/research-runs/[id]/dismiss` | POST | 显式忽略仍为 awaiting-approval 的 run；普通 UI 关闭不会调用；写请求要求 auth + CSRF + required subject |
| `/api/research-backlog` | GET | 🆕 T3.2：列出当前 subject 待研究问题队列（`?status=open\|researched\|dismissed` 过滤，缺省返回全部） |
| `/api/research-backlog/[id]` | PATCH | 🆕 T3.2：更新一条待研究问题状态（`{ status, researchJobId? }`）；跨 subject/不存在 → 404 |
| `/api/sources/[id]/reingest` | POST | 🆕 孤儿 source 重摄入：有可续传 failed job → requeue（checkpoint 续传）；查无 job/completed/cancelled → 新建 ingest job；已被页面引用 409 `already-referenced`、在途 409 `in-flight`；source 本身已被删（`id` 查无）404 |
| `/api/sources/[id]` | DELETE | 🆕 删除孤儿 source（零关联守卫 409 `already-referenced`；同源查询 active 优先，故即使存在更新 terminal，只要任意旧 pending/running 仍返回 409 `in-flight`）：vault 锁内删 raw 文件+sidecar（best-effort）→ 删 sources 行 → git commit `[subject:<slug>]` |
| `/api/jobs/[id]/retry` | POST | ingest workbench 通用重试：普通 failed Ingest 直接 requeue；携带服务端 `researchProvenance` 的 Research child 经 run/delivery/job 原子状态机恢复同一 job 与 checkpoint；cancelled、source 已删除、provenance 损坏或已进入 verification 均 409 |
| `/api/jobs/[id]/url-auth` | POST | failed URL Ingest 的 401/403 恢复入口：校验任务自身 Subject 与最新 `ingest:auth-required` challenge，创建 job/source/origin 绑定的短期加密 grant；普通 Ingest 以 grant ID 原子重排，Research child 则经 provenance 原语同步恢复同一 job/delivery/run |
| `/api/history` | GET | 列出当前 subject 操作时间线（rowid DESC，类型/受影响页/时间，status=applied 或 reverted） |
| `/api/history/[id]/diff` | GET | 单次操作的 unified diff（从 preHead → postHead）；404 未知/跨 subject |
| `/api/history/[id]/revert` | POST | 回滚操作（前向 Saga 还原：复用 `services/history-tools` 从 preHead 重建 inverse changeset、锁内核对当前 HEAD、apply、commit）；requireAuth+requireCsrf+resolveSubject；404 未知/跨 subject，409 已回滚，422 校验失败 |
| `/api/jobs` | GET | 列出任务（支持 `status` / `type` / `subjectId` filter） |
| `/api/jobs/[id]` | GET | 取单个任务详情 |
| `/api/jobs/[id]/events` | GET (SSE) | Server-Sent Events 流，供前端实时追踪任务进度；支持 `Last-Event-Id` 续播 |
| `/api/pages` | GET | 列出 wiki 页面（按 `?subjectId` 过滤，排除 `meta` tag） |
| `/api/pages/[...slug]` | GET | 读取单个页面（含 frontmatter、body、backlinks）；404 时返回 `otherSubjects: [{subjectId, slug, title}]` 提示；响应含整文件 raw 字段（供编辑器加载）|
| `/api/pages/[...slug]` | DELETE | 删除单个页面；DRY 复用 `services/page-write.ts::validateDeleteTarget`（守卫：`general`/`index`/`log` meta 页禁删，404 不存在）+ `executePageDelete`（Saga 事务 + embed 回填 enqueue）；响应附 `brokenBacklinks: number`（原来指向被删页的同-subject 链接数，供调用方提示用户清理）|
| `/api/pages/[...slug]` | PUT | 改整文件 markdown（Saga 重索引）。若 frontmatter 标题变化且 `refreshReferences`(默认 true)，同事务把本 subject 内以旧标题书写的 `[[Old Title]]` 引用重写为新标题（排除自引用页），返回 `referencesUpdated` 计数；slug/URL/文件不动 |
| `/api/assets/[...path]` | GET | 读取 enrich 生成的 subject-scoped PNG/JPEG/WebP 图片；只允许 `assets/<subject>/<filename>` 安全路径 |
| `/api/search` | GET | FTS5 全文搜索（`?q=...&subjectId=...`） |
| `/api/graph` | GET | 返回图视图需要的节点 + 边数据（`?subjectId=...`） |
| `/api/conversations` | GET | 🆕 列出当前 subject 会话（`updated_at DESC, rowid DESC`）|
| `/api/conversations/[id]` | GET / PATCH / DELETE | 🆕 读单个会话含 messages / 重命名（仅 title）/ 删除（跨 subject→404，PATCH 空 title→400）|
| `/api/query` | POST | 默认流式分支扩展：body 加 `conversationId?`（无/跨 subject 静默当新会话防泄漏）与 `messageReferences?`（最多 40 条，非空时要求 `pageSlug`）→ 载末 8 条历史注入 prompt → 流末 best-effort 落库 role-aware 消息证据 → done 回传 `{subjectId, conversationId}`；save-as-page/save-to-wiki 模式不持久化 |
| `/api/maintenance/status` | GET | 只读维护层运行态：开关 / 上次 sweep / 节律 / 范围内到期页数（`dueCount`）；维护是全局调度不绑 subject，仅 `requireAuth` |
| `/api/maintenance/due-pages` | GET | 🆕 到期页面明细预览：scope 与 status 同源、`total` 与 `dueCount` 同口径；entries 含 subject slug/name、标题（maturity 孤儿行为 null）、`nextDueAt`/priority/state，按 `priority DESC, next_due_at ASC` 最多 100 条 |
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
│       ├── ingest-workbench.tsx          # Ingest 提交 + 多任务恢复/选择
│       ├── ingest-task-switcher.tsx      # 并行 Ingest 任务切换条
│       └── ingest-live-view.tsx          # 单任务实时进度详情
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
    ├── jobs/[id]/url-auth/route.ts      # 🆕 POST URL 登录态授权并重排同一 job
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
| 2026-07-20 | URL 登录态授权扩展到 Research child：`POST /api/jobs/[id]/url-auth` 识别服务端 provenance 后把 grant ID 与 job/delivery/run 放在同一事务恢复，失败补偿新 grant；响应附最新 run 供 Health 即时恢复 importing 轮询。spec/plan 见 docs/{specs,plans}/2026-07-20-url-auth-auto-recovery-research.md |
| 2026-07-20 | URL Source 增加本地阅读模式：`/sources/[id]` 与页面 Sources 分栏均可在实时 sandbox iframe 和摄入时保存的 Markdown 正文间切换；只读预览不重新联网，旧 sidecar 从 chunks 去重回退。spec/plan 见 docs/{specs,plans}/2026-07-20-url-source-reader-mode.md |
| 2026-07-20 | 新增 `POST /api/jobs/[id]/url-auth`：只接受当前 Subject 的普通 failed URL Ingest 与最新 401/403 challenge，敏感头写短期 AES-GCM grant，job params 只保存 grant ID；CAS 失败补偿密文，Research child 保持 provenance 专用 retry 边界。spec/plan 见 docs/{specs,plans}/2026-07-20-url-authenticated-ingest.md |
| 2026-07-20 | URL Source 改为链接型实体：`POST /api/ingest` 与 Research 导入只保存规范化 URL 并原子入队，worker 开始 Ingest 时才临时抓取并写回网页标题/描述；左侧 Sources 列表展示标题+描述；`/sources/[id]` 与页面 Sources 分栏直接在无同源权限的远程 sandbox iframe 中加载原网页，默认禁用脚本，显式允许后也只开放 `allow-scripts`；旧 `originUrl` sidecar 自动兼容。spec/plan 见 docs/{specs,plans}/2026-07-20-url-source-live-preview.md |
| 2026-07-20 | 新增 `GET /api/maintenance/due-pages`（到期页面明细预览，最多 100 条 + total）：`maturity-repo.listDueDetailed` JOIN pages/subjects，scope 与 `/api/maintenance/status` 同源；Settings Maintenance 状态行新增 View 展开列表。spec/plan 见 docs/{specs,plans}/2026-07-20-maintenance-due-pages-preview.md |
| 2026-07-20 | `GET /api/usage` 新增可选 `subjectId` 项目筛选与存在性校验；不传项目时保持全局统计，旧版未归因用量不会被错误归入任一项目 |
| 2026-07-17 | `/api/query` 流式分支接收有界 `messageReferences`；非空时要求当前 `pageSlug`，并由服务端当前 Subject/page 补全用户引用身份后随问题持久化，客户端不能用该字段伪造跨 Subject 来源 |
| 2026-07-17 | 标志 v2：`icon.svg`/`apple-icon.png`/`opengraph-image.png` 随织纹 mark 改版重生成（三经 + 波形纬线，小尺寸可读），几何与 `shared/weftwise-mark.tsx` 保持一致 |
| 2026-07-17 | canonical 选区配图改用独立 `image-insert` Query mode，只注册只读工具与 `wiki.image.insert`，避免无关 `wiki.preview_change` union schema 导致 provider 拒绝整批工具 |
| 2026-07-17 | `/api/query` 统一使用结构化 LLM 分类普通提案、Re-enrich、选区配图与 Wiki 重置；新增 `intentContext:'reset-confirmation'` 和 `reset-confirmation` SSE，删除服务端/客户端自然语言意图正则，失败保持 fail-closed |
| 2026-07-17 | Subject 导出/导入：新增 `GET /api/subjects/[id]/export`（vault 锁内打 zip：manifest + wiki/raw/assets/sources 侧车）与 `POST /api/subjects/import`（multipart zip，manifest/formatVersion/zip-slip 校验，slug 冲突 409 可换名重试，失败清理回滚）；Subjects 页加 Import 按钮、编辑弹窗加 Export。spec/plan 见 docs/{specs,plans}/2026-07-17-subject-export-import.md |
| 2026-07-17 | 全站主题色切换 weftwise 双色语法：`globals.css` BASE 层 violet 家族 → weft（纬线朱=动作，UI 主档 `#CC3F27` 白字 4.87:1）+ warp（经线靛=连接）两家族；accent/focus/selection/input-focus → weft，新增 `--color-link(-hover)` → warp，graph 节点 → warp、active → weft；danger 移向绯红 `#DB374F` 拉开色相；亮 canvas 贴品牌纸 `#F6F5F2`，暗色底面/边框整体带品牌蓝调（canvas `#131315`）；暗色主按钮前景改深墨。plan 见 docs/plans/2026-07-17-brand-theme-colors.md |
| 2026-07-17 | Ask AI 结构化选区支持 canonical 完整 Markdown 块锚点；`wiki.image.insert` 只创建配图 PendingAction，批准后才原子启动 `image-insert` job，Reshape 配图命令拒绝写 canonical |
| 2026-07-17 | Ask AI 选区配图意图由 `query` 结构化 LLM 分类 `image-insert/other`，API 以 `userQuestion` 接收未拼 Passage 的原始问题；分类失败保守回退 read，工具授权不再依赖自然语言正则 |
| 2026-07-17 | 品牌落地 weftwise（织识）：根 layout metadata 改 `title: {default:'weftwise 织识', template:'%s · weftwise'}` + 品牌 description；新增 `icon.svg`（自适应 favicon）、`apple-icon.png`、`opengraph-image.png(+alt)`；ingest 与 wiki not-found 标题去手写后缀交给 template；`globals.css` BASE 层新增 `--brand-warp`/`--brand-weft` token（`.dark` 覆盖）。plan 见 docs/plans/2026-07-17-brand-weftwise.md |
| 2026-07-16 | Tags Review 增加 Rename/Merge/Delete 治理入口；`/api/tag-actions` 只创建/恢复服务端 PendingAction，批准继续复用通用 approve/reject API，批量写入由单 changeset Saga 原子执行 |
| 2026-07-16 | Tags 两路由升级为目录/组合浏览工作台，筛选状态 URL 化并增加 Suspense 加载边界；仍复用 subject-aware `/api/pages`，不新增写接口 |
| 2026-07-16 | 明确的“重新丰富当前页面 / 重新丰富页面 `<slug>`”由 `/api/query` 确定性创建 workflow PendingAction，不再等待 Query LLM 首次 tool-call；仍须独立批准才入队 |
| 2026-07-15 | 修正 `GET /api/lint/latest` 处置投影：Tidy/Fix 完成任务内验证、Research provenance 到达验证终态后均直接移除关联 finding，真实 fixed/failed/skipped 结果保留在近期摘要 |
| 2026-07-15 | `GET /api/lint/latest` 改为基于处置 postcondition 投影当前快照，fixed finding 直接移除；Health Fix/Tidy/Research 终态不再自动请求 `/api/lint`，显式 verification API 仅保留兼容 |
| 2026-07-15 | Ingest 工作台支持并行任务切换：批量文件/URL 提交后展示全部成功入队任务，刷新时恢复当前 Subject 的 running + pending + 可续传 failed；仅选中任务建立 SSE，任务条显示 queued/running/completed/failed，排队详情不再误报为正在解析 |
| 2026-07-15 | `/api/lint` 新增 subject-scoped verification 模式，严格校验 completed baseline lint 与 completed Fix/Curate 的 RemediationContext 关联；All Subjects 禁止 verification，普通请求保持 discovery |
| 2026-07-14 | Query 编排边界：流式 `error` part、迭代器异常与初始化异常统一为单一 SSE error 终态；失败后不再回落空答案、发送 citations/done、持久化部分回答或触发 coverage；正常空流仍按 `NO_QUERY_CONTEXT_ANSWER` 成功收口 |
| 2026-07-14 | 页面身份迁移 Phase 3D：`/api/query` 可生成 `wiki.move` PendingAction；旧 slug 的页面 API 返回 308 canonical redirect，阅读页永久重定向并保留 Subject 查询参数 |
| 2026-07-14 | Workflow 控制 Phase 3C：`/api/query` 可读 active Subject job 脱敏状态，re-enrich/research/cancel 只生成 PendingAction；批准 API 原子启动或取消 job，不信任客户端工作流参数 |
| 2026-07-14 | History 工具 Phase 3B：`/api/history*` 改复用共享 History 服务，既有响应/人工确认保持兼容；`/api/query` 可读取 history list/diff，回滚只生成 PendingAction 并由独立批准 API 消费 |
| 2026-07-14 | 跨 Subject 只读 Phase 3A：`/api/query` 不再因 active Subject 为空提前退出；流式工具循环可读取其他 Subject，citation schema/persistence 透传可选 subjectSlug，写预览仍绑定 active Subject |
| 2026-07-14 | Query Save-to-Wiki Phase 2D：补齐 `/api/query` save-only 与 question+save 入队契约测试；两种模式继续只创建 subject-scoped `save-to-wiki` job，页面创建统一由 worker 的 shared create command 执行 |
| 2026-07-15 | 修复 Research child Ingest 在工作台无法重试：`POST /api/jobs/[id]/retry` 识别服务端 provenance，先终态对账，再通过 repo 原子恢复同一 child job、delivery 与 run；保留 checkpoint/attempt，拒绝 cancelled、缺失 source、证据不匹配或 verification 后重试 |
| 2026-07-14 | Research 批准溯源 Phase 2C：新增 run 读取/批准/忽略 API，批准只接受稳定 candidate ID + version + idempotency key；`lint/latest` 批量注入 run 状态；通用 Ingest route 拒绝客户端 provenance，Research child retry 必须经过 provenance 状态机，coordinator cancel 后立即对账；reset/subject 删除覆盖 provenance 五表 |
| 2026-07-12 | Health 修复闭环 Phase 2A：`GET /api/lint/latest` 升级为完整 `HealthSnapshot`；新增 `POST /api/health/remediations` 统一校验、幂等执行入口；`POST /api/research` 改用稳定 `findingIds + lintJobId` 并接受 `coverage-gap / thin-page`，旧数组下标协议退役 |
| 2026-07-11 | Wiki 审批闭环 Phase 1B：`/api/query` 新增 read/propose 模式与 `pending-action` SSE；新增 pending-actions 列表/批准/拒绝三个 subject-scoped API，写请求均 requireAuth+CSRF，批准只消费服务端预览而不信任客户端 payload |
| 2026-04-22 | 初始化：根据实际路由结构生成文档 |
| 2026-04-25 | Subject：新增 `/api/subjects` + `(app)/subjects` 管理页；既有路由全部 subject 化（`resolveSubjectFromRequest`） |
| 2026-06-22 | 新增 `(app)/history/page.tsx` + `/api/history*` 三个路由（GET 列表、GET diff、POST 回滚），支持前向 Saga 还原（⑥ 版本历史/diff）|
| 2026-06-22 | 新增 `/api/conversations` + `/api/conversations/[id]` 四个路由（GET 列表、GET/PATCH/DELETE 详情）；`POST /api/query` 默认流式支持 conversationId 多轮 + 落库（⑦ 对话持久化 + 多轮记忆）|
| 2026-06-23 | 删除 `/api/merge` 和 `/api/split` 路由（逐页按钮已移除）；新增 `POST /api/curate`（全 subject agent 策展，入队 curate 任务）；merge/split LLM 逻辑内化为 page-ops 供 curate-service 调用 |
| 2026-06-24 | 新增 `POST /api/fix`（入队 fix 任务，一键修复 lint findings）；`(app)/health/page.tsx` 加 "Fix issues" 入口 |
| 2026-06-28 | 对话触发 Re-enrich：删除 `/api/re-enrich` 路由（`src/app/api/re-enrich/route.ts`）；触发入口改为 Ask AI 对话中的 `wiki.reenrich` 写工具；`POST /api/query` route 导入 `summarizeToolArgs` 从 `@/lib/tool-activity` 共用工具名摘要 |
| 2026-06-27 | Cognitive Lens：新增顶层 `GET /api/lens/[...slug]`、画像与反馈 API；新增 `middleware/user.ts::resolveUserId` |
| 2026-07-17 | Lens API 拆为纯读取 GET 与强制刷新 POST：GET 返回 saved/canonical，POST 走 auth+CSRF、生成成功后原子替换持久化版本；新增 `/api/rendition-assets/[id]` 读取重塑专属图片，取消/失败不覆盖旧版本 |
| 2026-07-17 | Reset 补齐 Reshape 资产清理：单 Subject 与全局 reset 均在清理事务中先删除 `page_rendition_assets` 再删除 `page_renditions`，不再留下不可达图片 |
| 2026-06-28 | Subject 体验重做：`(app)/subjects/page.tsx` 改可点卡片+gear+空态；创建/编辑/删除迁到全局 `SubjectDialog`（`src/components/subjects/`），切换器 "New subject…" 改唤起弹窗（删 `?new=1`）。零 API 改动 |
| 2026-06-29 | Subject 级联删除：`DELETE /api/subjects/[id]` 改为级联删除——`subjectsRepo.deleteWithContents(id)` 单事务清全部 subject-scoped 行 + `fs.rmSync` 删 vault `wiki\|raw\|.llm-wiki/sources/<slug>` + `commitVaultChanges`；守卫 `general`→409 `protected`、有入站跨主题引用→409 `has-inbound-refs`、不存在→404；移除旧 `deleteIfEmpty`/`renditions-repo` 调用。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-29-subject-cascade-delete* |
| 2026-06-30 | `DELETE /api/pages/[...slug]` DRY 重构：改用 `services/page-write.ts::validateDeleteTarget`（守卫单一真实源）+ `executePageDelete`（Saga+embed 回填）；响应新增 `brokenBacklinks: number`（同-subject 内原指向被删页的链接数，供 chat UI 提示清理）。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-weftwise-write-tools* |
| 2026-07-03 | Ingest URL 输入：`POST /api/ingest` 新增 JSON `{ urls: string[] }` 批量分支（≤20，最初在路由内同步抓取并落 raw；2026-07-20 已由链接型 Source 取代），每 URL 独立 ingest job；新增 sources/url-fetcher、url-ingest 与 workbench URL tab。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-03-ingest-url-input* |
| 2026-07-07 | T3.2 Ask AI 未命中 → 待研究队列：新增 `GET /api/research-backlog`（列出当前 subject 待研究问题，可按 status 过滤）+ `PATCH /api/research-backlog/[id]`（更新状态/回填 researchJobId，requireAuth+CSRF+resolveSubject，跨 subject/不存在→404）；`(app)/health/page.tsx` 新增 "Research backlog" 区块（逐条 Research 复用现成 `POST /api/research` topic 分支 / Dismiss）；`POST /api/query` 流式 `done` 事件新增 `coverageSufficient` 透传 |
| 2026-07-09 | 修复 orphan-source Delete 与 Retry 竞态：`POST /api/jobs/[id]/retry`（ingest workbench 通用重试，与 orphan-source 专用的 `/api/sources/[id]/reingest` 是两条独立路径）此前不校验 job 引用的 source 是否还在，Health 页删完源文件后若经此端点重试会立即 requeue、worker 在 `loadCleanText` 报 "Source file not found"；补上与 reingest 端点一致的存在性校验（解析 `job.paramsJson.sourceId` → `sourcesRepo.getSource` 查无则 409 友好提示，不 requeue）。 |

---

_生成时间：2026-04-22 00:25:29_

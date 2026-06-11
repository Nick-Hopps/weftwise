# Agentic Wiki — 项目架构导航

> 个人知识管理 Web 应用：由 LLM 从原始资料（Markdown / HTML / PDF / 纯文本）增量构建并维护一个可持久化、相互交叉引用的 Obsidian 兼容 Wiki。

---

## 一、项目愿景

- **目标**：将"读到的任何东西"通过 LLM 代理自动组织成一个带 wikilink 的知识网络。
- **核心工作流**：读资料 → LLM 规划变更 → 校验 → 写入 vault → Drizzle/SQLite 索引 → git 提交（Saga 事务）。
- **UX 原型**："The Triad" 三联布局：左导航树 / 中央阅读或对话区 / 右侧上下文面板（反向链接、元数据、迷你图）。
- **多主题（Subject）**：知识库按 **Subject** 划分独立工作区（`general` / `<custom>`），同名 slug 在不同 subject 中互不污染；跨主题用 `[[other-subject:Page]]` 显式引用。
- **部署**：Next.js 15（App Router）全栈 + 独立 worker 进程 + 共享 vault/SQLite 数据卷。

---

## 二、技术栈

| 分类 | 选型 |
|------|------|
| 框架 | Next.js 15 (App Router) + React 19 + TypeScript 5 |
| 样式 | Tailwind CSS 3.4 + class-variance-authority + 自定义 CSS 变量主题 |
| 状态 | Zustand（客户端 UI 状态，含持久化迁移 v1→v4）+ TanStack React Query |
| 数据库 | better-sqlite3 11 + Drizzle ORM 0.38 + FTS5 全文检索 |
| LLM | Vercel AI SDK 4 + 多供应商（Anthropic / OpenAI / Google / DeepSeek / Mistral / xAI / Ollama / OpenAI-compatible）|
| Markdown | unified / remark / rehype + gray-matter（frontmatter）+ rehype-pretty-code（Shiki 高亮）+ @uiw/react-md-editor |
| 其它 | simple-git（Vault git 提交）、pdf-parse、turndown（HTML → MD）、cytoscape（图可视化）、zod（Schema）|

---

## 三、架构总览

### 进程与职责分离

```
┌──────────────────────────┐        ┌────────────────────────────┐
│ Next.js (Web / API)      │        │ Worker Process (tsx)        │
│ ──────────────────────   │        │ ──────────────────────────  │
│ · App Router 页面        │        │ · 从 jobs 表拉取任务        │
│ · /api/* Route Handlers  │──enq──▶│ · 多阶段 LLM 调用           │
│ · 仅做入队与读操作       │        │ · 写 vault + SQLite + git   │
└──────────┬───────────────┘        └──────────┬──────────────────┘
           │                                   │
           │     ┌──────────────── 共享卷 ──────────┼─────────────┐
           └────▶│ vault/  (git repo)               │  wiki.db    │◀────┘
                 │ ├── wiki/<subject>/*.md          │  SQLite +   │
                 │ ├── raw/<subject>/...            │  FTS5       │
                 │ └── .llm-wiki/sources/<subject>/ │             │
                 └──────────────────────────────────┴─────────────┘
```

### 关键架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 长任务执行 | 独立 worker 进程（`src/server/worker-entry.ts`）| Route Handler 生命周期不可靠；worker 提供清晰的任务管理 |
| Wiki 写入 | Saga 事务模式：内存 changeset → validate → fs → SQLite tx → git commit | fs + SQLite + git 无法组成真正的 ACID；需要可恢复的补偿流 |
| LLM 产出 | `generateObject()` + Zod schema + 本地序列化 | 防止跨供应商格式漂移 |
| Wikilink 解析 | 单一 `resolveWikiLinkTarget()`（`src/server/wiki/wikilinks.ts`）| 避免前端/indexer/lint/LLM 校验多份实现语义漂移 |
| 并发控制 | `vault-mutex.ts` + worker 单任务串行 + SQLite WAL | 并行 git 提交会损坏 vault |
| 源数据 | `vault/.llm-wiki/sources/<subject>/*.json` 同时落地 | SQLite 仅作为可重建缓存 |
| Subject 隔离 | first-class `subjects` 表 + `pages` 复合 PK `(subject_id, slug)` + `path UNIQUE` | 跨主题同名 slug 合法；fs 路径仍唯一；删除非空 subject 直接 409，不做 cascade |
| Subject 解析 | `src/server/middleware/subject.ts::resolveSubjectFromRequest()`（`?subjectId` > `?s=` > body > cookie `wiki_subject` > general 兜底）| 服务端唯一真实源；前端通过 store + cookie 同步 |

### 模块结构图

```mermaid
graph TD
    Root["(根) agentic-wiki"] --> App["src/app<br/>Next.js App Router"]
    Root --> Server["src/server<br/>后端业务逻辑"]
    Root --> Components["src/components<br/>React UI 组件"]
    Root --> Lib["src/lib<br/>共享工具"]
    Root --> Hooks["src/hooks<br/>React Hooks"]
    Root --> Stores["src/stores<br/>Zustand 客户端状态"]

    App --> AppApi["api/<br/>Route Handlers"]
    App --> AppRoutes["(app)/<br/>页面路由"]

    Server --> SrvDb["db/<br/>Drizzle + repos"]
    Server --> SrvWiki["wiki/<br/>Saga 事务核心"]
    Server --> SrvJobs["jobs/<br/>任务队列"]
    Server --> SrvLlm["llm/<br/>多供应商路由"]
    Server --> SrvSrc["sources/<br/>原始文档解析"]
    Server --> SrvSvc["services/<br/>任务处理器"]
    Server --> SrvGit["git/<br/>vault 版本控制"]
    Server --> SrvMw["middleware/<br/>鉴权+CSRF"]
    Server --> SrvCfg["config/<br/>env 与路径"]

    Components --> CompLayout["layout/<br/>Shell/Header/Sidebar/ContextPanel"]
    Components --> CompUi["ui/<br/>设计系统原语"]
    Components --> CompWiki["wiki/<br/>页面渲染"]
    Components --> CompChat["chat/<br/>对话 UI"]
    Components --> CompSearch["search/<br/>命令面板"]
    Components --> CompGraph["graph/<br/>图可视化"]
    Components --> CompShared["shared/<br/>全局组件"]

    click App "./src/app/CLAUDE.md" "查看 App 模块文档"
    click Server "./src/server/CLAUDE.md" "查看 Server 模块文档"
    click Components "./src/components/CLAUDE.md" "查看 Components 模块文档"
    click Lib "./src/lib/CLAUDE.md" "查看 Lib 模块文档"
    click SrvDb "./src/server/db/CLAUDE.md" "查看 DB 子模块文档"
    click SrvWiki "./src/server/wiki/CLAUDE.md" "查看 Wiki 子模块文档"
    click SrvJobs "./src/server/jobs/CLAUDE.md" "查看 Jobs 子模块文档"
    click SrvLlm "./src/server/llm/CLAUDE.md" "查看 LLM 子模块文档"
    click SrvSvc "./src/server/services/CLAUDE.md" "查看 Services 子模块文档"
    click SrvSrc "./src/server/sources/CLAUDE.md" "查看 Sources 子模块文档"
```

---

## 四、模块索引

| 路径 | 一句话职责 | 文档链接 |
|------|------------|----------|
| `src/app/` | Next.js App Router，包含页面（含 `(app)/subjects` 管理页）与 `/api/*` Route Handlers（含 `/api/subjects`） | [查看](./src/app/CLAUDE.md) |
| `src/server/` | 所有后端业务代码（"server-only"），分层为数据/事务/任务/LLM/服务/中间件 | [查看](./src/server/CLAUDE.md) |
| `src/server/agents/` | Multi-agent runtime：orchestrator + skill loader + tool registry + MCP client pool（仅 ingest 启用） | [查看](./src/server/agents/CLAUDE.md) |
| `src/server/db/` | Drizzle schema、SQLite 单例、subjects/pages/jobs/sources repos + FTS5 | [查看](./src/server/db/CLAUDE.md) |
| `src/server/wiki/` | Saga 事务核心：parse / validate / apply / rollback / index（subject-aware） | [查看](./src/server/wiki/CLAUDE.md) |
| `src/server/jobs/` | 任务队列（SQLite 持久化）+ worker 轮询 + SSE 事件发射 | [查看](./src/server/jobs/CLAUDE.md) |
| `src/server/llm/` | 多供应商路由、task-router（defaults < task < override）、结构化输出 | [查看](./src/server/llm/CLAUDE.md) |
| `src/server/services/` | 长任务处理器：`ingest-service` / `query-service` / `lint-service`（强制 subjectId） | [查看](./src/server/services/CLAUDE.md) |
| `src/server/sources/` | 原始文档解析器（md/html/pdf）+ source-store（subject-scoped 持久化） | [查看](./src/server/sources/CLAUDE.md) |
| `src/server/git/` | vault 仓库初始化、commit、restoreToHead（用于 Saga 回滚）| `src/server/git/git-service.ts` |
| `src/server/middleware/` | `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest`（subject 解析单一真实源）| `src/server/middleware/{auth,subject}.ts` |
| `src/server/config/` | env schema（zod）+ `vaultPath()` 辅助 | `src/server/config/env.ts` |
| `src/components/` | React UI 组件（布局 / 设计系统 / wiki 渲染 / chat / search / graph / SubjectSwitcher）| [查看](./src/components/CLAUDE.md) |
| `src/lib/` | 共享工具：`contracts.ts`（所有 domain 类型，含 `Subject`）、`cn.ts`、`slug.ts`、`api-fetch.ts`、`markdown-client.ts`、`theme/` | [查看](./src/lib/CLAUDE.md) |
| `src/hooks/` | 客户端 hooks：`use-job-stream`（SSE）、`use-wiki-search`、`use-current-subject` | `src/hooks/` |
| `src/stores/` | Zustand 客户端状态：`ui-store`（侧边栏、上下文面板、暗黑模式、`currentSubjectId/Slug`）| `src/stores/ui-store.ts` |
| `scripts/` | 一次性维护脚本：`migrate-introduce-subject.ts`（legacy → subject-aware vault + DB） | `scripts/` |

---

## 五、运行与开发

### 必备环境变量

```bash
VAULT_PATH=./data/vault          # vault 目录（含 git 仓库）
DATABASE_PATH=./data/wiki.db     # SQLite 数据库文件
WIKI_API_KEY=<可选>              # 不设置 = 本地开发放行；设置 = 需要 Bearer / cookie 鉴权
WORKER_POLL_INTERVAL_MS=2000     # worker 轮询间隔（默认 2s）
```

LLM 配置存放于 `llm-config.json`（参考 `llm-config.example.json`），不入版本库。

### 常用脚本（来自 `package.json`）

| 命令 | 说明 |
|------|------|
| `npm run dev` | 仅启动 Next.js 开发服务器 |
| `npm run dev:all` | **同时启动 Next.js + worker 进程**（推荐开发使用）|
| `npm run build` | 生产构建（`next build`，`output: 'standalone'`）|
| `npm run start` | 启动已构建的 Next.js |
| `npm run start:all` | 同时启动 Next.js + worker |
| `npm run lint` | ESLint（`eslint-config-next`）|
| `npm run db:generate` | drizzle-kit 生成迁移 |
| `npm run db:migrate` | drizzle-kit 应用迁移 |
| `npm run db:migrate-subjects` | 一次性脚本：legacy DB/vault → subject-aware（备份 → backfill → git mv）|

---

## 六、测试策略

> vitest 已配置（`vitest.config.ts`），测试文件分布在各模块 `__tests__/` 目录（22 文件 / 179 用例，2026-06-12）。
> 已覆盖：wikilinks、wiki-transaction（validate/rollback/applyChangeset）、frontmatter、task-router、slug、agents runtime（budget/agent-loop/orchestrator/overlay-vault/commit-changeset）、ingest 流水线（prep/service/chunker/cleaner）、settings-repo、prompts。

仍待补充：

1. `src/server/jobs/worker.ts` — `isRetryableError` 分类 + 心跳续租
2. `src/server/db/repos/` — pages-repo 复合 PK 约束、jobs-repo claim 原子性、FTS 触发器一致性

---

## 七、编码规范

- **强 TypeScript**：所有领域类型集中在 `src/lib/contracts.ts`（避免循环依赖与双向漂移）。
- **"server-only" 屏障**：`src/server/**` 不得被客户端组件直接 import（靠 Next.js 的 `runtime = 'nodejs'` + 路径约定）。
- **Wikilink / slug 规则**：唯一真实源为 `src/server/wiki/wikilinks.ts` 与 `src/server/wiki/page-identity.ts`，不得在其他模块复刻；跨主题用 `[[other-subject:Page]]`，无前缀=本 subject。
- **Subject 解析规则**：所有 API 必须经 `resolveSubjectFromRequest()` 解析；写接口在缺失 subject 时按需 `required:true` 直接 400；客户端只读 `useUIStore::currentSubject*` 与 `useApiFetch()`，不要手写 cookie/query 拼装。
- **全局设置规则**：`wikiLanguage` 等"全 app 单实例"配置存放在 `app_settings` 表，统一通过 `db/repos/settings-repo.ts` 读写；服务层（ingest / query / lint）每次调用时实时读取，UI 修改无需重启 worker；server 是唯一真实源，**不要**镜像到 Zustand。
- **LLM 输出**：必须用 `generateObject()` + zod schema，禁止让模型直出 markdown 文件。
- **Saga 顺序**：`createChangeset(jobId, subject, entries)` → `validateChangeset` → （获取 vault 锁）→ 写 fs → 写 SQLite 事务 → git commit（message 含 `[subject:<slug>]`）→ 释放锁；失败分支必调 `rollbackChangeset`。
- **路径风格**：TS 路径别名 `@/*` → `src/*`。

---

## 八、AI 使用指引

当改动涉及以下场景时，请先阅读对应模块的 `CLAUDE.md`：

- 触到 **vault / git / 数据库** 任一环节 → 阅读 `src/server/wiki/CLAUDE.md` 与 `src/server/db/CLAUDE.md`（Saga 不能绕过；subject 必须贯通到底）。
- 新增 **LLM 任务类型** → 阅读 `src/server/llm/CLAUDE.md`（需更新 `LLMTaskSchema` + `llm-config.json` + 对应 prompt；如需带 subject 上下文请在 prompt header 注入）。
- 新增 **Route Handler** → 阅读 `src/app/CLAUDE.md`：
  - 写操作必须 `requireAuth(request)` + `requireCsrf(request)`；
  - subject-scoped 路由顶部调 `resolveSubjectFromRequest(request, { required: true, body })`；
  - 长任务只入队 `queue.enqueue(...)`，立即返回 202 + `jobId`，并把 `subjectId` 写到 job params。
- 新增 **客户端组件** → 阅读 `src/components/CLAUDE.md`，优先复用 `components/ui/*` 设计系统原语；数据请求一律 `useApiFetch()` 自动带 subject。

---

## 九、变更记录 (Changelog)

| 日期 | 变更 | 说明 |
|------|------|------|
| 2026-04-27 | Phase 1 multi-agent runtime | 引入 `src/server/agents/`（orchestrator + skill loader + tool registry + MCP client pool）；`ingest` 切换为 planner→writer×N→reviewer 流水线；新增 5 项 agent 设置；spec 见 `docs/superpowers/specs/2026-04-27-multi-agent-runtime-design.md` |
| 2026-04-22 | 初始化架构文档 | 自动扫描生成根级与 11 个模块级 `CLAUDE.md`，建立模块索引与架构图 |
| 2026-04-22 | 接入 `.context/` | 启用决策审计链，团队共享编码规范与工作流规则 |
| 2026-04-25 | 引入 Subject（主题） | first-class `subjects` 表 + `pages` 复合 PK + `[[subject:page]]` 跨主题语法 + SubjectSwitcher (⌘O) + `(app)/subjects` 管理页 + `db:migrate-subjects` 一次性迁移脚本；ui-store v3→v4 |
| 2026-04-26 | 引入 wikiLanguage 全局设置 | 新增 `app_settings` 表 + `settings-repo` + `GET/PUT /api/settings`；左侧 settings dialog 加 "Wiki language" 行；`PromptContext` 把语言指令注入 ingest/query/lint 五个 user prompt（slugs/wikilinks/frontmatter keys 明确禁止翻译）；首批 vitest 单测落地（17 用例） |
| 2026-06-12 | 架构治理重构（5 批次） | slug/SUBJECT_SLUG_RE 收敛到 `lib/slug.ts` 单源；恢复 ingest 流水线 page_sources 溯源写入；worker 重试排除业务错误；补 wikilinks/wiki-transaction/task-router 单测；WikiFrontmatter/ExtractedLink/WikiDocument/SubjectListEntry 迁入 contracts；拆分 mini-graph-view/settings-dialog/agent-loop/lint-service；db 迁移抽象 `legacyMigrateTable`；新增 `server/logging.ts` facade；前端补注册 agent/lint:scope 事件 |
| 2026-06-11 | Ingest 大文件分片 | 移除 30k 截断；新增 source-cleaner/source-chunker（递归切分+token 计长）+ ingest-prep（预算预检）+ orchestrator map step + chunkStore 块路由；agentMaxSteps 改单实例作用域；spec 见 docs/superpowers/specs/2026-06-05-ingest-large-file-chunking-design.md |

---

## 十、`.context` 项目上下文

> 项目使用 `.context/` 管理开发决策上下文。

- 编码规范：`.context/prefs/coding-style.md`
- 工作流规则：`.context/prefs/workflow.md`
- 决策历史：`.context/history/commits.md`

**规则**：修改代码前必读 `prefs/`，做决策时按 `workflow.md` 规则记录日志。`/ccg:commit` 会在提交时自动从 git diff + session.log 生成 ContextEntry 归档到 `history/commits.jsonl`。

---

_生成时间：2026-04-22 00:25:29，最近更新 2026-04-25（Batch 6: Subject）_

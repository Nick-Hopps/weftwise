# weftwise 代码导览

> 目标读者：从零熟悉本项目的开发者。建议按顺序阅读，每步先读"为什么"，再打开文件看指定代码段。全程约半天。

---

## 第 1 步 · 项目全景：根 CLAUDE.md + package.json

**看什么**
- `CLAUDE.md`（根目录）— 重点读"架构总览"的进程图与"关键架构决策"表
- `package.json` 的 scripts 段，特别是 `dev:all`（同时拉起 Next.js 和 worker）

**为什么从这里看**：本项目最大的认知前提是**双进程架构**——Web/API 进程只做"入队 + 读"，所有 LLM 长任务由独立 worker 执行，两者通过共享的 vault 目录 + SQLite 通信。不先建立这个心智模型，后面所有代码都会看错位置。

**读完应理解**：数据流主干是 `读资料 → LLM 规划 → 校验 → 写 vault → SQLite 索引 → git 提交`；为什么需要 Saga 事务（fs+SQLite+git 凑不出 ACID）。

---

## 第 2 步 · 领域契约：`src/lib/contracts.ts`

**看什么**
- `Subject`（L5–12）、`WikiPage`（L14–24）、`WikiLink`（L26–32）
- `Job`（L34–47）— 注意租约/心跳字段，这是 worker 可靠性的基础
- `ChangesetEntry`（L88–92）与 `Changeset`（L94–103）— 注意 `preHead/postHead/status`，这是 Saga 回滚的锚点

**为什么**：全项目所有领域类型集中在这一个文件（避免循环依赖与漂移），是阅读其余代码的"词汇表"。

**读完应理解**：每个核心实体长什么样；`Changeset` 记录 git HEAD 前后指针是为了崩溃恢复。

---

## 第 3 步 · 数据库 Schema：`src/server/db/schema.ts`

**看什么**
- `subjects`（L9–16）与 `pages`（L26–45）— 注意 **复合主键 `(subject_id, slug)` + `path UNIQUE`**，这是多主题隔离的核心设计
- `jobs`（L100–115）— `leaseExpiresAt / heartbeatAt / attemptCount` 三列对应队列租约机制
- `operations`（L126–136）— Saga 变更集的持久化落点，worker 重启后据此回滚未完成事务

**为什么**：DB 是 vault 的"可重建索引缓存"，schema 直接反映领域模型与并发设计。

**读完应理解**：跨 subject 同名 slug 为何合法；jobs 表如何同时充当队列；`operations` 表为何存在（crash recovery）。

---

## 第 4 步 · 语义基石：`src/server/wiki/wikilinks.ts`

**看什么**
- `parseLinkInner()`（L88–113）— `[[subject:Page|alias#section]]` 的拆解逻辑
- `extractWikiLinks()`（L121–173）— 注意先经 `maskCodeBlocks()`（L66–72）屏蔽代码块
- `resolveWikiLinkTarget()`（L180–189）— 全项目**唯一**的 wikilink 解析入口

**为什么**：前端渲染、indexer、lint、LLM 校验全部复用这一份实现；这是项目明文规定的"不得复刻"模块。

**读完应理解**：`[[Page]]` 默认本 subject，`[[other-subject:Page]]` 显式跨主题；任何涉及链接的功能都必须经过这两个函数。

---

## 第 5 步 · Saga 事务核心：`src/server/wiki/wiki-transaction.ts`

**看什么**（按执行顺序读）
1. `createChangeset()`（L36–51）— 纯内存构造，不碰 fs/DB
2. `validateChangeset()`（L60–177）— 路径归属、frontmatter、wikilink 目标三重校验
3. `applyChangeset()`（L186–274）— **黄金路径**：写 fs → SQLite 事务（indexer.ts 的 `indexTouchedPages`）→ git commit → `operations.status='applied'`
4. `rollbackChangeset()`（L280–303）— 补偿路径：git 强制回到 `preHead` → reindex → 标记 `rolled-back`（幂等）

**配套**：`vault-mutex.ts`（写入前必须拿 vault 锁，防止并发 git 提交损坏仓库）。

**为什么**：这是全项目最关键的不变量——任何 wiki 写入都必须走这条链路，不能绕过。

**读完应理解**：四步顺序与失败分支；为何 rollback 必须幂等（worker 可能在任意点崩溃后重放）。

---

## 第 6 步 · 任务队列与 Worker：`src/server/jobs/` + `src/server/worker-entry.ts`

**看什么**
- `queue.ts`：`enqueue()`（L4–10）、`claim()`（L12–14，原子地 `pending→running` 并写租约）
- `worker.ts`：`startWorker()`（L51–131，每 2s 轮询 + `isProcessing` 串行 flag + 30s 心跳续租）、`isRetryableError()`（L31–45，仅瞬时错误重试，MAX_RETRIES=2）
- `worker-entry.ts`：`main()`（L70 起）— 启动序列：初始化 DB → 自愈 FTS → **回收过期租约 → 回滚 pending operations** → 注册 handler；L33–36 通过副作用 import 注册三个 service handler；`bootRuntime()`（L38–68）启动 agent runtime

**为什么**：理解"长任务为何可靠"——租约 + 心跳 + 启动时补偿，是双进程架构的另一半。

**读完应理解**：一个 job 从入队到完成/失败/重试的完整生命周期；worker 重启时如何把上一次崩溃的 Saga 收拾干净。

---

## 第 7 步 · LLM 多供应商路由：`src/server/llm/`

**看什么**
- `task-router.ts` 的 `resolveTask()`（L13–79）— 三层合并：`defaults < task config < call-site override`，输出 provider profile + model + CallSettings
- `provider-registry.ts` 的 `generateStructuredOutput()`（L18–82）— 包装 AI SDK 的 `generateObject()` + zod schema + 超时控制

**为什么**：项目铁律是"LLM 只许产出结构化对象，禁止直出 markdown 文件"，这两个函数就是该铁律的实现点；新增任何 LLM 任务类型都从这里接入。

**读完应理解**：`llm-config.json` 的配置如何被解析成实际模型调用；为什么所有 service 调 LLM 都长一个样。

---

## 第 8 步 · Ingest 流水线：`src/server/services/ingest-service.ts`

**看什么**
- `loadCleanText()`（L35–53）— 委托 `sources/parser-registry.ts::parseSourceAsync()`（L39–54）按格式解析
- `registerHandler('ingest')`（L55–168）— 通读一遍，重点是 L73–92 的**预算预检**和 L138–145 的**流水线组装**：大文件（≥25k token）先 map（块摘要）→ planner → fanout writer ×N → reviewer；小文件 inline 跳过 map
- 配套：`sources/source-chunker.ts::chunkText()`（L53–86，递归切分 + token 计长）、`source-store.ts::saveRawSource()`（L37–92，hash 去重 + sidecar 元数据）

**为什么**：这是项目的"主业务流"——所有知识进入 wiki 的唯一入口，也是 multi-agent runtime 的唯一调用方。

**读完应理解**：一份 PDF 从上传到变成多个 wiki 页面的完整阶段划分；为什么 writer 只读、只有 reviewer 能提交 changeset。

---

## 第 9 步 · Multi-Agent Runtime：`src/server/agents/`

**看什么**
- `runtime/orchestrator.ts` 的 `runPipeline()`（L24–120）— 三种 step 类型：sequence（L32–40，透传 carry 上下文）、map（L41–77，semaphore 并发块摘要）、fanout（L78–117，快照隔离 + 冲突检测 + putEntries 合并）
- `skills/loader.ts::loadSkillsFromDir()`（L14–90）— skill 即 .md 文件（frontmatter + outputSchema）
- `tools/registry.ts::createToolRegistry()`（L3–33）— skill 按 pattern 声明可用工具

**为什么**：这是 2026-04 新引入的运行时，planner→writer→reviewer 的角色权限分离（谁能写、谁只能读）就由这一层保证。

**读完应理解**：pipeline step 是数据，runtime 是解释器；fanout 的快照隔离如何让多个 writer 并行而不互相污染。

---

## 第 10 步 · API Route 标准模式：`src/app/api/ingest/route.ts`

**看什么**
- L12 `requireAuth` → L14 `requireCsrf` → L89–91 `resolveSubjectFromRequest` → L93 `saveRawSource` → L95–99 `queue.enqueue()` 后立即返回 202 + jobId
- `src/server/middleware/subject.ts::resolveSubjectFromRequest()`（L49–93）— 解析优先级：`?subjectId` > `?s=` > body > cookie `wiki_subject` > general 兜底

**为什么**：这一个文件就是所有写接口的模板；subject 解析的"服务端唯一真实源"也在这里体现。

**读完应理解**：写接口三件套（auth + csrf + subject）；为什么 Route Handler 里看不到任何 LLM 调用（只入队）。

---

## 第 11 步 · 前端状态与数据获取：store / hooks / api-fetch

**看什么**
- `src/stores/ui-store.ts`：`UIState`（L16–55，注意 L34–35 的 `currentSubjectId/Slug`）、`setCurrentSubject()`（L187–190，同步写 cookie）、persist 迁移（L91–147，v1→v4）
- `src/lib/api-fetch.ts::useApiFetch()`（L80–96）— GET 自动注入 `?subjectId=`，前端不允许手拼 subject 参数
- `src/hooks/use-job-stream.ts::useJobStream()`（L23–196）— SSE 订阅 `/api/jobs/{id}/events`，Last-Event-Id 续播 + 最多 5 次重连

**为什么**：前端与后端 subject 体系的对接点就这三个文件；长任务进度如何实时到达 UI 也在这里闭环。

**读完应理解**：subject 在 store（内存）与 cookie（服务端可读）间的双写同步；ingest 进度条背后是 jobEvents 表 + SSE。

---

## 第 12 步 · 三联布局 UI：`src/components/layout/shell.tsx`

**看什么**
- `Shell`（L13–111）— Header（L53）+ 可拖拽 Sidebar（L57–92，拖拽逻辑 L25–49）+ main（L95–97）+ ContextPanel（L100–107，固定 360px）
- 顺带浏览同目录 `header.tsx`（SubjectSwitcher、命令面板入口）、`context-panel.tsx`（backlinks / 迷你图 / chat 两 tab）

**为什么**：这是 "The Triad" UX 原型的实现，串起前面所有 store 状态（sidebarWidth、contextPanelOpen 等）。

**读完应理解**：页面如何由布局组件 + Zustand 状态组合；右侧上下文面板从哪取数据（backlinks 来自 `wiki_links` 表）。

---

## 第 13 步 ·（收尾自测）跟踪一次完整 Ingest

不读新文件，在脑中（或加日志）走一遍全链路，验证理解：

```
上传文件 → /api/ingest（auth/csrf/subject → saveRawSource → enqueue, 202）
  → worker claim → ingest handler（解析 → 切块 → 预算预检）
  → runPipeline：map 摘要 → planner 出 plan.pages → fanout writer ×N → reviewer
  → reviewer 调 commit_changeset → createChangeset → validateChangeset
  → 拿 vault 锁 → 写 fs → SQLite tx → git commit "[subject:xxx]" → 释放锁
  → job complete → SSE 事件 → use-job-stream → UI 更新
```

能不翻文档完整复述这条链 + 每步对应的文件，导览即完成。

---

## 附：阅读顺序速查

| 步 | 主题 | 文件 | 关键代码 |
|---|---|---|---|
| 1 | 全景 | `CLAUDE.md`, `package.json` | 进程图、`dev:all` |
| 2 | 契约 | `src/lib/contracts.ts` | L5–103 |
| 3 | Schema | `src/server/db/schema.ts` | L9–136 |
| 4 | Wikilink | `src/server/wiki/wikilinks.ts` | L88–189 |
| 5 | Saga | `src/server/wiki/wiki-transaction.ts` | L36–303 |
| 6 | 队列/Worker | `src/server/jobs/{queue,worker}.ts`, `worker-entry.ts` | queue L4–34, worker L31–131, entry L33–70+ |
| 7 | LLM 路由 | `src/server/llm/{task-router,provider-registry}.ts` | L13–79 / L18–82 |
| 8 | Ingest | `src/server/services/ingest-service.ts` | L35–168（重点 L138–145） |
| 9 | Agents | `src/server/agents/runtime/orchestrator.ts` 等 | L24–120 |
| 10 | API 模式 | `src/app/api/ingest/route.ts`, `middleware/subject.ts` | L12–99 / L49–93 |
| 11 | 前端数据 | `ui-store.ts`, `api-fetch.ts`, `use-job-stream.ts` | L16–190 / L80–96 / L23–196 |
| 12 | 布局 | `src/components/layout/shell.tsx` | L13–111 |
| 13 | 自测 | —（全链路复述） | — |

设计逻辑：1–3 建立全局与数据模型 → 4–5 核心不变量（链接语义 + 事务）→ 6–7 基础设施（队列 + LLM）→ 8–9 主业务流 → 10–12 接口与前端 → 13 闭环验证。

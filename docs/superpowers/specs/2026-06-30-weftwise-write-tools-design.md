# weftwise 写工具内核 + 对话删除/创建（Spec 1）— 设计文档

> 日期：2026-06-30
> 主题：为 chat / Tidy structure(curate) / Fix issues(fix) 三个 agent 功能建立**共享的语义级 wiki 写工具集**，并在 Ask AI 对话循环里落地**创建 / 删除页面**两个写动作。本文是「weftwise Tools」三阶段计划的 **Spec 1（基础）**。

---

## 〇、Initiative 总览（三阶段）

本次需求是一次有意的架构转向：把三个 agent 功能统一到**同一套语义级 wiki 写工具 + tool-loop** 之上。

| 阶段 | 范围 | 状态 |
|------|------|------|
| **Spec 1（本文）** | 共享写工具内核（page-ops 补 create/delete 执行核 + `wiki.create`/`wiki.delete` 工具 + `ToolContext` 写能力）；Ask AI 对话循环落地删除/创建；DRY 现有 DELETE 路由 | 设计中 |
| **Spec 2** | curate（Tidy structure）由「triage→confirm→execute 结构化流水线」改造为 tool-loop agent，自驱 merge/split/delete/create | 待定 |
| **Spec 3** | fix（Fix issues）由「确定性 + 逐页结构化输出」改造为 tool-loop agent，自驱 update/create/delete | 待定 |

**架构前提（影响 Spec 2/3 的措辞清理）**：项目早期文档多处记载「放弃 tool-using agent / packyapi 工具死循环」。实测真因是 *Claude 经 packyapi 中转时 thinking 块缺 signature 被 AI SDK 拒*（DeepSeek 端点工具调用一直正常），并非 tool-loop 机制本身有问题。供应商已更新、不再经 packyapi，该障碍消失，tool-loop 全面可用。**Spec 2/3 在真正反转 curate/fix 的无-tool 立场时，统一清理 CLAUDE.md 相关叙事**；Spec 1 不动这部分（chat 本就是 tool-loop，只是加写工具）。

**共享工具集全貌（语义级高层工具）**：

```
tools = {
  wiki.read, wiki.search, wiki.list,   // 只读（已有）
  wiki.create,   // 新建单页          ← Spec 1
  wiki.delete,   // 删页(+坏链数)       ← Spec 1
  wiki.update,   // 改现有页正文        ← Spec 3
  wiki.merge,    // 包装 executePageMerge（含 relink）  ← Spec 2
  wiki.split,    // 包装 executePageSplit（含 relink）  ← Spec 2
}
chat  : read/search/list/create/delete/reenrich
curate: read/search/list/merge/split/delete/create
fix   : read/search/list/update/create/delete
```

> **粒度决策**：选「语义级高层工具」而非「低层原语」。merge/split 包装既有 `page-ops` 确定性内核（含 relink），模型只决定「做哪个操作、对哪些页」，relink/frontmatter/校验全部确定性。复用已验证逻辑、坏链风险低。Spec 1 只交付 chat 需要的 `wiki.create` / `wiki.delete`，其余工具留到各自消费者阶段，避免死工具。

---

## 一、背景与目标

Ask AI 问答（`query-service`）已是 tool-loop——模型经 `streamTextWithTools` / `generateTextWithTools` 自驱调用 `wiki.read` / `wiki.search` / `wiki.list`（只读）+ `wiki.reenrich`（唯一已有写动作，fire-and-forget 入队）。`wiki.reenrich`（见 `2026-06-28-reenrich-via-chat-design.md`）确立了「对话写工具」的形态：可选 `ToolContext` 能力 + 系统提示里的「先确认后执行」纪律。

**目标**：在此形态上新增两个写动作，让用户能**通过对话创建 / 删除**当前 subject 的 wiki 页面，并把删除 / 创建抽成**可被 Spec 2/3 复用的共享执行内核**。

- `wiki.delete`：删除指定页（Nick 的原始需求）。
- `wiki.create`：新建单页（创建/删除成对，统一页面管理能力）。

与 `wiki.reenrich` 的关键差异：**同步执行**而非入队后台 job。删除 / 创建是快速确定性 Saga（fs + SQLite + git），现有 `DELETE /api/pages/[...slug]` 路由已在 Next.js 进程内同步跑它。同步执行让模型在**同一轮**拿到真实结果（已删 / 未找到 / 冲突），可如实回复，无需新增 job 类型 / service。

**非目标（Spec 1 明确不做）**：

- 不做 `wiki.update`（改现有页正文）——留给 Spec 3（fix 用），届时 `page-ops` 补 `executePageUpdate`。
- 不做 `wiki.merge` / `wiki.split` 工具——留给 Spec 2（curate 用），其执行核 `executePageMerge` / `executePageSplit` 已存在，只待包装为工具。
- 不改造 curate / fix（Spec 2/3）。
- 不动 packyapi 工具-loop 避让叙事的文档（Spec 2/3 统一清理）。
- 删除**不自动重链 / 不改其他页**（与现有 DELETE 路由一致）；坏链交给 lint / Health。
- chat 不加 `wiki.update`（Nick 本次只要 create/delete）。

---

## 二、关键架构决策

### 决策 1：删除 / 创建同步执行，复用现有 Saga 路径

删除 / 创建在**工具 handler 内同步执行**完整 Saga（`createChangeset → validateChangeset → applyChangeset`），与现有 DELETE / PUT 路由完全等价。query tool-loop 跑在 Next.js 进程，`acquireVaultLock` 是进程内 mutex；跨进程（worker）安全由 **git commit 原子性**保证（项目既有约定，DELETE/PUT 路由早已这么做）。**不新增 job 类型 / service**。

每次工具写 = 一个 Saga changeset = 一个 git commit，写入 `operations` 表 → 出现在 History 页、**可逐条回滚**。

### 决策 2：执行内核下沉 `wiki/page-ops.ts`，与 merge/split 并列

新增两个执行核，签名 / 约定与 `executePageMerge` / `executePageSplit` 对齐（**不 emit、不 enqueue embed**，副作用由调用方自持）：

```ts
// 删除：构造 delete changeset → validate → apply
executePageDelete(jobId: string, subject: Subject, slug: string)
  : Promise<{ deletedSlug: string; brokenBacklinks: number }>

// 创建：title 派生 slug → 拼 frontmatter → create changeset → validate → apply
executePageCreate(jobId: string, subject: Subject, input: {
  title: string; body: string; summary?: string; tags?: string[];
}): Promise<{ createdSlug: string }>
```

- `brokenBacklinks`：本 subject 内指向被删页的入站链接数（`pagesRepo.getBacklinks(subject.id, slug)`，排除自引用），删后变坏链——供如实告知用户。
- `executePageCreate`：
  - slug 由 title **自动派生唯一值**：`deriveUniqueSlug(title, existingSlugs)`——`normalizeSlug(title) || 'page'` 为 base，冲突则追加 `-2`/`-3`…（`existingSlugs = pagesRepo.getAllPages(subject.id).map(slug)`）。该纯函数从 `planSplitPages` 内联逻辑**抽取为共享函数**（置于 `page-identity.ts`），split-plan 改为复用，杜绝两份派生逻辑漂移；
  - frontmatter 经 `serializeFrontmatter` + `stampSystemFrontmatter` 确定性拼装（title / created / updated / tags / sources=[] / summary）；
  - `validateChangeset` 自动拦坏链（body 里的 `[[Nonexistent]]`），失败抛 Error——模型在 tool-loop 里拿到错误可改了重试（自我修正）。

> 复用既有约定：`page-ops` 内核不 emit / 不 enqueue。Spec 1 的调用方（对话路径）负责 `enqueueEmbedIndex`；Spec 2/3 的调用方按各自语义处理。

### 决策 3：校验规则纯函数化 + 调用包装层（镜像 `reenrich-enqueue.ts`）

新增 `src/server/services/page-write.ts`：

```ts
// 删除规则单一真实源（纯函数，可单测）
//   保护页 index/log 或带 'meta' tag → 返回错误消息；page=null → 未找到；否则 null
validateDeleteTarget(slug: string, page: { tags: string[] } | null): string | null

// 对话路径包装：校验 → 执行核 → enqueueEmbedIndex → 返回（校验失败抛 Error，消息可直接转述）
deletePageInSubject(subject: Subject, slug: string)
  : Promise<{ deletedSlug: string; brokenBacklinks: number }>
createPageInSubject(subject: Subject, input: { title; body; summary?; tags? })
  : Promise<{ createdSlug: string }>
```

`validateDeleteTarget` 是删除规则的唯一来源，DELETE 路由与对话路径共用（决策 5）。`PROTECTED_SYSTEM_PAGES = {'index','log'}` 常量**从路由迁入 `page-write.ts` 并 export**，DELETE 路由改为 import 它（杜绝两份字面量漂移）。

### 决策 4：两个 builtin 工具，镜像 `wiki-reenrich.ts`

`src/server/agents/tools/builtin/wiki-delete.ts` / `wiki-create.ts`：

```ts
// wiki.delete
input  : { slug: string }
output : { ok: boolean; deletedSlug: string | null; brokenBacklinks: number | null; message: string }
sideEffect: 'destructive'   // ToolDef.sideEffect 联合新增字面量

// wiki.create
input  : { title: string; body: string; summary?: string; tags?: string[] }
output : { ok: boolean; createdSlug: string | null; message: string }
sideEffect: 'create'        // ToolDef.sideEffect 联合新增字面量
```

handler 经 `ctx.deletePage` / `ctx.createPage` 执行；ctx 未注入该能力时返回 `{ ok:false, message:'... not available in this context.' }`（ingest agent 调用安全降级）；执行失败 catch 后 `{ ok:false, message: err.message }`。成功消息：

- delete：`Deleted "<slug>". N other page(s) linked to it and now have broken links — run a Health check to fix them. This deletion is recorded in History and can be reverted.`（N=0 时省略坏链句）
- create：`Created "<title>" (slug: <slug>).`

### 决策 5：DELETE 路由 DRY

`/api/pages/[...slug]` 的 `DELETE` 改用 `validateDeleteTarget`（单一源规则，按 `existing ? 400 : 404` 映射状态码）+ `executePageDelete`，并在响应附 `brokenBacklinks`（向后兼容加字段，旧消费者忽略即可）。保留路由自身的 `requireAuth` / `requireCsrf` / `resolveSubjectFromRequest` / `enqueueEmbedIndex` 包装。

> 创建无对应路由可 DRY（页面历来经 ingest 创建，无独立 create-page API），`executePageCreate` 是纯新增、仅服务对话工具。

### 决策 6：`ToolContext` 加可选写能力

`tools/tool-context.ts` 的 `ToolContext` 接口新增（仅 query runner 注入，ingest 不注入 → 工具在 ingest 中调用优雅报错）：

```ts
deletePage?(slug: string): Promise<{ deletedSlug: string; brokenBacklinks: number }>;
createPage?(input: { title: string; body: string; summary?: string; tags?: string[] }):
  Promise<{ createdSlug: string }>;
```

`query-tools.ts::buildQueryToolContext` 注入实现（直接调 `page-write.ts` 的 `deletePageInSubject` / `createPageInSubject`）。

### 决策 7：系统提示新增写动作纪律

`QUERY_AGENTIC_SYSTEM_PROMPT` 工具清单加 `wiki_create` / `wiki_delete`，新增 "Creating a page" / "Deleting a page" 段：

- **通用**：写操作前必须目标明确；歧义先问；只有用户**明确请求**写操作才执行。
- **删除（最强纪律，沿用 reenrich 模式并加重）**：永久语义（虽 git 可回滚，对用户语义上是删除）；解析目标 slug（当前页 / `wiki_list`+`wiki_search` 定位）；歧义先问不猜；**ALWAYS 在删除前复述「将删除哪个页（标题+slug）」并请用户确认；禁止与提问同轮调用，只能在用户明确同意（"yes"/"go ahead"）后的后续轮调用**；删后如实告知坏链与可回滚。
- **创建**：复述将创建的标题与正文要点请用户确认后再调；slug 由标题自动派生唯一值（同名标题会得到 `-2` 后缀的 slug），创建后如实告知最终 slug。

### 决策 8：UI 工具活动映射

`src/lib/tool-activity.ts`：
- `wiki_create` → 图标 `➕` / 动词 `Creating` / 摘要取 `title`；
- `wiki_delete` → 图标 `🗑` / 动词 `Deleting` / 摘要取 `slug`。

---

## 三、数据流

```
用户在 Ask AI 说「删除 X 页」
        │
        ▼
query-service tool-loop (streamTextWithTools, Next.js 进程)
        │  模型先 wiki_list/wiki_search 定位 slug → 复述并请确认（本轮不删）
        │  用户「确认」→ 模型后续轮调用
        ▼
wiki.delete handler → ctx.deletePage(slug)
        ▼
page-write.deletePageInSubject(subject, slug)
        │  validateDeleteTarget(slug, page)  ── 失败 → throw → 工具返回 {ok:false,message}
        ▼
page-ops.executePageDelete(uuid, subject, slug)
        │  getBacklinks → brokenBacklinks 计数
        │  createChangeset(delete) → validateChangeset → applyChangeset (fs+SQLite+git, 1 commit)
        ▼
enqueueEmbedIndex(subject.id)  ── prune 孤儿向量（未配置 embedding 时 no-op）
        ▼
工具返回 {ok:true, deletedSlug, brokenBacklinks, message}
        ▼
模型如实回复用户（含坏链提示 + 可回滚）
```

创建路径对称（`wiki.create` → `createPageInSubject` → `executePageCreate` → backfill embed）。

---

## 四、文件清单

**新增**：
```
src/server/services/page-write.ts                    # validateDeleteTarget + delete/createPageInSubject
src/server/agents/tools/builtin/wiki-delete.ts       # wiki.delete 工具
src/server/agents/tools/builtin/wiki-create.ts       # wiki.create 工具
src/server/services/__tests__/page-write.test.ts     # validateDeleteTarget 纯函数
src/server/wiki/__tests__/page-ops-create-delete.test.ts  # executePageCreate/Delete（page-ops 现无测试，新建文件）
```

**修改**：
```
src/server/wiki/page-ops.ts                          # + executePageDelete / executePageCreate
src/server/wiki/page-identity.ts                     # + deriveUniqueSlug（纯函数，create/split 共用）
src/server/wiki/split-plan.ts                        # 改用 deriveUniqueSlug（行为不变）
src/server/agents/tools/tool-context.ts              # ToolContext + deletePage?/createPage?
src/server/agents/tools/builtin/index.ts             # 注册两工具
src/server/agents/types.ts                           # ToolSideEffect 联合 + 'destructive'|'create'
src/server/services/query-service.ts                 # resolve 列表 += wiki.create/wiki.delete
src/server/services/query-tools.ts                   # buildQueryToolContext 注入写能力
src/server/llm/prompts/query-prompt.ts               # QUERY_AGENTIC_SYSTEM_PROMPT + 写动作纪律
src/lib/tool-activity.ts                             # wiki_create/wiki_delete 映射
src/app/api/pages/[...slug]/route.ts                 # DELETE DRY（validateDeleteTarget + executePageDelete）
src/server/services/__tests__/query-tools.test.ts    # 扩：写能力降级/调用
docs/* CLAUDE.md（lib/agents/services/app + 根 changelog）
```

---

## 五、测试策略

- `validateDeleteTarget`：保护页（index/log/meta tag）→ 拒；page=null → 未找到；正常页 → null。
- `executePageDelete`：删除生效（页消失）；`brokenBacklinks` 计数准确（构造 N 个指向页 + 自引用排除）。
- `deriveUniqueSlug`：title→base 派生；冲突追加 `-2`/`-3`；空标题兜底 `page`。
- `executePageCreate`：唯一 slug 派生正确（含同名冲突加后缀）；body 含坏链被 `validateChangeset` 拦截抛错；正常创建落盘 + frontmatter 完整。
- `planSplitPages`：抽取 `deriveUniqueSlug` 后行为不变（回归）。
- `query-tools`：`buildQueryToolContext` 注入 `deletePage`/`createPage`；工具 handler 在 ctx 无能力时优雅降级、有能力时透传消息。
- 不为 LLM 调用本身写测试（沿用项目惯例，结构化/工具路径靠 schema 保证）。

---

## 六、关键不变量与风险

**不变量**：
- 写操作全走 Saga；每次工具写 = 一个 git commit，记入 History **可回滚**。
- 保护页 index/log 永不可删（`validateDeleteTarget` 单一源把守，路由 + 对话共用）。
- 坏链由 `validateChangeset` 拦截——模型产坏链会拿到错误并在 tool-loop 内自我修正。
- subject 隔离：所有操作经 `ctx.subject`，不跨 subject。

**风险**：
- *误删*：靠系统提示的「复述+后续轮确认」纪律 + git 可回滚兜底。提示纪律是软约束，但与 reenrich 同源、已在生产验证。
- *并发*：对话写与 worker ingest 可能同时写 vault。与现有 DELETE/PUT 路由风险等价（进程内 mutex + git 原子性），不引入新风险面。
- *删除留坏链*：刻意为之（与现 DELETE 一致），如实告知用户 + 引导 Health 修复。

---

## 七、Rollout

无 DB 迁移、无 schema 变更、无新 job 类型。纯增量：新增工具 + 执行核 + 提示。`ToolSideEffect` 加字面量不影响既有工具。DELETE 路由响应加字段向后兼容。部署即生效（worker 不需重启即可让对话工具可用，因 query 跑在 Next.js 侧）。

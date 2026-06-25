# 工具体系收敛设计（统一工具模型 + 复活 ingest 工具）

> 日期：2026-06-25
> 状态：设计已确认，待出实施计划

---

## 一、背景与问题

项目当前存在**两套互不相通的"LLM 工具"体系**，且真正活着的那套不遵循既定设计（工具应独立定义、由流水线/skill 选择调用）。

### System A —— agent runtime 工具（为 ingest 而建，当前失效）

- 工具以 `ToolDef`（`src/server/agents/types.ts`）独立定义：`vault.read` / `vault.search` / `dispatch.skill` / `commit_changeset`。
- 进程启动时（`worker-entry.ts:54-60`）注册进 `ToolRegistry`，`setRuntimeRegistries` 存为 **worker 进程单例**。
- skill 在 frontmatter 声明 `tools:`，`agent-loop.ts:131` 用 `registry.resolve(skill.tools)` 过滤，`compileToolSet` 包成 AI SDK 工具集。
- **失效根因**：`agent-loop.ts:53-55` 按 `skill.outputSchema` 分支——有 schema 走 `generateObject`（不传 toolSet），无 schema 才走 `generateText` + 工具循环。而 `ingest-planner` / `ingest-writer` 虽声明了 `vault.read`/`vault.search`，却同时带 `outputSchema`，于是编译出的 toolSet 被丢弃，工具从不被实际调用。其余 ingest skill 都 `tools: []`。结论：4 个 builtin 工具注册完整，但对模型全部不可达。

### System B —— Ask AI 工具循环（唯一活着的工具调用）

- `src/server/services/query-tools.ts` 用 AI SDK 的 `tool()` **内联**现造 `list_pages` / `search_wiki` / `read_page`，闭包绑定 `subject` + `accessed`（访问页累积，供引用）。
- `query-service` 经 `streamTextWithTools` / `generateTextWithTools`（`provider-registry.ts`）驱动，`maxSteps: 6`。
- **完全不进 `ToolRegistry`、不是 `ToolDef`、不被 `skill.tools` 选择**——既定的工具架构在此毫无参与。

### 既定设计 vs 现状

| 设计意图 | System A | System B |
|---|---|---|
| 工具独立定义 | ✅ ToolDef 文件 | ❌ 内联 `tool()`、闭包绑定 |
| 注册到统一容器 | ✅ ToolRegistry | ❌ 不进 registry |
| 流水线/skill 选择工具 | ✅ `resolve(skill.tools)` | ❌ service 直接造 |
| 模型实际调用 | ❌ 被 outputSchema 拦 | ✅ 唯一发生处 |

### 关键事实更新（前提已变）

历史上 ingest 主动放弃工具调用，真因是 **packyapi/Claude 的 thinking 块缺 signature 被 AI SDK 拒**（非"工具死循环"）。该问题已于 **2026-06-25 修复**：`provider-factory.ts` 的 anthropic 分支注入 `createAnthropicSignatureRepairFetch` / `injectMissingThinkingSignatures` 补占位 signature。DeepSeek 与 packyapi/Claude 两端的**非流式原生 tool call 现均已验证可用**（`scripts/verify-tool-call.ts` 5 探针全过）。因此"复活 ingest 工具"的拦路障碍已不存在。

---

## 二、目标与非目标

### 目标

1. **统一工具模型**：收敛为可复用的单一定义，ingest 与 query 都从同一 `ToolRegistry` 选择工具；消灭 System B 内联孤岛。
2. **复活 ingest 工具**：让带 `outputSchema` 的 ingest skill（planner/writer）在生成过程中真正调用 `wiki.read`/`wiki.search`。
3. **tools 与结构化输出共存**：通过 **submit 合成工具**收尾——结构化输出 = 一个 `finish` 终结工具（其 `inputSchema` = skill 的 `outputSchema`）。

### 非目标

- **不统一 runner**：ingest 保留 `agent-loop`（非流式 `generateText`），query 保留 `streamTextWithTools`（流式 SSE）。二者落在真实的执行差异上（见决策 D4），只共享工具模型，不合并循环包装。
- 不引入向量依赖到 ingest（暂存页未嵌入）。
- 不改 Saga 写入契约（commit 仍在 service 层；finish 工具只返回结构化结果，不落盘）。

---

## 三、设计决策（已锁定）

| 编号 | 决策 | 选择 | 理由 |
|------|------|------|------|
| D1 | 收敛意图 | 统一模型 + 立刻复活 ingest 工具 | thinking-signature 已解，无需再规避原生工具 |
| D2 | tools+结构化输出共存机制 | **submit 合成工具收尾** | 与"统一工具模型"最契合：结构化输出 = 一个终结工具；纯工具调用、zod 校验、单次循环；末步 `toolChoice` 强制 finish 防 meander |
| D3 | 读/搜/列工具粒度 | **收敛为可复用单一定义** `wiki.read`/`wiki.search`/`wiki.list` | 数据源/算法/副作用三处差异全部下沉到 `ToolContext`，工具只剩 LLM 契约 |
| D4 | runner 是否统一 | **不统一，保留两套** | ingest 后台非流式（liveness 靠 emit 事件，非 token）；query 前台流式 SSE。AI SDK 才是循环引擎，两个 runner 只是它的薄包装；统一收益小、改造成本（agent-loop 流式化）大 |
| D5 | 纯结构化 skill 是否也走工具循环 | **否，保留 `generateObject`** | enricher/verifier/indexer/chunk-summarizer 无 tools，`generateObject` 对纯结构化更可靠且已有 err.text 修复；submit-tool 精准用于"tools + schema"共存场景 |

---

## 四、架构与组件

### 4.1 `ToolContext`（新增，DI 接缝）

把"工具是什么（LLM 契约）"与"数据从哪来（绑定）"分离。工具只声明 schema + 记录访问，数据源由 ctx 注入。

```ts
interface ToolContext {
  subject: Subject;
  readPage(slug: string): Promise<{ title: string; markdown: string } | null>;
  search(query: string, limit: number): Promise<Array<{ slug: string; title: string; summary: string }>>;
  listPages(): Promise<Array<{ slug: string; title: string; summary: string; tags: string[] }>>;
  onAccess?(page: { slug: string; title: string; body?: string }): void;  // query 累积引用；ingest 不传
  emit?(type: string, msg: string, data?: Record<string, unknown>): void;
  agent?: AgentContext;  // 逃生舱：仅 ingest-only 工具（commit/dispatch）使用
}
```

两个 provider：

- **`agentToolContext(agentCtx): ToolContext`**（ingest）
  - `readPage` → `overlay.readPage`（含暂存页；title 从 frontmatter 解析）
  - `search` → `overlay.search`（FTS，含暂存页）
  - `listPages` → `pagesRepo.getAllPages(subject.id)`
  - `onAccess` → 不传；`emit` → `agentCtx.emit`；`agent` → `agentCtx`
- **`buildQueryToolContext(subject, accessed): ToolContext`**（query）
  - `readPage` → `readPageInSubject(subject.slug, slug)`（+ pages-repo 取 title）
  - `search` → `hybridRankSlugs(subject.id, query, limit)`（向量未配置自降纯 FTS）
  - `listPages` → `pagesRepo.getAllPages` 过滤 meta、按 updatedAt 倒序、上限 200
  - `onAccess` → 写入 `AccessedPages`；`agent` → 不传

> 同一个 `wiki.search` 定义，在 ingest 是 overlay-FTS、在 query 是混合向量——差异 100% 在 ctx，不在工具定义。

### 4.2 规范工具（替换 vault-read/vault-search）

`tools/builtin/` 下新增 `wiki-read.ts` / `wiki-search.ts` / `wiki-list.ts`，handler 改吃 `ToolContext`，逻辑变薄。示例：

```ts
// wiki.read
async handler({ slug }, ctx) {
  const p = await ctx.readPage(slug);
  if (!p) return { found: false, markdown: null };
  ctx.onAccess?.({ slug, title: p.title, body: p.markdown });
  return { found: true, title: p.title, markdown: p.markdown };
}
```

`commit_changeset` / `dispatch.skill` 保留为 **ingest-only** 工具，handler 通过 `ctx.agent!`（缺失即抛）访问 `pending`/`overlay`/`skillRegistry`。query skill 不选它们即可。

### 4.3 `ToolRegistry` 进程无关化（关键修正）

当前 registry 是 `worker-entry.ts` 建的 **worker 进程单例**。但 query 流式问答跑在 **Next.js 进程**（`/api/query` Route Handler 直接调 `streamAgenticQuery`，不入队），拿不到 worker 的 registry。

解法：抽纯工厂 `tools/builtin/index.ts::createBuiltinToolRegistry()`，两进程各自调用（ToolDef 无状态纯对象，可安全在任意进程构建）。worker-entry 与 query 路径都用它。

### 4.4 `agent-loop` 收敛（Point 1）

`compileToolSet` 从 `agent-loop.ts` 抽到共享模块 `tools/compile.ts`（改吃 `ToolContext`），ingest 与 query 共用。新增 `synthesizeFinishTool(outputSchema)`。

**`compileToolSet` 签名与仪表（消歧）**：`compileToolSet(toolDefs, ctx: ToolContext, opts?: { chargeStep?(): void })`。每个 ToolDef.handler 被包成 AI SDK 工具，其 `execute`：① `opts.chargeStep?.()`（ingest 传 `runSteps.chargeStep` 做单实例步数防线 + budget；query 不传）；② `handler(args, ctx)`；③ 若 `ctx.emit` 存在则发 `agent:step` 工具调用事件（ingest 经 `agentCtx.emit`；query **不依赖 emit**——其工具活动 🔍/📄/🗂 由 AI SDK 流式响应的 tool-call parts 原生携带，前端直接渲染）。`provider 安全名转换`（点号名 `wiki.read → wiki_read`，见 `toProviderToolName`）保留在 compileToolSet 内，两端同源。

执行分支：

| skill 形态 | 路径 |
|------|------|
| 有 tools + 有 outputSchema | **工具循环 + 合成 `finish`**（params = outputSchema）；末步 `toolChoice:{type:'tool',toolName:'finish'}` 强制收尾；finish 入参 = 结构化结果 |
| 有 tools，无 outputSchema | 自由文本工具循环（query 形态；ingest 暂不用）|
| 无 tools，有 outputSchema | **保留现有 `generateObject`**（D5）|

### 4.5 query 侧瘦身（Point 2）

`query-tools.ts` 删内联 `tool()` 三件套；保留 `AccessedPages` / `subjectHasContent` / `accessedToContext`，新增 `buildQueryToolContext`。`query-service` 改为 `registry.resolve(['wiki.read','wiki.search','wiki.list'])` → 共享 `compileToolSet(queryCtx)`（**不挂 finish**，要自由文本答案）→ 喂 `streamTextWithTools`。

---

## 五、数据流

**A. ingest planner/writer（submit-tool 路径）**

```
orchestrator → AgentContext + agentToolContext(ctx)
  → compileToolSet：resolve([wiki.read,wiki.search]) + 合成 finish(params=outputSchema)
  → generateText({ tools, maxSteps, toolChoice:'auto' })
       模型交错调 wiki.search/wiki.read（每次 emit agent:step + budget 计费）
       → 最终调 finish({…结构化页…})
  → finish 入参经 zod 校验（带 repair）= 结构化结果；命中即终止
       （撞 maxSteps-1 仍未 finish → 末步 toolChoice 强制 finish）
  → 结果进 ctx.pending（writer entry）；下游 Saga 不变
```

**B. ingest enricher/verifier/indexer** —— 完全不变（无 tools + schema → 现有 `generateObject`）。

**C. query（自由文本工具循环，流式，registry 取工具）**

```
/api/query → streamAgenticQuery
  → createAccessedPages() → buildQueryToolContext(subject, accessed)
  → resolve([wiki.read,wiki.search,wiki.list]) + compileToolSet(queryCtx)  // 无 finish
  → streamTextWithTools('query', { tools, maxSteps:6 })
       模型调 wiki.list/search/read（onAccess → accessed）；最终=流式文本答案
  → accessedToContext(accessed) → generateQueryCitations   // 不变
```

---

## 六、错误处理 / 降级

| 场景 | 行为 |
|------|------|
| 读/搜/列工具内部出错 | handler 返回 `{ error }` 字符串，**不抛**，循环继续（现 query 行为，扩到 ingest）|
| ingest 未产出 finish | 末步强制 `toolChoice:finish`；仍无 → 抛 AgentError → job failed |
| 向量未配置 | query `ctx.search` 自降纯 FTS；ingest `ctx.search`=overlay FTS（**不引入向量依赖**）|
| 空 subject（query）| `subjectHasContent` 守卫 → `NO_QUERY_CONTEXT_ANSWER` 短路（不变）|
| ingest-only 工具在非 ingest ctx 被调 | `ctx.agent` 缺失即抛（防御性；query skill 本不选）|
| provider 工具可靠性 | 依赖已落地的 thinking-signature 修复 fetch（非流式已验证）；query 流式 `signature_delta` SSE 路径是**既有**未验证项（query 今天已流式调工具），非本次引入，列为已知风险 |

---

## 七、测试策略

- `tool-context.test.ts`：两个 adapter 路由正确（readPage/search/listPages 走对数据源；query onAccess 累积；agent 逃生舱）。
- `wiki-tools.test.ts`：三工具 handler 对 fake ToolContext 的 found/not-found、访问记录、error 透传。
- `compile.test.ts`：provider 安全名转换；从 schema 合成 finish；末步强制 finish。
- `agent-loop`：tool+schema skill 命中 finish 即返回校验后对象；no-tool schema skill 仍走 generateObject（分支测试）。
- 既有 `commit-changeset` / `query-tools` / `query-service-agentic`：改为 registry 取工具后**对外行为（引用、访问页）不变**，应基本通过（按需调整 mock）。

---

## 八、文件级改动清单

**新增**
- `src/server/agents/tools/tool-context.ts`（ToolContext 接口 + `agentToolContext`）
- `src/server/agents/tools/compile.ts`（`compileToolSet` + `synthesizeFinishTool`）
- `src/server/agents/tools/builtin/wiki-read.ts` / `wiki-search.ts` / `wiki-list.ts`
- `src/server/agents/tools/builtin/index.ts`（`createBuiltinToolRegistry()`）

**修改**
- `src/server/agents/types.ts`：`ToolDef.handler` ctx `AgentContext → ToolContext`；ToolContext 加 `agent?`
- `src/server/agents/runtime/agent-loop.ts`：分支按"有无 tools"走 finish-loop / generateObject；改用 `tools/compile`
- `src/server/agents/tools/builtin/commit-changeset.ts`、`dispatch-skill.ts`：handler 读 `ctx.agent`
- `src/server/worker-entry.ts`：改用 `createBuiltinToolRegistry()`
- `src/server/services/query-tools.ts`：删内联 `tool()`，加 `buildQueryToolContext`
- `src/server/services/query-service.ts`：registry.resolve + `compileToolSet(queryCtx)`
- `examples/skills/ingest-planner.md`、`ingest-writer.md`：`vault.* → wiki.*`

**删除**
- `src/server/agents/tools/builtin/vault-read.ts`、`vault-search.ts`

---

## 九、迁移与回滚

- **skill 重播种**：`ingest-planner` / `ingest-writer` 的 `tools:` 由 `vault.*` 改为 `wiki.*`，需删 `data/vault/.llm-wiki/skills/ingest-{planner,writer}.md` 让 worker 启动时重播种（`seedSkillFiles` 不覆盖已有文件）。
- **零 DB 迁移**：纯代码 + skill YAML 改动。
- **回滚**：还原文件即可；无数据结构变更。

---

## 十、已知风险 / 限制

1. query 流式（`streamText`）+ Claude thinking 的 `signature_delta` SSE 路径未经验证——既有状态，非本次引入；若 query 切到 Claude 端点需补验。
2. planner/writer 复活工具后 token 消耗与延迟上升（多轮工具调用）；由现有 `agentMaxSteps` + token 预算兜底。
3. submit-tool 在个别模型上可能 meander（只读不交）——末步强制 `toolChoice:finish` + `maxSteps` 兜底缓解。

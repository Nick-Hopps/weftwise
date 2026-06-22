[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **agents**

# `src/server/agents/` — Multi-agent Runtime

## 模块职责

为长任务提供**多 agent 流水线执行环境**。核心动机：ingest 任务的四阶段内容工作流（规划 → 生成 → 增益 → 核查）在单次 LLM 调用中难以保证质量与可控性，需要独立 agent 角色分工、互相交接上下文、并受统一预算约束。

> **2026-06-21 重构**：原第五阶段 tool-using `ingest-reviewer`（`generateText` + `commit_changeset` 工具循环）在 packyapi 的 openai-compatible 转译下工具死循环（反复读 index/log 却不消费、永不 commit → 撞 maxSteps），已删除。索引/日志生成下沉为**无 tools 的 `ingest-indexer` 结构化输出**，**commit 上移回 service 层**（`ingest-service.ts::finalizeIngest` → `commitPending`）。详见根 `CLAUDE.md` Changelog 2026-06-21。

当前启用范围：**仅 `ingest` 任务**。其余任务（`query` / `lint`）仍走 `services/` 内的直接 LLM 调用。

---

## 流水线总览

```
ingest-service.ts
        │
        ▼ runPipeline(jobId, subject, sources, ctx)
  orchestrator.ts
        │
        ├── [大文件路径] map: skill 'ingest-chunk-summarizer' × N chunks
        │     └── 逐块定位性摘要，全文从 ctx.chunkStore 注入，summary 写回 chunkRefs
        │
        ├── step 1: skill 'ingest-planner'  (sequence)
        │     └── tools: vault.read, vault.search
        │
        ├── step 2: fanout skill 'ingest-writer' × N pages  (fanout)
        │     └── tools: vault.read, vault.search
        │       每个 writer entry 暂存进 ctx.pending（+overlay 读隔离）
        │       忠实层散文：只产出与原文忠实对应的 markdown 正文，不含 callout
        │       checkpointAs: 'writer-page'
        │
        ├── step 3: fanout skill 'ingest-enricher' × N pages  (fanout)
        │     └── 结构化输出（generateObject，无 tools）
        │       读取 step 2 的页面内容（injectPriorPageAs），叠加 [!type] callout 增益层
        │       callout 类型：intuition / example / quiz / background / diagram / pitfall
        │       ctx.pending 按 path upsert（last-write-wins，覆盖 writer 产出）
        │       checkpointAs: 'enricher-page'
        │
        ├── step 4: verify (kind:'verify') × N pages  ——P3 联网核查（⑨）
        │     └── runtime/verify-page.ts::runPageVerification（全程 generateObject 无 tools）
        │       读取 step 3 的页面内容（injectPriorPageAs:'content'），逐页两段式：
        │         ① triage skill 'ingest-verifier-triage' → { doubtfulClaims:[{excerpt,query,reason}] }
        │         ② 编排层 Tavily 搜索（query 去重+上限3+Promise.allSettled）
        │         ③ apply skill 'ingest-verifier-apply' → 证据驱动改 callout + citedSources
        │       降级：未配置/triage 空/零证据 → 既有 'ingest-verifier'(v2) 自检 或 passthrough
        │       provenance：citedSources 累积进 ctx.citedSources；URL 追加进页 frontmatter sources
        │       ctx.pending 按 path upsert（last-write-wins，覆盖 enricher 产出）
        │       checkpointAs: 'verifier-page'
        │       搜索后端配置在全局设置 app_settings（settings-repo::getWebSearchConfig）
        │
        ▼  runPipeline 返回（不在 agent 内提交）
  ────────────────────────────────────────────────────
  ingest-service.ts :: finalizeIngest（service 层收口）
        │
        ├── runSingle skill 'ingest-indexer'  (无 tools, generateObject)
        │     └── 输入: 全 subject 页清单(existing ∪ plan, 排除 meta) + 现有 index/log 全文
        │         输出: { indexMd, logMd }（不进页正文、不可能进工具循环）
        │
        └── commitPending(ctx, [index.md, log.md])
                    commit = ctx.pending ∪ [index, log]（按 path 去重）
                              │
                              ▼
                    wiki-transaction Saga
                    (validate → fs → SQLite → git)
```

**写入边界**：流水线内的 agent（Planner / Writer / Enricher / Verifier）**全部为结构化输出，无任何写盘工具**——它们只把页面暂存进 `ctx.pending`。真正的 commit 由 **service 层**（`finalizeIngest` → `commitPending`）在流水线结束后执行，符合"写操作经 services → wiki-transaction"的 Saga 契约。`commit_changeset` tool 仍注册但已无 skill 引用（薄包装 `commitPending`，保留作工具面/测试用）。

**暂存提交**：每个内容阶段（writer → enricher → verifier）的页面均由 orchestrator 暂存进 `ctx.pending`；同一 path 的 upsert 采用 **last-write-wins**（后一阶段覆盖前一阶段产出）。`commitPending` 提交 `pending ∪ [index.md, log.md]`（按 path 去重、supplied 覆盖）。indexer 只产出 `index.md` / `log.md`（meta 页），所有内容页随 `pending` 自动提交——索引/日志 LLM 调用不接触页正文，从根本上杜绝巨量工具参数与工具循环。

**跨阶段注入**：fanout step 可携带 `injectPriorPageAs`，orchestrator 将上一阶段对应 path 的 `content` 注入到当前阶段的输入，实现 writer → enricher → verifier 逐层内容传递。

---

## 入口与启动

`ingest-service.ts` 调用：

```ts
import { runPipeline } from '@/server/agents/runtime/orchestrator';

await runPipeline(job.id, subject, parsedSources, promptCtx);
```

agent-loop 的实例化发生在 `orchestrator.ts` 内部，每个 skill step 独享一个 loop 实例，共享同一个 `BudgetTracker`。

Worker 启动时（`worker-entry.ts`）会调用 `seedSkillFiles()`，将 `examples/skills/` 下的内置 skill YAML 复制到 `vault/.llm-wiki/skills/`，**已存在的文件不会覆盖**（用户自定义安全）。

---

## 子模块说明

### `types.ts`

所有 agent 内部类型定义（`AgentStep` / `SkillDef` / `ToolCall` / `BudgetSnapshot` / `CitedSource`<⑨> 等）+ `AgentContext.citedSources?: Map<string, CitedSource>`（⑨ 核查累积桶，仅 ingest 注入）。不依赖 `contracts.ts`（单向依赖，agents 消费 contracts，不反向注入）。

### `runtime/`

| 文件 | 职责 |
|------|------|
| `agent-loop.ts` | 单个 agent 的 tool-call 驱动循环；调用 `llm/provider-registry::resolveModel(route)` 获取模型，循环执行直到 stop 或 budget 超限 |
| `orchestrator.ts` | 按 step 顺序驱动多个 agent-loop；管理 context 传递（上一 step 的输出作为下一 step 的 user prompt 前缀）；捕获 emit 事件写 SSE；支持 sequence（carryThrough/omitFromInput）/fanout/map 三种 step；map 用于大文件逐块摘要；chunkStore 块路由（relevantChunks 按 planner sourceRefs 注入）；step 支持 `checkpointAs`（'plan'/'writer-page'/'enricher-page'/'verifier-page'/'chunk-summary'），命中检查点跳过 LLM，每页完成即落盘；fanout step 可携带 `injectPriorPageAs`，自动将上一阶段对应 path 的 content 注入当前阶段输入；亦可携带 `injectExistingPageForUpdate`（仅 writer step 启用），当本页 slug 命中 `existingPages`（=更新已有页）时经 `ctx.overlay.readPage` 注入现有正文 `existingPageContent`，供 writer 增量并入而非覆盖（⑤）；`ctx.pending` 按 path upsert（last-write-wins，后阶段覆盖前阶段）|
| `budget.ts` | `createBudgetTracker`（job 级 token）+ `createRunStepTracker`（单实例 step）；超限抛 `BudgetExceededError` |
| `overlay-vault.ts` | 读写隔离层：agent 读操作走 vault 快照，写操作累积为内存 diff，commit 时才一次性落地 |
| `checkpoint.ts` | `loadCheckpoint(jobId)` → `IngestCheckpoint`；内存索引 + 落盘双写（checkpoints-repo）；挂于 `AgentContext.checkpoint?`，缺省时 orchestrator 行为不变。kinds：chunk-summary/plan/writer-page/enricher-page/verifier-page + `cited-sources`（⑨ 续传补源：整张 `CitedSource[]` 单 blob，`getCitedSources/putCitedSources`，`verify-page` record 后 persist、`ingest-service` pipeline 前 rehydrate） |
| `verify-page.ts` | `runPageVerification({ resolveSkill, ctx, input }): Promise<AgentRunResult>`（⑨）——逐页两段式联网核查：triage→编排层 `webSearch`→apply / 降级到 `ingest-verifier`(v2) 自检 / triage 空时 passthrough；apply 的 citedSources URL 经 `parseFrontmatter/serializeFrontmatter` 确定性追加进页 frontmatter `sources`，并累积进 `ctx.citedSources`（按 url 去重、合并 citedBy、fallbackContent 取匹配 snippet）。全程无 tools |

### `skills/`

| 文件 | 职责 |
|------|------|
| `schema.ts` | `SkillSchema`（zod）：定义 skill YAML 的合法结构（id / system_prompt / tools / llm_override?）|
| `loader.ts` | `loadSkill(id)` — 从 `vault/.llm-wiki/skills/<id>.yaml` 读取并 parse；`seedSkillFiles()` — worker 启动时从 `examples/skills/` 播种，不覆盖已有文件 |
| `registry.ts` | `SkillRegistry` — 内存缓存 + `get(id)` / `list()` / `register(def)`；agent-loop 通过 registry 拿到 skill 配置 |

### `tools/`

| 文件 | 职责 |
|------|------|
| `registry.ts` | `ToolRegistry` — 工具集合容器；每个 step 初始化一个 registry，按 skill 配置决定挂载哪些工具 |
| `builtin/vault-read.ts` | `vault.read` — 通过 `overlay-vault` 读取 wiki 页面内容 |
| `builtin/vault-search.ts` | `vault.search` — 通过 `pagesRepo.searchPages` 做 FTS5 搜索 |
| `builtin/commit-changeset.ts` | `commit_changeset` — 仅 reviewer 可用；提交 `ctx.pending ∪ input.entries`（按 path 去重、input 覆盖）→ 调用 `wiki-transaction` Saga |
| `builtin/dispatch-skill.ts` | `dispatch_skill` — orchestrator fanout 用；触发子 skill 执行（writer × N）|
| `mcp/config.ts` | MCP 服务器连接配置（从 `app_settings` 读取）|
| `mcp/transport.ts` | stdio / SSE transport 封装 |
| `mcp/client-pool.ts` | `McpClientPool` — 按 lifecycle 管理连接：`eager`（worker 启动即连）/ `lazy`（首次工具调用时连）/ `per-job`（每个 job 独立连接，job 结束即断）|
| `mcp/tool-bridge.ts` | 把 MCP 工具描述转为 `ToolRegistry` 可挂载的 `ToolDef`，处理 JSON Schema ↔ Zod 转换 |

---

## 对外接口

```ts
// orchestrator.ts
export async function runPipeline(
  jobId: string,
  subject: Subject,
  sources: ParsedSource[],
  ctx: PromptContext,
): Promise<PipelineResult>

// skills/loader.ts
export async function loadSkill(id: string): Promise<SkillDef>
export async function seedSkillFiles(): Promise<void>

// runtime/budget.ts
export function createBudgetTracker(budget: AgentBudget): BudgetTracker   // job 级 token
export function createRunStepTracker(maxSteps: number): RunStepTracker    // 单实例 step
```

---

## Agent 设置（`app_settings`）

5 个 agent runtime 配置 key，由 `settings-repo.ts` 读写，**每次 `runPipeline` 调用时实时读取**（无需重启 worker）：

| Key | 默认值 | 说明 |
|-----|--------|------|
| `agentMaxSteps` | `25` | **单个 agent 实例**内的最大 tool-call 轮次（2026-06 起从 job 级改为实例级；job 级总量防线由 token 预算承担） |
| `agentMaxTokensPerJob` | `1200000` | 单个 job 的 token 总预算（in + out）；P2 三轮内容阶段后默认预算由 500k 提升至 1.2M |
| `agentMaxParallelSubAgents` | `3` | fanout writer step 的最大并发数 |
| `agentMcpLifecycle` | `'lazy'` | MCP 连接生命周期（`eager` / `lazy` / `per-job`）|
| `agentTaskRouterMode` | `'frontmatter-override'` | skill LLM 选择策略（`frontmatter-override` = skill YAML 中的 `llm_override` 优先；`config-only` = 仅用 `llm-config.json`）|

---

## Skill 文件格式

Skill YAML 存放于 `vault/.llm-wiki/skills/<id>.yaml`（可被用户直接编辑）：

```yaml
id: ingest-planner
system_prompt: |
  You are a wiki planner ...
tools:
  - vault.read
  - vault.search
llm_override:          # 可选；对应 llm-config.json::tasks."skill:ingest-planner"
  temperature: 0.1
```

内置 skill 模板来自 `examples/skills/`，worker 启动时播种到 vault，**不覆盖用户已有文件**。

---

## MCP 生命周期模式

| 模式 | 连接时机 | 断开时机 | 适用场景 |
|------|----------|----------|----------|
| `eager` | worker 启动 | worker 关闭 | 低延迟、频繁调用的本地 MCP server |
| `lazy` | 首次工具调用时 | worker 关闭 | 默认；大多数 MCP server 推荐 |
| `per-job` | 每个 job 开始 | 每个 job 结束 | 有状态 MCP server、需要隔离会话 |

---

## 扩展指南

- **新增 builtin tool**：在 `tools/builtin/` 新建文件，实现 `ToolDef` interface，在 `tools/registry.ts` 注册为内置工具；按需在 skill YAML 的 `tools:` 列表中声明。
- **新增 skill**：在 `examples/skills/` 添加 YAML 文件（会随 worker 启动播种到 vault）；需要自定义 LLM 时在 `llm-config.json::tasks` 添加 `"skill:<id>": { ... }` 节。
- **新增 pipeline**：在 `orchestrator.ts` 添加新的 step 序列；目前 `runPipeline` 的 step 顺序硬编码在 orchestrator，未来可抽为配置（Phase 2 考虑）。
- **接入新任务类型（如 query / lint）**：在对应 service 文件末尾调用 `runPipeline` 替换直接 LLM 调用；需要创建对应 skill YAML 文件。

---

## 测试与质量

```
src/server/agents/runtime/__tests__/
src/server/agents/skills/__tests__/
src/server/agents/tools/builtin/__tests__/
```

关键覆盖点：

- `BudgetTracker`：step 超限抛 `BudgetExceededError`；token 累加准确。
- `OverlayVault`：读取命中内存 diff；commit 时 diff 正确合并到真实 vault。
- `commitPending`（及其薄包装 `commit_changeset` tool）：合并 `pending ∪ supplied` 调用 Saga；重复提交 / 空集报错。
- Orchestrator step 顺序：planner 输出传入 writer context；writer 扁平 entry 累积进 `ctx.pending`。

---

## 常见问题 (FAQ)

- **谁负责 commit？为什么不在 agent 内？**
  流水线内所有 agent 都是结构化输出（无写盘工具），只往 `ctx.pending` 暂存。commit 由 service 层 `finalizeIngest` 在流水线结束后统一执行（`commitPending`）。这样写操作回归 services → wiki-transaction 的 Saga 契约，也避免了原 reviewer 用工具循环 commit 在 openai-compatible 供应商上的死循环/巨量参数问题。

- **budget 超限后 job 会怎样？**
  `BudgetExceededError` 被 orchestrator 捕获，触发 `rollbackChangeset`（如已有部分写入）并以 `status='failed'` 结束 job，`error_json` 中记录 budget snapshot。该错误标记为不可重试（避免无限消耗 token）。

- **Skill YAML 改了需要重启 worker 吗？**
  不需要。`loadSkill(id)` 在每次 `runPipeline` 调用时重新读文件（无进程级缓存，文件修改即时生效）。

- **如何在 llm-config.json 中为特定 skill 指定模型？**
  在 `tasks` 节中添加 `"skill:ingest-planner": { "model": "...", "temperature": 0.1 }`。`resolveTask` 识别 `skill:` 前缀并与 skill YAML 中的 `llm_override` 合并（config < frontmatter-override 顺序）。

---

## 相关文件清单

```
src/server/agents/
├── types.ts                        # 内部类型定义
├── runtime/
│   ├── agent-loop.ts               # 单 agent tool-call 循环
│   ├── orchestrator.ts             # 多 step 流水线驱动（含 checkpointAs 逐页续传）
│   ├── budget.ts                   # BudgetTracker
│   ├── overlay-vault.ts            # 读写隔离层
│   ├── checkpoint.ts               # IngestCheckpoint 句柄（内存索引 + 落盘双写）
│   └── __tests__/
├── skills/
│   ├── schema.ts                   # SkillSchema (zod)
│   ├── loader.ts                   # loadSkill + seedSkillFiles
│   ├── registry.ts                 # SkillRegistry
│   └── __tests__/
└── tools/
    ├── registry.ts                 # ToolRegistry
    ├── builtin/
    │   ├── vault-read.ts           # vault.read
    │   ├── vault-search.ts         # vault.search
    │   ├── commit-changeset.ts     # commit_changeset (reviewer only)
    │   ├── dispatch-skill.ts       # dispatch_skill (fanout)
    │   └── __tests__/
    └── mcp/
        ├── config.ts               # MCP 连接配置
        ├── transport.ts            # stdio / SSE transport
        ├── client-pool.ts          # McpClientPool (eager/lazy/per-job)
        └── tool-bridge.ts          # MCP tool → ToolDef 桥接
```

---

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-27 | 初始化（Phase 1）：orchestrator + skill loader + tool registry + MCP client pool；ingest 切换为 planner→writer×N→reviewer 流水线 |
| 2026-06-20 | 断点续传：新增 `checkpoint.ts`（IngestCheckpoint 句柄）；`AgentContext.checkpoint?` 可选字段；`PipelineStep.checkpointAs` 逐页续传（命中检查点跳过 LLM，writer 完成即落盘）|
| 2026-06-20 | P2 双层增益：新增 enricher（`[!type]` callout 增益层）+ verifier（参数化自检，结构化输出无 tools）fanout 步骤；orchestrator pending last-write-wins upsert + 跨阶段 injectPriorPageAs 注入；checkpoint 扩展 enricher-page/verifier-page 类型；DEFAULT_AGENT_MAX_TOKENS_PER_JOB 500k→1.2M（CONTENT_STAGE_FACTOR=3）|
| 2026-06-21 | 删除 tool-using `ingest-reviewer`（packyapi openai-compatible 上工具死循环）：新增无 tools 的 `ingest-indexer`（结构化输出 `{indexMd, logMd}`）；commit 抽出 `commitPending` 并上移到 `ingest-service::finalizeIngest`（service 层收口，符合 Saga 契约）；流水线由 5 阶段收敛为 4 内容阶段 + service finalize；`commit_changeset` tool 降级为 `commitPending` 薄包装（已无 skill 引用）|
| 2026-06-22 | 增量合并：fanout step 加 `injectExistingPageForUpdate`，writer 更新已有页时 orchestrator 确定性注入现有正文 `existingPageContent`（`buildFanoutInput` 改 async），writer skill v5 并入新材料而非覆盖、planner skill v3 强化复用 slug（⑤）|
| 2026-06-22 | P3 联网核查（⑨）：verifier 阶段由 fanout 'ingest-verifier' 改为 `verify` step kind → 新 `runtime/verify-page.ts::runPageVerification` 逐页两段式（triage `ingest-verifier-triage` → 编排层 Tavily 搜索 → apply `ingest-verifier-apply`），全程 generateObject 无 tools（绕开 packyapi 工具死循环）；未配置/零证据降级既有 `ingest-verifier`(v2) 自检；新增 `CitedSource` 类型 + `AgentContext.citedSources`；`commit_changeset`/`commitPending` 接受第三参 webSources（network 引用源 links+extraStagePaths）|
| 2026-06-22 | ⑨ fast-follow（闭合终审 I-1）：`IngestCheckpoint` 加 `getCitedSources/putCitedSources`（checkpoint kind `'cited-sources'` 单 blob）；`verify-page` record 后同步 persist、`ingest-service` pipeline 前 rehydrate `ctx.citedSources`——崩溃续传命中 verifier-page 检查点跳过 verify 的页，其网页 source 仍被完整导入 |

---

_生成时间：2026-04-27_

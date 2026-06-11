[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **agents**

# `src/server/agents/` — Multi-agent Runtime

## 模块职责

为长任务提供**多 agent 流水线执行环境**。核心动机：ingest 任务的三阶段工作流（规划 → 生成 → 审校）在单次 LLM 调用中难以保证质量与可控性，需要独立 agent 角色分工、互相交接上下文、并受统一预算与写入边界约束。

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
        ├── step 1: skill 'ingest-planner'
        │     └── tools: vault.read, vault.search
        │
        ├── step 2: fanout skill 'ingest-writer' × N pages
        │     └── tools: vault.read, vault.search
        │
        └── step 3: skill 'ingest-reviewer'
              └── tools: vault.read, vault.search, commit_changeset (ONLY HERE)
                              │
                              ▼
                    wiki-transaction Saga
                    (validate → fs → SQLite → git)
```

**写入边界**：只有 `ingest-reviewer` skill 可以调用 `commit_changeset` tool。Planner 与 Writer 只做读操作（`vault.read` / `vault.search`）。这是通过 Tool Registry 在各 step 挂载不同工具集来强制的。

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

所有 agent 内部类型定义（`AgentStep` / `SkillDef` / `ToolCall` / `BudgetSnapshot` 等）。不依赖 `contracts.ts`（单向依赖，agents 消费 contracts，不反向注入）。

### `runtime/`

| 文件 | 职责 |
|------|------|
| `agent-loop.ts` | 单个 agent 的 tool-call 驱动循环；调用 `llm/provider-registry::resolveModel(route)` 获取模型，循环执行直到 stop 或 budget 超限 |
| `orchestrator.ts` | 按 step 顺序驱动多个 agent-loop；管理 context 传递（上一 step 的输出作为下一 step 的 user prompt 前缀）；捕获 emit 事件写 SSE；支持 sequence（carryThrough/omitFromInput）/fanout/map 三种 step；map 用于大文件逐块摘要；chunkStore 块路由（relevantChunks 按 planner sourceRefs 注入） |
| `budget.ts` | `createBudgetTracker`（job 级 token）+ `createRunStepTracker`（单实例 step）；超限抛 `BudgetExceededError` |
| `overlay-vault.ts` | 读写隔离层：agent 读操作走 vault 快照，写操作累积为内存 diff，commit 时才一次性落地 |

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
| `builtin/commit-changeset.ts` | `commit_changeset` — 仅 reviewer 可用；接收 `ChangesetEntry[]` → 调用 `wiki-transaction` Saga |
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
| `agentMaxTokensPerJob` | `500000` | 单个 job 的 token 总预算（in + out） |
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
- `commit_changeset` tool：传入合法 entries 时调用 Saga；传入非法 entries 时返回 tool error（不抛出）。
- Orchestrator step 顺序：planner 输出传入 writer context；reviewer 拿到 writer 聚合输出。

---

## 常见问题 (FAQ)

- **为什么 writer 不能直接 commit？**
  写入边界由 tool registry 强制：writer step 的 registry 中根本不包含 `commit_changeset`。LLM 即使尝试调用该工具，也会收到"tool not found"响应而非执行写入。这防止部分写入（reviewer 可以拒绝或修改 writer 产出后再统一 commit）。

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
│   ├── orchestrator.ts             # 多 step 流水线驱动
│   ├── budget.ts                   # BudgetTracker
│   ├── overlay-vault.ts            # 读写隔离层
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

---

_生成时间：2026-04-27_

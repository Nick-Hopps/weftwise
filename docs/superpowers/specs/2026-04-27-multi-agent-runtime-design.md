# Multi-Agent Runtime — Design Spec

**Status:** Approved (brainstorming complete) — pending implementation plan
**Date:** 2026-04-27
**Phase:** 1 of 2

---

## 1. Goal

Add an in-process multi-agent runtime to agentic-wiki that:

- Lets a single job orchestrate **multiple LLM agents** (planner / writer / reviewer-style pipelines) instead of today's one-shot `generateStructuredOutput` call.
- Lets agents call **tools**, including external **MCP servers** (as MCP **client**) and reusable **skills** (markdown-defined sub-agent templates).
- Keeps the existing **Saga write boundary** (vault fs + SQLite + git) intact: only the final accumulated changeset commits, never per-agent writes.
- Ships in two phases:
  - **Phase 1 (this spec):** Build the runtime; cut over `ingest` only; keep `query` / `lint` untouched.
  - **Phase 2 (deferred):** Generalize all task types onto the runtime; promote agent persistence to dedicated tables; richer UI; expose vault as MCP server.

This document is the *design contract* for Phase 1. The implementation plan is produced by `superpowers:writing-plans` from this spec.

---

## 2. Decisions Locked During Brainstorming

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Topology support | **All three** (single / fixed-pipeline / dynamic) | Phase 2 needs all; runtime built once, no rewrite later |
| D2 | Phase 1 ingest topology | **Fixed pipeline** (`planner → writer(s) → reviewer`) | Predictable, controllable, fewest moving parts |
| D3 | MCP role | **MCP client only** (Phase 1) | Phase-2 server exposure deferred |
| D4 | Skill format | **Markdown file with frontmatter** stored in vault, instantiated as sub-agent at runtime | Same artifact serves Phase 2 "agent template" |
| D5 | Skill location | `vault/.llm-wiki/skills/<id>.md` — **shared across subjects** (no per-subject dir) | Skills are capabilities, not knowledge |
| D6 | Phase 1 pipeline definition | **Hard-coded in `services/ingest-service.ts`** | Avoid premature DSL; refactor only if Phase 2 needs config-driven pipelines |
| D7 | Write boundary | **Strict layering** — only `commit_changeset` writes; called at most once per root run | Preserves Saga; agent loops stay side-effect-free |
| D8 | Persistence (Phase 1) | **Reuse `job_events`** with structured `data_json` (`agentRunId` / `parentRunId` / `stepIndex` / `kind` / …) | Avoid table churn; Phase 2 migration is a `INSERT … SELECT json_extract(...)` |
| D9 | UI (Phase 1) | **No tree timeline yet** — reuse current task detail page | Keeps Phase 1 backend-only |
| D10 | Defaults | maxSteps=25 / maxTokens=500K / parallelSubAgents=3 / MCP=lazy / model=task-router+frontmatter override | Sensible budgets; all configurable from settings UI |
| D11 | Worker concurrency | **Stay serial** (single in-flight job) | vault-mutex, rate-limit, debugging simplicity |
| D12 | Settings storage | **`app_settings` table** (existing pattern, same as `wikiLanguage`) | Server is single source of truth; live-reload on every read |
| D13 | Reviewer rejects commit | **Fail job** — no retry-from-planner | Reviewer's prompt instructs "≥2 unimproved rounds → commit anyway"; this branch is rare and surfacing the failure to the user is more useful than burning more tokens |
| D14 | Skill `<<include: …>>` syntax | **Deferred to Phase 2** | Phase 1 keeps skill body opaque; reserve the syntax token but no parser |

---

## 3. Architecture

### 3.1 Module Layout

```
src/server/agents/                            ← NEW subtree
├── runtime/
│   ├── agent-run.ts          # AgentRun state machine (one root run per job)
│   ├── agent-loop.ts         # Per-agent step loop (think → tool-call → observe)
│   ├── orchestrator.ts       # Topology dispatch: single / fixed-pipeline / dynamic
│   ├── overlay-vault.ts      # In-memory vault view layered on accumulated changeset
│   └── budget.ts             # Step / token / parallelism budgets
├── tools/
│   ├── registry.ts           # ToolDef registry (name → handler + zod schemas)
│   ├── builtin/
│   │   ├── vault-read.ts
│   │   ├── vault-search.ts
│   │   ├── commit-changeset.ts   # Sole write tool; sideEffect='commit'
│   │   └── dispatch-skill.ts     # Sub-agent dispatch (used by topology iii)
│   └── mcp/
│       ├── client-pool.ts        # MCP connection pool, lazy lifecycle
│       ├── transport.ts          # stdio + streamable-http adapters
│       └── tool-bridge.ts        # MCP tool descriptor → ToolDef adapter
├── skills/
│   ├── loader.ts             # Scan vault/.llm-wiki/skills/*.md → SkillTemplate[]
│   ├── schema.ts             # zod for skill frontmatter
│   └── registry.ts           # In-memory cache (single load at worker boot)
└── types.ts                  # AgentRun / AgentStep / SkillTemplate / ToolDef / AgentBudget
```

### 3.2 Module Interactions

```
worker.ts → ingest job
        │
        ▼
services/ingest-service.ts (rewritten)
        │   loadAndParseSources(sourceIds, subject)
        │
        ▼
agents/runtime/orchestrator.runPipeline(steps, ctx)
        │
        ├─▶ agents/runtime/agent-loop.ts (planner)
        │       └─ tools: vault.read, vault.search
        ├─▶ agents/runtime/agent-loop.ts (writer × N, parallel ≤3)
        │       └─ tools: vault.read, vault.search
        └─▶ agents/runtime/agent-loop.ts (reviewer)
                └─ tools: vault.read, vault.search, commit_changeset
                          │
                          ▼
                wiki/wiki-transaction.applyChangeset(...)   ← UNCHANGED Saga
```

### 3.3 Module Change Matrix

| Module | Change |
|---|---|
| `jobs/queue` `jobs/worker` `jobs/events` | None — `data_json` carries new agent fields |
| `wiki/wiki-transaction` | None — runtime calls it once at the end |
| `wiki/wiki-store` `wiki/indexer` | None — overlay wraps reads, never bypasses indexer |
| `llm/provider-registry` | None |
| `llm/task-router` | Minor — recognize `skill:<id>` as a task key |
| `services/ingest-service` | Rewritten as orchestrator caller |
| `services/query-service` `services/lint-service` | None (Phase 1) |
| `db/schema` `db/repos/settings-repo` | Add 5 keys to `app_settings` |
| `middleware` `git` `sources` | None |
| Frontend `settings-dialog.tsx` | Add an "Agents" section with 5 controls |

---

## 4. Skill File Format

**Location:** `vault/.llm-wiki/skills/<skill-id>.md`. Single global directory; subject is injected at runtime via context, not via path.

**Seeding:** Repository ships `examples/skills/{ingest-planner,ingest-writer,ingest-reviewer}.md`. On worker boot, missing files are copied from `examples/skills/` into the user's vault. Existing files are never overwritten.

```markdown
---
id: ingest-planner
name: Ingest Planner
description: Plan which wiki pages to create / merge from raw sources.
version: 1

# Tool whitelist. Patterns: 'name', 'namespace.*', '*'.
tools:
  - vault.read
  - vault.search

# Sub-agent dispatch whitelist. Only meaningful if tools includes dispatch.skill.
canDispatch: []

# LLM override. Optional. Merges over task-router 'skill:ingest-planner'.
model:
  profile: anthropic-default
  model: claude-sonnet-4-6
  maxTokens: 8192
  temperature: 0.2

# JSON Schema string. Optional. Loader compiles to zod via zod-from-json-schema.
# When present, runtime uses generateObject; when absent, generateText.
outputSchema: |
  {
    "type": "object",
    "properties": {
      "pages": { "type": "array", "items": { "type": "object" } }
    },
    "required": ["pages"]
  }

# Per-skill budget overrides. Optional.
budget:
  maxSteps: 8
  maxTokens: 50000
---

# System Prompt

The body of the markdown file is injected verbatim as the agent's system prompt.

Runtime injects context blocks the prompt may reference: <subject-context>, <wiki-language>, <source-text>, <existing-pages>, …
```

**Rules:**
- `id` must equal the filename stem; loader rejects mismatches.
- Unknown frontmatter keys are rejected (typos surface early).
- `tools: []` means no tools (LLM must produce a final answer immediately).
- Skills with parse errors load into `degradedSkills`; jobs that try to use them fail fast with `agent:skill-load-error`.
- **No hot reload in Phase 1.** Changes require a worker restart.

---

## 5. Internal Types

```ts
// src/server/agents/types.ts

interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  tools: string[];                // patterns
  canDispatch: string[];          // skill ids
  systemPrompt: string;           // markdown body
  outputSchema?: ZodSchema;
  model?: TaskLLMOverride;        // shape from llm/task-router
  budget?: Partial<AgentBudget>;
}

interface ToolDef {
  name: string;                   // 'vault.read' / 'mcp.fetch.get' / 'dispatch.skill' / 'commit_changeset'
  source: 'builtin' | 'mcp' | 'dispatch';
  description: string;            // sent to LLM
  inputSchema: ZodSchema;
  outputSchema: ZodSchema;
  sideEffect: 'none' | 'commit';
  handler: (input: unknown, ctx: AgentContext) => Promise<unknown>;
}

interface AgentBudget {
  maxSteps: number;               // default 25
  maxTokensPerJob: number;        // default 500_000
  maxParallelSubAgents: number;   // default 3
}

interface AgentRun {
  id: string;
  jobId: string;
  subjectId: string;
  parentRunId: string | null;     // null = root
  skillId: string;
  status: 'running' | 'completed' | 'failed' | 'budget-exceeded';
  startedAt: number;
  endedAt?: number;
  tokensUsed: number;
  stepCount: number;
}

type AgentStep =
  | { kind: 'thinking';            runId: string; index: number; text: string; tokensIn: number; tokensOut: number }
  | { kind: 'tool-call';           runId: string; index: number; tool: string; input: unknown; output: unknown; durationMs: number; tokensIn?: number; tokensOut?: number }
  | { kind: 'sub-agent-dispatch';  runId: string; index: number; childRunId: string; skillId: string }
  | { kind: 'final';               runId: string; index: number; output: unknown; tokensIn: number; tokensOut: number };

interface AgentContext {
  job: Job;
  subject: Subject;
  emit: (eventType: string, data: unknown) => Promise<void>;
  overlay: OverlayVault;
  budget: BudgetTracker;
  rootRunId: string;
  parentRunId: string | null;
  cancelled: boolean;             // checked at step boundaries
  committed: boolean;             // flips true after commit_changeset succeeds
}
```

---

## 6. Runtime Behavior

### 6.1 Single-Agent Step Loop

```
loop:
  1. Compose messages (system = skill.systemPrompt + ctx; history = previous steps).
  2. Check budget; throw BudgetExceeded if over.
  3. Call LLM with skill.tools resolved to ToolDef[].
       outputSchema present → generateObject
       outputSchema absent  → generateText with tools
  4. On LLM response:
       a. tool_call(s)   → execute (parallel/sequential per LLM choice), append observations, repeat from 1
       b. final answer   → emit step kind='final', return
  5. After every step: heartbeat(jobId), accumulate tokensUsed/stepCount, emit 'agent:step'.
```

Cancellation and budget are checked **at step boundaries**, never mid-LLM-call.

### 6.2 Topology Implementations

**Single** — direct call:
```ts
runSingle(skillId, ctx) → agentLoop(skill, ctx)
```

**Fixed pipeline** — used by ingest:
```ts
runPipeline(steps, ctx)
  // steps: SkillId | { kind: 'fanout', skillId, fromOutput: string }
  for each step:
    if scalar: run sub-agent; carry output forward
    if fanout: split prior output by `fromOutput` path; run skill in parallel; merge results
  return final carry
```
Fanout parallelism is bounded by `agentMaxParallelSubAgents` (semaphore inside orchestrator). Default `failFast=true`: any sub-agent failure aborts the pipeline.

**Dynamic** — runtime supports it but Phase 1 has no skill that uses it. Reserves the field; no production path.

### 6.3 Overlay Vault

Reviewer must be able to see writer drafts before commit. The overlay layers an in-memory changeset on top of `wiki-store`:

- `overlay.readPage(slug)` → check accumulated `entries` first; fall back to `wiki-store`.
- `overlay.search(query)` → FTS5 on disk **plus** in-memory title/summary scan over overlay entries; merge by `(subject, slug)` (overlay wins).
- Writer fanout uses **per-writer snapshots** of the overlay (taken at fanout dispatch time): a writer cannot see siblings' in-progress drafts, only what was already merged before it started.
- After fanout, every writer's draft entries are merged back into the root overlay before reviewer runs. **Conflict policy:** if two writers produce entries for the same `(subjectId, slug)`, the merge fails fast with `agent:writer-conflict` and the job is marked failed (not retryable). Phase 1 prevents this at the planner level — the planner's `IngestPlanSchema` requires unique slugs per page; the writer is given exactly one slug.
- Overlay is purely a read view; physical vault is untouched until `commit_changeset`.
- Lifecycle = root run lifecycle.

### 6.4 `commit_changeset` (sole write tool)

```ts
{
  name: 'commit_changeset',
  source: 'builtin',
  sideEffect: 'commit',
  inputSchema: z.object({
    entries: z.array(ChangesetEntrySchema),
    summary: z.string().min(1),
  }),
  handler: async (input, ctx) => {
    if (ctx.committed) throw new Error('commit_changeset already invoked in this run');
    const changeset = await createChangeset(ctx.job.id, ctx.subject, input.entries);
    await validateChangeset(changeset);
    const result = await applyChangeset(changeset, { commitMessage: input.summary });
    ctx.committed = true;
    return { commitSha: result.commitSha, pagesCreated: result.pagesCreated, pagesUpdated: result.pagesUpdated };
  }
}
```

Invariants:
- Only ToolDefs with `sideEffect: 'commit'` go through Saga; MCP and other built-ins cannot acquire commit power, regardless of skill whitelist.
- Idempotent: duplicate calls throw deterministically.
- On Saga failure, `applyChangeset` already runs `rollbackChangeset`; the agent run is marked `failed` and tokens already burned are not refunded.

### 6.5 MCP Lifecycle

Configuration file: `mcp-config.json` at repository root (peer of `llm-config.json`):

```json
{
  "version": 1,
  "servers": {
    "fetch": {
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    },
    "context7": {
      "transport": "streamable-http",
      "url": "https://context7.example/mcp"
    }
  }
}
```

Tool naming across all modes: `mcp.<serverId>.<toolName>` (avoids collisions across servers). Connect failures yield tool errors the agent can observe and route around; the pool marks the server `dead` and retries on the next acquire. Worker `SIGTERM` / `SIGINT` always calls `client-pool.shutdown()` to close every active connection.

Three lifecycle modes, selected via the `agentMcpLifecycle` setting:

| Mode | When connect | When disconnect | When `list_tools` runs |
|---|---|---|---|
| `eager` | Worker boot — connect every server in `mcp-config.json` in parallel | Worker shutdown only | Worker boot |
| `lazy` (default) | First time a skill calls a tool from that server | Worker shutdown only | First acquire |
| `per-job` | First time a job touches that server | At job completion (success or failure) | First acquire within the job |

Notes:
- `eager` trades worker startup latency for first-call latency (good if you have stable, fast-starting servers like context7).
- `lazy` matches the brainstormed default — most servers cost-of-startup is paid only when actually needed.
- `per-job` keeps the worker idle footprint minimal and ensures a fresh server per job (good for servers that leak state). Cost: every job that uses MCP pays the connect time.
- All three share the same `client-pool` interface; `agent-loop` does not branch on mode — only the pool's eviction policy changes.

### 6.6 Budgets

Tracked per-root-run; sub-agents share the same totals:

| Limit | Default | Setting key | Behavior on breach |
|---|---|---|---|
| Steps per agent | 25 | `agentMaxSteps` | Throw `BudgetExceeded`; job → `failed` |
| Tokens per job | 500_000 | `agentMaxTokensPerJob` | Throw `BudgetExceeded`; job → `failed` |
| Parallel sub-agents | 3 | `agentMaxParallelSubAgents` | Semaphore wait |

Settings are read **fresh at the start of every root run** (same pattern as `wikiLanguage`). UI changes apply on the next ingest.

### 6.7 Cancellation, Timeout, Retry

| Scenario | Handling |
|---|---|
| User cancels job | At step boundary, `ctx.cancelled` flips → throw `JobCancelled` |
| Single LLM call timeout | Existing `task.timeoutMs` applies; thrown error classified as before |
| `BudgetExceeded` | Not retryable |
| `JobCancelled` | Not retryable |
| MCP connect timeout | Retryable (transient) |
| MCP tool execute error | Not retryable (deterministic business error) |
| LLM 5xx / rate limit | Retryable (existing `isRetryableError`) |
| `validateChangeset` failure | Not retryable (regenerating won't fix invalid wikilinks reliably) |

### 6.8 Event Emission

Phase 1 reuses `job_events`. Every agent step is one event row. New event types and required `data_json` fields:

| Event | data_json fields |
|---|---|
| `agent:run-started` | `runId`, `parentRunId`, `skillId`, `subjectId` |
| `agent:step` | `runId`, `parentRunId`, `skillId`, `stepIndex`, `kind`, plus kind-specific fields |
| `agent:run-completed` | `runId`, `tokensUsed`, `stepCount`, `durationMs` |
| `agent:run-failed` | `runId`, `reason`, `error` |
| `agent:budget-exceeded` | `runId`, `limit`, `actual` |
| `agent:skill-load-error` | `skillId`, `errors[]` |

**Backward-compatible business events stay** — `ingest:planning`, `ingest:writing-page`, `ingest:committing` are still emitted at skill boundaries by the orchestrator (so the existing UI keeps working without any frontend change).

---

## 7. Phase 1 Ingest Cutover

### 7.1 Stage Mapping

| Old `ingest-service` stage | New role | Skill file | Tool whitelist | Output |
|---|---|---|---|---|
| 1. Read sources, parse | runtime pre-step (not an agent) | — | — | `sources[]` |
| 2. Plan | `planner` | `ingest-planner.md` | `vault.read`, `vault.search` | `IngestPlanSchema` |
| 3. Page bodies (×N, parallel ≤3) | `writer` (fanout) | `ingest-writer.md` | `vault.read`, `vault.search` | `ChangesetEntry` per writer |
| 4. Index update + accumulate entries | `reviewer` | `ingest-reviewer.md` | `vault.read`, `vault.search`, `commit_changeset` | Final commit |

### 7.2 New `ingest-service.ts` skeleton

```ts
registerHandler('ingest', async (job, emit) => {
  const subject = await subjectsRepo.requireById(job.subjectId);
  const sources = await loadAndParseSources(job.params.sourceIds, subject);

  const ctx = createAgentContext({ job, subject, emit, sources });

  const result = await orchestrator.runPipeline(
    [
      'ingest-planner',
      { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages' },
      'ingest-reviewer',
    ],
    ctx,
  );

  return {
    commitSha: result.commitSha,
    pagesCreated: result.pagesCreated,
    pagesUpdated: result.pagesUpdated,
    linksAdded: result.linksAdded,
  };
});
```

### 7.3 Backward Compatibility

- `Job.params` shape unchanged — old queued jobs run on the new runtime untouched.
- SSE event consumers receive the **same business events** they receive today; new `agent:*` events are additive.
- Worker upgrade requires a stop / start (single user, acceptable).

---

## 8. Settings UI

The existing left-sidebar settings dialog gains a section "Agents":

| UI Label | Control | Setting key | Default |
|---|---|---|---|
| Max steps per agent | NumberInput (1–200) | `agentMaxSteps` | 25 |
| Total token budget per task | NumberInput (10_000–5_000_000) | `agentMaxTokensPerJob` | 500_000 |
| Parallel sub-agents | NumberInput (1–10) | `agentMaxParallelSubAgents` | 3 |
| MCP connection mode | Select (`eager` / `lazy` / `per-job`) | `agentMcpLifecycle` | `lazy` |
| LLM selection mode | Select (`task-router-only` / `frontmatter-override`) | `agentTaskRouterMode` | `frontmatter-override` |

`GET /api/settings` and `PUT /api/settings` extended with the five keys (zod-validated). Worker reads via `settings-repo`, fresh per root run. No restart required to apply changes.

---

## 9. LLM Model Selection

Per-skill model resolution depends on `agentTaskRouterMode`:

- **`frontmatter-override` (default):** `defaults` ◀ `tasks['skill:<id>']` ◀ skill frontmatter `model:` (rightmost wins).
- **`task-router-only`:** skill frontmatter `model:` is ignored. `defaults` ◀ `tasks['skill:<id>']`.

`task-router.ts` recognizes the `skill:<id>` task key as a first-class entry. `llm-config.json` users can configure per-skill models without editing skill files:

```json
{
  "tasks": {
    "skill:ingest-reviewer": { "model": "claude-opus-4-7", "maxTokens": 16384 }
  }
}
```

---

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Runaway agent loop burning tokens | Two-budget hard stop (`maxSteps` + `maxTokensPerJob`); `BudgetExceeded` is not retryable |
| R2 | Writer fanout creates implicit serial dependencies via overlay | Per-writer overlay snapshots at fanout dispatch; reviewer sees merged superset |
| R3 | MCP server zombie / leak | `client-pool` health-checks on acquire, marks dead on failure, reconnects next call; explicit `shutdown()` on worker SIGTERM |
| R4 | Malformed skill file blocks worker | Loader records parse errors in `degradedSkills`; jobs using them fail fast; healthy skills still load |
| R5 | Reviewer rejects commit indefinitely | `maxSteps` cap; reviewer system prompt instructs "if ≥2 review rounds without improvement, commit anyway" |
| R6 | New ingest output drifts semantically vs old version | 1–2 fixture sources held aside; manual semantic comparison post-cutover (no character-level requirement) |
| R7 | In-flight ingest job during upgrade | Acceptable: stop worker before deploy. Single-user environment. |
| R8 | Overlay / FTS time-skew | Overlay carries lightweight in-memory title+summary index; full FTS only after commit and indexer run |

---

## 11. Out of Scope (Phase 1)

- Topology iii (dynamic dispatch) — runtime supports it but no skill activates it
- Migrating `query-service` / `lint-service` to runtime
- Dedicated `agent_runs` / `agent_steps` tables
- Tree-timeline UI for agent runs
- Vault as MCP server
- Multi-job parallelism in worker
- Skill hot reload
- Per-skill token-cost reports / analytics

---

## 12. Test Priorities

(First tests targeting agent runtime — vitest, same harness as `wikiLanguage` plan added.)

1. `agents/runtime/budget.ts` — step / token accounting; correct breach behavior.
2. `agents/skills/loader.ts` — frontmatter parsing; JSON-Schema → zod conversion; `canDispatch` validation; degraded-skill recording.
3. `agents/runtime/overlay-vault.ts` — read precedence (overlay > store); search merge / dedupe.
4. `agents/tools/builtin/commit-changeset.ts` — second invocation throws; failure rolls back via Saga.
5. `agents/runtime/orchestrator.ts::runPipeline` — fanout parallelism cap; failFast semantics; output carrying.
6. `services/ingest-service.ts` — end-to-end with mock LLM driving planner → writer → reviewer → commit.

---

## 13. Open Questions

_None — all questions raised during brainstorming were resolved (see decisions D13 / D14)._

---

## 14. Phase 2 Preview (Non-binding)

Once Phase 1 lands and stabilizes:

- Migrate `query` and `lint` to the runtime.
- Promote agent persistence to `agent_runs` / `agent_steps` (`INSERT … SELECT json_extract(...)` from `job_events` history).
- Tree-timeline UI on task detail page; live tool-call streaming.
- Optional dynamic-dispatch orchestrator skills.
- Pipeline definitions move into skill frontmatter (`pipeline: [...]`) — same skill file format extended.
- Vault-as-MCP-server for external Claude Desktop / agent clients.

---

_End of spec._

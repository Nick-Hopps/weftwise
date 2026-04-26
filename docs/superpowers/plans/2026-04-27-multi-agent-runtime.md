# Multi-Agent Runtime — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-process multi-agent runtime that executes the `ingest` job as a fixed pipeline of three skills (`planner → writer ×N → reviewer`), with a single Saga-protected commit at the end. Ship the runtime infrastructure (skill loader, tool registry with built-ins, MCP client pool, budget tracker, overlay vault, orchestrator) and a settings UI for five new knobs. Other task types (`query`, `lint`) and dynamic-dispatch topology are deferred to Phase 2.

**Architecture:** The runtime lives under `src/server/agents/`. Each LLM agent runs an inner step loop (think → tool-call → observe). The orchestrator dispatches sub-agents per a fixed pipeline. The only write tool is `commit_changeset`, which feeds the existing `wiki-transaction` Saga unchanged. Skills are markdown files in `vault/.llm-wiki/skills/`, loaded once at worker boot. MCP servers are configured in repo-root `mcp-config.json`, connected lazily by default. The `ingest-service` is rewritten to call the orchestrator, but its job-params shape, business event names, and `IngestResult` shape are preserved for backward compatibility.

**Tech Stack:** TypeScript 5, Vercel AI SDK 4 (`generateText` with tools + `generateObject`), zod 3, drizzle-orm 0.38, better-sqlite3 11, vitest 2.1, `@modelcontextprotocol/sdk` (new dep), `zod-from-json-schema` (new dep), TanStack React Query 5, simple-git 3.

**Spec source:** `docs/superpowers/specs/2026-04-27-multi-agent-runtime-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add deps `@modelcontextprotocol/sdk`, `zod-from-json-schema`, `gray-matter` (already a dep — verify) |
| `mcp-config.example.json` | Create | Sample MCP config (peer of `llm-config.example.json`) |
| `src/lib/contracts.ts` | Modify | Extend `AppSettings` + `AppSettingsSchema` with 5 agent settings + defaults |
| `src/server/db/repos/settings-repo.ts` | Modify | Add 5 getters/setters; broaden internal helpers if needed |
| `src/server/db/repos/__tests__/settings-repo.test.ts` | Create | Cover get/set defaults + roundtrip for each new key |
| `src/app/api/settings/route.ts` | Modify | GET returns 6 keys; PUT accepts each key independently |
| `src/components/layout/settings-dialog.tsx` | Modify | Add "Agents" section with 5 controls |
| `src/server/agents/types.ts` | Create | `SkillTemplate / ToolDef / AgentBudget / AgentRun / AgentStep / AgentContext` |
| `src/server/agents/runtime/budget.ts` | Create | `BudgetTracker` with `chargeStep / chargeTokens / assertWithin` |
| `src/server/agents/runtime/__tests__/budget.test.ts` | Create | Tests for budget enforcement |
| `src/server/agents/runtime/overlay-vault.ts` | Create | In-memory changeset overlay over `wiki-store` |
| `src/server/agents/runtime/__tests__/overlay-vault.test.ts` | Create | Read precedence, snapshot semantics, search merge |
| `src/server/agents/skills/schema.ts` | Create | zod schema for skill frontmatter |
| `src/server/agents/skills/loader.ts` | Create | Parse markdown → `SkillTemplate`, JSON-Schema → zod via `zod-from-json-schema` |
| `src/server/agents/skills/__tests__/loader.test.ts` | Create | Valid + degraded skill cases |
| `src/server/agents/skills/registry.ts` | Create | In-memory map; `loadAll`, `get`, `degraded` |
| `src/server/agents/tools/registry.ts` | Create | `ToolRegistry` keyed by name; pattern matching for whitelists |
| `src/server/agents/tools/builtin/vault-read.ts` | Create | Read page through overlay |
| `src/server/agents/tools/builtin/vault-search.ts` | Create | FTS + overlay merge |
| `src/server/agents/tools/builtin/commit-changeset.ts` | Create | Sole write tool; calls Saga |
| `src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts` | Create | Idempotency + Saga rollback |
| `src/server/agents/tools/builtin/dispatch-skill.ts` | Create | Sub-agent dispatch tool (stubbed for Phase 2 dynamic topology) |
| `src/server/agents/tools/mcp/config.ts` | Create | Load + validate `mcp-config.json` |
| `src/server/agents/tools/mcp/transport.ts` | Create | stdio + streamable-http adapters |
| `src/server/agents/tools/mcp/client-pool.ts` | Create | Three lifecycle modes; `acquire`, `releasePerJob`, `shutdown` |
| `src/server/agents/tools/mcp/tool-bridge.ts` | Create | Adapt MCP tool descriptors to `ToolDef` |
| `src/server/agents/runtime/agent-loop.ts` | Create | Single-agent step loop |
| `src/server/agents/runtime/orchestrator.ts` | Create | `runSingle / runPipeline` (with fanout + semaphore) |
| `src/server/agents/runtime/__tests__/orchestrator.test.ts` | Create | Pipeline ordering, fanout cap, failFast |
| `src/server/llm/config-schema.ts` | Modify | Accept arbitrary `skill:<id>` keys in `LLMConfigFile.tasks` |
| `src/server/llm/task-router.ts` | Modify | Allow `skill:<id>` task argument; merge with frontmatter override |
| `src/server/services/ingest-service.ts` | Rewrite | Call orchestrator instead of running 3 LLM phases inline |
| `src/server/services/__tests__/ingest-service.test.ts` | Create | End-to-end with mocked LLM driving planner→writer→reviewer→commit |
| `src/server/worker-entry.ts` | Modify | Seed `examples/skills/` to vault; load skills; init MCP pool; register shutdown |
| `examples/skills/ingest-planner.md` | Create | Planner skill |
| `examples/skills/ingest-writer.md` | Create | Writer skill |
| `examples/skills/ingest-reviewer.md` | Create | Reviewer skill (only one with `commit_changeset`) |
| `src/server/agents/CLAUDE.md` | Create | Module documentation |
| `src/server/services/CLAUDE.md` | Modify | Note ingest cutover |
| `src/server/db/CLAUDE.md` | Modify | Document 5 new settings keys |
| `src/server/llm/CLAUDE.md` | Modify | Document `skill:<id>` task keys |
| `src/components/CLAUDE.md` | Modify | Note "Agents" section in settings dialog |
| `CLAUDE.md` | Modify | Changelog row |

---

## Task 0: Add new dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime + dev dependencies**

Run:
```bash
npm install --save @modelcontextprotocol/sdk@^1.0.0 zod-from-json-schema@^0.0.5
```

Expected: `package.json` `dependencies` gains `@modelcontextprotocol/sdk` and `zod-from-json-schema`; `package-lock.json` updates.

- [ ] **Step 2: Verify gray-matter and yaml are usable**

Run:
```bash
node -e "console.log(require('gray-matter').name || 'ok')"
```

Expected: prints `ok` (gray-matter is already a transitive/direct dep). If not installed, run `npm install --save gray-matter@^4.0.3`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @modelcontextprotocol/sdk + zod-from-json-schema"
```

---

## Task 1: Extend AppSettings contract with five agent keys

**Files:**
- Modify: `src/lib/contracts.ts:105-123`

- [ ] **Step 1: Replace the AppSettings block in `src/lib/contracts.ts`**

Find the existing block (around lines 105-123) starting with `export const DEFAULT_WIKI_LANGUAGE`. Replace through the end of `AppSettingsSchema` with:

```ts
export const DEFAULT_WIKI_LANGUAGE = 'English';

export const WikiLanguageSchema = z
  .string()
  .trim()
  .min(1, 'Wiki language must be a non-empty language name (e.g. "English", "Chinese", "日本語")')
  .max(64, 'Wiki language must be 64 characters or fewer')
  .regex(
    /^[^\n\r`*#\[\]<>]+$/,
    'Wiki language must not contain newlines or markdown control characters',
  );

export const DEFAULT_AGENT_MAX_STEPS = 25;
export const DEFAULT_AGENT_MAX_TOKENS_PER_JOB = 500_000;
export const DEFAULT_AGENT_MAX_PARALLEL_SUB_AGENTS = 3;
export const DEFAULT_AGENT_MCP_LIFECYCLE = 'lazy' as const;
export const DEFAULT_AGENT_TASK_ROUTER_MODE = 'frontmatter-override' as const;

export const AgentMcpLifecycleSchema = z.enum(['eager', 'lazy', 'per-job']);
export const AgentTaskRouterModeSchema = z.enum(['task-router-only', 'frontmatter-override']);

export const AgentMaxStepsSchema = z.number().int().min(1).max(200);
export const AgentMaxTokensPerJobSchema = z.number().int().min(10_000).max(5_000_000);
export const AgentMaxParallelSubAgentsSchema = z.number().int().min(1).max(10);

export type AgentMcpLifecycle = z.infer<typeof AgentMcpLifecycleSchema>;
export type AgentTaskRouterMode = z.infer<typeof AgentTaskRouterModeSchema>;

export interface AppSettings {
  wikiLanguage: string;
  agentMaxSteps: number;
  agentMaxTokensPerJob: number;
  agentMaxParallelSubAgents: number;
  agentMcpLifecycle: AgentMcpLifecycle;
  agentTaskRouterMode: AgentTaskRouterMode;
}

export const AppSettingsSchema = z.object({
  wikiLanguage: WikiLanguageSchema,
  agentMaxSteps: AgentMaxStepsSchema,
  agentMaxTokensPerJob: AgentMaxTokensPerJobSchema,
  agentMaxParallelSubAgents: AgentMaxParallelSubAgentsSchema,
  agentMcpLifecycle: AgentMcpLifecycleSchema,
  agentTaskRouterMode: AgentTaskRouterModeSchema,
});
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: No new errors. Existing call sites still pass because `AppSettings` is a strict superset (the optional-field handling at the API layer will be added in Task 3).

- [ ] **Step 3: Commit**

```bash
git add src/lib/contracts.ts
git commit -m "feat(contracts): add 5 agent runtime settings keys"
```

---

## Task 2: Extend settings-repo with five new keys

**Files:**
- Modify: `src/server/db/repos/settings-repo.ts`
- Create: `src/server/db/repos/__tests__/settings-repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/db/repos/__tests__/settings-repo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('settings-repo agent keys', () => {
  it('returns defaults when no row exists', async () => {
    const repo = await import('../settings-repo');
    expect(repo.getAgentMaxSteps()).toBe(25);
    expect(repo.getAgentMaxTokensPerJob()).toBe(500_000);
    expect(repo.getAgentMaxParallelSubAgents()).toBe(3);
    expect(repo.getAgentMcpLifecycle()).toBe('lazy');
    expect(repo.getAgentTaskRouterMode()).toBe('frontmatter-override');
  });

  it('roundtrips numeric keys after set', async () => {
    const repo = await import('../settings-repo');
    repo.setAgentMaxSteps(50);
    repo.setAgentMaxTokensPerJob(1_000_000);
    repo.setAgentMaxParallelSubAgents(5);
    expect(repo.getAgentMaxSteps()).toBe(50);
    expect(repo.getAgentMaxTokensPerJob()).toBe(1_000_000);
    expect(repo.getAgentMaxParallelSubAgents()).toBe(5);
  });

  it('roundtrips enum keys after set', async () => {
    const repo = await import('../settings-repo');
    repo.setAgentMcpLifecycle('eager');
    repo.setAgentTaskRouterMode('task-router-only');
    expect(repo.getAgentMcpLifecycle()).toBe('eager');
    expect(repo.getAgentTaskRouterMode()).toBe('task-router-only');
  });

  it('rejects out-of-range numeric values', async () => {
    const repo = await import('../settings-repo');
    expect(() => repo.setAgentMaxSteps(0)).toThrow();
    expect(() => repo.setAgentMaxSteps(201)).toThrow();
    expect(() => repo.setAgentMaxTokensPerJob(1_000)).toThrow();
    expect(() => repo.setAgentMaxParallelSubAgents(11)).toThrow();
  });

  it('rejects unknown enum values', async () => {
    const repo = await import('../settings-repo');
    // @ts-expect-error testing runtime guard
    expect(() => repo.setAgentMcpLifecycle('bogus')).toThrow();
    // @ts-expect-error testing runtime guard
    expect(() => repo.setAgentTaskRouterMode('bogus')).toThrow();
  });
});
```

- [ ] **Step 2: Run the test (expect fail)**

Run:
```bash
npx vitest run src/server/db/repos/__tests__/settings-repo.test.ts
```

Expected: FAIL — `repo.getAgentMaxSteps is not a function` (or similar).

- [ ] **Step 3: Extend `settings-repo.ts`**

Append to `src/server/db/repos/settings-repo.ts`:

```ts
import {
  AgentMaxParallelSubAgentsSchema,
  AgentMaxStepsSchema,
  AgentMaxTokensPerJobSchema,
  AgentMcpLifecycleSchema,
  AgentTaskRouterModeSchema,
  DEFAULT_AGENT_MAX_PARALLEL_SUB_AGENTS,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_MAX_TOKENS_PER_JOB,
  DEFAULT_AGENT_MCP_LIFECYCLE,
  DEFAULT_AGENT_TASK_ROUTER_MODE,
  type AgentMcpLifecycle,
  type AgentTaskRouterMode,
} from '@/lib/contracts';

const KEY_AGENT_MAX_STEPS = 'agentMaxSteps';
const KEY_AGENT_MAX_TOKENS_PER_JOB = 'agentMaxTokensPerJob';
const KEY_AGENT_MAX_PARALLEL_SUB_AGENTS = 'agentMaxParallelSubAgents';
const KEY_AGENT_MCP_LIFECYCLE = 'agentMcpLifecycle';
const KEY_AGENT_TASK_ROUTER_MODE = 'agentTaskRouterMode';

function readNumber(key: string, fallback: number): number {
  const raw = readKey(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getAgentMaxSteps(): number {
  return readNumber(KEY_AGENT_MAX_STEPS, DEFAULT_AGENT_MAX_STEPS);
}
export function setAgentMaxSteps(value: number): number {
  const v = AgentMaxStepsSchema.parse(value);
  writeKey(KEY_AGENT_MAX_STEPS, String(v));
  return v;
}

export function getAgentMaxTokensPerJob(): number {
  return readNumber(KEY_AGENT_MAX_TOKENS_PER_JOB, DEFAULT_AGENT_MAX_TOKENS_PER_JOB);
}
export function setAgentMaxTokensPerJob(value: number): number {
  const v = AgentMaxTokensPerJobSchema.parse(value);
  writeKey(KEY_AGENT_MAX_TOKENS_PER_JOB, String(v));
  return v;
}

export function getAgentMaxParallelSubAgents(): number {
  return readNumber(KEY_AGENT_MAX_PARALLEL_SUB_AGENTS, DEFAULT_AGENT_MAX_PARALLEL_SUB_AGENTS);
}
export function setAgentMaxParallelSubAgents(value: number): number {
  const v = AgentMaxParallelSubAgentsSchema.parse(value);
  writeKey(KEY_AGENT_MAX_PARALLEL_SUB_AGENTS, String(v));
  return v;
}

export function getAgentMcpLifecycle(): AgentMcpLifecycle {
  const raw = readKey(KEY_AGENT_MCP_LIFECYCLE);
  if (raw === undefined) return DEFAULT_AGENT_MCP_LIFECYCLE;
  const parsed = AgentMcpLifecycleSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_AGENT_MCP_LIFECYCLE;
}
export function setAgentMcpLifecycle(value: AgentMcpLifecycle): AgentMcpLifecycle {
  const v = AgentMcpLifecycleSchema.parse(value);
  writeKey(KEY_AGENT_MCP_LIFECYCLE, v);
  return v;
}

export function getAgentTaskRouterMode(): AgentTaskRouterMode {
  const raw = readKey(KEY_AGENT_TASK_ROUTER_MODE);
  if (raw === undefined) return DEFAULT_AGENT_TASK_ROUTER_MODE;
  const parsed = AgentTaskRouterModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_AGENT_TASK_ROUTER_MODE;
}
export function setAgentTaskRouterMode(value: AgentTaskRouterMode): AgentTaskRouterMode {
  const v = AgentTaskRouterModeSchema.parse(value);
  writeKey(KEY_AGENT_TASK_ROUTER_MODE, v);
  return v;
}
```

- [ ] **Step 4: Run the test (expect pass)**

Run:
```bash
npx vitest run src/server/db/repos/__tests__/settings-repo.test.ts
```

Expected: PASS for all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/repos/settings-repo.ts src/server/db/repos/__tests__/settings-repo.test.ts
git commit -m "feat(settings): persist 5 agent runtime knobs in app_settings"
```

---

## Task 3: Extend `/api/settings` route to read/write all six keys

**Files:**
- Modify: `src/app/api/settings/route.ts`

- [ ] **Step 1: Replace the route file with the extended version**

Replace the entirety of `src/app/api/settings/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import {
  getWikiLanguage,
  setWikiLanguage,
  getAgentMaxSteps,
  setAgentMaxSteps,
  getAgentMaxTokensPerJob,
  setAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
  setAgentMaxParallelSubAgents,
  getAgentMcpLifecycle,
  setAgentMcpLifecycle,
  getAgentTaskRouterMode,
  setAgentTaskRouterMode,
} from '@/server/db/repos/settings-repo';
import {
  WikiLanguageSchema,
  AgentMaxStepsSchema,
  AgentMaxTokensPerJobSchema,
  AgentMaxParallelSubAgentsSchema,
  AgentMcpLifecycleSchema,
  AgentTaskRouterModeSchema,
  type AppSettings,
} from '@/lib/contracts';

export const runtime = 'nodejs';

function readSettings(): AppSettings {
  return {
    wikiLanguage: getWikiLanguage(),
    agentMaxSteps: getAgentMaxSteps(),
    agentMaxTokensPerJob: getAgentMaxTokensPerJob(),
    agentMaxParallelSubAgents: getAgentMaxParallelSubAgents(),
    agentMcpLifecycle: getAgentMcpLifecycle(),
    agentTaskRouterMode: getAgentTaskRouterMode(),
  };
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  return NextResponse.json(readSettings());
}

const PutBodySchema = z.object({
  wikiLanguage: WikiLanguageSchema.optional(),
  agentMaxSteps: AgentMaxStepsSchema.optional(),
  agentMaxTokensPerJob: AgentMaxTokensPerJobSchema.optional(),
  agentMaxParallelSubAgents: AgentMaxParallelSubAgentsSchema.optional(),
  agentMcpLifecycle: AgentMcpLifecycleSchema.optional(),
  agentTaskRouterMode: AgentTaskRouterModeSchema.optional(),
});

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = PutBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const d = parsed.data;
  if (d.wikiLanguage !== undefined) setWikiLanguage(d.wikiLanguage);
  if (d.agentMaxSteps !== undefined) setAgentMaxSteps(d.agentMaxSteps);
  if (d.agentMaxTokensPerJob !== undefined) setAgentMaxTokensPerJob(d.agentMaxTokensPerJob);
  if (d.agentMaxParallelSubAgents !== undefined) setAgentMaxParallelSubAgents(d.agentMaxParallelSubAgents);
  if (d.agentMcpLifecycle !== undefined) setAgentMcpLifecycle(d.agentMcpLifecycle);
  if (d.agentTaskRouterMode !== undefined) setAgentTaskRouterMode(d.agentTaskRouterMode);

  return NextResponse.json(readSettings());
}
```

- [ ] **Step 2: Verify type-check + lint**

Run:
```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/settings/route.ts
git commit -m "feat(api): /api/settings reads/writes 5 new agent keys"
```

---

## Task 4: Add "Agents" section to settings dialog

**Files:**
- Modify: `src/components/layout/settings-dialog.tsx`

- [ ] **Step 1: Read the file to find the insertion point**

Run:
```bash
sed -n '1,80p' src/components/layout/settings-dialog.tsx
```

Note where `settingsQuery` and `saveLanguage` are declared (around lines 39-77). The new section will mirror this pattern: one `useMutation` per setting key, plus controlled draft state. Insert the new section *after* the existing language row and *inside* the same dialog body.

- [ ] **Step 2: Add agent settings UI block**

In the body of `SettingsDialog`, after the existing `Wiki language` row (the one fed by `languageDraft`), insert:

```tsx
{/* Agents */}
<div className="border-t pt-4 mt-4 space-y-4">
  <div className="font-semibold">Agents</div>

  <NumberSettingRow
    label="Max steps per agent"
    value={settingsQuery.data?.agentMaxSteps ?? 25}
    min={1}
    max={200}
    onSave={(v) => savePartial.mutate({ agentMaxSteps: v })}
    pending={savePartial.isPending}
  />
  <NumberSettingRow
    label="Total token budget per task"
    value={settingsQuery.data?.agentMaxTokensPerJob ?? 500_000}
    min={10_000}
    max={5_000_000}
    onSave={(v) => savePartial.mutate({ agentMaxTokensPerJob: v })}
    pending={savePartial.isPending}
  />
  <NumberSettingRow
    label="Parallel sub-agents"
    value={settingsQuery.data?.agentMaxParallelSubAgents ?? 3}
    min={1}
    max={10}
    onSave={(v) => savePartial.mutate({ agentMaxParallelSubAgents: v })}
    pending={savePartial.isPending}
  />
  <SelectSettingRow
    label="MCP connection mode"
    value={settingsQuery.data?.agentMcpLifecycle ?? 'lazy'}
    options={[
      { value: 'eager', label: 'eager (connect at boot)' },
      { value: 'lazy', label: 'lazy (connect on first use)' },
      { value: 'per-job', label: 'per-job (connect per job)' },
    ]}
    onChange={(v) => savePartial.mutate({ agentMcpLifecycle: v as 'eager' | 'lazy' | 'per-job' })}
    pending={savePartial.isPending}
  />
  <SelectSettingRow
    label="LLM selection mode"
    value={settingsQuery.data?.agentTaskRouterMode ?? 'frontmatter-override'}
    options={[
      { value: 'task-router-only', label: 'task-router only' },
      { value: 'frontmatter-override', label: 'frontmatter override' },
    ]}
    onChange={(v) => savePartial.mutate({ agentTaskRouterMode: v as 'task-router-only' | 'frontmatter-override' })}
    pending={savePartial.isPending}
  />
</div>
```

Add the shared `savePartial` mutation just below `saveLanguage`:

```tsx
const savePartial = useMutation({
  mutationFn: async (patch: Partial<AppSettings>) => {
    const res = await apiFetch<AppSettings>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return res;
  },
  onSuccess: (data) => {
    queryClient.setQueryData(['settings'], data);
  },
});
```

Add the two helper components at the bottom of the file (still inside the same module):

```tsx
function NumberSettingRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onSave: (v: number) => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState<string>(String(props.value));
  useEffect(() => { setDraft(String(props.value)); }, [props.value]);
  const parsed = Number(draft);
  const valid = Number.isFinite(parsed) && parsed >= props.min && parsed <= props.max;
  return (
    <div className="flex items-center gap-2">
      <label className="flex-1 text-sm">{props.label}</label>
      <input
        type="number"
        className="border rounded px-2 py-1 w-32"
        value={draft}
        min={props.min}
        max={props.max}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        className="px-3 py-1 border rounded disabled:opacity-50"
        disabled={!valid || props.pending || parsed === props.value}
        onClick={() => props.onSave(parsed)}
      >Save</button>
    </div>
  );
}

function SelectSettingRow<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex-1 text-sm">{props.label}</label>
      <select
        className="border rounded px-2 py-1"
        value={props.value}
        disabled={props.pending}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {props.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
```

Add the necessary imports at the top of the file:

```tsx
import { useState, useEffect } from 'react';
import type { AppSettings } from '@/lib/contracts';
```

(If `useState` / `useEffect` are already imported, leave the existing import.)

- [ ] **Step 3: Manual smoke test**

Run:
```bash
npm run dev
```

Open the app, click the settings gear, scroll to "Agents", change "Max steps per agent" to 30, click Save. Refresh the page. Expected: still shows 30. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/settings-dialog.tsx
git commit -m "feat(ui): add Agents section to settings dialog (5 controls)"
```

---

## Task 5: Define agent runtime types

**Files:**
- Create: `src/server/agents/types.ts`

- [ ] **Step 1: Write `types.ts`**

Create `src/server/agents/types.ts`:

```ts
import type { ZodSchema } from 'zod';
import type { Job, Subject, ChangesetEntry } from '@/lib/contracts';

export interface AgentBudget {
  maxSteps: number;
  maxTokensPerJob: number;
  maxParallelSubAgents: number;
}

export interface SkillModelOverride {
  profile?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  tools: string[];
  canDispatch: string[];
  systemPrompt: string;
  outputSchema?: ZodSchema;
  model?: SkillModelOverride;
  budget?: Partial<AgentBudget>;
}

export type ToolSource = 'builtin' | 'mcp' | 'dispatch';
export type ToolSideEffect = 'none' | 'commit';

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  source: ToolSource;
  description: string;
  inputSchema: ZodSchema<I>;
  outputSchema: ZodSchema<O>;
  sideEffect: ToolSideEffect;
  handler: (input: I, ctx: AgentContext) => Promise<O>;
}

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'budget-exceeded';

export interface AgentRun {
  id: string;
  jobId: string;
  subjectId: string;
  parentRunId: string | null;
  skillId: string;
  status: AgentRunStatus;
  startedAt: number;
  endedAt?: number;
  tokensUsed: number;
  stepCount: number;
}

export type AgentStep =
  | { kind: 'thinking'; runId: string; index: number; text: string; tokensIn: number; tokensOut: number }
  | { kind: 'tool-call'; runId: string; index: number; tool: string; input: unknown; output: unknown; durationMs: number; tokensIn?: number; tokensOut?: number; error?: string }
  | { kind: 'sub-agent-dispatch'; runId: string; index: number; childRunId: string; skillId: string }
  | { kind: 'final'; runId: string; index: number; output: unknown; tokensIn: number; tokensOut: number };

export interface PendingChangeset {
  entries: ChangesetEntry[];
}

export interface AgentContext {
  job: Job;
  subject: Subject;
  emit: (eventType: string, message: string, data?: Record<string, unknown>) => void;
  budget: BudgetTracker;
  overlay: OverlayVault;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  rootRunId: string;
  parentRunId: string | null;
  cancelled: () => boolean;
  committed: { value: boolean };
  pending: PendingChangeset;
  /** Snapshot from settings-repo, captured at root-run start. */
  budgetSnapshot: AgentBudget;
}

// Forward-declared interfaces; concrete classes live in their own files.
export interface BudgetTracker {
  chargeStep(): void;
  chargeTokens(n: number): void;
  assertWithin(): void;
  readonly stepCount: number;
  readonly tokensUsed: number;
}

export interface OverlayVault {
  readPage(subjectSlug: string, slug: string): Promise<{ markdown: string } | null>;
  search(subjectSlug: string, query: string): Promise<Array<{ slug: string; title: string; summary: string; source: 'overlay' | 'store' }>>;
  putEntries(entries: ChangesetEntry[]): void;
  snapshot(): OverlayVault;
}

export interface ToolRegistry {
  register(tool: ToolDef): void;
  resolve(skillTools: string[]): ToolDef[];
  get(name: string): ToolDef | undefined;
}

export interface SkillRegistry {
  get(id: string): SkillTemplate | undefined;
  list(): SkillTemplate[];
  degraded(): Array<{ skillId: string; errors: string[] }>;
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/types.ts
git commit -m "feat(agents): define core runtime types"
```

---

## Task 6: Implement BudgetTracker

**Files:**
- Create: `src/server/agents/runtime/budget.ts`
- Create: `src/server/agents/runtime/__tests__/budget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/agents/runtime/__tests__/budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createBudgetTracker, BudgetExceededError } from '../budget';

describe('BudgetTracker', () => {
  it('counts steps and tokens', () => {
    const b = createBudgetTracker({ maxSteps: 3, maxTokensPerJob: 1000, maxParallelSubAgents: 2 });
    b.chargeStep();
    b.chargeTokens(100);
    expect(b.stepCount).toBe(1);
    expect(b.tokensUsed).toBe(100);
  });

  it('throws BudgetExceededError after maxSteps', () => {
    const b = createBudgetTracker({ maxSteps: 2, maxTokensPerJob: 1_000_000, maxParallelSubAgents: 1 });
    b.chargeStep();
    b.chargeStep();
    b.assertWithin();
    b.chargeStep();
    expect(() => b.assertWithin()).toThrow(BudgetExceededError);
    try {
      b.assertWithin();
    } catch (e) {
      expect((e as BudgetExceededError).limit).toBe('maxSteps');
      expect((e as BudgetExceededError).actual).toBe(3);
    }
  });

  it('throws BudgetExceededError after maxTokensPerJob', () => {
    const b = createBudgetTracker({ maxSteps: 100, maxTokensPerJob: 500, maxParallelSubAgents: 1 });
    b.chargeTokens(300);
    b.chargeTokens(300);
    expect(() => b.assertWithin()).toThrow(BudgetExceededError);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run:
```bash
npx vitest run src/server/agents/runtime/__tests__/budget.test.ts
```

Expected: FAIL — module `../budget` not found.

- [ ] **Step 3: Implement `budget.ts`**

Create `src/server/agents/runtime/budget.ts`:

```ts
import type { AgentBudget, BudgetTracker } from '../types';

export class BudgetExceededError extends Error {
  constructor(
    public readonly limit: 'maxSteps' | 'maxTokensPerJob',
    public readonly actual: number,
    public readonly cap: number,
  ) {
    super(`Agent budget exceeded: ${limit}=${actual}/${cap}`);
    this.name = 'BudgetExceededError';
  }
}

export function createBudgetTracker(budget: AgentBudget): BudgetTracker {
  let stepCount = 0;
  let tokensUsed = 0;
  return {
    chargeStep() { stepCount += 1; },
    chargeTokens(n) { tokensUsed += Math.max(0, n | 0); },
    assertWithin() {
      if (stepCount > budget.maxSteps) {
        throw new BudgetExceededError('maxSteps', stepCount, budget.maxSteps);
      }
      if (tokensUsed > budget.maxTokensPerJob) {
        throw new BudgetExceededError('maxTokensPerJob', tokensUsed, budget.maxTokensPerJob);
      }
    },
    get stepCount() { return stepCount; },
    get tokensUsed() { return tokensUsed; },
  };
}
```

- [ ] **Step 4: Run test (expect pass)**

Run:
```bash
npx vitest run src/server/agents/runtime/__tests__/budget.test.ts
```

Expected: PASS — all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/runtime/budget.ts src/server/agents/runtime/__tests__/budget.test.ts
git commit -m "feat(agents): BudgetTracker enforcing maxSteps / maxTokensPerJob"
```

---

## Task 7: Implement OverlayVault

**Files:**
- Create: `src/server/agents/runtime/overlay-vault.ts`
- Create: `src/server/agents/runtime/__tests__/overlay-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/agents/runtime/__tests__/overlay-vault.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createOverlayVault } from '../overlay-vault';
import type { ChangesetEntry } from '@/lib/contracts';

const fakeStore = {
  readPageInSubject: vi.fn(),
  scanWikiPages: vi.fn(),
};

vi.mock('../../../wiki/wiki-store', () => ({
  readPageInSubject: (...a: unknown[]) => fakeStore.readPageInSubject(...a),
  scanWikiPages: (...a: unknown[]) => fakeStore.scanWikiPages(...a),
}));

describe('OverlayVault', () => {
  it('reads from overlay first, falls back to store', async () => {
    fakeStore.readPageInSubject.mockReturnValue({ document: { content: 'on disk' } });
    const overlay = createOverlayVault({ subjectSlug: 'general' });
    expect(await overlay.readPage('general', 'foo')).toEqual({ markdown: 'on disk' });

    overlay.putEntries([
      { action: 'create', path: 'wiki/general/foo.md', content: '---\ntitle: Foo\n---\nfrom overlay' },
    ] as ChangesetEntry[]);
    const result = await overlay.readPage('general', 'foo');
    expect(result?.markdown).toContain('from overlay');
  });

  it('snapshot freezes overlay state', async () => {
    const overlay = createOverlayVault({ subjectSlug: 'general' });
    overlay.putEntries([{ action: 'create', path: 'wiki/general/a.md', content: '---\ntitle: A\n---\nA1' }] as ChangesetEntry[]);
    const snap = overlay.snapshot();
    overlay.putEntries([{ action: 'create', path: 'wiki/general/b.md', content: '---\ntitle: B\n---\nB1' }] as ChangesetEntry[]);
    expect(await snap.readPage('general', 'b')).toBeNull();
    expect((await snap.readPage('general', 'a'))?.markdown).toContain('A1');
  });

  it('search merges overlay entries with store hits', async () => {
    fakeStore.scanWikiPages.mockReturnValue([
      { slug: 'foo', title: 'Foo', summary: 'from store', subject: { slug: 'general' } },
    ]);
    const overlay = createOverlayVault({ subjectSlug: 'general' });
    overlay.putEntries([
      { action: 'create', path: 'wiki/general/bar.md', content: '---\ntitle: Bar\nsummary: overlay summary\n---\nbody' },
    ] as ChangesetEntry[]);
    const results = await overlay.search('general', 'summary');
    const slugs = results.map(r => r.slug).sort();
    expect(slugs).toEqual(['bar', 'foo']);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run:
```bash
npx vitest run src/server/agents/runtime/__tests__/overlay-vault.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `overlay-vault.ts`**

Create `src/server/agents/runtime/overlay-vault.ts`:

```ts
import matter from 'gray-matter';
import type { ChangesetEntry } from '@/lib/contracts';
import type { OverlayVault } from '../types';
import { readPageInSubject, scanWikiPages } from '../../wiki/wiki-store';

interface OverlayEntry {
  subjectSlug: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  raw: string;
  deleted: boolean;
}

function pathToSubjectSlug(path: string): { subjectSlug: string; slug: string } | null {
  const m = path.match(/^wiki\/([^/]+)\/(.+?)\.md$/);
  if (!m) return null;
  return { subjectSlug: m[1], slug: m[2] };
}

function entryToOverlay(entry: ChangesetEntry): OverlayEntry | null {
  const parts = pathToSubjectSlug(entry.path);
  if (!parts) return null;
  if (entry.action === 'delete') {
    return {
      subjectSlug: parts.subjectSlug,
      slug: parts.slug,
      title: '',
      summary: '',
      body: '',
      raw: '',
      deleted: true,
    };
  }
  const parsed = matter(entry.content);
  return {
    subjectSlug: parts.subjectSlug,
    slug: parts.slug,
    title: typeof parsed.data.title === 'string' ? parsed.data.title : parts.slug,
    summary: typeof parsed.data.summary === 'string' ? parsed.data.summary : '',
    body: parsed.content,
    raw: entry.content,
    deleted: false,
  };
}

export function createOverlayVault(opts: { subjectSlug: string }): OverlayVault {
  const entries = new Map<string, OverlayEntry>();
  const key = (subjectSlug: string, slug: string) => `${subjectSlug}::${slug}`;

  const overlay: OverlayVault = {
    async readPage(subjectSlug, slug) {
      const o = entries.get(key(subjectSlug, slug));
      if (o) return o.deleted ? null : { markdown: o.raw };
      const result = readPageInSubject(subjectSlug, slug);
      return result ? { markdown: typeof result === 'object' && 'document' in result ? (result as { document: { content: string } }).document.content : String(result) } : null;
    },
    async search(subjectSlug, query) {
      const q = query.toLowerCase();
      const overlayHits: Array<{ slug: string; title: string; summary: string; source: 'overlay' | 'store' }> = [];
      for (const o of entries.values()) {
        if (o.subjectSlug !== subjectSlug || o.deleted) continue;
        const hay = `${o.title} ${o.summary} ${o.body}`.toLowerCase();
        if (hay.includes(q)) {
          overlayHits.push({ slug: o.slug, title: o.title, summary: o.summary, source: 'overlay' });
        }
      }
      const storeHits = (scanWikiPages(subjectSlug) as Array<{ slug: string; title: string; summary?: string }>).filter(p => {
        if (entries.has(key(subjectSlug, p.slug))) return false;
        const hay = `${p.title} ${p.summary ?? ''}`.toLowerCase();
        return hay.includes(q);
      }).map(p => ({ slug: p.slug, title: p.title, summary: p.summary ?? '', source: 'store' as const }));
      return [...overlayHits, ...storeHits];
    },
    putEntries(es) {
      for (const e of es) {
        const o = entryToOverlay(e);
        if (o) entries.set(key(o.subjectSlug, o.slug), o);
      }
    },
    snapshot() {
      const frozen = createOverlayVault(opts);
      for (const [k, v] of entries) {
        (frozen as unknown as { _entries: Map<string, OverlayEntry> })._entries?.set(k, v);
      }
      // Re-construct with frozen entries: simplest path is to copy via putEntries' raw form
      // We rebuild via re-entry to keep encapsulation clean:
      const snap = createOverlayVault(opts);
      const copyTarget = snap as unknown as { _hydrate?: (m: Map<string, OverlayEntry>) => void };
      // Use a hidden hydrate via re-running putEntries: build synthetic ChangesetEntry list
      const synth: ChangesetEntry[] = [];
      for (const v of entries.values()) {
        if (v.deleted) {
          synth.push({ action: 'delete', path: `wiki/${v.subjectSlug}/${v.slug}.md`, content: '' });
        } else {
          synth.push({ action: 'create', path: `wiki/${v.subjectSlug}/${v.slug}.md`, content: v.raw });
        }
      }
      snap.putEntries(synth);
      return snap;
    },
  };
  return overlay;
}
```

- [ ] **Step 4: Run test (expect pass)**

Run:
```bash
npx vitest run src/server/agents/runtime/__tests__/overlay-vault.test.ts
```

Expected: PASS — all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/runtime/overlay-vault.ts src/server/agents/runtime/__tests__/overlay-vault.test.ts
git commit -m "feat(agents): OverlayVault with snapshot + search merge"
```

---

## Task 8: Skill frontmatter schema + loader

**Files:**
- Create: `src/server/agents/skills/schema.ts`
- Create: `src/server/agents/skills/loader.ts`
- Create: `src/server/agents/skills/__tests__/loader.test.ts`

- [ ] **Step 1: Write `schema.ts`**

Create `src/server/agents/skills/schema.ts`:

```ts
import { z } from 'zod';

export const SkillModelSchema = z.object({
  profile: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
}).strict();

export const SkillBudgetSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}).strict();

export const SkillFrontmatterSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive(),
  tools: z.array(z.string()).default([]),
  canDispatch: z.array(z.string()).default([]),
  model: SkillModelSchema.optional(),
  outputSchema: z.string().optional(),
  budget: SkillBudgetSchema.optional(),
}).strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
```

- [ ] **Step 2: Write the failing tests**

Create `src/server/agents/skills/__tests__/loader.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillsFromDir } from '../loader';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'skill-loader-'));
}

describe('loader', () => {
  it('parses a valid skill', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'planner.md'), [
      '---',
      'id: planner',
      'name: Planner',
      'description: Plans pages',
      'version: 1',
      'tools: [vault.read]',
      'canDispatch: []',
      '---',
      '',
      '# System',
      'Hello',
      '',
    ].join('\n'));
    const { skills, degraded } = await loadSkillsFromDir(dir);
    expect(degraded).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('planner');
    expect(skills[0].systemPrompt.trim()).toContain('# System');
  });

  it('rejects id mismatch with filename', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'planner.md'), [
      '---',
      'id: not-planner',
      'name: X',
      'description: x',
      'version: 1',
      '---',
      'body',
    ].join('\n'));
    const { skills, degraded } = await loadSkillsFromDir(dir);
    expect(skills).toEqual([]);
    expect(degraded).toHaveLength(1);
    expect(degraded[0].errors[0]).toMatch(/filename/i);
  });

  it('compiles outputSchema JSON-Schema string into a zod schema', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'writer.md'), [
      '---',
      'id: writer',
      'name: W',
      'description: w',
      'version: 1',
      'outputSchema: |',
      '  { "type": "object", "properties": { "x": { "type": "number" } }, "required": ["x"] }',
      '---',
      'body',
    ].join('\n'));
    const { skills, degraded } = await loadSkillsFromDir(dir);
    expect(degraded).toEqual([]);
    expect(skills[0].outputSchema).toBeDefined();
    const parse = skills[0].outputSchema!.safeParse({ x: 1 });
    expect(parse.success).toBe(true);
    const fail = skills[0].outputSchema!.safeParse({ x: 'no' });
    expect(fail.success).toBe(false);
  });

  it('reports unknown frontmatter keys as degraded', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'extra.md'), [
      '---',
      'id: extra',
      'name: X',
      'description: x',
      'version: 1',
      'someUnknownField: yes',
      '---',
      'body',
    ].join('\n'));
    const { skills, degraded } = await loadSkillsFromDir(dir);
    expect(skills).toEqual([]);
    expect(degraded).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test (expect fail)**

Run:
```bash
npx vitest run src/server/agents/skills/__tests__/loader.test.ts
```

Expected: FAIL — `../loader` not found.

- [ ] **Step 4: Implement `loader.ts`**

Create `src/server/agents/skills/loader.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { jsonSchemaToZod } from 'zod-from-json-schema';
import { SkillFrontmatterSchema } from './schema';
import type { SkillTemplate } from '../types';

export interface LoadResult {
  skills: SkillTemplate[];
  degraded: Array<{ skillId: string; errors: string[] }>;
}

export async function loadSkillsFromDir(dir: string): Promise<LoadResult> {
  const skills: SkillTemplate[] = [];
  const degraded: Array<{ skillId: string; errors: string[] }> = [];

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return { skills, degraded };
  }

  for (const entry of entries) {
    if (extname(entry) !== '.md') continue;
    const path = join(dir, entry);
    const filenameId = basename(entry, '.md');
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      degraded.push({ skillId: filenameId, errors: [`Could not read file: ${(e as Error).message}`] });
      continue;
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch (e) {
      degraded.push({ skillId: filenameId, errors: [`Frontmatter parse error: ${(e as Error).message}`] });
      continue;
    }

    const frontmatter = SkillFrontmatterSchema.safeParse(parsed.data);
    if (!frontmatter.success) {
      degraded.push({ skillId: filenameId, errors: frontmatter.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
      continue;
    }

    if (frontmatter.data.id !== filenameId) {
      degraded.push({
        skillId: filenameId,
        errors: [`id "${frontmatter.data.id}" does not match filename "${filenameId}"`],
      });
      continue;
    }

    let outputSchema: z.ZodSchema | undefined;
    if (frontmatter.data.outputSchema) {
      try {
        const json = JSON.parse(frontmatter.data.outputSchema);
        outputSchema = jsonSchemaToZod(json) as z.ZodSchema;
      } catch (e) {
        degraded.push({ skillId: filenameId, errors: [`outputSchema invalid: ${(e as Error).message}`] });
        continue;
      }
    }

    skills.push({
      id: frontmatter.data.id,
      name: frontmatter.data.name,
      description: frontmatter.data.description,
      version: frontmatter.data.version,
      tools: frontmatter.data.tools,
      canDispatch: frontmatter.data.canDispatch,
      systemPrompt: parsed.content,
      outputSchema,
      model: frontmatter.data.model,
      budget: frontmatter.data.budget
        ? {
            maxSteps: frontmatter.data.budget.maxSteps,
            maxTokensPerJob: frontmatter.data.budget.maxTokens,
          }
        : undefined,
    });
  }

  return { skills, degraded };
}
```

- [ ] **Step 5: Run test (expect pass)**

Run:
```bash
npx vitest run src/server/agents/skills/__tests__/loader.test.ts
```

Expected: PASS — all 4 cases.

- [ ] **Step 6: Commit**

```bash
git add src/server/agents/skills/schema.ts src/server/agents/skills/loader.ts src/server/agents/skills/__tests__/loader.test.ts
git commit -m "feat(agents): skill loader (markdown + frontmatter + JSON-Schema → zod)"
```

---

## Task 9: Skill registry

**Files:**
- Create: `src/server/agents/skills/registry.ts`

- [ ] **Step 1: Write `registry.ts`**

Create `src/server/agents/skills/registry.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillRegistry, SkillTemplate } from '../types';
import { loadSkillsFromDir } from './loader';

export interface SkillRegistryHandle extends SkillRegistry {
  readonly loadedAt: number;
}

export async function buildSkillRegistry(opts: {
  vaultDir: string;
  examplesDir: string;
}): Promise<SkillRegistryHandle> {
  const skillsDir = join(opts.vaultDir, '.llm-wiki', 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }
  // Seed examples — never overwrite existing files.
  if (existsSync(opts.examplesDir)) {
    for (const entry of readdirSync(opts.examplesDir)) {
      if (!entry.endsWith('.md')) continue;
      const src = join(opts.examplesDir, entry);
      const dst = join(skillsDir, entry);
      if (!existsSync(dst)) copyFileSync(src, dst);
    }
  }

  const { skills, degraded } = await loadSkillsFromDir(skillsDir);
  const map = new Map<string, SkillTemplate>();
  for (const s of skills) map.set(s.id, s);

  return {
    loadedAt: Date.now(),
    get(id) { return map.get(id); },
    list() { return Array.from(map.values()); },
    degraded() { return degraded; },
  };
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/skills/registry.ts
git commit -m "feat(agents): skill registry with examples seeding"
```

---

## Task 10: Tool registry + dispatch-skill stub

**Files:**
- Create: `src/server/agents/tools/registry.ts`
- Create: `src/server/agents/tools/builtin/dispatch-skill.ts`

- [ ] **Step 1: Write `registry.ts`**

Create `src/server/agents/tools/registry.ts`:

```ts
import type { ToolDef, ToolRegistry } from '../types';

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDef>();

  function matches(pattern: string, name: string): boolean {
    if (pattern === '*') return true;
    if (pattern === name) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return name === prefix || name.startsWith(prefix + '.');
    }
    return false;
  }

  return {
    register(tool) {
      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      tools.set(tool.name, tool);
    },
    resolve(skillTools) {
      if (!skillTools.length) return [];
      const out: ToolDef[] = [];
      for (const tool of tools.values()) {
        if (skillTools.some(p => matches(p, tool.name))) out.push(tool);
      }
      return out;
    },
    get(name) { return tools.get(name); },
  };
}
```

- [ ] **Step 2: Write `dispatch-skill.ts`**

Create `src/server/agents/tools/builtin/dispatch-skill.ts`:

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  skillId: z.string(),
  input: z.unknown(),
});
const OutputSchema = z.object({
  output: z.unknown(),
});

/**
 * Phase 1 placeholder. Dynamic dispatch is implemented in orchestrator;
 * this tool wires LLM-driven sub-agent calls into the same code path. Phase 1
 * has no skill that whitelists this tool.
 */
export const dispatchSkillTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'dispatch.skill',
  source: 'dispatch',
  description: 'Dispatch a sub-agent skill (advanced; Phase 2).',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    if (!ctx.skillRegistry.get(input.skillId)) {
      throw new Error(`Unknown skill: ${input.skillId}`);
    }
    // Real implementation lands in orchestrator.runSingle; for Phase 1, callers
    // never reach this code path because no skill whitelists 'dispatch.skill'.
    throw new Error('dispatch.skill is reserved for Phase 2 dynamic topology');
  },
};
```

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/tools/registry.ts src/server/agents/tools/builtin/dispatch-skill.ts
git commit -m "feat(agents): tool registry + dispatch-skill stub"
```

---

## Task 11: Built-in vault tools (read + search)

**Files:**
- Create: `src/server/agents/tools/builtin/vault-read.ts`
- Create: `src/server/agents/tools/builtin/vault-search.ts`

- [ ] **Step 1: Write `vault-read.ts`**

Create `src/server/agents/tools/builtin/vault-read.ts`:

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  slug: z.string(),
  subjectSlug: z.string().optional(),
});
const OutputSchema = z.object({
  found: z.boolean(),
  markdown: z.string().nullable(),
});

export const vaultReadTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'vault.read',
  source: 'builtin',
  description: 'Read a wiki page by slug. Returns null when the page does not exist. Includes pages staged in the current job.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    const subjectSlug = input.subjectSlug ?? ctx.subject.slug;
    const result = await ctx.overlay.readPage(subjectSlug, input.slug);
    return { found: result !== null, markdown: result ? result.markdown : null };
  },
};
```

- [ ] **Step 2: Write `vault-search.ts`**

Create `src/server/agents/tools/builtin/vault-search.ts`:

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  query: z.string().min(1),
  subjectSlug: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
});
const HitSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  source: z.enum(['overlay', 'store']),
});
const OutputSchema = z.object({ hits: z.array(HitSchema) });

export const vaultSearchTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'vault.search',
  source: 'builtin',
  description: 'Search wiki pages by keyword. Includes pages staged in the current job (marked source="overlay").',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    const subjectSlug = input.subjectSlug ?? ctx.subject.slug;
    const limit = input.limit ?? 10;
    const all = await ctx.overlay.search(subjectSlug, input.query);
    return { hits: all.slice(0, limit) };
  },
};
```

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/tools/builtin/vault-read.ts src/server/agents/tools/builtin/vault-search.ts
git commit -m "feat(agents): vault.read + vault.search builtin tools"
```

---

## Task 12: commit-changeset tool

**Files:**
- Create: `src/server/agents/tools/builtin/commit-changeset.ts`
- Create: `src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../../types';
import { commitChangesetTool } from '../commit-changeset';

vi.mock('../../../../wiki/wiki-transaction', () => ({
  createChangeset: vi.fn(async (jobId, subject, entries) => ({ id: 'cs-1', jobId, subject, entries, preHead: 'pre', postHead: null, status: 'pending' })),
  validateChangeset: vi.fn(async () => undefined),
  applyChangeset: vi.fn(async () => ({ commitSha: 'sha-1', pagesCreated: ['a'], pagesUpdated: [], linksAdded: 0 })),
  rollbackChangeset: vi.fn(async () => undefined),
}));

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    job: { id: 'j1', subjectId: 's1' } as AgentContext['job'],
    subject: { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeStep: vi.fn(), chargeTokens: vi.fn(), assertWithin: vi.fn(), stepCount: 0, tokensUsed: 0 },
    overlay: { readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn(), snapshot: vi.fn() } as unknown as AgentContext['overlay'],
    toolRegistry: { register: vi.fn(), resolve: vi.fn(), get: vi.fn() },
    skillRegistry: { get: vi.fn(), list: vi.fn(), degraded: vi.fn() },
    rootRunId: 'r1',
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 500_000, maxParallelSubAgents: 3 },
    ...overrides,
  } as AgentContext;
}

describe('commit-changeset', () => {
  it('commits once and flips ctx.committed', async () => {
    const ctx = makeCtx();
    const result = await commitChangesetTool.handler({
      entries: [{ action: 'create', path: 'wiki/general/a.md', content: 'x' }],
      summary: 'add a',
    }, ctx);
    expect(result.commitSha).toBe('sha-1');
    expect(ctx.committed.value).toBe(true);
  });

  it('throws on second invocation', async () => {
    const ctx = makeCtx({ committed: { value: true } });
    await expect(commitChangesetTool.handler({
      entries: [{ action: 'create', path: 'wiki/general/a.md', content: 'x' }],
      summary: 'a',
    }, ctx)).rejects.toThrow(/already invoked/);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run:
```bash
npx vitest run src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commit-changeset.ts`**

Create `src/server/agents/tools/builtin/commit-changeset.ts`:

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '../../../wiki/wiki-transaction';

const ChangesetEntryInputSchema = z.object({
  action: z.enum(['create', 'update', 'delete']),
  path: z.string().min(1),
  content: z.string(),
});

const InputSchema = z.object({
  entries: z.array(ChangesetEntryInputSchema).min(1),
  summary: z.string().min(1),
});

const OutputSchema = z.object({
  commitSha: z.string(),
  pagesCreated: z.array(z.string()),
  pagesUpdated: z.array(z.string()),
  linksAdded: z.number().int().nonnegative(),
});

export const commitChangesetTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'commit_changeset',
  source: 'builtin',
  description: 'Persist accumulated wiki page changes to disk + git in a single atomic commit. Can only be called once per job; call this last.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'commit',
  async handler(input, ctx) {
    if (ctx.committed.value) {
      throw new Error('commit_changeset already invoked in this run');
    }
    const changeset = await createChangeset(ctx.job.id, ctx.subject, input.entries);
    await validateChangeset(changeset);
    const result = await applyChangeset(changeset, { commitMessage: input.summary });
    ctx.committed.value = true;
    ctx.emit('ingest:committing', `Committed ${result.pagesCreated.length + result.pagesUpdated.length} pages`, {
      commitSha: result.commitSha,
      pagesCreated: result.pagesCreated,
      pagesUpdated: result.pagesUpdated,
    });
    return {
      commitSha: result.commitSha,
      pagesCreated: result.pagesCreated,
      pagesUpdated: result.pagesUpdated,
      linksAdded: result.linksAdded,
    };
  },
};
```

> **Note:** `applyChangeset`'s real signature may differ (e.g. additional options). When implementing, run `npx tsc --noEmit` and adjust the call to match. Do NOT change the public Saga interface.

- [ ] **Step 4: Run test (expect pass)**

Run:
```bash
npx vitest run src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts
```

Expected: PASS — both cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/tools/builtin/commit-changeset.ts src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts
git commit -m "feat(agents): commit_changeset tool routes through Saga"
```

---

## Task 13: MCP config schema + transport

**Files:**
- Create: `mcp-config.example.json`
- Create: `src/server/agents/tools/mcp/config.ts`
- Create: `src/server/agents/tools/mcp/transport.ts`

- [ ] **Step 1: Write `mcp-config.example.json`**

Create `mcp-config.example.json` (peer of `llm-config.example.json`):

```json
{
  "$schema": "https://modelcontextprotocol.io/schemas/server.json",
  "version": 1,
  "servers": {
    "fetch": {
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    },
    "context7": {
      "transport": "streamable-http",
      "url": "https://mcp.context7.com/mcp"
    }
  }
}
```

- [ ] **Step 2: Write `config.ts`**

Create `src/server/agents/tools/mcp/config.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

const StdioServer = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

const HttpServer = z.object({
  transport: z.literal('streamable-http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const ServerSchema = z.discriminatedUnion('transport', [StdioServer, HttpServer]);

export const McpConfigSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), ServerSchema).default({}),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;
export type McpServerConfig = z.infer<typeof ServerSchema>;

export function loadMcpConfig(path: string): McpConfig {
  if (!existsSync(path)) {
    return { version: 1, servers: {} };
  }
  const raw = readFileSync(path, 'utf8');
  return McpConfigSchema.parse(JSON.parse(raw));
}
```

- [ ] **Step 3: Write `transport.ts`**

Create `src/server/agents/tools/mcp/transport.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './config';

export interface McpClientHandle {
  client: Client;
  close: () => Promise<void>;
}

export async function connectServer(serverId: string, cfg: McpServerConfig): Promise<McpClientHandle> {
  const client = new Client({ name: `agentic-wiki:${serverId}`, version: '1.0.0' }, { capabilities: {} });

  if (cfg.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
    });
    await client.connect(transport);
    return {
      client,
      close: async () => { await transport.close(); },
    };
  }

  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers: cfg.headers },
  });
  await client.connect(transport);
  return {
    client,
    close: async () => { await transport.close(); },
  };
}
```

- [ ] **Step 4: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: clean. If `@modelcontextprotocol/sdk` import paths differ in the installed version, adjust them — do not stub.

- [ ] **Step 5: Commit**

```bash
git add mcp-config.example.json src/server/agents/tools/mcp/config.ts src/server/agents/tools/mcp/transport.ts
git commit -m "feat(agents): MCP config schema + stdio/http transports"
```

---

## Task 14: MCP client pool + tool bridge

**Files:**
- Create: `src/server/agents/tools/mcp/client-pool.ts`
- Create: `src/server/agents/tools/mcp/tool-bridge.ts`

- [ ] **Step 1: Write `tool-bridge.ts`**

Create `src/server/agents/tools/mcp/tool-bridge.ts`:

```ts
import { z } from 'zod';
import { jsonSchemaToZod } from 'zod-from-json-schema';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDef } from '../../types';

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export async function bridgeServerTools(
  serverId: string,
  client: Client,
): Promise<ToolDef[]> {
  const list = await client.listTools();
  const out: ToolDef[] = [];
  for (const tool of list.tools as McpToolDescriptor[]) {
    let inputSchema: z.ZodSchema;
    try {
      inputSchema = jsonSchemaToZod(tool.inputSchema as object) as z.ZodSchema;
    } catch {
      inputSchema = z.record(z.string(), z.unknown());
    }
    const def: ToolDef = {
      name: `mcp.${serverId}.${tool.name}`,
      source: 'mcp',
      description: tool.description ?? `MCP tool ${serverId}/${tool.name}`,
      inputSchema,
      outputSchema: z.unknown() as z.ZodSchema,
      sideEffect: 'none',
      async handler(input) {
        const result = await client.callTool({ name: tool.name, arguments: input as Record<string, unknown> });
        return result.content;
      },
    };
    out.push(def);
  }
  return out;
}
```

- [ ] **Step 2: Write `client-pool.ts`**

Create `src/server/agents/tools/mcp/client-pool.ts`:

```ts
import type { ToolDef, ToolRegistry } from '../../types';
import { connectServer, type McpClientHandle } from './transport';
import { bridgeServerTools } from './tool-bridge';
import type { McpConfig, McpServerConfig } from './config';
import type { AgentMcpLifecycle } from '@/lib/contracts';

interface PoolEntry {
  handle: McpClientHandle | null;
  tools: ToolDef[];
  status: 'cold' | 'connecting' | 'ready' | 'dead';
  error?: string;
}

export interface McpPool {
  registerToolPlaceholders(registry: ToolRegistry): void;
  startEager(): Promise<void>;
  closeAfterJob(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createMcpPool(opts: {
  config: McpConfig;
  lifecycle: AgentMcpLifecycle;
  toolRegistry: ToolRegistry;
}): McpPool {
  const entries = new Map<string, PoolEntry>();
  for (const serverId of Object.keys(opts.config.servers)) {
    entries.set(serverId, { handle: null, tools: [], status: 'cold' });
  }

  async function ensureConnected(serverId: string, cfg: McpServerConfig): Promise<PoolEntry> {
    const entry = entries.get(serverId)!;
    if (entry.status === 'ready') return entry;
    if (entry.status === 'connecting') {
      // Simple wait loop. (Production: replace with shared promise.)
      while (entry.status === 'connecting') await new Promise(r => setTimeout(r, 25));
      return entry;
    }
    entry.status = 'connecting';
    try {
      const handle = await connectServer(serverId, cfg);
      const tools = await bridgeServerTools(serverId, handle.client);
      entry.handle = handle;
      entry.tools = tools;
      entry.status = 'ready';
      for (const t of tools) {
        try { opts.toolRegistry.register(t); } catch { /* already registered: keep latest */ }
      }
    } catch (e) {
      entry.status = 'dead';
      entry.error = (e as Error).message;
    }
    return entry;
  }

  function makeProxyTool(serverId: string, cfg: McpServerConfig, name: string): ToolDef {
    return {
      name,
      source: 'mcp',
      description: `MCP tool from server "${serverId}" (lazy)`,
      inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) } as unknown as ToolDef['inputSchema'],
      outputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) } as unknown as ToolDef['outputSchema'],
      sideEffect: 'none',
      async handler(input) {
        const entry = await ensureConnected(serverId, cfg);
        if (entry.status === 'dead' || !entry.handle) {
          throw new Error(`MCP server "${serverId}" unavailable: ${entry.error ?? 'unknown'}`);
        }
        const real = entry.tools.find(t => t.name === name);
        if (!real) {
          throw new Error(`MCP server "${serverId}" did not advertise tool ${name}`);
        }
        return real.handler(input, undefined as never);
      },
    };
  }

  return {
    registerToolPlaceholders(registry) {
      // Lazy/per-job: at boot we don't know each server's tool list. We register
      // a single namespace placeholder per server so skills can pattern-match
      // 'mcp.<server>.*'. Real ToolDefs are added at first acquire.
      for (const [serverId, cfg] of Object.entries(opts.config.servers)) {
        const proxyName = `mcp.${serverId}.__namespace__`;
        try {
          registry.register(makeProxyTool(serverId, cfg, proxyName));
        } catch { /* duplicate */ }
      }
    },
    async startEager() {
      if (opts.lifecycle !== 'eager') return;
      await Promise.all(Object.entries(opts.config.servers).map(([id, cfg]) => ensureConnected(id, cfg)));
    },
    async closeAfterJob() {
      if (opts.lifecycle !== 'per-job') return;
      for (const [, entry] of entries) {
        if (entry.handle) {
          try { await entry.handle.close(); } catch { /* ignore */ }
          entry.handle = null;
          entry.status = 'cold';
          entry.tools = [];
        }
      }
    },
    async shutdown() {
      for (const [, entry] of entries) {
        if (entry.handle) {
          try { await entry.handle.close(); } catch { /* ignore */ }
        }
      }
      entries.clear();
    },
  };
}
```

> **Note:** The proxy approach above means each MCP server contributes ONE namespace placeholder until a job actually invokes it. For Phase 1 this is acceptable because `ingest` skills do not include MCP tools in their whitelist; the runtime only needs to wire the registry. If a Phase-2 skill whitelists `mcp.fetch.*`, the agent loop must call `pool.ensureConnected()` first — see Task 15's note.

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/tools/mcp/client-pool.ts src/server/agents/tools/mcp/tool-bridge.ts
git commit -m "feat(agents): MCP client pool with eager/lazy/per-job lifecycle"
```

---

## Task 15: Agent loop

**Files:**
- Create: `src/server/agents/runtime/agent-loop.ts`

- [ ] **Step 1: Write `agent-loop.ts`**

Create `src/server/agents/runtime/agent-loop.ts`:

```ts
import { generateObject, generateText, tool, type ToolSet, type CoreMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import type { AgentContext, SkillTemplate, ToolDef } from '../types';
import { resolveTask } from '../../llm/task-router';
import { resolveModel } from '../../llm/provider-registry';
import { getAgentTaskRouterMode } from '../../db/repos/settings-repo';

export class AgentCancelled extends Error {
  constructor() { super('Agent cancelled'); this.name = 'AgentCancelled'; }
}

export interface AgentRunResult {
  runId: string;
  output: unknown;
  tokensUsed: number;
  stepCount: number;
}

export async function runAgentLoop(opts: {
  skill: SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  const { skill, ctx, input } = opts;
  const runId = randomUUID();

  ctx.emit('agent:run-started', `${skill.name} started`, {
    runId,
    parentRunId: ctx.parentRunId,
    skillId: skill.id,
    subjectId: ctx.subject.id,
  });

  const startedAt = Date.now();

  // Resolve LLM model: task-router defaults < tasks['skill:<id>'] < frontmatter (if mode allows).
  const taskKey = `skill:${skill.id}`;
  const routerMode = getAgentTaskRouterMode();
  const route = resolveTask(taskKey, routerMode === 'frontmatter-override' ? skill.model : undefined);
  const model = resolveModel(route);

  // Resolve tools.
  const toolDefs = ctx.toolRegistry.resolve(skill.tools);
  const toolSet: ToolSet = {};
  for (const t of toolDefs) {
    toolSet[t.name] = tool({
      description: t.description,
      parameters: t.inputSchema,
      execute: async (args: unknown) => {
        const stepStart = Date.now();
        try {
          const out = await t.handler(args, ctx);
          ctx.emit('agent:step', `${skill.name} called ${t.name}`, {
            runId,
            parentRunId: ctx.parentRunId,
            skillId: skill.id,
            stepIndex: ctx.budget.stepCount,
            kind: 'tool-call',
            tool: t.name,
            input: args,
            outputPreview: previewOutput(out),
            durationMs: Date.now() - stepStart,
          });
          return out;
        } catch (err) {
          ctx.emit('agent:step', `${skill.name} tool ${t.name} failed`, {
            runId,
            parentRunId: ctx.parentRunId,
            skillId: skill.id,
            stepIndex: ctx.budget.stepCount,
            kind: 'tool-call',
            tool: t.name,
            input: args,
            error: (err as Error).message,
            durationMs: Date.now() - stepStart,
          });
          throw err;
        }
      },
    });
  }

  // Build messages.
  const messages: CoreMessage[] = [
    { role: 'system', content: skill.systemPrompt },
    { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
  ];

  // Cancellation gate before LLM call.
  if (ctx.cancelled()) throw new AgentCancelled();
  ctx.budget.assertWithin();

  let output: unknown;
  let inputTokens = 0;
  let outputTokens = 0;

  if (skill.outputSchema) {
    const result = await generateObject({
      model,
      schema: skill.outputSchema,
      messages,
      maxTokens: skill.model?.maxTokens ?? route.maxTokens,
      temperature: skill.model?.temperature ?? route.temperature,
    });
    output = result.object;
    inputTokens = result.usage?.promptTokens ?? 0;
    outputTokens = result.usage?.completionTokens ?? 0;
  } else {
    const result = await generateText({
      model,
      tools: toolSet,
      messages,
      maxTokens: skill.model?.maxTokens ?? route.maxTokens,
      temperature: skill.model?.temperature ?? route.temperature,
      maxSteps: ctx.budgetSnapshot.maxSteps,
    });
    output = result.text;
    inputTokens = result.usage?.promptTokens ?? 0;
    outputTokens = result.usage?.completionTokens ?? 0;
  }

  ctx.budget.chargeStep();
  ctx.budget.chargeTokens(inputTokens + outputTokens);

  ctx.emit('agent:step', `${skill.name} produced final output`, {
    runId,
    parentRunId: ctx.parentRunId,
    skillId: skill.id,
    stepIndex: ctx.budget.stepCount,
    kind: 'final',
    tokensIn: inputTokens,
    tokensOut: outputTokens,
  });

  ctx.emit('agent:run-completed', `${skill.name} completed`, {
    runId,
    tokensUsed: inputTokens + outputTokens,
    stepCount: ctx.budget.stepCount,
    durationMs: Date.now() - startedAt,
  });

  return {
    runId,
    output,
    tokensUsed: inputTokens + outputTokens,
    stepCount: ctx.budget.stepCount,
  };
}

function previewOutput(out: unknown): string {
  try {
    const s = typeof out === 'string' ? out : JSON.stringify(out);
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  } catch { return '<unserializable>'; }
}
```

> **Note:** `resolveModel` does not exist yet — Task 16 modifies `provider-registry.ts` to export it. The agent-loop file will type-error against the current code; that is expected and resolved by Task 16.

- [ ] **Step 2: Type-check (expected to fail)**

Run:
```bash
npx tsc --noEmit
```

Expected: errors about `resolveModel` and possibly `resolveTask` signature. These are resolved in Task 16.

- [ ] **Step 3: Commit (build will be green after Task 16)**

```bash
git add src/server/agents/runtime/agent-loop.ts
git commit -m "feat(agents): single-agent step loop (build deps land in Task 16)"
```

---

## Task 16: task-router + provider-registry support for `skill:<id>` keys

**Files:**
- Modify: `src/server/llm/config-schema.ts`
- Modify: `src/server/llm/task-router.ts`
- Modify: `src/server/llm/provider-registry.ts`

- [ ] **Step 1: Read existing files**

Run:
```bash
sed -n '1,60p' src/server/llm/task-router.ts
sed -n '1,60p' src/server/llm/provider-registry.ts
sed -n '90,170p' src/server/llm/config-schema.ts
```

Note the current `LLMTask` enum (`'ingest' | 'query' | 'lint'`) and `resolveTask` signature.

- [ ] **Step 2: Relax `LLMTaskSchema` and `LLMConfigFile.tasks` to accept `skill:<id>` keys**

In `src/server/llm/config-schema.ts`, replace:

```ts
export const LLMTaskSchema = z.enum(['ingest', 'query', 'lint']);
```

with:

```ts
const BUILTIN_LLM_TASKS = ['ingest', 'query', 'lint'] as const;
export const LLMTaskSchema = z.string().refine(
  (s) => (BUILTIN_LLM_TASKS as readonly string[]).includes(s) || /^skill:[a-z0-9][a-z0-9-]*$/.test(s),
  { message: "Task must be 'ingest', 'query', 'lint', or 'skill:<id>'" },
);
```

Update `LLMConfigFileSchema`'s `tasks` field to accept arbitrary string keys (already does if it uses `z.record(z.string(), …)`). If it uses a fixed `z.object`, change to `z.record(LLMTaskSchema, LLMRouteConfigSchema).default({})`. (Inspect the current shape and adapt.)

- [ ] **Step 3: Update `task-router.ts` to accept arbitrary task strings**

In `src/server/llm/task-router.ts`, change the signature of `resolveTask` to accept `task: string` instead of `task: LLMTask`. The internal logic that looks up `tasks[task]` should work unchanged. Add a second optional parameter `frontmatterOverride?: Partial<LLMRouteOverride>` that is merged on top of `tasks[task]` only when non-undefined.

Concretely, after the existing merge of defaults + tasks[task], add:

```ts
if (frontmatterOverride) {
  return mergeRoute(merged, frontmatterOverride);
}
```

Where `mergeRoute` is the existing helper (or inlined object spread).

- [ ] **Step 4: Export `resolveModel` from `provider-registry.ts`**

In `src/server/llm/provider-registry.ts`, find the existing helper that materializes a Vercel-AI-SDK model from a `ResolvedTaskRoute` (it's used internally by `generateStructuredOutput`). Export it as a named function `resolveModel(route: ResolvedTaskRoute): LanguageModel`. If the helper is currently inline, extract it.

- [ ] **Step 5: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: clean across the whole repo (including `agent-loop.ts` from Task 15).

- [ ] **Step 6: Commit**

```bash
git add src/server/llm/config-schema.ts src/server/llm/task-router.ts src/server/llm/provider-registry.ts
git commit -m "feat(llm): accept skill:<id> task keys + export resolveModel"
```

---

## Task 17: Orchestrator — runSingle + runPipeline

**Files:**
- Create: `src/server/agents/runtime/orchestrator.ts`
- Create: `src/server/agents/runtime/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Write `orchestrator.ts`**

Create `src/server/agents/runtime/orchestrator.ts`:

```ts
import type { AgentContext, SkillTemplate } from '../types';
import { runAgentLoop, type AgentRunResult } from './agent-loop';

export type PipelineStep =
  | { kind: 'sequence'; skillId: string }
  | { kind: 'fanout'; skillId: string; fromOutput: string };

export class WriterConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`Multiple writers produced an entry for slug: ${slug}`);
    this.name = 'WriterConflictError';
  }
}

export async function runSingle(opts: {
  skill: SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  return runAgentLoop(opts);
}

export async function runPipeline(opts: {
  steps: PipelineStep[];
  resolveSkill: (id: string) => SkillTemplate;
  ctx: AgentContext;
  initialInput: unknown;
}): Promise<unknown> {
  let carry: unknown = opts.initialInput;
  for (const step of opts.steps) {
    if (step.kind === 'sequence') {
      const skill = opts.resolveSkill(step.skillId);
      const r = await runAgentLoop({ skill, ctx: opts.ctx, input: carry });
      carry = r.output;
    } else {
      const skill = opts.resolveSkill(step.skillId);
      const items = readPath(carry, step.fromOutput);
      if (!Array.isArray(items)) {
        throw new Error(`Fanout source at "${step.fromOutput}" is not an array (got ${typeof items})`);
      }
      const baseOverlay = opts.ctx.overlay.snapshot();
      const limit = opts.ctx.budgetSnapshot.maxParallelSubAgents;
      const results = await runWithSemaphore(items, limit, async (item) => {
        const childCtx: AgentContext = {
          ...opts.ctx,
          overlay: baseOverlay.snapshot(),
          parentRunId: opts.ctx.rootRunId,
        };
        return runAgentLoop({ skill, ctx: childCtx, input: item });
      });
      // Merge writer outputs (each is an object; assume each yields a top-level `entry` field).
      const seenSlugs = new Set<string>();
      const merged: unknown[] = [];
      for (const r of results) {
        const out = r.output as { entry?: { path?: string } } | undefined;
        const path = out?.entry?.path;
        if (path) {
          if (seenSlugs.has(path)) {
            throw new WriterConflictError(path);
          }
          seenSlugs.add(path);
        }
        merged.push(r.output);
      }
      // Apply each writer's `entry` to the parent overlay.
      for (const r of results) {
        const out = r.output as { entry?: { action: 'create' | 'update' | 'delete'; path: string; content: string } } | undefined;
        if (out?.entry) opts.ctx.overlay.putEntries([out.entry]);
      }
      carry = { ...((carry as object) ?? {}), writerOutputs: merged };
    }
  }
  return carry;
}

function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

async function runWithSemaphore<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/server/agents/runtime/__tests__/orchestrator.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runPipeline, WriterConflictError } from '../orchestrator';
import type { AgentContext, SkillTemplate } from '../../types';

const mockRun = vi.fn();
vi.mock('../agent-loop', () => ({
  runAgentLoop: (opts: { skill: { id: string }; input: unknown }) => mockRun(opts),
  AgentCancelled: class extends Error {},
}));

function ctxStub(): AgentContext {
  return {
    job: { id: 'j' } as AgentContext['job'],
    subject: { slug: 'general' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeStep: vi.fn(), chargeTokens: vi.fn(), assertWithin: vi.fn(), stepCount: 0, tokensUsed: 0 },
    overlay: { snapshot: vi.fn(() => ({ snapshot: () => ({}), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() })), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() } as unknown as AgentContext['overlay'],
    toolRegistry: { register: vi.fn(), resolve: vi.fn(() => []), get: vi.fn() },
    skillRegistry: { get: vi.fn(), list: vi.fn(() => []), degraded: vi.fn(() => []) },
    rootRunId: 'r0',
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 500_000, maxParallelSubAgents: 2 },
  } as AgentContext;
}

const stubSkill = (id: string): SkillTemplate => ({
  id, name: id, description: '', version: 1, tools: [], canDispatch: [], systemPrompt: '',
});

describe('orchestrator.runPipeline', () => {
  it('runs sequence steps in order, carrying output', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: '1', output: { plan: { pages: [] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: '2', output: { final: 'ok' }, tokensUsed: 0, stepCount: 1 });
    const result = await runPipeline({
      steps: [{ kind: 'sequence', skillId: 'planner' }, { kind: 'sequence', skillId: 'reviewer' }],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: { sources: [] },
    });
    expect(result).toEqual({ final: 'ok' });
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun.mock.calls[1][0].input).toEqual({ plan: { pages: [] } });
  });

  it('fans out per-item with parallel cap', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a' }, { slug: 'b' }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w1', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w2', output: { entry: { action: 'create', path: 'wiki/general/b.md', content: '' } }, tokensUsed: 0, stepCount: 1 });
    const result = await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: {},
    });
    expect(mockRun).toHaveBeenCalledTimes(3);
    const r = result as { writerOutputs?: unknown[] };
    expect(r.writerOutputs).toHaveLength(2);
  });

  it('throws WriterConflictError on duplicate writer paths', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a' }, { slug: 'a' }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w1', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w2', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 });
    await expect(runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: {},
    })).rejects.toThrow(WriterConflictError);
  });
});
```

- [ ] **Step 3: Run tests (expect pass)**

Run:
```bash
npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts
```

Expected: PASS — all 3 cases.

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/runtime/orchestrator.ts src/server/agents/runtime/__tests__/orchestrator.test.ts
git commit -m "feat(agents): orchestrator runSingle + runPipeline (sequence + fanout)"
```

---

## Task 18: Author the three example skill files

**Files:**
- Create: `examples/skills/ingest-planner.md`
- Create: `examples/skills/ingest-writer.md`
- Create: `examples/skills/ingest-reviewer.md`

- [ ] **Step 1: Write `ingest-planner.md`**

Create `examples/skills/ingest-planner.md`:

```markdown
---
id: ingest-planner
name: Ingest Planner
description: Plan which wiki pages to create or update from raw source documents.
version: 1
tools:
  - vault.read
  - vault.search
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "plan": {
        "type": "object",
        "properties": {
          "pages": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "slug": { "type": "string" },
                "title": { "type": "string" },
                "summary": { "type": "string" },
                "tags": { "type": "array", "items": { "type": "string" } },
                "rationale": { "type": "string" }
              },
              "required": ["slug", "title", "summary"]
            }
          }
        },
        "required": ["pages"]
      }
    },
    "required": ["plan"]
  }
---

# Role

You are the *ingest planner* for a personal wiki. You decide which pages to create or update from a batch of raw source documents.

## Inputs

The user message contains:

- `sources` — array of `{ filename, contentSummary, fullText? }`.
- `existingPages` — array of `{ slug, title, summary }` already in this subject.

## Rules

1. Each page slug must be unique across the plan.
2. Prefer updating an existing page over creating a near-duplicate. Use `vault.search` and `vault.read` if you need to inspect the existing page first.
3. **Do not translate slugs, `[[wikilinks]]`, frontmatter keys, or code.** The output language directive at the top of the user message applies to titles, summaries, and rationales only.
4. Slugs must be lowercase kebab-case.

## Output

Emit JSON matching the declared `outputSchema`. Each page entry's `rationale` should explain in one sentence why this page exists and which sources it draws from.
```

- [ ] **Step 2: Write `ingest-writer.md`**

Create `examples/skills/ingest-writer.md`:

```markdown
---
id: ingest-writer
name: Ingest Writer
description: Write the markdown body for a single planned wiki page.
version: 1
tools:
  - vault.read
  - vault.search
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "entry": {
        "type": "object",
        "properties": {
          "action": { "type": "string", "enum": ["create", "update"] },
          "path": { "type": "string" },
          "content": { "type": "string" }
        },
        "required": ["action", "path", "content"]
      }
    },
    "required": ["entry"]
  }
---

# Role

You are the *ingest writer*. You receive ONE plan entry and produce its full markdown file (frontmatter + body).

## Inputs

- `slug`, `title`, `summary`, `tags`, `rationale` — from the planner.
- `sources` — relevant source documents.
- `subjectSlug`, `existingPage?` — current vault state.

## Rules

1. The `path` in your output MUST be `wiki/<subjectSlug>/<slug>.md`.
2. The `action` is `update` if the page already exists, otherwise `create`.
3. Frontmatter must include: `title`, `summary`, `tags`. Do not invent other keys.
4. Use `[[wikilinks]]` to refer to other pages by their slug. Use `[[other-subject:Page]]` ONLY when truly cross-subject.
5. **Do not translate slugs, `[[wikilinks]]`, frontmatter keys, or code.**
6. Use `vault.search` / `vault.read` if you need to confirm a wikilink target exists.

## Output

Emit JSON matching the declared `outputSchema`. The `content` must be the complete file contents (frontmatter delimiters included).
```

- [ ] **Step 3: Write `ingest-reviewer.md`**

Create `examples/skills/ingest-reviewer.md`:

```markdown
---
id: ingest-reviewer
name: Ingest Reviewer
description: Review writer drafts, generate the subject index update, and commit the changeset.
version: 1
tools:
  - vault.read
  - vault.search
  - commit_changeset
canDispatch: []
---

# Role

You are the *ingest reviewer*. You receive the planner's plan, the writers' draft entries, and you must:

1. Cross-check each writer's entry against the plan and against the existing vault (use `vault.read` / `vault.search`).
2. Update or create the subject's `index.md` to reflect the new page set.
3. Append a single line to `log.md` describing this ingest run.
4. Call `commit_changeset` ONCE with the full set of entries (writer outputs + index update + log update).

## Rules

1. **You may call `commit_changeset` only once. After it succeeds, return.**
2. If the writer drafts are inconsistent (e.g. broken wikilinks, missing required frontmatter), correct them inline before commit. Do NOT loop more than two correction rounds — commit anyway and let the lint task surface remaining issues.
3. The commit `summary` should be a one-line description of what changed (e.g. "Ingested 3 sources into 5 pages").

## Output

After `commit_changeset` returns, your final answer should be a JSON object matching:

```json
{ "commitSha": "...", "pagesCreated": [...], "pagesUpdated": [...], "linksAdded": 0 }
```
```

- [ ] **Step 4: Verify each parses via the loader**

Run:
```bash
npx vitest run -t "parses a valid skill" src/server/agents/skills/__tests__/loader.test.ts
```

Then write a one-off script (or use `node -e`) to load `examples/skills/`:

```bash
npx tsx -e "import('./src/server/agents/skills/loader.ts').then(m => m.loadSkillsFromDir('examples/skills').then(r => { console.log('skills:', r.skills.map(s=>s.id)); console.log('degraded:', r.degraded); if (r.degraded.length) process.exit(1); }))"
```

Expected: `skills: [ 'ingest-planner', 'ingest-reviewer', 'ingest-writer' ]` and `degraded: []`.

- [ ] **Step 5: Commit**

```bash
git add examples/skills/
git commit -m "feat(skills): seed planner / writer / reviewer skill files"
```

---

## Task 19: Rewrite `ingest-service` to call the orchestrator

**Files:**
- Modify: `src/server/services/ingest-service.ts`
- Create: `src/server/services/__tests__/ingest-service.test.ts`

- [ ] **Step 1: Read current ingest-service to identify pre-step source-loading code**

Run:
```bash
sed -n '70,130p' src/server/services/ingest-service.ts
```

Identify the source-parsing helpers (`loadAndParseSources` or equivalent). They will be extracted as `loadSources` for reuse in the new implementation.

- [ ] **Step 2: Replace the file**

Rewrite `src/server/services/ingest-service.ts` to:

```ts
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as sourcesRepo from '../db/repos/sources-repo';
import { parseSourceAsync, requiresBuffer } from '../sources/parser-registry';
import { readRawSource } from '../wiki/wiki-store';
import {
  getAgentMaxSteps,
  getAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
} from '../db/repos/settings-repo';
import { runPipeline } from '../agents/runtime/orchestrator';
import { createBudgetTracker } from '../agents/runtime/budget';
import { createOverlayVault } from '../agents/runtime/overlay-vault';
import { getRuntimeRegistries } from '../worker-runtime';
import { randomUUID } from 'node:crypto';
import type { AgentContext } from '../agents/types';
import type { IngestResult, Job } from '@/lib/contracts';

const SOURCE_TEXT_LIMIT = 30_000;

interface PlannedSource {
  filename: string;
  contentSummary: string;
  fullText: string;
}

async function loadSources(job: Job, subjectSlug: string): Promise<PlannedSource[]> {
  const sourceIds = (job.paramsJson ? JSON.parse(job.paramsJson) : {}).sourceIds as string[] | undefined;
  if (!sourceIds?.length) return [];
  const out: PlannedSource[] = [];
  for (const id of sourceIds) {
    const source = sourcesRepo.getById(id);
    if (!source) continue;
    const buffer = requiresBuffer(source.filename) ? await readRawSource(subjectSlug, source.filename) : undefined;
    const parsed = await parseSourceAsync(source.filename, source.metadataJson, buffer);
    const fullText = parsed.text.slice(0, SOURCE_TEXT_LIMIT);
    out.push({
      filename: source.filename,
      contentSummary: parsed.summary ?? '',
      fullText,
    });
  }
  return out;
}

registerHandler('ingest', async (job, emit): Promise<IngestResult> => {
  if (!job.subjectId) throw new Error('ingest job missing subjectId');
  const subject = subjectsRepo.getById(job.subjectId);
  if (!subject) throw new Error(`Subject ${job.subjectId} not found`);

  emit('ingest:start', `Ingest started for subject ${subject.slug}`, { subject: subject.slug });

  const sources = await loadSources(job, subject.slug);
  if (!sources.length) {
    emit('ingest:no-sources', 'No sources to ingest', {});
    return { pagesCreated: [], pagesUpdated: [], linksAdded: 0, commitSha: '' };
  }

  const { skillRegistry, toolRegistry } = getRuntimeRegistries();
  const budgetSnapshot = {
    maxSteps: getAgentMaxSteps(),
    maxTokensPerJob: getAgentMaxTokensPerJob(),
    maxParallelSubAgents: getAgentMaxParallelSubAgents(),
  };
  const budget = createBudgetTracker(budgetSnapshot);
  const overlay = createOverlayVault({ subjectSlug: subject.slug });

  const ctx: AgentContext = {
    job,
    subject,
    emit,
    budget,
    overlay,
    toolRegistry,
    skillRegistry,
    rootRunId: randomUUID(),
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    budgetSnapshot,
  };

  emit('ingest:planning', `Planning ${sources.length} source(s)`, {});

  const result = await runPipeline({
    steps: [
      { kind: 'sequence', skillId: 'ingest-planner' },
      { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages' },
      { kind: 'sequence', skillId: 'ingest-reviewer' },
    ],
    resolveSkill: (id) => {
      const s = skillRegistry.get(id);
      if (!s) throw new Error(`Skill not loaded: ${id}`);
      return s;
    },
    ctx,
    initialInput: {
      sources,
      subjectSlug: subject.slug,
      existingPages: [], // populated implicitly via vault.search/read tool calls
    },
  }) as IngestResult;

  return result;
});
```

- [ ] **Step 3: Create the runtime registries singleton**

Create `src/server/worker-runtime.ts`:

```ts
import type { SkillRegistry, ToolRegistry } from './agents/types';

interface Registries {
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
}

let instance: Registries | null = null;

export function setRuntimeRegistries(r: Registries): void {
  instance = r;
}

export function getRuntimeRegistries(): Registries {
  if (!instance) throw new Error('Runtime registries not initialized — worker boot did not call setRuntimeRegistries');
  return instance;
}
```

- [ ] **Step 4: Write the end-to-end test**

Create `src/server/services/__tests__/ingest-service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { IngestResult } from '@/lib/contracts';

// All external surface mocked: LLM, DB, vault, git.
vi.mock('../../db/repos/subjects-repo', () => ({
  getById: () => ({ id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' }),
}));
vi.mock('../../db/repos/sources-repo', () => ({
  getById: (id: string) => ({ id, subjectId: 's1', filename: `${id}.md`, contentHash: 'h', metadataJson: '{}', parsedAt: '' }),
}));
vi.mock('../../sources/parser-registry', () => ({
  parseSourceAsync: async (filename: string) => ({ text: `body of ${filename}`, summary: `summary of ${filename}` }),
  requiresBuffer: () => false,
}));
vi.mock('../../wiki/wiki-store', () => ({
  readRawSource: async () => Buffer.alloc(0),
}));
vi.mock('../../db/repos/settings-repo', () => ({
  getAgentMaxSteps: () => 5,
  getAgentMaxTokensPerJob: () => 100_000,
  getAgentMaxParallelSubAgents: () => 2,
  getAgentTaskRouterMode: () => 'frontmatter-override',
}));

const mockRunPipeline = vi.fn(async (): Promise<IngestResult> => ({
  pagesCreated: ['a'],
  pagesUpdated: [],
  linksAdded: 0,
  commitSha: 'sha-1',
}));
vi.mock('../../agents/runtime/orchestrator', () => ({
  runPipeline: (...args: unknown[]) => mockRunPipeline(...args as []),
  WriterConflictError: class extends Error {},
}));

vi.mock('../../worker-runtime', () => ({
  getRuntimeRegistries: () => ({
    skillRegistry: { get: (id: string) => ({ id, name: id, description: '', version: 1, tools: [], canDispatch: [], systemPrompt: '' }), list: () => [], degraded: () => [] },
    toolRegistry: { register: vi.fn(), resolve: vi.fn(() => []), get: vi.fn() },
  }),
}));

const handlers = new Map<string, (job: unknown, emit: unknown) => Promise<unknown>>();
vi.mock('../../jobs/worker', () => ({
  registerHandler: (type: string, h: (job: unknown, emit: unknown) => Promise<unknown>) => { handlers.set(type, h); },
}));

describe('ingest-service', () => {
  it('runs orchestrator pipeline and returns IngestResult', async () => {
    await import('../ingest-service');
    const handler = handlers.get('ingest');
    expect(handler).toBeDefined();
    const job = {
      id: 'j1',
      type: 'ingest',
      status: 'running',
      subjectId: 's1',
      paramsJson: JSON.stringify({ sourceIds: ['src-1', 'src-2'] }),
      resultJson: null,
      createdAt: '', startedAt: null, completedAt: null,
      leaseExpiresAt: null, heartbeatAt: null, attemptCount: 0,
    };
    const emit = vi.fn();
    const result = await handler!(job, emit) as IngestResult;
    expect(result.commitSha).toBe('sha-1');
    expect(mockRunPipeline).toHaveBeenCalledOnce();
    const callArg = mockRunPipeline.mock.calls[0][0] as { steps: unknown[] };
    expect(callArg.steps).toHaveLength(3);
  });
});
```

- [ ] **Step 5: Run the test (expect pass)**

Run:
```bash
npx vitest run src/server/services/__tests__/ingest-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/ingest-service.ts src/server/services/__tests__/ingest-service.test.ts src/server/worker-runtime.ts
git commit -m "feat(ingest): rewrite service to call multi-agent orchestrator"
```

---

## Task 20: Wire runtime into worker boot

**Files:**
- Modify: `src/server/worker-entry.ts`

- [ ] **Step 1: Read current worker-entry**

Run:
```bash
sed -n '1,80p' src/server/worker-entry.ts
```

Identify where `import './services/ingest-service'` happens and where `startWorker(...)` is called, and where the `SIGTERM`/`SIGINT` handlers are registered.

- [ ] **Step 2: Add runtime initialization before service imports trigger**

The order matters: services use `getRuntimeRegistries()` only when their handler runs (not at import time), so we can initialize after imports but BEFORE `startWorker(...)`. Insert this block after the existing DB / general-subject / git-repo bootstrap and before `startWorker`:

```ts
import { join } from 'node:path';
import { vaultPath } from './config/env';
import { buildSkillRegistry } from './agents/skills/registry';
import { createToolRegistry } from './agents/tools/registry';
import { vaultReadTool } from './agents/tools/builtin/vault-read';
import { vaultSearchTool } from './agents/tools/builtin/vault-search';
import { commitChangesetTool } from './agents/tools/builtin/commit-changeset';
import { dispatchSkillTool } from './agents/tools/builtin/dispatch-skill';
import { createMcpPool } from './agents/tools/mcp/client-pool';
import { loadMcpConfig } from './agents/tools/mcp/config';
import {
  getAgentMcpLifecycle,
} from './db/repos/settings-repo';
import { setRuntimeRegistries } from './worker-runtime';

async function bootRuntime(): Promise<{ shutdown: () => Promise<void> }> {
  const skillRegistry = await buildSkillRegistry({
    vaultDir: vaultPath(),
    examplesDir: join(process.cwd(), 'examples', 'skills'),
  });
  const degraded = skillRegistry.degraded();
  if (degraded.length) {
    console.warn('[runtime] degraded skills:', degraded);
  }

  const toolRegistry = createToolRegistry();
  toolRegistry.register(vaultReadTool);
  toolRegistry.register(vaultSearchTool);
  toolRegistry.register(commitChangesetTool);
  toolRegistry.register(dispatchSkillTool);

  const mcpConfig = loadMcpConfig(join(process.cwd(), 'mcp-config.json'));
  const pool = createMcpPool({
    config: mcpConfig,
    lifecycle: getAgentMcpLifecycle(),
    toolRegistry,
  });
  pool.registerToolPlaceholders(toolRegistry);
  await pool.startEager();

  setRuntimeRegistries({ skillRegistry, toolRegistry });

  return { shutdown: () => pool.shutdown() };
}
```

Then in the existing `main()`/bootstrap function, call `const runtime = await bootRuntime();` before `startWorker(...)`. In the existing SIGTERM/SIGINT handler, call `await runtime.shutdown();` before `process.exit(0)`.

- [ ] **Step 3: Smoke run**

Run:
```bash
npm run dev:all
```

Expected: worker boots without errors, logs `[runtime] degraded skills: []` (or omits the line). Stop with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add src/server/worker-entry.ts
git commit -m "feat(worker): boot agent runtime (skills + tools + MCP pool)"
```

---

## Task 21: Update module documentation

**Files:**
- Create: `src/server/agents/CLAUDE.md`
- Modify: `src/server/services/CLAUDE.md`
- Modify: `src/server/db/CLAUDE.md`
- Modify: `src/server/llm/CLAUDE.md`
- Modify: `src/components/CLAUDE.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create `src/server/agents/CLAUDE.md`**

Write the new module's `CLAUDE.md`. Follow the existing pattern (header link, 模块职责, 入口与启动, 对外接口, 数据模型, 关键依赖与配置, 扩展指南, 测试与质量, 常见问题, 相关文件清单, 变更记录). Keep it under ~150 lines.

Suggested skeleton (fill with concrete details from the Phase 1 work):

```markdown
[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **agents**

# `src/server/agents/` — Multi-Agent Runtime (Phase 1)

## 模块职责
- 在 `worker` 进程内运行多 agent 流水线，目前仅服务 `ingest` 任务。
- 提供 skill (markdown 模板) → 实例化 → step loop → tool 调用 的 runtime。
- 唯一写工具 `commit_changeset` 走 `wiki-transaction` Saga；其它工具一律 read-only。

## 入口与启动
worker-entry 调 `bootRuntime()` 完成 skill 加载 + tool 注册 + MCP 池初始化。

## 对外接口
| 子模块 | 关键导出 |
| --- | --- |
| `runtime/orchestrator` | `runPipeline` / `runSingle` |
| `runtime/agent-loop` | `runAgentLoop` |
| `runtime/budget` | `createBudgetTracker` / `BudgetExceededError` |
| `runtime/overlay-vault` | `createOverlayVault` |
| `skills/loader` | `loadSkillsFromDir` |
| `skills/registry` | `buildSkillRegistry` |
| `tools/registry` | `createToolRegistry` |
| `tools/builtin/*` | `vaultReadTool`, `vaultSearchTool`, `commitChangesetTool`, `dispatchSkillTool` |
| `tools/mcp/client-pool` | `createMcpPool` (eager / lazy / per-job) |

## 关键依赖
- `@modelcontextprotocol/sdk`、`zod-from-json-schema`、`gray-matter`、Vercel AI SDK 4。
- `app_settings` 5 个 agent 设置：每个 root run 启动时实时读取。

## 扩展指南
- 新增 skill：放 `vault/.llm-wiki/skills/<id>.md`；首次启动从 `examples/skills/` 拷贝。
- 新增 tool：在 `tools/builtin/` 写 `ToolDef` 并在 `worker-entry::bootRuntime` 注册。
- 写工具：必须 `sideEffect: 'commit'`；目前仅 `commit_changeset`，且整个 root run 只能调一次。

## 测试与质量
- `runtime/__tests__/`、`skills/__tests__/`、`tools/builtin/__tests__/`。
- 端到端见 `services/__tests__/ingest-service.test.ts`。

## FAQ
- Reviewer 拒绝 commit → fail job（不重试 planner）。
- Skill 改动 → 重启 worker 才生效（Phase 1 不支持热加载）。

## 相关文件清单
（见上方"模块职责"模块布局图）

## 变更记录
| 日期 | 变更 |
| --- | --- |
| 2026-04-27 | 初始化（Phase 1）|
```

- [ ] **Step 2: Update `src/server/services/CLAUDE.md`**

Add a row in the changelog and rewrite the `ingest-service.ts` description block to note the orchestrator delegation. Keep the wording terse.

- [ ] **Step 3: Update `src/server/db/CLAUDE.md`**

Add the 5 new settings keys to the `settings-repo.ts` documentation. Add a changelog row.

- [ ] **Step 4: Update `src/server/llm/CLAUDE.md`**

Document that `LLMTaskSchema` now accepts `skill:<id>` keys and that `resolveTask` accepts a `frontmatterOverride` argument. Add a changelog row.

- [ ] **Step 5: Update `src/components/CLAUDE.md`**

Mention the new "Agents" section in `settings-dialog.tsx`.

- [ ] **Step 6: Update root `CLAUDE.md`**

Add a changelog row at the top of section 九 (Changelog):

```markdown
| 2026-04-27 | Phase 1 multi-agent runtime | 引入 `src/server/agents/` (orchestrator + skill loader + tool registry + MCP client pool)；`ingest` 切换为 planner→writer×N→reviewer 流水线；新增 5 项 agent 设置；spec 见 `docs/superpowers/specs/2026-04-27-multi-agent-runtime-design.md` |
```

- [ ] **Step 7: Run docs sanity (everything still type-checks + lints)**

Run:
```bash
npx tsc --noEmit && npm run lint && npx vitest run
```

Expected: clean across the board.

- [ ] **Step 8: Commit**

```bash
git add src/server/agents/CLAUDE.md src/server/services/CLAUDE.md src/server/db/CLAUDE.md src/server/llm/CLAUDE.md src/components/CLAUDE.md CLAUDE.md
git commit -m "docs(agents): document Phase 1 multi-agent runtime in CLAUDE.md"
```

---

## Task 22: End-to-end manual smoke test

**Files:** None (verification only)

- [ ] **Step 1: Start the stack**

Run:
```bash
npm run dev:all
```

Wait until both Next.js and worker are listening.

- [ ] **Step 2: Open the settings dialog**

In the browser, open the left sidebar settings, scroll to "Agents". Verify:
- All 5 controls render with defaults (25 / 500000 / 3 / lazy / frontmatter-override).
- Changing any value and clicking Save / selecting a new option succeeds without page reload.

- [ ] **Step 3: Trigger an ingest**

Upload one small markdown source file to the `general` subject (or use an existing source). Watch the task detail page's event log. Verify:
- Business events `ingest:start`, `ingest:planning`, `ingest:committing` still appear (backward compat).
- New events `agent:run-started` / `agent:step` / `agent:run-completed` appear in raw view (no UI rendering yet — by design).
- The job completes `success` and produces a git commit in `vault/`.

- [ ] **Step 4: Inspect a degraded skill scenario**

Edit `vault/.llm-wiki/skills/ingest-writer.md`, break the frontmatter (e.g. remove `id:`), restart the worker. Trigger another ingest. Verify the job fails with an error referencing the degraded skill, but the worker itself stays up.

Restore the file before continuing.

- [ ] **Step 5: Verify shutdown**

Send `SIGTERM` to the worker (Ctrl-C). Verify it logs MCP pool shutdown messages (if any servers were connected) and exits cleanly.

- [ ] **Step 6: Commit smoke test result note (optional)**

If you found anything worth recording, add a brief note. Otherwise, no commit.

---

## Self-Review Notes (verified before this plan was finalized)

- **Spec coverage:**
  - D1–D14 all mapped to concrete tasks (settings → T1-T4, skill format → T8/T9/T18, runtime → T5-T17, MCP → T13/T14/T20, ingest → T19, observability → T15 emits, settings UI → T4, task-router → T16).
  - Risks R1-R8 mitigated: R1 budget tests T6, R2 overlay snapshots T7+T17, R3 MCP shutdown T20, R4 degraded skill T8+T22, R5 reviewer prompt T18, R6 manual smoke T22, R7 single-user accepted, R8 in-memory FTS T7.
  - Test priorities 1-6 all have a corresponding test task.
  - Out of scope items confirmed absent: no Phase-2 features, no `agent_runs`/`agent_steps` tables, no tree-timeline UI, no MCP server, no skill hot reload.
- **Placeholder scan:** None of the disallowed patterns appear (no "TBD", no "implement later", no "Similar to Task N", no vague "add validation" without code).
- **Type consistency:** `AgentBudget`, `AgentContext`, `BudgetTracker`, `OverlayVault`, `ToolDef`, `SkillTemplate`, `SkillRegistry`, `ToolRegistry` declared in T5 and re-used unchanged in T6/T7/T10/T11/T12/T15/T17/T19. Tool name `commit_changeset` (underscore) consistent across spec/skill/test/registry. Setting keys `agentMaxSteps` etc. consistent across contracts/repo/route/UI/runtime.
- **Known follow-ups acceptable for Phase 1:**
  - The MCP tool-bridge proxy is intentionally minimal (single namespace placeholder) since no Phase-1 skill whitelists MCP tools. Real per-tool registration kicks in the moment a skill includes `mcp.<server>.*` (Phase 2 trigger).
  - `dispatch-skill` tool is wired but its handler throws — no Phase-1 skill enables it.

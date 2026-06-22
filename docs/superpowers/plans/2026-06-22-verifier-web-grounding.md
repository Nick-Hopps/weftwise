# ⑨ Verifier 联网核查（web-grounding）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ingest 增益流水线第 4 阶段 verifier 由「参数化自检（P2）」升级为「联网接地核查（P3）」：对增益 callout 的存疑断言做 web 检索取证、证据驱动修正，并把被引用网页按需抓正文导入为 source（三层 provenance）。

**Architecture:** verifier 步骤改为**逐页确定性两段式**——`triage`（结构化输出，挑存疑 callout 断言+检索 query）→ **编排代码层** `Promise.allSettled` 跑 Tavily 搜索 → `apply`（结构化输出，拿证据修正整页）。全程 `generateObject` 无 tools，绝不进 agent-loop 工具循环（根除 packyapi 死循环）。被引用网页经 `saveRawSource` 导入为 source、写 `page_sources`、URL 追加进引用页 frontmatter `sources`，扩展 Saga `SourceLinkOps`（多源+额外 stage 路径）使其随同一次 ingest commit 落地。未配置搜索后端 → 逐页退回既有 `ingest-verifier`(v2) 自检，零行为变化。

**Tech Stack:** TypeScript 5 + zod；Tavily HTTP API（search + extract，`fetch`）；Vercel AI SDK `generateObject`（经既有 `runAgentLoop`）；better-sqlite3 + Drizzle（`app_settings` 设置）；gray-matter（frontmatter）；vitest（mkdtempSync 临时 DB fixture + vi.mock）。

## Global Constraints

- **全程 `generateObject` 无 tools**：verifier 三个 skill（triage/apply/既有自检）均结构化输出；搜索在编排层确定性执行，**不得**走 agent-loop 的 `generateText`+tool 路径。
- **搜索后端配置落全局设置 `app_settings`**（`settings-repo` 三 key），**不进 `llm-config.json`**；`web-search.ts` 经 `getWebSearchConfig()` **每次调用实时读 DB**（UI 改即时生效、无需重启 worker）。
- **未配置（apiKey trim 后为空）→ 降级**逐页跑既有 `ingest-verifier`(v2) 自检 skill；行为与当前 P2 完全一致。
- **忠实正文逐字复刻**：apply 只改 `[!type]` callout、不加新 callout、不动 frontmatter；frontmatter `sources` 的 URL 追加由**编排层确定性**完成（非 LLM）。
- **网页 source 三层 provenance**：`saveRawSource`（source 实体）+ `page_sources`（`linkPageSource`）+ 引用页 frontmatter `sources` 追加 URL；三者随**同一次 ingest commit** 落地（扩展 `SourceLinkOps`：`links: Array<{ sourceId; pageSlugs }>` + `extraStagePaths`）。
- **检索预算**：每页 query 去重后上限 `MAX_SEARCHES_PER_PAGE = 3`；`Promise.allSettled` 并发；单查超时 `SEARCH_TIMEOUT_MS = 8000`。
- **降级矩阵**：未配置→自检；triage 空→passthrough（不搜索/不 apply）；有存疑但零证据→自检；extract 失败→snippet 兜底为 source 正文；saveRawSource 失败→跳过该 source（frontmatter URL 保留，不阻断 commit）。
- **复用既有**：`runAgentLoop`/`AgentRunResult`（`agent-loop.ts`）、orchestrator fanout 骨架（overlay 快照/checkpoint/path 规范/pending/冲突检测）、`saveRawSource`（`source-store.ts`）、`parseFrontmatter/serializeFrontmatter`（`frontmatter.ts`）、settings 三件套（contracts schema → settings-repo readKey/writeKey → /api/settings → settings-rows）。
- 注释 / commit message 用**中文**（单行摘要、无细节）；**禁止** AI 署名（无 `Co-Authored-By`、无 "Generated with" 脚注）。
- packyapi：Claude 模型走 openai-compatible profile（与本特性无直接交互，但 triage/apply 的 LLM 调用沿用既有 `resolveSkillModel`，不引入新约束）。

---

## File Structure

**新增：**
- `src/server/search/web-search.ts` — Tavily HTTP 客户端 + 配置守卫（`isWebSearchConfigured`/`webSearch`/`extractContent`）。
- `src/server/search/__tests__/web-search.test.ts`
- `src/server/agents/runtime/verify-page.ts` — 逐页两段式核查编排（triage→搜索→apply/降级→frontmatter 追加→citedSources 累积）。
- `src/server/agents/runtime/__tests__/verify-page.test.ts`
- `examples/skills/ingest-verifier-triage.md`
- `examples/skills/ingest-verifier-apply.md`

**修改：**
- `src/lib/contracts.ts` — WebSearch 三 schema + 默认值 + `WebSearchProvider` 类型 + `AppSettings`/`AppSettingsSchema` 三字段。
- `src/server/db/repos/settings-repo.ts` — 3 key getter/setter + `getWebSearchConfig()`。
- `src/server/db/repos/__tests__/settings-repo.test.ts` — web search key 用例。
- `src/app/api/settings/route.ts` — `readSettings`/`PutBodySchema`/PUT 分支补 3 字段。
- `src/components/layout/settings-rows.tsx` — 新增 `TextSettingRow`（password/允许空）。
- `src/components/layout/settings-content.tsx` — 新增 "Web search" section。
- `src/server/agents/types.ts` — `PipelineStep` 加 `verify` kind？（实际放 orchestrator.ts，见下）；`AgentContext.citedSources?`；`CitedSource` 类型。
- `src/server/agents/runtime/orchestrator.ts` — `PipelineStep` 联合加 `verify` kind；fanout 分支路由到 `runPageVerification`。
- `src/server/wiki/wiki-transaction.ts` — `SourceLinkOps` 多源 + `extraStagePaths`；`applyChangeset` stage/link 适配。
- `src/server/agents/tools/builtin/commit-changeset.ts` — `commitPending` 第三参 `webSources`，构造新版 `SourceLinkOps`。
- `src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts`（若存在则扩展，否则在 wiki-transaction 测试覆盖）。
- `src/server/services/ingest-service.ts` — verify step；`finalizeIngest` 导入 cited sources；`MIN_SKILL_VERSIONS`。
- `llm-config.example.json` — 仅 triage/apply 模型路由注释示例。

> **类型放置说明**：`CitedSource` 是 agents runtime 内部类型，放 `src/server/agents/types.ts`（不进 contracts.ts，客户端不需要）。`PipelineStep` 联合定义在 `orchestrator.ts`（既有位置），verify kind 加在那里。`WebSearchResult` 放 `web-search.ts` 本模块。

---

### Task 1: 全局设置后端（contracts + settings-repo + /api/settings）

**Files:**
- Modify: `src/lib/contracts.ts`（在 `AgentTaskRouterModeSchema` 区块后、`AppSettings` 接口处）
- Modify: `src/server/db/repos/settings-repo.ts`
- Modify: `src/app/api/settings/route.ts`
- Test: `src/server/db/repos/__tests__/settings-repo.test.ts`（追加用例）

**Interfaces:**
- Produces:
  - contracts: `WebSearchProviderSchema = z.enum(['tavily'])`、`DEFAULT_WEB_SEARCH_PROVIDER`、`WebSearchApiKeySchema`、`DEFAULT_WEB_SEARCH_API_KEY`、`WebSearchMaxResultsSchema`、`DEFAULT_WEB_SEARCH_MAX_RESULTS`、`type WebSearchProvider`；`AppSettings` 增 `webSearchProvider: WebSearchProvider; webSearchApiKey: string; webSearchMaxResults: number`。
  - settings-repo: `getWebSearchProvider(): WebSearchProvider`、`setWebSearchProvider(v): WebSearchProvider`、`getWebSearchApiKey(): string`、`setWebSearchApiKey(v): string`、`getWebSearchMaxResults(): number`、`setWebSearchMaxResults(v): number`、`getWebSearchConfig(): { provider: WebSearchProvider; apiKey: string; maxResults: number }`。

- [ ] **Step 1: 写失败测试**（追加到 `settings-repo.test.ts` 末尾，新 describe 块）

```typescript
describe('settings-repo web search keys', () => {
  it('returns defaults when no row exists', async () => {
    const repo = await import('../settings-repo');
    expect(repo.getWebSearchProvider()).toBe('tavily');
    expect(repo.getWebSearchApiKey()).toBe('');
    expect(repo.getWebSearchMaxResults()).toBe(5);
    expect(repo.getWebSearchConfig()).toEqual({ provider: 'tavily', apiKey: '', maxResults: 5 });
  });

  it('roundtrips after set', async () => {
    const repo = await import('../settings-repo');
    repo.setWebSearchProvider('tavily');
    repo.setWebSearchApiKey('  tvly-abc123  ');
    repo.setWebSearchMaxResults(8);
    expect(repo.getWebSearchApiKey()).toBe('tvly-abc123'); // trimmed
    expect(repo.getWebSearchMaxResults()).toBe(8);
    expect(repo.getWebSearchConfig()).toEqual({ provider: 'tavily', apiKey: 'tvly-abc123', maxResults: 8 });
  });

  it('allows empty apiKey (means not configured)', async () => {
    const repo = await import('../settings-repo');
    expect(() => repo.setWebSearchApiKey('')).not.toThrow();
    expect(repo.getWebSearchApiKey()).toBe('');
  });

  it('rejects out-of-range maxResults and bad provider', async () => {
    const repo = await import('../settings-repo');
    expect(() => repo.setWebSearchMaxResults(0)).toThrow();
    expect(() => repo.setWebSearchMaxResults(11)).toThrow();
    // @ts-expect-error testing runtime guard
    expect(() => repo.setWebSearchProvider('bing')).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/settings-repo.test.ts`
Expected: FAIL（`repo.getWebSearchProvider is not a function`）

- [ ] **Step 3: contracts.ts 加 schema/默认/AppSettings 字段**

在 `src/lib/contracts.ts` 的 `export type AgentTaskRouterMode = ...`（line ~233）之后、`export interface AppSettings {`（line ~235）之前插入：

```typescript
export const DEFAULT_WEB_SEARCH_PROVIDER = 'tavily' as const;
export const DEFAULT_WEB_SEARCH_API_KEY = '';
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;

export const WebSearchProviderSchema = z.enum(['tavily']);
// 允许空串：空 = 未配置 / 关闭联网核查（优雅降级纯自检）
export const WebSearchApiKeySchema = z.string().trim().max(200);
export const WebSearchMaxResultsSchema = z.number().int().min(1).max(10);

export type WebSearchProvider = z.infer<typeof WebSearchProviderSchema>;
```

在 `AppSettings` 接口内追加三字段：

```typescript
export interface AppSettings {
  wikiLanguage: string;
  agentMaxSteps: number;
  agentMaxTokensPerJob: number;
  agentMaxParallelSubAgents: number;
  agentMcpLifecycle: AgentMcpLifecycle;
  agentTaskRouterMode: AgentTaskRouterMode;
  webSearchProvider: WebSearchProvider;
  webSearchApiKey: string;
  webSearchMaxResults: number;
}
```

在 `AppSettingsSchema` 对象内追加三字段：

```typescript
export const AppSettingsSchema = z.object({
  wikiLanguage: WikiLanguageSchema,
  agentMaxSteps: AgentMaxStepsSchema,
  agentMaxTokensPerJob: AgentMaxTokensPerJobSchema,
  agentMaxParallelSubAgents: AgentMaxParallelSubAgentsSchema,
  agentMcpLifecycle: AgentMcpLifecycleSchema,
  agentTaskRouterMode: AgentTaskRouterModeSchema,
  webSearchProvider: WebSearchProviderSchema,
  webSearchApiKey: WebSearchApiKeySchema,
  webSearchMaxResults: WebSearchMaxResultsSchema,
});
```

- [ ] **Step 4: settings-repo.ts 加 key + getter/setter**

在 import 块补充类型与 schema：

```typescript
import {
  // ...既有 imports...
  WebSearchProviderSchema,
  WebSearchApiKeySchema,
  WebSearchMaxResultsSchema,
  DEFAULT_WEB_SEARCH_PROVIDER,
  DEFAULT_WEB_SEARCH_API_KEY,
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  type WebSearchProvider,
} from '@/lib/contracts';
```

在既有 `KEY_AGENT_TASK_ROUTER_MODE` 常量后追加：

```typescript
const KEY_WEB_SEARCH_PROVIDER = 'webSearchProvider';
const KEY_WEB_SEARCH_API_KEY = 'webSearchApiKey';
const KEY_WEB_SEARCH_MAX_RESULTS = 'webSearchMaxResults';
```

在文件末尾追加：

```typescript
// ─────────────────────────────────────────────────────────────────
// Web Search Backend Configuration (⑨ verifier 联网核查)
// 全 app 单实例配置；服务层每次实时读，UI 改即时生效、无需重启 worker。
// ─────────────────────────────────────────────────────────────────

export function getWebSearchProvider(): WebSearchProvider {
  const raw = readKey(KEY_WEB_SEARCH_PROVIDER);
  if (raw === undefined) return DEFAULT_WEB_SEARCH_PROVIDER;
  const parsed = WebSearchProviderSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_WEB_SEARCH_PROVIDER;
}

export function setWebSearchProvider(value: WebSearchProvider): WebSearchProvider {
  const v = WebSearchProviderSchema.parse(value);
  writeKey(KEY_WEB_SEARCH_PROVIDER, v);
  return v;
}

export function getWebSearchApiKey(): string {
  return readKey(KEY_WEB_SEARCH_API_KEY) ?? DEFAULT_WEB_SEARCH_API_KEY;
}

export function setWebSearchApiKey(value: string): string {
  const v = WebSearchApiKeySchema.parse(value);
  writeKey(KEY_WEB_SEARCH_API_KEY, v);
  return v;
}

export function getWebSearchMaxResults(): number {
  return readNumber(KEY_WEB_SEARCH_MAX_RESULTS, DEFAULT_WEB_SEARCH_MAX_RESULTS);
}

export function setWebSearchMaxResults(value: number): number {
  const v = WebSearchMaxResultsSchema.parse(value);
  writeKey(KEY_WEB_SEARCH_MAX_RESULTS, String(v));
  return v;
}

/** 一次读取三字段，供 web-search.ts 使用。 */
export function getWebSearchConfig(): {
  provider: WebSearchProvider;
  apiKey: string;
  maxResults: number;
} {
  return {
    provider: getWebSearchProvider(),
    apiKey: getWebSearchApiKey(),
    maxResults: getWebSearchMaxResults(),
  };
}
```

- [ ] **Step 5: /api/settings route.ts 接线三字段**

import 补充：

```typescript
import {
  // ...既有...
  getWebSearchProvider,
  setWebSearchProvider,
  getWebSearchApiKey,
  setWebSearchApiKey,
  getWebSearchMaxResults,
  setWebSearchMaxResults,
} from '@/server/db/repos/settings-repo';
import {
  // ...既有...
  WebSearchProviderSchema,
  WebSearchApiKeySchema,
  WebSearchMaxResultsSchema,
  type AppSettings,
} from '@/lib/contracts';
```

`readSettings()` 追加三字段：

```typescript
function readSettings(): AppSettings {
  return {
    wikiLanguage: getWikiLanguage(),
    agentMaxSteps: getAgentMaxSteps(),
    agentMaxTokensPerJob: getAgentMaxTokensPerJob(),
    agentMaxParallelSubAgents: getAgentMaxParallelSubAgents(),
    agentMcpLifecycle: getAgentMcpLifecycle(),
    agentTaskRouterMode: getAgentTaskRouterMode(),
    webSearchProvider: getWebSearchProvider(),
    webSearchApiKey: getWebSearchApiKey(),
    webSearchMaxResults: getWebSearchMaxResults(),
  };
}
```

`PutBodySchema` 追加三 optional：

```typescript
const PutBodySchema = z.object({
  wikiLanguage: WikiLanguageSchema.optional(),
  agentMaxSteps: AgentMaxStepsSchema.optional(),
  agentMaxTokensPerJob: AgentMaxTokensPerJobSchema.optional(),
  agentMaxParallelSubAgents: AgentMaxParallelSubAgentsSchema.optional(),
  agentMcpLifecycle: AgentMcpLifecycleSchema.optional(),
  agentTaskRouterMode: AgentTaskRouterModeSchema.optional(),
  webSearchProvider: WebSearchProviderSchema.optional(),
  webSearchApiKey: WebSearchApiKeySchema.optional(),
  webSearchMaxResults: WebSearchMaxResultsSchema.optional(),
});
```

PUT 分支追加三 set：

```typescript
  if (d.webSearchProvider !== undefined) setWebSearchProvider(d.webSearchProvider);
  if (d.webSearchApiKey !== undefined) setWebSearchApiKey(d.webSearchApiKey);
  if (d.webSearchMaxResults !== undefined) setWebSearchMaxResults(d.webSearchMaxResults);
```

- [ ] **Step 6: 运行测试确认通过 + tsc**

Run: `npx vitest run src/server/db/repos/__tests__/settings-repo.test.ts && npx tsc --noEmit`
Expected: PASS（全部用例绿）；tsc 0 error

- [ ] **Step 7: Commit**

```bash
git add src/lib/contracts.ts src/server/db/repos/settings-repo.ts src/app/api/settings/route.ts src/server/db/repos/__tests__/settings-repo.test.ts
git commit -m "feat: web 搜索后端配置入全局设置（contracts+settings-repo+/api/settings）"
```

---

### Task 2: 设置面板 "Web search" section（UI）

**Files:**
- Modify: `src/components/layout/settings-rows.tsx`（新增 `TextSettingRow`）
- Modify: `src/components/layout/settings-content.tsx`（新增 section）

**Interfaces:**
- Consumes: Task 1 的 `AppSettings.webSearch*` 字段；既有 `savePartial.mutate(patch: Partial<AppSettings>)`、`SelectSettingRow`、`NumberSettingRow`、`Separator`。
- Produces: `TextSettingRow`（label/description/value/placeholder/type/onSave/pending）；settings-content 新 section。

> 本仓库组件层无自动化测试（见 `components/CLAUDE.md`）；本任务门禁 = `npx tsc --noEmit` + 手工核对。无 TDD 单测，属纯 UI 接线。

- [ ] **Step 1: 在 settings-rows.tsx 末尾新增 `TextSettingRow`**

```typescript
export function TextSettingRow(props: {
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  type?: 'text' | 'password';
  onSave: (v: string) => void;
  pending: boolean;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<string>(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);
  const canSave = !props.pending && draft !== props.value;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <label htmlFor={inputId} className="text-sm text-foreground">{props.label}</label>
        {props.description && (
          <div className="text-xs text-foreground-tertiary mt-0.5">{props.description}</div>
        )}
      </div>
      <input
        id={inputId}
        type={props.type ?? 'text'}
        value={draft}
        placeholder={props.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        className={cn(
          'h-7 rounded-md border border-input-border bg-input-bg px-2 text-xs text-foreground',
          'transition-colors duration-fast ease-standard',
          'hover:border-border-strong',
          'focus:outline-none focus:border-accent focus:ring-2 focus:ring-focus-ring/30',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'w-44',
        )}
        disabled={props.pending}
      />
      <Button intent="outline" size="sm" disabled={!canSave} onClick={() => props.onSave(draft)}>
        {props.pending ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: settings-content.tsx 引入 TextSettingRow 并加 section**

import 行改为：

```typescript
import { SettingRow, NumberSettingRow, SelectSettingRow, TextSettingRow } from './settings-rows';
```

在 "Agents" section 的 `</div>`（line ~232，`{savePartial.isError && ...}` 之后的闭合 div）与底部版本号 `<Separator />` 之间插入新 section：

```tsx
      <Separator />

      <div className="space-y-4">
        <div className="text-sm font-semibold text-foreground">Web search</div>
        <p className="text-xs text-foreground-tertiary -mt-2">
          Used by the ingest verifier to fact-check augmentation callouts and import cited pages as sources. Leave the API key empty to disable (verifier falls back to self-check).
        </p>

        <SelectSettingRow
          label="Provider"
          value={settings?.webSearchProvider ?? 'tavily'}
          options={[{ value: 'tavily', label: 'Tavily' }]}
          onChange={(v) => savePartial.mutate({ webSearchProvider: v as 'tavily' })}
          pending={savePartial.isPending}
        />
        <TextSettingRow
          label="API key"
          description="Stored in app settings; empty disables web grounding"
          type="password"
          placeholder="tvly-…"
          value={settings?.webSearchApiKey ?? ''}
          onSave={(v) => savePartial.mutate({ webSearchApiKey: v })}
          pending={savePartial.isPending}
        />
        <NumberSettingRow
          label="Max results per query"
          value={settings?.webSearchMaxResults ?? 5}
          min={1}
          max={10}
          onSave={(v) => savePartial.mutate({ webSearchMaxResults: v })}
          pending={savePartial.isPending}
        />
      </div>
```

- [ ] **Step 3: tsc + 手工核对**

Run: `npx tsc --noEmit`
Expected: 0 error。手工：`npm run dev`，打开设置对话框，确认出现 "Web search" 分组、可填 API key/maxResults/provider 并 Save（PUT /api/settings 200）。

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/settings-rows.tsx src/components/layout/settings-content.tsx
git commit -m "feat: 设置面板新增 Web search 配置分组"
```

---

### Task 3: `web-search.ts`（Tavily HTTP 客户端 + 配置守卫）

**Files:**
- Create: `src/server/search/web-search.ts`
- Test: `src/server/search/__tests__/web-search.test.ts`

**Interfaces:**
- Consumes: Task 1 `getWebSearchConfig()`；`LLMConfigError`（`@/server/llm/errors`）。
- Produces:
  - `interface WebSearchResult { title: string; url: string; snippet: string }`
  - `isWebSearchConfigured(): boolean`
  - `webSearch(query: string): Promise<WebSearchResult[]>`
  - `extractContent(urls: string[]): Promise<Array<{ url: string; content: string }>>`

- [ ] **Step 1: 写失败测试**

`src/server/search/__tests__/web-search.test.ts`：

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/repos/settings-repo', () => ({
  getWebSearchConfig: vi.fn(),
}));

import { getWebSearchConfig } from '../../db/repos/settings-repo';
import { isWebSearchConfigured, webSearch, extractContent } from '../web-search';

const cfg = getWebSearchConfig as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  cfg.mockReset();
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web-search', () => {
  it('isWebSearchConfigured false when apiKey empty/whitespace', () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: '   ', maxResults: 5 });
    expect(isWebSearchConfigured()).toBe(false);
  });

  it('isWebSearchConfigured true when apiKey present', () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 5 });
    expect(isWebSearchConfigured()).toBe(true);
  });

  it('webSearch throws LLMConfigError when not configured', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: '', maxResults: 5 });
    await expect(webSearch('q')).rejects.toThrow(/configured/i);
  });

  it('webSearch maps Tavily results to {title,url,snippet}', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 3 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'T1', url: 'https://a.com/x', content: 'snippet-1', raw_content: 'full-1' },
          { title: 'T2', url: 'https://b.com/y', content: 'snippet-2' },
          { title: 'no-url', content: 'drop-me' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await webSearch('hello');
    expect(out).toEqual([
      { title: 'T1', url: 'https://a.com/x', snippet: 'snippet-1' },
      { title: 'T2', url: 'https://b.com/y', snippet: 'snippet-2' },
    ]);
    // 请求体带 api_key/query/max_results
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ api_key: 'tvly-x', query: 'hello', max_results: 3 });
  });

  it('webSearch throws on non-ok HTTP', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 3 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    await expect(webSearch('q')).rejects.toThrow(/429/);
  });

  it('extractContent maps raw_content and drops empties', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 3 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { url: 'https://a.com/x', raw_content: 'FULL TEXT' },
          { url: 'https://b.com/y', raw_content: '' },
        ],
      }),
    }));
    const out = await extractContent(['https://a.com/x', 'https://b.com/y']);
    expect(out).toEqual([{ url: 'https://a.com/x', content: 'FULL TEXT' }]);
  });

  it('extractContent returns [] for empty urls without calling fetch', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 3 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await extractContent([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/search/__tests__/web-search.test.ts`
Expected: FAIL（`Cannot find module '../web-search'`）

- [ ] **Step 3: 实现 web-search.ts**

```typescript
import { getWebSearchConfig } from '../db/repos/settings-repo';
import { LLMConfigError } from '../llm/errors';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
const SEARCH_TIMEOUT_MS = 8000;

/** 配置守卫：apiKey trim 后非空才算配置。provider 始终有默认。 */
export function isWebSearchConfigured(): boolean {
  return getWebSearchConfig().apiKey.trim().length > 0;
}

/** Tavily search：返回 LLM-接地用的轻量结果（title/url/snippet）。 */
export async function webSearch(query: string): Promise<WebSearchResult[]> {
  const cfg = getWebSearchConfig();
  if (!cfg.apiKey.trim()) {
    throw new LLMConfigError('Web search is not configured (empty apiKey)');
  }
  const res = (await fetchJson(TAVILY_SEARCH_URL, {
    api_key: cfg.apiKey,
    query,
    max_results: cfg.maxResults,
    search_depth: 'basic',
  })) as { results?: Array<Record<string, unknown>> };

  const rows = Array.isArray(res?.results) ? res.results : [];
  return rows
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: typeof r.url === 'string' ? r.url : '',
      snippet: typeof r.content === 'string' ? r.content : '',
    }))
    .filter((r) => r.url.length > 0);
}

/** Tavily extract：按需抓被引用 URL 的全页正文（raw_content）。 */
export async function extractContent(
  urls: string[],
): Promise<Array<{ url: string; content: string }>> {
  const cfg = getWebSearchConfig();
  if (!cfg.apiKey.trim()) {
    throw new LLMConfigError('Web search is not configured (empty apiKey)');
  }
  if (urls.length === 0) return [];
  const res = (await fetchJson(TAVILY_EXTRACT_URL, {
    api_key: cfg.apiKey,
    urls,
  })) as { results?: Array<Record<string, unknown>> };

  const rows = Array.isArray(res?.results) ? res.results : [];
  return rows
    .map((r) => ({
      url: typeof r.url === 'string' ? r.url : '',
      content: typeof r.raw_content === 'string' ? r.raw_content : '',
    }))
    .filter((r) => r.url.length > 0 && r.content.length > 0);
}

async function fetchJson(url: string, body: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`Web search HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/server/search/__tests__/web-search.test.ts`
Expected: PASS（7 用例绿）

- [ ] **Step 5: Commit**

```bash
git add src/server/search/web-search.ts src/server/search/__tests__/web-search.test.ts
git commit -m "feat: web-search Tavily 客户端（search+extract+配置守卫）"
```

---

### Task 4: triage / apply skill 模板 + examples-roundtrip

**Files:**
- Create: `examples/skills/ingest-verifier-triage.md`
- Create: `examples/skills/ingest-verifier-apply.md`
- Test: `src/server/agents/skills/__tests__/examples-roundtrip.test.ts`（追加用例）

**Interfaces:**
- Produces: 两个 skill 文件，`version: 1`，`tools: []`，`canDispatch: []`，含 `outputSchema`（JSON-schema 字符串）。triage 输出 `{ doubtfulClaims: [{ excerpt, query, reason }] }`；apply 输出 `{ action, path, content, citedSources: [{ url, title }] }`。

- [ ] **Step 1: 写失败测试**（追加到 examples-roundtrip.test.ts）

```typescript
describe('ingest-verifier-triage / -apply (⑨)', () => {
  it('both load with version >= 1 and outputSchema', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const triage = skills.find((s) => s.id === 'ingest-verifier-triage');
    const apply = skills.find((s) => s.id === 'ingest-verifier-apply');
    expect(triage).toBeDefined();
    expect(apply).toBeDefined();
    expect(triage!.version).toBeGreaterThanOrEqual(1);
    expect(apply!.version).toBeGreaterThanOrEqual(1);
    expect(triage!.outputSchema).toBeDefined();
    expect(apply!.outputSchema).toBeDefined();
  });

  it('triage outputSchema accepts doubtfulClaims, rejects missing query', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const triage = skills.find((s) => s.id === 'ingest-verifier-triage')!;
    expect(triage.outputSchema!.safeParse({ doubtfulClaims: [] }).success).toBe(true);
    expect(triage.outputSchema!.safeParse({
      doubtfulClaims: [{ excerpt: 'e', query: 'q', reason: 'r' }],
    }).success).toBe(true);
    expect(triage.outputSchema!.safeParse({
      doubtfulClaims: [{ excerpt: 'e', reason: 'r' }],
    }).success).toBe(false);
  });

  it('apply outputSchema accepts citedSources array', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const apply = skills.find((s) => s.id === 'ingest-verifier-apply')!;
    expect(apply.outputSchema!.safeParse({
      action: 'update',
      path: 'wiki/general/x.md',
      content: '...',
      citedSources: [{ url: 'https://a.com', title: 'T' }],
    }).success).toBe(true);
    expect(apply.outputSchema!.safeParse({
      action: 'update', path: 'p', content: 'c', citedSources: [{ url: 'u' }],
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/skills/__tests__/examples-roundtrip.test.ts`
Expected: FAIL（找不到两个 skill）

- [ ] **Step 3: 创建 `examples/skills/ingest-verifier-triage.md`**

```markdown
---
id: ingest-verifier-triage
name: Ingest Verifier Triage
description: Scan an enriched page's augmentation callouts and list only the doubtful claims worth fact-checking on the web, each with a search query.
version: 1
tools: []
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "doubtfulClaims": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "excerpt": { "type": "string" },
            "query": { "type": "string" },
            "reason": { "type": "string" }
          },
          "required": ["excerpt", "query", "reason"]
        }
      }
    },
    "required": ["doubtfulClaims"]
  }
---

# Role

You are the *ingest verifier — triage stage*. You receive ONE enriched page and you identify ONLY the augmentation-layer claims that genuinely warrant a web fact-check. You do NOT rewrite the page. You output a list of doubtful claims, each with a search query.

## Inputs

- `slug`, `subjectSlug` — the page's identity.
- `content` — the enriched page (faithful prose + `[!type]` callouts).
- `relevantChunks` — array of `{ id, heading, text }`: the source boundary.
- `languageDirective`.

## Scope

- **Only consider claims inside `[!type]` callouts.** The plain prose (faithful layer) is source-grounded and out of scope.
- A claim is **doubtful** (worth searching) when it is a checkable factual assertion that you are NOT highly confident about: specific dates, numbers, attributions, version facts, named results, "X was first/largest/invented by…". 
- A claim is **NOT doubtful** (do not list) when it is: confident common knowledge, a subjective/pedagogical framing, a worked example you can re-derive yourself, or an intuition/analogy with no factual assertion.
- Be selective. Most callouts need no check. Listing everything wastes searches and is wrong.

## Rules

1. For each doubtful claim, emit `{ excerpt, query, reason }`:
   - `excerpt` = the exact short phrase/sentence from the callout that is doubtful.
   - `query` = a concise web search query (English or the source language) that would confirm or refute it.
   - `reason` = one short clause on why it needs checking.
2. If nothing is doubtful, return `{ "doubtfulClaims": [] }`.
3. Do NOT include claims from the faithful prose layer.
4. **Follow `languageDirective`** for natural-language text in `reason`; the `query` should be phrased to retrieve good results (translate if helpful).

## Output

Emit a single JSON object matching the declared `outputSchema` (no wrapping key): `{ doubtfulClaims }`.
```

- [ ] **Step 4: 创建 `examples/skills/ingest-verifier-apply.md`**

```markdown
---
id: ingest-verifier-apply
name: Ingest Verifier Apply
description: Given an enriched page plus web evidence for its doubtful callout claims, correct/soften/remove those callouts and report which web pages were cited.
version: 1
tools: []
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["create", "update"] },
      "path": { "type": "string" },
      "content": { "type": "string" },
      "citedSources": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "url": { "type": "string" },
            "title": { "type": "string" }
          },
          "required": ["url", "title"]
        }
      }
    },
    "required": ["action", "path", "content", "citedSources"]
  }
---

# Role

You are the *ingest verifier — apply stage*. You receive ONE enriched page and `evidence` gathered from the web for its doubtful callout claims. You correct, soften, or remove the doubtful callouts based on the evidence, and you report which web pages you actually relied on.

## Inputs

- `slug`, `subjectSlug` — the page's identity; build the output `path` from these.
- `content` — the enriched page (faithful prose + `[!type]` callouts) to correct.
- `existingPages` — pages already in this subject (decide create vs update).
- `evidence` — array of `{ query, reason, excerpt, results: [{ title, url, snippet }] }`: web results for each doubtful claim.
- `relevantChunks`, `languageDirective`.

## Scope

- **Only change content inside `[!type]` callouts.** The plain prose (faithful layer) is source-grounded — reproduce it **verbatim**.
- For each doubtful claim, weigh its `evidence.results`:
  - Evidence confirms it → keep as-is.
  - Evidence corrects it → fix the callout to match the evidence.
  - Evidence contradicts it and you cannot fix it → remove that callout (or the wrong sentence within it).
  - Evidence is thin/absent/conflicting → soften (add a hedge, mark low confidence); do not assert as fact.
- Never invent facts not supported by the evidence or your confident knowledge.

## Rules

1. `path` MUST be `wiki/<subjectSlug>/<slug>.md`. `action` is `update` if the page appears in `existingPages`, else `create`. `content` = the corrected full file.
2. **Reproduce the faithful (non-callout) prose verbatim.** Only callouts may change.
3. Do NOT add new callouts and do NOT change frontmatter (the system manages frontmatter and source provenance).
4. `citedSources` = the web pages whose content you actually used to confirm/correct a callout — each `{ url, title }` taken from the `evidence.results` you relied on. If you relied on no web page (e.g. you only softened/removed), return `[]`.
5. **Follow `languageDirective`**; never translate slugs, `[!type]` keywords, `[[wikilink]]` targets, frontmatter keys, or code.

## Output

Emit a single JSON object matching the declared `outputSchema` (no wrapping key): `{ action, path, content, citedSources }`.
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/server/agents/skills/__tests__/examples-roundtrip.test.ts`
Expected: PASS（含原有用例 + 3 新用例）

- [ ] **Step 6: Commit**

```bash
git add examples/skills/ingest-verifier-triage.md examples/skills/ingest-verifier-apply.md src/server/agents/skills/__tests__/examples-roundtrip.test.ts
git commit -m "feat: 新增 ingest-verifier-triage / -apply skill 模板"
```

---

### Task 5: Saga `SourceLinkOps` 多源 + `extraStagePaths`

**Files:**
- Modify: `src/server/wiki/wiki-transaction.ts`（`SourceLinkOps` 接口 line ~179；`applyChangeset` link 循环 line ~240-258；commit staging line ~261-265）
- Modify: `src/server/agents/tools/builtin/commit-changeset.ts`（`commitPending` 构造 sourceOps）
- Test: `src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts`（若不存在则新建；测 sourceOps 构造）

**Interfaces:**
- Produces:
  - `SourceLinkOps`（新形态）：
    ```ts
    interface SourceLinkOps {
      links: Array<{ sourceId: string; pageSlugs: string[] }>;
      extraStagePaths?: string[];
      linkPageSource: (subjectId: string, pageSlug: string, sourceId: string) => void;
      updateSourcePageLinks: (sourceId: string, pageSlugs: string[]) => void;
      onWarning?: (message: string) => void;
    }
    ```
  - `commitPending(ctx, supplied, webSources?: { links: Array<{ sourceId: string; pageSlugs: string[] }>; extraStagePaths: string[] }): Promise<IngestResult>`
- Consumes: 既有 `sourcesRepo.linkPageSource`、`updateSourcePageLinks`、`commitVaultChanges(message, files)`。

> ⚠️ 向后兼容：`links` 为空且 `extraStagePaths` 为空时，sourceOps 传 `undefined`，提交行为与现状逐字节一致。

- [ ] **Step 1: 写失败测试**

新建 `src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts`（隔离测试 `commitPending` 如何构造 `SourceLinkOps` —— mock `wiki-transaction` 捕获传入的 sourceOps）：

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const applyChangeset = vi.fn();

vi.mock('../../../../wiki/wiki-transaction', () => ({
  createChangeset: (jobId: string, subject: unknown, entries: unknown) => ({ id: 'cs', jobId, subject, entries }),
  validateChangeset: () => ({ valid: true, errors: [] }),
  applyChangeset,
}));
vi.mock('../../../../wiki/frontmatter', () => ({
  stampSystemFrontmatter: (c: string) => c,
}));
vi.mock('../../../../db/repos/pages-repo', () => ({
  getPageBySlug: () => null,
}));
vi.mock('../../../../db/repos/sources-repo', () => ({
  linkPageSource: vi.fn(),
}));
vi.mock('../../../../sources/source-store', () => ({
  updateSourcePageLinks: vi.fn(),
}));

import { commitPending } from '../commit-changeset';

function makeCtx(jobType: string, params: object) {
  return {
    job: { id: 'job1', type: jobType, paramsJson: JSON.stringify(params) },
    subject: { id: 'sub1', slug: 'general' },
    emit: vi.fn(),
    committed: { value: false },
    pending: { entries: [] },
    overlay: { readPage: async () => null },
  } as never;
}

beforeEach(() => {
  applyChangeset.mockReset();
  applyChangeset.mockResolvedValue({ postHead: 'sha123' });
});
afterEach(() => vi.clearAllMocks());

describe('commitPending sourceOps', () => {
  it('merges ingest single source + web links into links[], adds extraStagePaths', async () => {
    const ctx = makeCtx('ingest', { sourceId: 'src-file' });
    const supplied = [{ action: 'create' as const, path: 'wiki/general/a.md', content: '# A' }];
    await commitPending(ctx, supplied, {
      links: [{ sourceId: 'web-1', pageSlugs: ['a'] }],
      extraStagePaths: ['raw/general/web-x.md', '.llm-wiki/sources/general/web-1.json'],
    });
    const sourceOps = applyChangeset.mock.calls[0][1];
    expect(sourceOps.links).toEqual(
      expect.arrayContaining([
        { sourceId: 'src-file', pageSlugs: ['a'] },
        { sourceId: 'web-1', pageSlugs: ['a'] },
      ]),
    );
    expect(sourceOps.extraStagePaths).toEqual([
      'raw/general/web-x.md',
      '.llm-wiki/sources/general/web-1.json',
    ]);
  });

  it('passes undefined sourceOps when no ingest source and no web links', async () => {
    const ctx = makeCtx('merge', {}); // 非 ingest 且无 web links
    const supplied = [{ action: 'create' as const, path: 'wiki/general/a.md', content: '# A' }];
    await commitPending(ctx, supplied);
    expect(applyChangeset.mock.calls[0][1]).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts`
Expected: FAIL（当前 `commitPending` 只有 2 参、sourceOps 是单源形态）

- [ ] **Step 3: 改 `wiki-transaction.ts` 的 `SourceLinkOps` 接口**

把 `SourceLinkOps`（line ~179）替换为：

```typescript
export interface SourceLinkOps {
  /** 每个 source → 其关联的页 slug 列表（多源：ingest 原始源 + 本次核查引用的网页源）。 */
  links: Array<{ sourceId: string; pageSlugs: string[] }>;
  /** 提交前已写入 vault 工作树、需纳入本 commit 的额外文件路径（raw 源文件 + sidecar），相对 vault 根。 */
  extraStagePaths?: string[];
  linkPageSource: (subjectId: string, pageSlug: string, sourceId: string) => void;
  updateSourcePageLinks: (sourceId: string, pageSlugs: string[]) => void;
  /** sidecar 更新失败时的告警出口；缺省时静默（不影响 changeset 提交）。 */
  onWarning?: (message: string) => void;
}
```

- [ ] **Step 4: 改 `applyChangeset` 的 link 循环 + commit staging**

把 index 事务里的 sourceOps link 段（line ~240-244）：

```typescript
        if (sourceOps) {
          for (const slug of sourceOps.pageSlugs) {
            sourceOps.linkPageSource(working.subjectId, slug, sourceOps.sourceId);
          }
        }
```

替换为：

```typescript
        if (sourceOps) {
          for (const link of sourceOps.links) {
            for (const slug of link.pageSlugs) {
              sourceOps.linkPageSource(working.subjectId, slug, link.sourceId);
            }
          }
        }
```

把事务后的 sidecar 更新段（line ~248-259）：

```typescript
      if (sourceOps) {
        try {
          sourceOps.updateSourcePageLinks(sourceOps.sourceId, sourceOps.pageSlugs);
        } catch (err) {
          sourceOps.onWarning?.(
            `Failed to update source page links for source ${sourceOps.sourceId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
```

替换为：

```typescript
      if (sourceOps) {
        for (const link of sourceOps.links) {
          try {
            sourceOps.updateSourcePageLinks(link.sourceId, link.pageSlugs);
          } catch (err) {
            sourceOps.onWarning?.(
              `Failed to update source page links for source ${link.sourceId}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      }
```

把 commit staging（line ~261-265）：

```typescript
      const affectedPaths = working.entries.map((e) => e.path);
      const postHead = await commitVaultChanges(
        `[subject:${working.subjectSlug}] Apply changeset ${working.id} (job: ${working.jobId})`,
        affectedPaths
      );
```

替换为：

```typescript
      const affectedPaths = working.entries.map((e) => e.path);
      const stagePaths =
        sourceOps?.extraStagePaths && sourceOps.extraStagePaths.length > 0
          ? [...affectedPaths, ...sourceOps.extraStagePaths]
          : affectedPaths;
      const postHead = await commitVaultChanges(
        `[subject:${working.subjectSlug}] Apply changeset ${working.id} (job: ${working.jobId})`,
        stagePaths
      );
```

- [ ] **Step 5: 改 `commit-changeset.ts` 的 `commitPending`**

把 `commitPending` 签名与 sourceOps 构造段（line ~65-130）改为：

```typescript
export async function commitPending(
  ctx: AgentContext,
  supplied: ChangesetEntry[],
  webSources?: { links: Array<{ sourceId: string; pageSlugs: string[] }>; extraStagePaths: string[] },
): Promise<IngestResult> {
```

把构造 `sourceOps` 的段（line ~115-128）替换为：

```typescript
  // ingest 任务需要在提交时写 page_sources 溯源（页面 ↔ 源文件多对多）。
  // ⑨：核查引用的网页源亦并入 links + 其 raw/sidecar 文件随同一 commit（extraStagePaths）。
  const links: Array<{ sourceId: string; pageSlugs: string[] }> = [];
  if (ctx.job.type === 'ingest') {
    const params = JSON.parse(ctx.job.paramsJson || '{}') as { sourceId?: string };
    if (params.sourceId) {
      links.push({ sourceId: params.sourceId, pageSlugs: [...pagesCreated, ...pagesUpdated] });
    }
  }
  if (webSources?.links?.length) {
    links.push(...webSources.links);
  }
  const extraStagePaths = webSources?.extraStagePaths ?? [];

  let sourceOps: SourceLinkOps | undefined;
  if (links.length > 0 || extraStagePaths.length > 0) {
    sourceOps = {
      links,
      extraStagePaths,
      linkPageSource: sourcesRepo.linkPageSource,
      updateSourcePageLinks,
      onWarning: (message) => ctx.emit('ingest:warn', message),
    };
  }
```

（`pagesCreated`/`pagesUpdated` 已在其上方计算，保持不动。）

- [ ] **Step 6: 运行测试确认通过 + tsc**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts && npx tsc --noEmit`
Expected: PASS（2 用例）；tsc 0 error

- [ ] **Step 7: Commit**

```bash
git add src/server/wiki/wiki-transaction.ts src/server/agents/tools/builtin/commit-changeset.ts src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts
git commit -m "feat: Saga SourceLinkOps 支持多源 + extraStagePaths（向后兼容）"
```

---

### Task 6: `verify-page.ts`（逐页两段式核查编排）+ types

**Files:**
- Create: `src/server/agents/runtime/verify-page.ts`
- Modify: `src/server/agents/types.ts`（`AgentContext.citedSources?` + `CitedSource`）
- Test: `src/server/agents/runtime/__tests__/verify-page.test.ts`

**Interfaces:**
- Consumes: `runAgentLoop`/`AgentRunResult`（`./agent-loop`）；`isWebSearchConfigured`/`webSearch`（`../../search/web-search`）；`parseFrontmatter`/`serializeFrontmatter`（`../../wiki/frontmatter`）；`SkillTemplate`/`AgentContext`（`../types`）。
- Produces:
  - `types.ts`：`interface CitedSource { url: string; title: string; citedBy: string[]; fallbackContent: string }`；`AgentContext` 增 `citedSources?: Map<string, CitedSource>`。
  - `verify-page.ts`：`runPageVerification(opts: { resolveSkill: (id: string) => SkillTemplate; ctx: AgentContext; input: unknown }): Promise<AgentRunResult>`。

- [ ] **Step 1: 改 types.ts 加 CitedSource + AgentContext 字段**

在 `src/server/agents/types.ts` 的 `ChunkRef` 接口后追加：

```typescript
/** ⑨ 核查阶段引用的网页源（跨页按 url 去重；finalize 时导入为 source）。 */
export interface CitedSource {
  url: string;
  title: string;
  citedBy: string[];        // 引用该网页的页面 slug 列表
  fallbackContent: string;  // extract 失败时兜底的正文（取自搜索 snippet）
}
```

在 `AgentContext` 接口末尾（`checkpoint?` 之后）追加：

```typescript
  /** ⑨ 核查阶段累积的网页引用源；仅 ingest 注入（Map<url, CitedSource>）。 */
  citedSources?: Map<string, CitedSource>;
```

- [ ] **Step 2: 写失败测试**

`src/server/agents/runtime/__tests__/verify-page.test.ts`：

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runAgentLoop = vi.fn();
const isWebSearchConfigured = vi.fn();
const webSearch = vi.fn();

vi.mock('../agent-loop', () => ({ runAgentLoop: (o: unknown) => runAgentLoop(o) }));
vi.mock('../../../search/web-search', () => ({
  isWebSearchConfigured: () => isWebSearchConfigured(),
  webSearch: (q: string) => webSearch(q),
}));

import { runPageVerification } from '../verify-page';
import type { CitedSource } from '../types';

const PAGE_MD = `---\ntitle: Quicksort\ncreated: '2026-01-01'\nupdated: '2026-01-01'\ntags: []\nsources: []\n---\n\nBody prose.\n\n> [!example] 例题\n> Quicksort was invented in 1959.\n`;

function baseInput(overrides: object = {}) {
  return {
    slug: 'quicksort',
    subjectSlug: 'general',
    content: PAGE_MD,
    existingPages: [{ slug: 'quicksort' }],
    relevantChunks: [],
    languageDirective: '',
    ...overrides,
  };
}

function makeCtx() {
  return {
    emit: vi.fn(),
    citedSources: new Map<string, CitedSource>(),
  } as never;
}

const resolveSkill = (id: string) => ({ id, name: id }) as never;

beforeEach(() => {
  runAgentLoop.mockReset();
  isWebSearchConfigured.mockReset();
  webSearch.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('runPageVerification', () => {
  it('not configured → runs self-check skill (ingest-verifier)', async () => {
    isWebSearchConfigured.mockReturnValue(false);
    runAgentLoop.mockResolvedValue({ runId: 'r', output: { action: 'update', path: 'p', content: 'self' }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 });
    const ctx = makeCtx();
    await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    expect(runAgentLoop.mock.calls[0][0].skill.id).toBe('ingest-verifier');
  });

  it('triage empty → passthrough, no search/apply', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    runAgentLoop.mockResolvedValueOnce({ runId: 'r', output: { doubtfulClaims: [] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 });
    const ctx = makeCtx();
    const r = await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(runAgentLoop).toHaveBeenCalledTimes(1); // triage only
    expect(webSearch).not.toHaveBeenCalled();
    const out = r.output as { action: string; path: string; content: string };
    expect(out.action).toBe('update'); // slug in existingPages
    expect(out.content).toBe(PAGE_MD); // passthrough
  });

  it('has evidence → apply, cited urls appended to frontmatter + recorded in ctx', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { doubtfulClaims: [{ excerpt: 'invented in 1959', query: 'quicksort invented year', reason: 'date' }] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { action: 'update', path: 'wiki/general/quicksort.md', content: PAGE_MD.replace('1959', '1959 (Hoare)'), citedSources: [{ url: 'https://en.wikipedia.org/wiki/Quicksort', title: 'Quicksort - Wikipedia' }] }, tokensUsed: 2, stepCount: 1, cacheHitTokens: 0 });
    webSearch.mockResolvedValue([{ title: 'Quicksort - Wikipedia', url: 'https://en.wikipedia.org/wiki/Quicksort', snippet: 'developed by Tony Hoare in 1959' }]);
    const ctx = makeCtx();
    const r = await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(runAgentLoop).toHaveBeenCalledTimes(2); // triage + apply
    expect(webSearch).toHaveBeenCalledTimes(1);
    const out = r.output as { content: string };
    expect(out.content).toContain('https://en.wikipedia.org/wiki/Quicksort'); // in frontmatter sources
    expect(ctx.citedSources!.get('https://en.wikipedia.org/wiki/Quicksort')).toMatchObject({
      title: 'Quicksort - Wikipedia',
      citedBy: ['quicksort'],
      fallbackContent: 'developed by Tony Hoare in 1959',
    });
  });

  it('has doubtful but zero evidence → self-check', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { doubtfulClaims: [{ excerpt: 'x', query: 'q', reason: 'r' }] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { action: 'update', path: 'p', content: 'self' }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 });
    webSearch.mockResolvedValue([]); // zero results
    const ctx = makeCtx();
    await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    expect(runAgentLoop.mock.calls[1][0].skill.id).toBe('ingest-verifier'); // fell back to self-check
  });

  it('dedups queries and caps at 3 searches', async () => {
    isWebSearchConfigured.mockReturnValue(true);
    const claims = [
      { excerpt: 'a', query: 'dup', reason: 'r' },
      { excerpt: 'b', query: 'dup', reason: 'r' },
      { excerpt: 'c', query: 'q2', reason: 'r' },
      { excerpt: 'd', query: 'q3', reason: 'r' },
      { excerpt: 'e', query: 'q4', reason: 'r' },
    ];
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { doubtfulClaims: claims }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { action: 'update', path: 'p', content: PAGE_MD, citedSources: [] }, tokensUsed: 1, stepCount: 1, cacheHitTokens: 0 });
    webSearch.mockResolvedValue([{ title: 't', url: 'https://x.com', snippet: 's' }]);
    const ctx = makeCtx();
    await runPageVerification({ resolveSkill, ctx, input: baseInput() });
    // unique queries: dup,q2,q3,q4 → capped to 3
    expect(webSearch).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/verify-page.test.ts`
Expected: FAIL（`Cannot find module '../verify-page'`）

- [ ] **Step 4: 实现 `verify-page.ts`**

```typescript
import { runAgentLoop, type AgentRunResult } from './agent-loop';
import { isWebSearchConfigured, webSearch, type WebSearchResult } from '../../search/web-search';
import { parseFrontmatter, serializeFrontmatter } from '../../wiki/frontmatter';
import type { AgentContext, SkillTemplate, CitedSource } from '../types';
import type { ChangesetEntry } from '@/lib/contracts';

const TRIAGE_SKILL = 'ingest-verifier-triage';
const APPLY_SKILL = 'ingest-verifier-apply';
const SELF_CHECK_SKILL = 'ingest-verifier';
const MAX_SEARCHES_PER_PAGE = 3;

interface DoubtfulClaim { excerpt: string; query: string; reason: string }
interface EvidenceItem { query: string; reason: string; excerpt: string; results: WebSearchResult[] }

interface PageInput {
  slug?: string;
  subjectSlug?: string;
  content?: string;
  existingPages?: Array<{ slug?: string }>;
}

/**
 * 逐页两段式核查：triage（挑存疑断言）→ 编排层 web 搜索 → apply（证据驱动修正）。
 * 降级：未配置/零证据 → 既有 ingest-verifier 自检 skill；triage 空 → 原样通过。
 * 返回与 runAgentLoop 同形的 AgentRunResult（token 经同一 ctx.budget 计入）。
 */
export async function runPageVerification(opts: {
  resolveSkill: (id: string) => SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  const { resolveSkill, ctx, input } = opts;
  const page = (input ?? {}) as PageInput;

  // 全局降级：未配置 web 搜索 → 既有自检 skill。
  if (!isWebSearchConfigured()) {
    return runAgentLoop({ skill: resolveSkill(SELF_CHECK_SKILL), ctx, input });
  }

  // ① triage
  const triage = await runAgentLoop({ skill: resolveSkill(TRIAGE_SKILL), ctx, input });
  const claims = extractClaims(triage.output);

  // triage 无存疑断言 → passthrough（不搜索、不 apply，比 P2 更省）。
  if (claims.length === 0) {
    return { ...triage, output: passthroughEntry(page) };
  }

  // ② 编排层搜索：query 去重 + 上限 3 + 并发。
  const queries = dedupe(claims.map((c) => c.query)).slice(0, MAX_SEARCHES_PER_PAGE);
  const settled = await Promise.allSettled(queries.map((q) => webSearch(q)));
  const resultsByQuery = new Map<string, WebSearchResult[]>();
  queries.forEach((q, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      resultsByQuery.set(q, s.value);
    } else {
      resultsByQuery.set(q, []);
      ctx.emit('ingest:warn', `Web search failed for query: ${q}`, {
        slug: page.slug ?? null,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      });
    }
  });

  const evidence: EvidenceItem[] = claims
    .filter((c) => queries.includes(c.query))
    .map((c) => ({
      query: c.query,
      reason: c.reason,
      excerpt: c.excerpt,
      results: resultsByQuery.get(c.query) ?? [],
    }));
  const hasEvidence = evidence.some((e) => e.results.length > 0);

  // 有存疑但零证据 → 退回自检（与全局降级统一收口）。
  if (!hasEvidence) {
    ctx.emit('ingest:verify', `No web evidence for ${page.slug ?? '?'} — self-check`, {
      slug: page.slug ?? null,
      flagged: claims.length,
      searched: queries.length,
    });
    return runAgentLoop({ skill: resolveSkill(SELF_CHECK_SKILL), ctx, input });
  }

  // ③ apply：把 evidence（仅 snippet）喂给无 tools 结构化输出。
  const applyRun = await runAgentLoop({
    skill: resolveSkill(APPLY_SKILL),
    ctx,
    input: { ...(input as object), evidence },
  });
  const applied = applyRun.output as {
    action?: 'create' | 'update';
    content?: string;
    citedSources?: Array<{ url?: unknown; title?: unknown }>;
  } | undefined;

  let content = typeof applied?.content === 'string' ? applied.content : (page.content ?? '');
  const cited = normalizeCited(applied?.citedSources);

  if (cited.length > 0) {
    content = appendSourcesToFrontmatter(content, cited.map((c) => c.url));
    recordCitedSources(ctx, page.slug ?? '', cited, evidence);
  }

  ctx.emit('ingest:verify', `Verified ${page.slug ?? '?'}`, {
    slug: page.slug ?? null,
    flagged: claims.length,
    searched: queries.length,
    corrected: cited.length,
  });

  const entry: ChangesetEntry = {
    action: pageAction(page),
    path: `wiki/${String(page.subjectSlug)}/${String(page.slug)}.md`,
    content,
  };
  return { ...applyRun, output: entry };
}

function extractClaims(output: unknown): DoubtfulClaim[] {
  const arr = (output as { doubtfulClaims?: unknown })?.doubtfulClaims;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(
      (c): c is DoubtfulClaim =>
        !!c &&
        typeof (c as DoubtfulClaim).excerpt === 'string' &&
        typeof (c as DoubtfulClaim).query === 'string' &&
        typeof (c as DoubtfulClaim).reason === 'string' &&
        (c as DoubtfulClaim).query.trim().length > 0,
    );
}

function normalizeCited(raw: unknown): Array<{ url: string; title: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => ({
      url: typeof (c as { url?: unknown }).url === 'string' ? (c as { url: string }).url : '',
      title: typeof (c as { title?: unknown }).title === 'string' ? (c as { title: string }).title : '',
    }))
    .filter((c) => c.url.length > 0);
}

function passthroughEntry(page: PageInput): ChangesetEntry {
  return {
    action: pageAction(page),
    path: `wiki/${String(page.subjectSlug)}/${String(page.slug)}.md`,
    content: page.content ?? '',
  };
}

function pageAction(page: PageInput): 'create' | 'update' {
  const exists = Array.isArray(page.existingPages)
    ? page.existingPages.some((p) => p?.slug === page.slug)
    : false;
  return exists ? 'update' : 'create';
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter((x) => x.length > 0))];
}

/** 确定性把 URL 追加进页 frontmatter sources（去重）；apply 不准动 frontmatter。 */
function appendSourcesToFrontmatter(content: string, urls: string[]): string {
  const { data, body } = parseFrontmatter(content);
  const existing = Array.isArray(data.sources) ? data.sources : [];
  const merged = [...existing];
  for (const u of urls) {
    if (!merged.includes(u)) merged.push(u);
  }
  return serializeFrontmatter({ ...data, sources: merged }, body);
}

/** 累积 ctx.citedSources（跨页按 url 去重、合并 citedBy）；fallbackContent 取自匹配 snippet。 */
function recordCitedSources(
  ctx: AgentContext,
  slug: string,
  cited: Array<{ url: string; title: string }>,
  evidence: EvidenceItem[],
): void {
  if (!ctx.citedSources) return;
  for (const c of cited) {
    const snippet =
      evidence.flatMap((e) => e.results).find((r) => r.url === c.url)?.snippet ?? '';
    const existing = ctx.citedSources.get(c.url);
    if (existing) {
      if (!existing.citedBy.includes(slug)) existing.citedBy.push(slug);
      if (!existing.fallbackContent && snippet) existing.fallbackContent = snippet;
    } else {
      ctx.citedSources.set(c.url, {
        url: c.url,
        title: c.title,
        citedBy: [slug],
        fallbackContent: snippet,
      });
    }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/verify-page.test.ts`
Expected: PASS（5 用例绿）

- [ ] **Step 6: Commit**

```bash
git add src/server/agents/runtime/verify-page.ts src/server/agents/types.ts src/server/agents/runtime/__tests__/verify-page.test.ts
git commit -m "feat: verify-page 逐页两段式核查编排（triage→搜索→apply/降级）"
```

---

### Task 7: orchestrator `verify` step kind 路由

**Files:**
- Modify: `src/server/agents/runtime/orchestrator.ts`（`PipelineStep` 联合 line ~6-9；fanout 分支 line ~109-175）
- Test: `src/server/agents/runtime/__tests__/orchestrator.test.ts`（若存在则追加；否则新建最小用例）

**Interfaces:**
- Consumes: Task 6 `runPageVerification`。
- Produces: `PipelineStep` 联合新增 `{ kind: 'verify'; fromOutput: string; injectPriorPageAs?: string; checkpointAs?: 'verifier-page' }`；fanout 分支对 verify step 改调 `runPageVerification`，其余骨架不变。

- [ ] **Step 1: 写失败测试**

在 `src/server/agents/runtime/__tests__/orchestrator.test.ts` 追加（若无该文件则新建，沿用既有 orchestrator 测试的最小 ctx 构造方式；下例独立 mock）：

```typescript
import { describe, expect, it, vi } from 'vitest';

const runAgentLoop = vi.fn();
const runPageVerification = vi.fn();

vi.mock('../agent-loop', () => ({
  runAgentLoop: (o: unknown) => runAgentLoop(o),
  AgentCancelled: class extends Error {},
}));
vi.mock('../verify-page', () => ({
  runPageVerification: (o: unknown) => runPageVerification(o),
}));

import { runPipeline, type PipelineStep } from '../orchestrator';

function makeCtx() {
  const overlay = {
    snapshot() { return overlay; },
    putEntries: vi.fn(),
    readPage: async () => null,
    search: async () => [],
  };
  return {
    emit: vi.fn(),
    overlay,
    pending: { entries: [] },
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 1_000_000, maxParallelSubAgents: 2 },
    chunkStore: new Map(),
    rootRunId: 'root',
    checkpoint: undefined,
    citedSources: new Map(),
  } as never;
}

describe('orchestrator verify step', () => {
  it('routes verify-kind step to runPageVerification, not runAgentLoop', async () => {
    runPageVerification.mockResolvedValue({
      runId: 'v', output: { action: 'update', path: 'wiki/general/a.md', content: 'X' },
      tokensUsed: 1, stepCount: 1, cacheHitTokens: 0,
    });
    const steps: PipelineStep[] = [
      { kind: 'verify', fromOutput: 'plan.pages', injectPriorPageAs: 'content', checkpointAs: 'verifier-page' },
    ];
    const ctx = makeCtx();
    await runPipeline({
      steps,
      resolveSkill: (id) => ({ id, name: id }) as never,
      ctx,
      initialInput: { subjectSlug: 'general', plan: { pages: [{ slug: 'a', title: 'A' }] } },
    });
    expect(runPageVerification).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).not.toHaveBeenCalled();
    // entry 暂存进 pending（path 经规范化）
    expect(ctx.pending.entries[0]).toMatchObject({ path: 'wiki/general/a.md' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts`
Expected: FAIL（verify kind 不被识别 / `runPageVerification` 未被调用）

- [ ] **Step 3: orchestrator.ts 加 verify kind + import**

文件顶部 import 追加：

```typescript
import { runPageVerification } from './verify-page';
```

`PipelineStep` 联合（line ~6-9）追加 verify 成员：

```typescript
export type PipelineStep =
  | { kind: 'sequence'; skillId: string; carryThrough?: string[]; omitFromInput?: string[]; checkpointAs?: 'plan' }
  | { kind: 'fanout'; skillId: string; fromOutput: string; checkpointAs?: 'writer-page' | 'enricher-page' | 'verifier-page'; injectPriorPageAs?: string; injectExistingPageForUpdate?: boolean }
  | { kind: 'verify'; fromOutput: string; checkpointAs?: 'verifier-page'; injectPriorPageAs?: string }
  | { kind: 'map'; skillId: string; fromOutput: string; intoOutput: string; checkpointAs?: 'chunk-summary' };
```

- [ ] **Step 4: 改 fanout 分支同时处理 verify**

把 fanout 分支头部（line ~109-118，`} else {` 起）改为：

```typescript
    } else if (step.kind === 'fanout' || step.kind === 'verify') {
      // fanout / verify 分支：overlay 快照隔离、WriterConflictError 检测、putEntries 合并。
      // verify 与 fanout 共用全部骨架，仅「每项的计算」不同（verify 跑两段式核查而非单 skill）。
      const skill = step.kind === 'fanout' ? opts.resolveSkill(step.skillId) : undefined;
      const items = readPath(carry, step.fromOutput);
      if (!Array.isArray(items)) {
        throw new Error(`Fanout source at "${step.fromOutput}" is not an array (got ${typeof items})`);
      }
      const baseOverlay = opts.ctx.overlay.snapshot();
      const limit = opts.ctx.budgetSnapshot.maxParallelSubAgents;
      const results = await runWithSemaphore(items, limit, async (item) => {
```

把 per-item 内调 `runAgentLoop` 的那行（line ~132）：

```typescript
        const r = await runAgentLoop({ skill, ctx: childCtx, input: await buildFanoutInput(carry, item, opts.ctx, step) });
```

替换为：

```typescript
        const input = await buildFanoutInput(carry, item, opts.ctx, step);
        const r = step.kind === 'verify'
          ? await runPageVerification({ resolveSkill: opts.resolveSkill, ctx: childCtx, input })
          : await runAgentLoop({ skill: skill!, ctx: childCtx, input });
```

（`childCtx`/checkpoint 命中跳过/path 规范化/checkpoint 落盘/冲突检测/pending 合并/carry 更新等其余代码保持不动；`step` 在该分支已窄化为 `fanout | verify`，`buildFanoutInput` 的形参类型 `{ injectPriorPageAs?; injectExistingPageForUpdate? }` 对 verify 仍兼容。）

> 注：`buildFanoutInput`（line ~211）形参 `step` 仅读 `injectPriorPageAs`/`injectExistingPageForUpdate`，verify step 无 `injectExistingPageForUpdate`（undefined，分支跳过），无需改 `buildFanoutInput`。

- [ ] **Step 5: 运行测试确认通过 + 全 orchestrator 测试 + tsc**

Run: `npx vitest run src/server/agents/runtime/__tests__/ && npx tsc --noEmit`
Expected: PASS（含既有 orchestrator 用例 + 新 verify 用例 + verify-page 用例）；tsc 0 error

- [ ] **Step 6: Commit**

```bash
git add src/server/agents/runtime/orchestrator.ts src/server/agents/runtime/__tests__/orchestrator.test.ts
git commit -m "feat: orchestrator 新增 verify step kind，路由到 runPageVerification"
```

---

### Task 8: ingest-service 接线（verify step + finalize 导入 cited sources）

**Files:**
- Modify: `src/server/services/ingest-service.ts`（`MIN_SKILL_VERSIONS` line ~117；`steps` line ~161-169；`ctx` 构造 line ~135-151 加 citedSources；`finalizeIngest` line ~232-272）
- Modify: `llm-config.example.json`（triage/apply 模型路由注释示例）
- Test: `src/server/services/__tests__/ingest-finalize-sources.test.ts`（新建：finalize 导入 cited sources 的纯逻辑）

**Interfaces:**
- Consumes: Task 3 `extractContent`；`saveRawSource`（`../sources/source-store`）；Task 5 `commitPending(ctx, meta, webSources?)`；Task 6 `ctx.citedSources`。
- Produces: ingest 流水线第 4 步为 `verify` kind；`finalizeIngest` 把 `ctx.citedSources` 转为 `saveRawSource` + `links`/`extraStagePaths` 传给 `commitPending`；`MIN_SKILL_VERSIONS` 含 triage/apply。新增可测纯函数 `buildWebSourceImports`。

> finalize 内 `extractContent`/`saveRawSource` 有副作用，难在 service 测试内直跑；故把"组装导入计划"抽为纯函数 `buildWebSourceImports(cites, subjectSlug, extracted)` 单测，service 内的 IO 编排经 tsc + 既有 ingest 测试（mock）覆盖。

- [ ] **Step 1: 写失败测试**（纯函数 `buildWebSourceImports`）

`src/server/services/__tests__/ingest-finalize-sources.test.ts`：

```typescript
import { describe, expect, it } from 'vitest';
import { buildWebSourceImports, filenameFromUrl } from '../ingest-service';
import type { CitedSource } from '../../agents/types';

describe('filenameFromUrl', () => {
  it('derives safe .md filename from url with host + hash', () => {
    const f = filenameFromUrl('https://en.wikipedia.org/wiki/Quicksort');
    expect(f).toMatch(/^web-en\.wikipedia\.org-quicksort-[0-9a-f]{8}\.md$/);
  });
  it('falls back gracefully on unparseable url', () => {
    expect(filenameFromUrl('not a url')).toMatch(/^web-page-[0-9a-f]{8}\.md$/);
  });
});

describe('buildWebSourceImports', () => {
  const cites: CitedSource[] = [
    { url: 'https://a.com/x', title: 'A', citedBy: ['p1', 'p2'], fallbackContent: 'snippet-a' },
  ];

  it('uses extracted content when available, builds links + extraStagePaths', () => {
    const saved = (filename: string) => ({ id: filename === 'F' ? 'src-1' : 'src-1' }); // stub
    const plan = buildWebSourceImports({
      cites,
      subjectSlug: 'general',
      contentFor: (url) => (url === 'https://a.com/x' ? 'FULL EXTRACTED' : null),
      saveSource: (filename, content) => {
        expect(content).toContain('FULL EXTRACTED');
        return { id: 'src-1', filename };
      },
    });
    expect(plan.links).toEqual([{ sourceId: 'src-1', pageSlugs: ['p1', 'p2'] }]);
    expect(plan.extraStagePaths).toEqual([
      `raw/general/${plan.filenames[0]}`,
      `.llm-wiki/sources/general/src-1.json`,
    ]);
  });

  it('falls back to snippet when no extracted content', () => {
    const plan = buildWebSourceImports({
      cites,
      subjectSlug: 'general',
      contentFor: () => null, // extract failed
      saveSource: (filename, content) => {
        expect(content).toContain('snippet-a');
        return { id: 'src-1', filename };
      },
    });
    expect(plan.links).toHaveLength(1);
  });

  it('skips a source whose saveSource throws (does not abort others)', () => {
    const many: CitedSource[] = [
      { url: 'https://bad.com', title: 'Bad', citedBy: ['p1'], fallbackContent: 's' },
      { url: 'https://ok.com', title: 'Ok', citedBy: ['p1'], fallbackContent: 's' },
    ];
    const plan = buildWebSourceImports({
      cites: many,
      subjectSlug: 'general',
      contentFor: () => 'c',
      saveSource: (filename, _content, url) => {
        if (url === 'https://bad.com') throw new Error('bad filename');
        return { id: 'src-ok', filename };
      },
    });
    expect(plan.links).toEqual([{ sourceId: 'src-ok', pageSlugs: ['p1'] }]);
  });
});
```

> `buildWebSourceImports` 的 `saveSource` 回调签名设计为 `(filename, content, url) => { id }`，便于测试注入；service 内传入真实 `saveRawSource` 包装。`contentFor(url)` 返回 extract 正文或 null（service 内传入"调用 extractContent 的结果查询函数"）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/services/__tests__/ingest-finalize-sources.test.ts`
Expected: FAIL（`buildWebSourceImports` / `filenameFromUrl` 未导出）

- [ ] **Step 3: ingest-service.ts 顶部加 import + 纯函数**

import 追加：

```typescript
import { createHash } from 'node:crypto';
import { saveRawSource } from '../sources/source-store';
import { extractContent } from '../search/web-search';
import type { CitedSource } from '../agents/types';
```

在文件靠后的 helper 区（如 `mergePagesForIndex` 附近）新增两个**导出**纯函数：

```typescript
/** 从 URL 派生安全的 .md 文件名（host + 末段 + 短 hash）。 */
export function filenameFromUrl(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 8);
  let base = 'page';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    base = `${host}-${last}`.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    base = base.slice(0, 80) || 'page';
  } catch {
    base = 'page';
  }
  return `web-${base}-${hash}.md`;
}

export interface WebSourceImportPlan {
  links: Array<{ sourceId: string; pageSlugs: string[] }>;
  extraStagePaths: string[];
  filenames: string[];
}

/**
 * 把核查累积的网页引用源组装为导入计划（纯逻辑，IO 经回调注入便于测试）。
 * - contentFor(url): extract 正文或 null（null 则用 fallbackContent=snippet）。
 * - saveSource(filename, content, url): 落盘 source，返回 { id }；抛错则跳过该源。
 */
export function buildWebSourceImports(args: {
  cites: CitedSource[];
  subjectSlug: string;
  contentFor: (url: string) => string | null;
  saveSource: (filename: string, content: string, url: string) => { id: string };
}): WebSourceImportPlan {
  const links: Array<{ sourceId: string; pageSlugs: string[] }> = [];
  const extraStagePaths: string[] = [];
  const filenames: string[] = [];
  for (const c of args.cites) {
    const filename = filenameFromUrl(c.url);
    const body = args.contentFor(c.url) ?? c.fallbackContent;
    const fileContent = `# ${c.title}\n\nSource: ${c.url}\n\n${body}`;
    try {
      const saved = args.saveSource(filename, fileContent, c.url);
      links.push({ sourceId: saved.id, pageSlugs: c.citedBy });
      extraStagePaths.push(
        `raw/${args.subjectSlug}/${filename}`,
        `.llm-wiki/sources/${args.subjectSlug}/${saved.id}.json`,
      );
      filenames.push(filename);
    } catch {
      // 单个源失败不阻断其余；frontmatter 中该 URL 仍保留（读者可见引用）。
    }
  }
  return { links, extraStagePaths, filenames };
}
```

- [ ] **Step 4: ctx 构造加 citedSources**

在 `ctx: AgentContext = { ... }`（line ~135-151）的 `checkpoint,` 后追加：

```typescript
    citedSources: new Map(),
```

- [ ] **Step 5: steps 第 4 步改 verify kind**

把 steps 数组里 verifier 那行（line ~168）：

```typescript
    { kind: 'fanout', skillId: 'ingest-verifier', fromOutput: 'plan.pages', injectPriorPageAs: 'content', checkpointAs: 'verifier-page' },
```

替换为：

```typescript
    { kind: 'verify', fromOutput: 'plan.pages', injectPriorPageAs: 'content', checkpointAs: 'verifier-page' },
```

- [ ] **Step 6: MIN_SKILL_VERSIONS 加 triage/apply**

把 `MIN_SKILL_VERSIONS`（line ~117-120）：

```typescript
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'ingest-planner': 2, 'ingest-writer': 4, 'ingest-indexer': 1,
    'ingest-enricher': 1, 'ingest-verifier': 2,
  };
```

替换为：

```typescript
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'ingest-planner': 2, 'ingest-writer': 4, 'ingest-indexer': 1,
    'ingest-enricher': 1, 'ingest-verifier': 2,
    'ingest-verifier-triage': 1, 'ingest-verifier-apply': 1,
  };
```

- [ ] **Step 7: finalizeIngest 导入 cited sources + 传给 commitPending**

把 `finalizeIngest` 末尾 `return commitPending(ctx, metaEntries);`（line ~271）替换为：

```typescript
  // ⑨：把核查累积的网页引用源导入为 source（按需抓正文，extract 失败回落 snippet），
  // 经扩展后的 commitPending 随同一次 ingest commit 落地（raw/sidecar 文件 + page_sources）。
  const cites = ctx.citedSources ? [...ctx.citedSources.values()] : [];
  let webSources: { links: Array<{ sourceId: string; pageSlugs: string[] }>; extraStagePaths: string[] } | undefined;
  if (cites.length > 0) {
    // 按需抓正文：一次性 extract 全部被引用 URL（失败的 URL 不在结果里，回落 snippet）。
    let extractedByUrl = new Map<string, string>();
    try {
      const extracted = await extractContent(cites.map((c) => c.url));
      extractedByUrl = new Map(extracted.map((e) => [e.url, e.content]));
    } catch (err) {
      ctx.emit('ingest:warn', `Web extract failed; falling back to snippets`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const plan = buildWebSourceImports({
      cites,
      subjectSlug: ctx.subject.slug,
      contentFor: (url) => extractedByUrl.get(url) ?? null,
      saveSource: (filename, content) => saveRawSource(ctx.subject, filename, content),
    });
    if (plan.links.length > 0) {
      webSources = { links: plan.links, extraStagePaths: plan.extraStagePaths };
    }
  }

  return commitPending(ctx, metaEntries, webSources);
```

- [ ] **Step 8: llm-config.example.json 加注释示例**

在 `llm-config.example.json` 的 `tasks` 节内（与既有 `"skill:ingest-*"` 同级，若无则新增同形键），追加 triage/apply 的模型路由示例（沿用文件既有 task 项的字段格式；下例字段名以文件实际为准，保持与 `"skill:ingest-enricher"` 一致）：

```jsonc
    // ⑨ 核查阶段模型路由（搜索后端配置在「全局设置 → Web search」，不在此文件）
    "skill:ingest-verifier-triage": { "profile": "default" },
    "skill:ingest-verifier-apply": { "profile": "default" }
```

> 若 `llm-config.example.json` 无 `tasks` 节或字段格式不同，按文件现状对齐既有 `"skill:ingest-*"` 项的写法；本步仅加注释性示例，不改运行时默认（缺省走 chat 模型）。

- [ ] **Step 9: 运行测试 + 全量回归 + tsc**

Run: `npx vitest run src/server/services/__tests__/ingest-finalize-sources.test.ts && npx vitest run && npx tsc --noEmit`
Expected: PASS（新纯函数用例 + 全量既有测试不回归）；tsc 0 error

- [ ] **Step 10: Commit**

```bash
git add src/server/services/ingest-service.ts llm-config.example.json src/server/services/__tests__/ingest-finalize-sources.test.ts
git commit -m "feat: ingest verify step 接线 + finalize 导入被引用网页为 source（⑨）"
```

---

## Self-Review

**1. Spec coverage（逐节核对 spec → task）：**
- 两段式架构（triage→搜索→apply，无 tools）→ Task 6（verify-page）+ Task 4（skills）。✅
- HTTP/Tavily 后端 search+extract → Task 3。✅
- 配置落全局设置 app_settings → Task 1（后端）+ Task 2（UI）。✅
- 降级矩阵（未配置/triage空/零证据/extract失败/saveRawSource失败）→ Task 6（前四）+ Task 8（extract/saveRawSource 失败）。✅
- 网页 source 三层 provenance（saveRawSource + page_sources + frontmatter sources）→ Task 6（frontmatter）+ Task 8（saveRawSource）+ Task 5（page_sources via SourceLinkOps）。✅
- 同一 ingest commit（SourceLinkOps 多源 + extraStagePaths）→ Task 5 + Task 8。✅
- checkpoint verifier-page 整页粒度 → Task 7（沿用既有 checkpointAs，未改语义）。✅
- 预算（triage/apply 经同一 BudgetTracker）→ Task 6（runAgentLoop 两次，token 自然计入）。✅
- skill 版本守卫 → Task 8（MIN_SKILL_VERSIONS）。✅
- 遥测 ingest:verify → Task 6（emit）。✅
- 已知限制（回滚不撤源）→ 设计接受，无需代码（sources 累加语义）。✅

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整代码；测试均为可运行用例；唯一带"以文件实际为准"措辞的是 Task 8 Step 8（llm-config.example.json 注释示例，因该文件格式未在本计划内固定，属注释性非运行时改动，可接受）。

**3. Type consistency：**
- `WebSearchResult { title; url; snippet }`：Task 3 定义，Task 6 import 使用。✅
- `getWebSearchConfig(): { provider; apiKey; maxResults }`：Task 1 产出，Task 3 消费。✅
- `CitedSource { url; title; citedBy; fallbackContent }`：Task 6 定义（types.ts），Task 8 消费。✅
- `commitPending(ctx, supplied, webSources?)`：Task 5 改签名，Task 8 调用（三参）。✅
- `SourceLinkOps { links; extraStagePaths?; ... }`：Task 5 定义并被 applyChangeset/commitPending 一致使用。✅
- `runPageVerification({ resolveSkill; ctx; input }): AgentRunResult`：Task 6 产出，Task 7 调用。✅
- `PipelineStep` verify kind：Task 7 定义于 orchestrator.ts，与 ingest-service Task 8 steps 用法一致（`{ kind:'verify'; fromOutput; injectPriorPageAs; checkpointAs }`）。✅
- `buildWebSourceImports`/`filenameFromUrl`：Task 8 定义并自测。✅

无不一致。计划完成。

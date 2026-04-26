# Wiki Language Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single global *Wiki language* setting that the user edits from the existing left-sidebar settings dialog. Persist it server-side in SQLite so the worker process can read it. Inject it as an `OUTPUT LANGUAGE` directive into every LLM user prompt that produces wiki content (ingest plan, page body, index, query answer, lint findings) — without translating slugs, `[[wikilinks]]`, frontmatter keys, or code.

**Architecture:**
1. **Server-side persistence = SQLite `app_settings` table** (key/value). One row per setting; today only `wikiLanguage` lives there. Default `"English"` when the row is absent. The worker reads it fresh at the start of every LLM service call (no startup caching), so changes from the UI take effect on the next ingest/query/lint without restarting the worker.
2. **REST contract.** `GET /api/settings` returns `{ wikiLanguage: string }`. `PUT /api/settings` writes it (auth + CSRF + zod body). Both sit under `src/app/api/settings/route.ts`.
3. **UI.** Existing left-sidebar settings dialog (`src/components/layout/settings-dialog.tsx`, opened from `sidebar.tsx:246`) gains a "Wiki language" row: text input + Save button, fetched via TanStack Query and saved via mutation. We do NOT mirror it into Zustand — server is the only source of truth and the dialog is the only place it's edited.
4. **Prompt assembly.** New shared module `src/server/llm/prompts/prompt-context.ts` exports `PromptContext = { language: string; subject?: SubjectContextLite }` and `renderLanguageDirective(language)`. Each user-prompt builder (5 total: plan, pageBody, index, query, lint) replaces its trailing `subject?` parameter with `ctx: PromptContext` and prepends the directive.

**Tech Stack:** TypeScript 5, zod 3, Drizzle ORM 0.38 + better-sqlite3, Vercel AI SDK 4, TanStack React Query 5. Tests: **vitest** (newly added — first tests in the repo).

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `vitest.config.ts` | Create | Minimal vitest setup — node env, path alias |
| `package.json` | Modify | Add `vitest` devDep + `test` / `test:watch` scripts |
| `src/server/db/schema.ts` | Modify | Add `appSettings` table (`key` PK, `value` text, `updatedAt` text) |
| `drizzle/<timestamp>_app_settings.sql` | Generated | Drizzle-kit migration for the new table |
| `src/server/db/repos/settings-repo.ts` | Create | `getWikiLanguage()`, `setWikiLanguage(value)`, `DEFAULT_WIKI_LANGUAGE` |
| `src/server/llm/prompts/prompt-context.ts` | Create | `PromptContext` interface + `renderLanguageDirective(language)` |
| `src/server/llm/prompts/ingest-prompt.ts` | Modify | 3 builders take `ctx: PromptContext`; emit language directive |
| `src/server/llm/prompts/query-prompt.ts` | Modify | builder takes `ctx`; emit directive |
| `src/server/llm/prompts/lint-prompt.ts` | Modify | builder takes `ctx`; emit directive |
| `src/server/services/ingest-service.ts` | Modify | Read `getWikiLanguage()`; pass `PromptContext` to builders |
| `src/server/services/query-service.ts` | Modify | Same |
| `src/server/services/lint-service.ts` | Modify | Same |
| `src/app/api/settings/route.ts` | Create | GET (auth) + PUT (auth + CSRF) for `wikiLanguage` |
| `src/lib/contracts.ts` | Modify | Export `AppSettings` type + `WikiLanguage` zod-validated string alias |
| `src/components/layout/settings-dialog.tsx` | Modify | Add "Wiki language" row with `useQuery` + `useMutation` |
| `src/server/llm/prompts/__tests__/prompt-context.test.ts` | Create | Test directive content |
| `src/server/llm/prompts/__tests__/ingest-prompt.test.ts` | Create | Test all 3 ingest builders embed the language |
| `src/server/llm/prompts/__tests__/query-prompt.test.ts` | Create | Test query builder embeds language |
| `src/server/llm/prompts/__tests__/lint-prompt.test.ts` | Create | Test lint builder embeds language |
| `CLAUDE.md` | Modify | Changelog row |
| `src/server/db/CLAUDE.md` | Modify | Document `appSettings` table & repo |
| `src/server/llm/CLAUDE.md` | Modify | Document `PromptContext` + language directive |
| `src/components/CLAUDE.md` | Modify | Note `wikiLanguage` row in settings dialog |

---

### Task 0: Set up vitest test infrastructure

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install vitest as a devDependency**

Run:
```bash
npm install --save-dev vitest@^2.1.0
```

Expected: `package.json` `devDependencies` gains `"vitest": "^2.1.0"`; `package-lock.json` updates.

- [ ] **Step 2: Add the `test` scripts to `package.json`**

Open `package.json`. Inside the `"scripts"` object, after `"db:migrate-subjects": "tsx scripts/migrate-introduce-subject.ts"`, append:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

Make sure the comma after `"db:migrate-subjects"` value is added so the JSON stays valid.

- [ ] **Step 3: Create `vitest.config.ts` at repo root**

Create `/Users/nickhopps/Documents/playground/agentic-wiki/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
```

- [ ] **Step 4: Verify the runner starts**

Run:
```bash
npm test
```

Expected: vitest prints `No test files found` (exit 0 or 1, both acceptable). No compile error, no module-resolution error.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore(test): scaffold vitest for unit tests"
```

---

### Task 1: Add `app_settings` table, settings-repo, and Drizzle migration

**Files:**
- Modify: `src/server/db/schema.ts` (new `appSettings` table)
- Create: `src/server/db/repos/settings-repo.ts`
- Modify: `src/lib/contracts.ts` (export `AppSettings` type)
- Generated: `drizzle/*_app_settings.sql` (via `npm run db:generate`)

> No unit test for the repo — testing it cleanly requires a temp DB harness, which we'll defer. Confidence comes from `tsc`, manual SQLite inspection (Step 6), and the end-to-end smoke in Task 9.

- [ ] **Step 1: Add the `appSettings` table to the Drizzle schema**

Open `src/server/db/schema.ts`. After the existing `subjects` table (around line 16) and **before** the `pages` table, insert:

```ts
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type AppSettingsRow = typeof appSettings.$inferSelect;
```

> Schema rationale: a generic key/value table beats one column per setting because future settings can be added without further migrations, and writes can use a single upsert path.

- [ ] **Step 2: Generate the Drizzle migration**

Run:
```bash
npm run db:generate
```

Expected: drizzle-kit creates `drizzle/0000_<random>_app_settings.sql` (or `0001_*` if other migrations exist) containing `CREATE TABLE app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);`. Inspect it; if it includes unrelated changes, fix the schema and re-run.

- [ ] **Step 3: Apply the migration against the local DB**

Run:
```bash
npm run db:migrate
```

Expected: drizzle-kit applies the migration to `data/wiki.db` without error.

- [ ] **Step 4: Add a `wikiLanguage` zod schema + type to `contracts.ts`**

Open `src/lib/contracts.ts`. Append (or insert near other domain types):

```ts
import { z } from 'zod';

export const DEFAULT_WIKI_LANGUAGE = 'English';

export const WikiLanguageSchema = z
  .string()
  .trim()
  .min(1, 'Wiki language must be a non-empty language name (e.g. "English", "Chinese", "日本語")')
  .max(64, 'Wiki language must be 64 characters or fewer');

export interface AppSettings {
  wikiLanguage: string;
}

export const AppSettingsSchema = z.object({
  wikiLanguage: WikiLanguageSchema,
});
```

> If `contracts.ts` already imports `zod`, reuse the existing import — do NOT duplicate.

- [ ] **Step 5: Create the settings repository**

Create `src/server/db/repos/settings-repo.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { appSettings } from '@/server/db/schema';
import { DEFAULT_WIKI_LANGUAGE, WikiLanguageSchema } from '@/lib/contracts';

const KEY_WIKI_LANGUAGE = 'wikiLanguage';

function readKey(key: string): string | undefined {
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get();
  return row?.value;
}

function writeKey(key: string, value: string): void {
  const now = new Date().toISOString();
  db.insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now },
    })
    .run();
}

/**
 * Returns the configured wiki language. Falls back to DEFAULT_WIKI_LANGUAGE
 * when no row has been written yet. Reads the DB on every call so changes
 * made via the settings dialog take effect on the next LLM task without a
 * worker restart.
 */
export function getWikiLanguage(): string {
  return readKey(KEY_WIKI_LANGUAGE) ?? DEFAULT_WIKI_LANGUAGE;
}

/**
 * Persists a new wiki language. Validates via WikiLanguageSchema (throws on
 * empty/whitespace/over-long input). Caller is responsible for any further
 * authorization checks.
 */
export function setWikiLanguage(value: string): string {
  const validated = WikiLanguageSchema.parse(value);
  writeKey(KEY_WIKI_LANGUAGE, validated);
  return validated;
}
```

> If the existing `db/client.ts` exports the singleton under a different name (e.g. `getDb()`), adapt the import accordingly. Same for the Drizzle SQL helper imports — match what other repos in `src/server/db/repos/` use.

- [ ] **Step 6: Manual smoke test of the repo**

Run an ad-hoc node command to verify read/write round-trip:

```bash
node --import tsx -e "
import('./src/server/db/repos/settings-repo.ts').then(m => {
  console.log('initial:', m.getWikiLanguage());
  m.setWikiLanguage('Chinese');
  console.log('after set:', m.getWikiLanguage());
  m.setWikiLanguage('English');
  console.log('reset:', m.getWikiLanguage());
});"
```

Expected output:
```
initial: English
after set: Chinese
reset: English
```

- [ ] **Step 7: TypeScript check**

Run: `npx tsc --noEmit`

Expected: 0 new errors related to settings-repo / appSettings / AppSettings. Pre-existing errors elsewhere are out of scope.

- [ ] **Step 8: Commit**

```bash
git add src/server/db/schema.ts src/lib/contracts.ts \
        src/server/db/repos/settings-repo.ts drizzle/
git commit -m "feat(db): add app_settings table + settings-repo for wikiLanguage"
```

---

### Task 2: Create the shared `PromptContext` module + language directive

**Files:**
- Create: `src/server/llm/prompts/prompt-context.ts`
- Create: `src/server/llm/prompts/__tests__/prompt-context.test.ts`

- [ ] **Step 1: Write the failing prompt-context test**

Create `src/server/llm/prompts/__tests__/prompt-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderLanguageDirective } from '../prompt-context';

describe('renderLanguageDirective', () => {
  it('embeds the language name in the directive', () => {
    const out = renderLanguageDirective('Chinese');
    expect(out).toContain('Chinese');
  });

  it('explicitly forbids translating slugs / wikilinks / frontmatter keys / code', () => {
    const out = renderLanguageDirective('Japanese');
    expect(out).toMatch(/slug/i);
    expect(out).toMatch(/wikilink|\[\[/i);
    expect(out).toMatch(/frontmatter/i);
    expect(out).toMatch(/code/i);
  });

  it('starts with a clear OUTPUT LANGUAGE marker', () => {
    const out = renderLanguageDirective('English');
    expect(out.split('\n')[0]).toMatch(/OUTPUT LANGUAGE/);
  });

  it('renders deterministically for the same input', () => {
    expect(renderLanguageDirective('English')).toBe(renderLanguageDirective('English'));
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- src/server/llm/prompts/__tests__/prompt-context.test.ts`

Expected: FAIL with "Cannot find module '../prompt-context'".

- [ ] **Step 3: Create the module**

Create `src/server/llm/prompts/prompt-context.ts`:

```ts
/**
 * Per-call context shared by every wiki-generation prompt builder.
 *
 * `language` is required and globally configured via the settings dialog
 * (persisted to the `app_settings` table; read via `settings-repo.getWikiLanguage()`).
 * `subject` is optional and per-call; when present the builder also emits
 * subject-scoping rules.
 */
export interface PromptContext {
  language: string;
  subject?: SubjectContextLite;
}

/**
 * Structural-only mirror of the SubjectContext shape used by individual
 * prompt files. Decouples this module from any one prompt file's interface.
 */
export interface SubjectContextLite {
  slug: string;
  name: string;
  description?: string;
}

/**
 * Renders a strongly-worded "OUTPUT LANGUAGE" block for the top of a user
 * prompt. Forbids translating identifiers (slugs, wikilink targets,
 * frontmatter keys, code), since translating them would silently break the
 * wiki graph.
 */
export function renderLanguageDirective(language: string): string {
  return [
    '=== OUTPUT LANGUAGE ===',
    `All natural-language content (page bodies, summaries, descriptions, log entries, citations, lint findings) MUST be written in **${language}**.`,
    '',
    'Do NOT translate or alter:',
    '- Slugs / page identifiers (kebab-case ASCII)',
    '- [[wikilink]] target names — keep them byte-for-byte identical to existing pages',
    '- Frontmatter keys (e.g. `title`, `tags`, `aliases`)',
    '- Code blocks and inline `code`',
    '- Proper nouns, library names, and APIs that have no idiomatic translation',
    '',
    `If the source document is in a different language, translate the substantive content into ${language} for the wiki, but preserve identifiers as above.`,
    '=== END OUTPUT LANGUAGE ===',
  ].join('\n');
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- src/server/llm/prompts/__tests__/prompt-context.test.ts`

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/llm/prompts/prompt-context.ts \
        src/server/llm/prompts/__tests__/prompt-context.test.ts
git commit -m "feat(llm): add PromptContext + renderLanguageDirective"
```

---

### Task 3: Inject language directive into the three ingest builders

**Files:**
- Modify: `src/server/llm/prompts/ingest-prompt.ts`
- Create: `src/server/llm/prompts/__tests__/ingest-prompt.test.ts`

> The three builders are `buildPlanUserPrompt`, `buildPageBodyUserPrompt`, `buildIndexUserPrompt`. Each currently has signature `(...args, subject?: SubjectContext)`. The new signature replaces the trailing `subject?` with `ctx: PromptContext`. Subject-scoping rendering is unchanged — `ctx.subject` substitutes for the old `subject` arg.

- [ ] **Step 1: Write the failing ingest test**

Create `src/server/llm/prompts/__tests__/ingest-prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildPlanUserPrompt,
  buildPageBodyUserPrompt,
  buildIndexUserPrompt,
} from '../ingest-prompt';
import type { PromptContext } from '../prompt-context';

const ctxEnglish: PromptContext = { language: 'English' };
const ctxChinese: PromptContext = {
  language: 'Chinese',
  subject: { slug: 'general', name: 'General', description: '' },
};

describe('ingest prompt builders – language directive', () => {
  it('buildPlanUserPrompt prepends OUTPUT LANGUAGE with the configured language', () => {
    const out = buildPlanUserPrompt('source text', [], ctxChinese);
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
    expect(out).toContain('Chinese');
    expect(out).toContain('source text');
  });

  it('buildPageBodyUserPrompt embeds the language directive', () => {
    const out = buildPageBodyUserPrompt(
      { slug: 'foo', title: 'Foo', summary: 's', outline: ['o'], tags: [], sources: [] } as never,
      'source text',
      ['Foo'],
      ctxEnglish,
    );
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('English');
  });

  it('buildIndexUserPrompt embeds the language directive', () => {
    const out = buildIndexUserPrompt(
      [{ slug: 'foo', title: 'Foo' } as never],
      ctxChinese,
    );
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('Chinese');
  });

  it('still renders the subject section when ctx.subject is set', () => {
    const out = buildPlanUserPrompt('source', [], ctxChinese);
    expect(out).toContain('General');
  });

  it('omits the subject section when ctx.subject is undefined', () => {
    const out = buildPlanUserPrompt('source', [], ctxEnglish);
    expect(out).not.toContain('General');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- src/server/llm/prompts/__tests__/ingest-prompt.test.ts`

Expected: FAIL — call signatures do not yet accept `PromptContext`.

- [ ] **Step 3: Update `ingest-prompt.ts` signatures and bodies**

Open `src/server/llm/prompts/ingest-prompt.ts`.

3a) At the top of the file, add the import:

```ts
import { renderLanguageDirective, type PromptContext } from './prompt-context';
```

3b) Find `buildPlanUserPrompt` (around line 217). Change the signature from:

```ts
export function buildPlanUserPrompt(
  sourceText: string,
  existingPages: ExistingPageContext[],
  subject?: SubjectContext,
): string {
```

to:

```ts
export function buildPlanUserPrompt(
  sourceText: string,
  existingPages: ExistingPageContext[],
  ctx: PromptContext,
): string {
```

In the body, replace the existing
```ts
const subjectSection = subject ? `${renderSubjectHeader(subject)}\n\n` : '';
```
with:
```ts
const subjectSection = ctx.subject
  ? `${renderSubjectHeader(ctx.subject as SubjectContext)}\n\n`
  : '';
const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
```

Then prepend `${languageDirective}` to the returned template literal — it must be the very first thing in the output (before `subjectSection`).

3c) Apply the same transformation to `buildPageBodyUserPrompt` (around line 243):
- Replace trailing `subject?: SubjectContext` with `ctx: PromptContext`.
- Use `ctx.subject` for the existing subject branch.
- Compute `languageDirective` the same way and prepend to the returned string.

3d) Apply the same transformation to `buildIndexUserPrompt` (around line 274):
- Same parameter swap.
- Same prepend.

> The cast `ctx.subject as SubjectContext` is deliberate: `PromptContext.subject` is the lighter `SubjectContextLite` shape, and the local `SubjectContext` interface in this file is a structural superset. The cast is safe because `renderSubjectHeader` only reads fields present on both. Mark it explicitly so readers see the deliberate widening.

- [ ] **Step 4: Run the test and confirm all five cases pass**

Run: `npm test -- src/server/llm/prompts/__tests__/ingest-prompt.test.ts`

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/llm/prompts/ingest-prompt.ts \
        src/server/llm/prompts/__tests__/ingest-prompt.test.ts
git commit -m "feat(llm): inject wikiLanguage directive into ingest prompts"
```

---

### Task 4: Inject language directive into the query builder

**Files:**
- Modify: `src/server/llm/prompts/query-prompt.ts`
- Create: `src/server/llm/prompts/__tests__/query-prompt.test.ts`

- [ ] **Step 1: Write the failing query test**

Create `src/server/llm/prompts/__tests__/query-prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildQueryUserPrompt } from '../query-prompt';
import type { PromptContext } from '../prompt-context';

const ctx: PromptContext = {
  language: 'Chinese',
  subject: { slug: 'general', name: 'General', description: '' },
};

describe('buildQueryUserPrompt – language directive', () => {
  it('embeds OUTPUT LANGUAGE with the configured language', () => {
    const out = buildQueryUserPrompt('What is X?', [], ctx);
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('Chinese');
  });

  it('keeps the user question intact', () => {
    const out = buildQueryUserPrompt('What is X?', [], ctx);
    expect(out).toContain('What is X?');
  });

  it('still renders the subject section', () => {
    const out = buildQueryUserPrompt('q', [], ctx);
    expect(out).toContain('General');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/server/llm/prompts/__tests__/query-prompt.test.ts`

Expected: FAIL (signature mismatch).

- [ ] **Step 3: Update `query-prompt.ts`**

Open `src/server/llm/prompts/query-prompt.ts`.

3a) Add import:
```ts
import { renderLanguageDirective, type PromptContext } from './prompt-context';
```

3b) Find `buildQueryUserPrompt` (around line 71). Change the trailing `subject?: SubjectContext` parameter to `ctx: PromptContext`. Inside the body, replace any `subject` references with `ctx.subject`, compute
```ts
const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
```
and prepend it to the returned template literal.

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- src/server/llm/prompts/__tests__/query-prompt.test.ts`

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/llm/prompts/query-prompt.ts \
        src/server/llm/prompts/__tests__/query-prompt.test.ts
git commit -m "feat(llm): inject wikiLanguage directive into query prompt"
```

---

### Task 5: Inject language directive into the lint builder

**Files:**
- Modify: `src/server/llm/prompts/lint-prompt.ts`
- Create: `src/server/llm/prompts/__tests__/lint-prompt.test.ts`

- [ ] **Step 1: Write the failing lint test**

Create `src/server/llm/prompts/__tests__/lint-prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildLintUserPrompt } from '../lint-prompt';
import type { PromptContext } from '../prompt-context';

const ctx: PromptContext = {
  language: 'Japanese',
  subject: { slug: 'general', name: 'General', description: '' },
};

describe('buildLintUserPrompt – language directive', () => {
  it('embeds OUTPUT LANGUAGE with the configured language', () => {
    const out = buildLintUserPrompt(
      [{ slug: 'foo', title: 'Foo', body: 'body' } as never],
      ctx,
    );
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('Japanese');
  });

  it('still renders the subject section', () => {
    const out = buildLintUserPrompt(
      [{ slug: 'foo', title: 'Foo', body: 'b' } as never],
      ctx,
    );
    expect(out).toContain('General');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/server/llm/prompts/__tests__/lint-prompt.test.ts`

Expected: FAIL.

- [ ] **Step 3: Update `lint-prompt.ts`**

Open `src/server/llm/prompts/lint-prompt.ts`.

3a) Add import:
```ts
import { renderLanguageDirective, type PromptContext } from './prompt-context';
```

3b) Find `buildLintUserPrompt` (around line 82). Change `subject?: SubjectContext` to `ctx: PromptContext`. Inside the body, replace `subject` with `ctx.subject`, compute
```ts
const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
```
and prepend it to the returned string.

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- src/server/llm/prompts/__tests__/lint-prompt.test.ts`

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/llm/prompts/lint-prompt.ts \
        src/server/llm/prompts/__tests__/lint-prompt.test.ts
git commit -m "feat(llm): inject wikiLanguage directive into lint prompt"
```

---

### Task 6: Wire the three services to read `getWikiLanguage()` and pass `PromptContext`

**Files:**
- Modify: `src/server/services/ingest-service.ts`
- Modify: `src/server/services/query-service.ts`
- Modify: `src/server/services/lint-service.ts`

> No new test file here — prompt-builder tests already cover correctness of the directive; services are dependency-injection wrappers. We rely on `tsc` + the existing test suite + the manual smoke in Task 9.

- [ ] **Step 1: Update `ingest-service.ts`**

Open `src/server/services/ingest-service.ts`.

1a) Add imports near the existing prompt imports:

```ts
import { getWikiLanguage } from '@/server/db/repos/settings-repo';
import type { PromptContext } from '@/server/llm/prompts/prompt-context';
```

1b) Inside the main service function, immediately after building `subjectCtx` (where `subjectsRepo.getById(subjectId)` is read — around line 132), add:

```ts
const promptCtx: PromptContext = {
  language: getWikiLanguage(),
  subject: subjectCtx ?? undefined,
};
```

1c) Replace every call site that previously passed `subjectCtx` as the trailing argument to a builder. There are three:
- `buildPlanUserPrompt(sourceText, existingPages, subjectCtx)` → `buildPlanUserPrompt(sourceText, existingPages, promptCtx)`
- `buildPageBodyUserPrompt(page, sourceText, allPageTitles, subjectCtx)` → `buildPageBodyUserPrompt(page, sourceText, allPageTitles, promptCtx)`
- `buildIndexUserPrompt(pages, subjectCtx)` → `buildIndexUserPrompt(pages, promptCtx)`

> Use `grep -n "buildPlanUserPrompt\|buildPageBodyUserPrompt\|buildIndexUserPrompt" src/server/services/ingest-service.ts` to find exact line numbers.

- [ ] **Step 2: Update `query-service.ts`**

Open `src/server/services/query-service.ts`.

2a) Add the same two imports.

2b) Find the call to `buildQueryUserPrompt(...)` (around lines 99–114). Right before it, add:

```ts
const promptCtx: PromptContext = {
  language: getWikiLanguage(),
  subject: subjectCtx ?? undefined,
};
```

(Use whatever local variable currently holds the resolved subject; preserve its name.)

2c) Change the trailing argument of `buildQueryUserPrompt(...)` from `subjectCtx` to `promptCtx`.

- [ ] **Step 3: Update `lint-service.ts`**

Open `src/server/services/lint-service.ts`.

3a) Add the same two imports.

3b) Around lines 23–28, before `buildLintUserPrompt(pages, subjectCtx)`, add the same `promptCtx` block.

3c) Change `buildLintUserPrompt(pages, subjectCtx)` → `buildLintUserPrompt(pages, promptCtx)`.

- [ ] **Step 4: Type-check the whole project**

Run: `npx tsc --noEmit`

Expected: 0 new errors related to changed signatures. Pre-existing errors elsewhere remain out of scope.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`

Expected: all tests added in Tasks 2–5 PASS (~14 tests).

- [ ] **Step 6: Run lint**

Run: `npm run lint`

Expected: clean for the changed files.

- [ ] **Step 7: Commit**

```bash
git add src/server/services/ingest-service.ts \
        src/server/services/query-service.ts \
        src/server/services/lint-service.ts
git commit -m "feat(services): pass wikiLanguage via PromptContext to all LLM tasks"
```

---

### Task 7: API routes — `GET /api/settings` and `PUT /api/settings`

**Files:**
- Create: `src/app/api/settings/route.ts`

> No unit tests; rely on `tsc`, manual `curl` checks here, and the end-to-end smoke in Task 9.

- [ ] **Step 1: Create the route handler**

Create `src/app/api/settings/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/server/middleware/auth';
import { requireCsrf } from '@/server/middleware/csrf';
import {
  getWikiLanguage,
  setWikiLanguage,
} from '@/server/db/repos/settings-repo';
import { WikiLanguageSchema, type AppSettings } from '@/lib/contracts';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth) return auth;

  const body: AppSettings = { wikiLanguage: getWikiLanguage() };
  return NextResponse.json(body);
}

const PutBodySchema = z.object({
  wikiLanguage: WikiLanguageSchema.optional(),
});

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth) return auth;
  const csrf = requireCsrf(request);
  if (csrf) return csrf;

  let parsed: z.infer<typeof PutBodySchema>;
  try {
    parsed = PutBodySchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'Invalid request body', detail: String(err) },
      { status: 400 },
    );
  }

  if (parsed.wikiLanguage !== undefined) {
    setWikiLanguage(parsed.wikiLanguage);
  }

  const body: AppSettings = { wikiLanguage: getWikiLanguage() };
  return NextResponse.json(body);
}
```

> Verify the actual middleware module names — the project's CLAUDE.md cites `requireAuth` from `@/server/middleware/auth` and `requireCsrf` from `@/server/middleware/csrf` (or possibly co-located in `auth.ts`). Run `grep -rn "export function requireAuth\|export function requireCsrf" src/server/middleware/` and adjust imports if the actual paths differ.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`

Expected: 0 new errors.

- [ ] **Step 3: Manual smoke — GET**

Start the dev server in one terminal:
```bash
npm run dev
```

In another terminal (set `WIKI_API_KEY` if your local env requires it; otherwise skip the header):
```bash
curl -s http://localhost:3000/api/settings | jq
```

Expected:
```json
{ "wikiLanguage": "English" }
```

- [ ] **Step 4: Manual smoke — PUT**

Get a CSRF cookie/header by visiting any UI page first, then:
```bash
# adapt header names to whatever requireCsrf expects (likely a header
# echoing a cookie value). Inspect requireCsrf to confirm.
curl -s -X PUT http://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <copy from browser>' \
  -H 'x-csrf-token: <copy from browser>' \
  -d '{"wikiLanguage":"Chinese"}' | jq
```

Expected:
```json
{ "wikiLanguage": "Chinese" }
```

Repeat with `English` to reset.

If CSRF wiring is awkward to replicate from curl, skip Step 4 and validate via the UI in Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/settings/route.ts
git commit -m "feat(api): add GET/PUT /api/settings for wikiLanguage"
```

---

### Task 8: Add the "Wiki language" row to the settings dialog

**Files:**
- Modify: `src/components/layout/settings-dialog.tsx`

> The dialog already imports `useUIStore`, `Button`, `IconButton`, `Separator`. We add a TanStack Query hook for read + mutation, plus a controlled `<Input>` row. We do NOT mirror the value into Zustand — server is source of truth.

- [ ] **Step 1: Update `settings-dialog.tsx` imports**

Open `src/components/layout/settings-dialog.tsx`. At the top, add (preserving existing imports):

```ts
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { Input } from '@/components/ui/input';
import type { AppSettings } from '@/lib/contracts';
```

> If `apiFetch` is exported under a different name (e.g. `apiClient`, `useApiFetch`), match the project's convention. Settings is global and not subject-scoped, so we use the lower-level `apiFetch` (string URL) rather than the `useApiFetch` hook that auto-injects `?subjectId`.

- [ ] **Step 2: Add the data hooks inside `SettingsDialog`**

Inside the existing `SettingsDialog` function (after the existing `useUIStore` selector calls, before the `useEffect`), insert:

```ts
const queryClient = useQueryClient();

const settingsQuery = useQuery<AppSettings>({
  queryKey: ['app-settings'],
  queryFn: async () => {
    const res = await apiFetch('/api/settings');
    if (!res.ok) throw new Error(`GET /api/settings -> ${res.status}`);
    return res.json();
  },
  enabled: isOpen,
  staleTime: 30_000,
});

const [languageDraft, setLanguageDraft] = useState('');

useEffect(() => {
  if (settingsQuery.data) {
    setLanguageDraft(settingsQuery.data.wikiLanguage);
  }
}, [settingsQuery.data]);

const saveLanguage = useMutation({
  mutationFn: async (value: string) => {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wikiLanguage: value }),
    });
    if (!res.ok) throw new Error(`PUT /api/settings -> ${res.status}`);
    return (await res.json()) as AppSettings;
  },
  onSuccess: (data) => {
    queryClient.setQueryData(['app-settings'], data);
  },
});

const trimmedDraft = languageDraft.trim();
const canSave =
  trimmedDraft.length > 0 &&
  trimmedDraft !== settingsQuery.data?.wikiLanguage &&
  !saveLanguage.isPending;
```

- [ ] **Step 3: Add the "Wiki language" row before the version footer**

Find the JSX block ending with the version footer:

```tsx
<Separator />

<div className="flex items-center justify-between text-xs text-foreground-tertiary">
  <span>Agentic Wiki</span>
  <span className="tabular-nums">v{APP_VERSION}</span>
</div>
```

Insert **immediately before** that `<Separator />` (so the order becomes: Appearance · Sidebar width · Wiki language · footer):

```tsx
<Separator />

<SettingRow
  label="Wiki language"
  description="Language LLM uses for new wiki content (slugs and wikilinks stay verbatim)"
  className="items-start"
>
  <div className="flex items-center gap-1.5">
    <Input
      value={languageDraft}
      onChange={(e) => setLanguageDraft(e.target.value)}
      placeholder="English"
      className="h-7 w-32 text-xs"
      aria-label="Wiki language"
      disabled={settingsQuery.isLoading}
    />
    <Button
      intent="outline"
      size="sm"
      onClick={() => saveLanguage.mutate(trimmedDraft)}
      disabled={!canSave}
    >
      {saveLanguage.isPending ? 'Saving…' : 'Save'}
    </Button>
  </div>
</SettingRow>

{saveLanguage.isError && (
  <p role="alert" className="text-xs text-danger">
    Failed to save: {(saveLanguage.error as Error).message}
  </p>
)}
```

> If `Input` doesn't accept `className` (unlikely, but check `src/components/ui/input.tsx`), wrap it in a `<div className="...">` instead. If the project's Tailwind theme doesn't define `text-danger`, use the existing tone class found in other error-state components (e.g. `text-foreground-secondary` or whatever appears in `chat-interface.tsx` for errors).

- [ ] **Step 4: Manual UI smoke**

Run:
```bash
npm run dev:all
```

In the browser:
1. Open the left sidebar settings button (the gear icon at `sidebar.tsx:246`).
2. Confirm a "Wiki language" row appears with the current value (initially `English`).
3. Change the value to `Chinese` and click Save. Confirm:
   - The Save button briefly shows `Saving…` then re-disables (no diff between input and saved value).
   - DevTools Network tab shows `PUT /api/settings 200`.
4. Close and reopen the dialog. Value should still be `Chinese`.
5. Restart the worker (`Ctrl+C`, then `npm run dev:all`) — value should still be `Chinese` (DB-persisted).

- [ ] **Step 5: Type-check + lint**

Run:
```bash
npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/settings-dialog.tsx
git commit -m "feat(ui): add Wiki language row to settings dialog"
```

---

### Task 9: End-to-end smoke + docs

**Files:**
- Modify: `CLAUDE.md` (root) — changelog
- Modify: `src/server/db/CLAUDE.md`
- Modify: `src/server/llm/CLAUDE.md`
- Modify: `src/components/CLAUDE.md`

- [ ] **Step 1: End-to-end smoke — generate a wiki page in a non-default language**

1a) Run `npm run dev:all`.

1b) Open the settings dialog from the left sidebar. Set "Wiki language" to `Chinese`. Click Save.

1c) Ingest a small English markdown source (paste 1–2 paragraphs of any English text) via the existing ingest UI flow. Wait for the job to complete.

1d) Open the resulting wiki page(s). Verify:
- ✅ Page body prose is in Chinese.
- ✅ Page slug remains kebab-case ASCII (e.g. `quantum-computing`, not 量子计算).
- ✅ `[[wikilinks]]` inside the body still reference existing slugs verbatim.
- ✅ Frontmatter keys (`title`, `tags`, etc.) are unchanged English; `title` *values* may legitimately be Chinese.

1e) Reset "Wiki language" to `English` via the dialog. Re-ingest a different source. Verify body is back to English.

1f) Ask a question via the chat UI (right panel). Verify the answer comes back in the configured language.

> If any check fails, revisit Task 2 (directive wording) — it likely needs sharper "do not translate" wording for the failing dimension. Update tests + directive together.

- [ ] **Step 2: Update root `CLAUDE.md` changelog**

Open `/Users/nickhopps/Documents/playground/agentic-wiki/CLAUDE.md`. In the "九、变更记录 (Changelog)" table, append a new row:

```markdown
| 2026-04-26 | 引入 wikiLanguage 全局设置 | 新增 `app_settings` 表 + `settings-repo` + `GET/PUT /api/settings`；左侧 settings dialog 加 "Wiki language" 行；`PromptContext` 把语言指令注入 ingest/query/lint 五个 user prompt（slugs/wikilinks/frontmatter keys 明确禁止翻译）；首批 vitest 单测落地 |
```

- [ ] **Step 3: Update `src/server/db/CLAUDE.md`**

Open `src/server/db/CLAUDE.md`. Add a section documenting the new table + repo:

```markdown
### `app_settings`（全局键值设置）

通用 key/value 表，承载所有"全 app 单实例"的全局设置（首个使用方：`wikiLanguage`）。

| 列 | 类型 | 备注 |
|----|------|------|
| `key` | TEXT PK | 设置名（如 `wikiLanguage`）|
| `value` | TEXT | 字符串值（zod 校验由调用方负责） |
| `updated_at` | TEXT | ISO-8601 时间戳 |

读写统一走 `repos/settings-repo.ts`：

- `getWikiLanguage()` —— 缺失时返回 `DEFAULT_WIKI_LANGUAGE`（`English`）
- `setWikiLanguage(value)` —— 经 `WikiLanguageSchema.parse()` 校验后 upsert

服务层（`ingest/query/lint`）每次调用时**实时**读取，不在启动时缓存，方便 UI 修改即时生效。
```

- [ ] **Step 4: Update `src/server/llm/CLAUDE.md`**

Add (or extend the existing prompts section with) a paragraph:

```markdown
### `PromptContext` & wikiLanguage 注入

`prompts/prompt-context.ts` 导出：
- `interface PromptContext { language: string; subject?: SubjectContextLite }`
- `renderLanguageDirective(language)` —— 渲染 `=== OUTPUT LANGUAGE ===` 块

5 个 user prompt builder（plan / pageBody / index / query / lint）签名末参数从 `subject?` 改为 `ctx: PromptContext`，并在返回字符串顶部插入 `renderLanguageDirective(ctx.language)`。指令明确禁止翻译 slug、`[[wikilink]]` 目标、frontmatter 键、code block —— 否则会破坏 wiki 图。

服务层从 `db/repos/settings-repo::getWikiLanguage()` 读取语言（不是 `llm-config.json`；它是个**用户运行时设置**，非 LLM 路由配置）。
```

- [ ] **Step 5: Update `src/components/CLAUDE.md`**

In the `layout/` section, find the `settings-dialog.tsx` mention (or add one) and append:

```markdown
- `settings-dialog.tsx` 现包含 "Wiki language" 行：通过 `useQuery(['app-settings'])` 读 `GET /api/settings`，本地 `useState` 暂存 input，`useMutation` 发 `PUT /api/settings`。**不**写回 Zustand —— 服务端 `app_settings` 表是唯一真实源。
```

- [ ] **Step 6: Run lint + full tests one last time**

```bash
npm run lint && npm test
```

Expected: clean lint; all tests pass.

- [ ] **Step 7: Final commit**

```bash
git add CLAUDE.md src/server/db/CLAUDE.md src/server/llm/CLAUDE.md src/components/CLAUDE.md
git commit -m "docs: document wikiLanguage settings + PromptContext usage"
```

---

## Out of Scope (intentionally deferred)

- **Per-subject language override** — user explicitly asked for *one global* setting. Adding a `language` column to the `subjects` table can be done later by extending `PromptContext` to accept `subject.language ?? globalLanguage`.
- **Refactoring the duplicated `SubjectContext` / `renderSubjectHeader`** across the three prompt files — a pre-existing DRY violation, not introduced by this change.
- **Lint-findings language separation** — findings follow the global `wikiLanguage` directive by default. If users later want findings always in English even when wiki content is Chinese, add a separate `lintLanguage` row.
- **Language presets / dropdown UI** — V1 ships a free-form text input. A `<select>` with common presets + custom option can be layered on later without changing the API.
- **Translating existing pages** — only NEW LLM output respects the new language. Re-translating existing wiki content is a separate (much bigger) feature.

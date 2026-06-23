# 增益流水线 P4 实现计划 — 手动重新增益 + per-subject 增益强度

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ingest 增益强度按 subject 可配（off/light/standard/deep），并提供对存量页面手动「重新增益」的异步动作，为 P5 维护层铺好可复用的 `re-enrich` job。

**Architecture:** `augmentationLevel` 落地为 `subjects` 表一等列，贯穿 `Subject` 契约 → `/api/subjects` → subject 管理页 UI；ingest-service 读取它，`off` 时跳过 enricher+verify 两阶段、否则把强度指令注入 enricher。新增 `re-enrich` job 类型与 `reenrich-service.ts`：复用现有 `runPipeline`，以「现有页正文当 draft → enricher → verify」两步重跑（writer 阶段跳过），单事务 `commitPending` 收口。阅读页加 Re-enrich 入口（镜像现有 merge/split 对话）。

**Tech Stack:** Next.js 15 / React 19 / TypeScript / better-sqlite3 + Drizzle / Vitest / Vercel AI SDK（agents runtime）。

## Global Constraints

- **强 TypeScript**：所有领域类型集中在 `src/lib/contracts.ts`，不得在别处复刻。
- **Saga 顺序不可绕过**：写盘只能经 `commitPending`（→ `createChangeset` → `validateChangeset` → `applyChangeset`）；agent 阶段一律结构化输出、无写盘工具。
- **server-only 屏障**：`src/server/**` 不得被客户端组件直接 import。
- **写接口契约**：写 Route Handler 必须 `requireAuth(request)` + `requireCsrf(request)`；subject-scoped 接口顶部调 `resolveSubjectFromRequest(request, { required: true, body })`，error 非空直接 `return error`；长任务只 `queue.enqueue(...)` 后返回 202 + `{ jobId }`。
- **skill 版本守卫**：改 skill 输入契约必须 bump `version` 并同步 `ingest-service.ts::MIN_SKILL_VERSIONS`；rollout 需手动删 `data/vault/.llm-wiki/skills/<id>.md` 让 worker 重新播种。
- **生成代码注释/commit message 用中文**；commit message 一句话总结，**禁止** AI 署名 trailer。
- **测试命令**：`npx vitest run <path>`（`package.json` 的 `test` = `vitest run`）。类型检查：`npx tsc --noEmit`。`npm run lint` 不可用（next lint 已弃用），改用 tsc 校验。
- **增益强度取值**：`off | light | standard | deep`，默认 `standard`。`off` = 退回纯忠实层（现有行为）。

---

### Task 1: `augmentationLevel` 契约 + schema + 迁移 + repo

把增益强度做成 `subjects` 表的一等列，贯通 `Subject` 契约与 subjects-repo。

**Files:**
- Modify: `src/lib/contracts.ts`（新增 `AugmentationLevel` 类型/schema/默认值；`Subject` 与 `SubjectListEntry` 各加字段）
- Modify: `src/server/db/schema.ts`（`subjects` 表加列）
- Modify: `src/server/db/client.ts:103-130`（`ensureSubjectsAndGeneral`：CREATE 含新列 + 存量库 ALTER 补列）
- Modify: `src/server/db/repos/subjects-repo.ts`（`rowToSubject` 映射新列；新增 `setAugmentationLevel`）
- Test: `src/server/db/repos/__tests__/subjects-repo.test.ts`（新建）

**Interfaces:**
- Produces:
  - `AugmentationLevel = 'off' | 'light' | 'standard' | 'deep'`
  - `AugmentationLevelSchema: z.ZodEnum`（`z.enum(['off','light','standard','deep'])`）
  - `DEFAULT_AUGMENTATION_LEVEL = 'standard'`
  - `Subject.augmentationLevel: AugmentationLevel`、`SubjectListEntry.augmentationLevel: AugmentationLevel`
  - `subjectsRepo.setAugmentationLevel(id: string, level: AugmentationLevel): Subject`
  - `subjectsRepo.create` / `getById` 返回的 `Subject` 含 `augmentationLevel`（缺省 `'standard'`）

- [ ] **Step 1: 写失败测试 — subjects-repo 的 augmentationLevel 读写**

新建 `src/server/db/repos/__tests__/subjects-repo.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as subjectsRepo from '../subjects-repo';

// 每个用例用独立内存库：测试前指向临时 DATABASE_PATH 并重置单例。
// 本仓库现有 repo 测试均依赖真实 SQLite 文件；这里用唯一文件名隔离。
beforeEach(() => {
  process.env.DATABASE_PATH = `/private/tmp/claude-test-${randomUUID()}.db`;
});

describe('subjects-repo augmentationLevel', () => {
  it('新建 subject 默认 augmentationLevel = standard', () => {
    const s = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'T' });
    expect(s.augmentationLevel).toBe('standard');
  });

  it('setAugmentationLevel 持久化且 getById 可读回', () => {
    const s = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'T' });
    const updated = subjectsRepo.setAugmentationLevel(s.id, 'deep');
    expect(updated.augmentationLevel).toBe('deep');
    expect(subjectsRepo.getById(s.id)?.augmentationLevel).toBe('deep');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/subjects-repo.test.ts`
Expected: FAIL（`augmentationLevel` 不存在于返回对象 / `setAugmentationLevel is not a function`）。

- [ ] **Step 3: 加契约类型**

在 `src/lib/contracts.ts` 顶部（`SubjectId` 之后、`Subject` 之前）加：

```ts
/** 每个 subject 独立的增益强度（ingest/re-enrich 读取）。`off` = 退回纯忠实层。 */
export type AugmentationLevel = 'off' | 'light' | 'standard' | 'deep';
export const DEFAULT_AUGMENTATION_LEVEL: AugmentationLevel = 'standard';
```

把 `Subject` 与 `SubjectListEntry` 各加一行（紧跟各自的 `description`）：

```ts
export interface Subject {
  id: SubjectId;
  slug: string;
  name: string;
  description: string;
  augmentationLevel: AugmentationLevel;
  createdAt: string;
  updatedAt: string;
}
```

```ts
export interface SubjectListEntry {
  id: SubjectId;
  slug: string;
  name: string;
  description: string;
  augmentationLevel: AugmentationLevel;
  pageCount: number;
}
```

> 注：`AugmentationLevelSchema`（zod）放在校验需要它的地方——本任务 repo 不需要 zod（值由 API/前端约束）。schema 在 Task 2 的 contracts 中补充，与其它 `*Schema` 同处。为避免重复，这里同时加上：

在 `src/lib/contracts.ts` 中需要 import zod 的设置 schema 区（与 `AppSettingsSchema` 同段，约 L236 之后）加：

```ts
export const AugmentationLevelSchema = z.enum(['off', 'light', 'standard', 'deep']);
```

- [ ] **Step 4: 加 schema 列**

在 `src/server/db/schema.ts` 的 `subjects` 表定义里，`description` 之后加列：

```ts
  augmentationLevel: text('augmentation_level').notNull().default('standard'),
```

- [ ] **Step 5: 建表/迁移补列**

在 `src/server/db/client.ts::ensureSubjectsAndGeneral`（L103）里，把 CREATE 语句加上新列，并对存量库补 ALTER：

```ts
function ensureSubjectsAndGeneral(): string {
  const sqlite = rawSqlite!;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      augmentation_level TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 存量库补列（同 migrateJobs 的 ALTER ADD COLUMN 增量补齐策略）
  if (!tableColumns('subjects').includes('augmentation_level')) {
    try {
      sqlite.exec(`ALTER TABLE subjects ADD COLUMN augmentation_level TEXT NOT NULL DEFAULT 'standard'`);
    } catch {
      // 已存在或不支持
    }
  }

  const existing = sqlite
    .prepare(`SELECT id FROM subjects WHERE slug = 'general'`)
    .get() as { id: string } | undefined;
  if (existing) return existing.id;

  const id = randomUUID();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
       VALUES (?, 'general', 'General', '', ?, ?)`
    )
    .run(id, now, now);
  return id;
}
```

> `augmentation_level` 有 DEFAULT，故 INSERT 不必显式写它。

- [ ] **Step 6: repo 映射 + setter**

在 `src/server/db/repos/subjects-repo.ts` 改 `rowToSubject`（L119）：

```ts
function rowToSubject(row: typeof subjects.$inferSelect): Subject {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    augmentationLevel: (row.augmentationLevel ?? 'standard') as Subject['augmentationLevel'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
```

`create`（L46）的 `subject` 字面量加 `augmentationLevel: 'standard'`，使插入对象类型完整：

```ts
  const subject: Subject = {
    id: randomUUID(),
    slug,
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    augmentationLevel: 'standard',
    createdAt: now,
    updatedAt: now,
  };
```

新增导出（放在 `rename` 之后）：

```ts
export function setAugmentationLevel(id: string, level: Subject['augmentationLevel']): Subject {
  const subject = getById(id);
  if (!subject) {
    throw new SubjectError('not-found', `Subject ${id} not found`);
  }
  const updatedAt = new Date().toISOString();
  const db = getDb();
  db.update(subjects)
    .set({ augmentationLevel: level, updatedAt })
    .where(eq(subjects.id, id))
    .run();
  return { ...subject, augmentationLevel: level, updatedAt };
}
```

- [ ] **Step 7: 运行测试，确认通过 + 全量类型检查**

Run: `npx vitest run src/server/db/repos/__tests__/subjects-repo.test.ts`
Expected: PASS（2 用例）。
Run: `npx tsc --noEmit`
Expected: 无新增报错。

- [ ] **Step 8: 提交**

```bash
git add src/lib/contracts.ts src/server/db/schema.ts src/server/db/client.ts src/server/db/repos/subjects-repo.ts src/server/db/repos/__tests__/subjects-repo.test.ts
git commit -m "feat(subjects): augmentationLevel 落为 subjects 表一等列 + repo 读写"
```

---

### Task 2: `/api/subjects` 暴露并可改 augmentationLevel

GET 自然带出新字段（`rowToSubject` 已含）；PATCH 接受 `augmentationLevel`。

**Files:**
- Modify: `src/app/api/subjects/[id]/route.ts:9-65`（PATCH schema + 处理分支）
- Test: `src/app/api/subjects/__tests__/patch-augmentation.test.ts`（新建）

**Interfaces:**
- Consumes: `subjectsRepo.setAugmentationLevel`（Task 1）、`AugmentationLevelSchema`（Task 1）
- Produces: `PATCH /api/subjects/[id]` body 支持 `{ augmentationLevel?: AugmentationLevel }`，返回更新后的 `Subject`

- [ ] **Step 1: 写失败测试 — PATCH 处理 augmentationLevel**

新建 `src/app/api/subjects/__tests__/patch-augmentation.test.ts`，直接断言 schema 解析逻辑（避免起 Next 运行时）：

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AugmentationLevelSchema } from '@/lib/contracts';

// 镜像路由内的 PatchSubjectSchema（含 augmentationLevel），验证契约。
const PatchSubjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  augmentationLevel: AugmentationLevelSchema.optional(),
});

describe('PatchSubjectSchema augmentationLevel', () => {
  it('接受合法 level', () => {
    expect(PatchSubjectSchema.safeParse({ augmentationLevel: 'deep' }).success).toBe(true);
  });
  it('拒绝非法 level', () => {
    expect(PatchSubjectSchema.safeParse({ augmentationLevel: 'turbo' }).success).toBe(false);
  });
  it('允许只改 augmentationLevel（name/description 可缺省）', () => {
    const r = PatchSubjectSchema.safeParse({ augmentationLevel: 'off' });
    expect(r.success && r.data.augmentationLevel).toBe('off');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/app/api/subjects/__tests__/patch-augmentation.test.ts`
Expected: FAIL（`AugmentationLevelSchema` 尚未从 contracts 导出 → import 报错，或断言失败）。
（若 Task 1 已加 `AugmentationLevelSchema`，则 import 通过、但这里仍先确认本测试随路由改动一起绿。）

- [ ] **Step 3: 改路由**

`src/app/api/subjects/[id]/route.ts` 顶部 import 加：

```ts
import { AugmentationLevelSchema } from '@/lib/contracts';
```

`PatchSubjectSchema`（L9）改为：

```ts
const PatchSubjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  augmentationLevel: AugmentationLevelSchema.optional(),
});
```

PATCH 处理体（L55-57 的 try 块）改为：先处理 rename（仅当 name/description 有值），再处理 augmentationLevel，返回最新 subject：

```ts
  try {
    const { augmentationLevel, ...renameFields } = parsed.data;
    let subject = subjectsRepo.getById(id);
    if (!subject) {
      return NextResponse.json({ error: 'Subject not found' }, { status: 404 });
    }
    if (renameFields.name !== undefined || renameFields.description !== undefined) {
      subject = subjectsRepo.rename(id, renameFields);
    }
    if (augmentationLevel !== undefined) {
      subject = subjectsRepo.setAugmentationLevel(id, augmentationLevel);
    }
    return NextResponse.json(subject);
  } catch (err) {
    if (err instanceof SubjectError) {
      const status = err.code === 'not-found' ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
```

- [ ] **Step 4: 运行测试，确认通过 + 类型检查**

Run: `npx vitest run src/app/api/subjects/__tests__/patch-augmentation.test.ts`
Expected: PASS（3 用例）。
Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: 提交**

```bash
git add "src/app/api/subjects/[id]/route.ts" src/app/api/subjects/__tests__/patch-augmentation.test.ts
git commit -m "feat(api): PATCH /api/subjects/[id] 支持改 augmentationLevel"
```

---

### Task 3: Subject 管理页 — 增益强度选择器

在每张 subject 卡片加一个增益强度下拉，onChange 即 PATCH。

**Files:**
- Modify: `src/app/(app)/subjects/page.tsx`（`PatchSubjectPayload` 加字段；`SubjectCard` 加下拉）

**Interfaces:**
- Consumes: `PATCH /api/subjects/[id]`（Task 2）、`SubjectListEntry.augmentationLevel`（Task 1）

- [ ] **Step 1: 扩展 patch payload 类型与函数**

`src/app/(app)/subjects/page.tsx` 顶部 import 处加类型：

```ts
import type { SubjectListEntry, AugmentationLevel } from '@/lib/contracts';
```

`PatchSubjectPayload`（L45）改为：

```ts
interface PatchSubjectPayload {
  id: string;
  name?: string;
  description?: string;
  augmentationLevel?: AugmentationLevel;
}
```

`patchSubject` 函数无需改动（它已 `JSON.stringify(body)` 透传剩余字段）。

- [ ] **Step 2: 在 SubjectCard 非编辑视图加下拉**

在 `SubjectCard` 的非编辑分支（`<>` 内，`Slug` 的 `<code>` 之后、`description` 之前）插入：

```tsx
            <SectionLabel className="text-[10px]">Augmentation</SectionLabel>
            <select
              value={subject.augmentationLevel}
              onChange={(e) =>
                patchMutation.mutate({
                  id: subject.id,
                  augmentationLevel: e.target.value as AugmentationLevel,
                })
              }
              disabled={patchMutation.isPending}
              aria-label="Augmentation level"
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-ring"
            >
              <option value="off">off — 纯忠实层</option>
              <option value="light">light — 少量增益</option>
              <option value="standard">standard — 平衡（默认）</option>
              <option value="deep">deep — 充分增益</option>
            </select>
```

> `patchMutation` 已存在（用于 rename）；其 `onSuccess` 调 `onChanged()`（失效 subjects 查询）后 `onCloseEdit()`——非编辑态下 `onCloseEdit` 无副作用（`editingId` 本就非本卡），安全复用。

- [ ] **Step 3: 类型检查 + 构建校验**

Run: `npx tsc --noEmit`
Expected: 无报错。
Run: `npx next build`
Expected: 构建成功（页面为客户端组件，无 SSR 报错）。

> 注：本仓库 UI 无单测框架（见 CLAUDE 备忘：next lint 不可用、用 tsc + Playwright）。视觉校验留待 Task 8 之后的端到端手测。

- [ ] **Step 4: 提交**

```bash
git add "src/app/(app)/subjects/page.tsx"
git commit -m "feat(ui): subject 管理页加增益强度下拉（onChange 即 PATCH）"
```

---

### Task 4: enricher skill v2 — 接受 augmentationDirective

让 enricher 按强度指令调节 callout 密度；bump 版本并加注入辅助函数。

**Files:**
- Modify: `examples/skills/ingest-enricher.md`（version 1→2；Inputs + 规则加 `augmentationDirective`）
- Modify: `src/server/llm/prompts/prompt-context.ts`（新增 `renderAugmentationDirective`）
- Modify: `src/server/services/ingest-service.ts:118-122`（`MIN_SKILL_VERSIONS['ingest-enricher']` 1→2）
- Test: `src/server/llm/prompts/__tests__/augmentation-directive.test.ts`（新建）

**Interfaces:**
- Produces: `renderAugmentationDirective(level: 'light' | 'standard' | 'deep'): string`

- [ ] **Step 1: 写失败测试 — renderAugmentationDirective**

新建 `src/server/llm/prompts/__tests__/augmentation-directive.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { renderAugmentationDirective } from '../prompt-context';

describe('renderAugmentationDirective', () => {
  it('每档都含 AUGMENTATION LEVEL 块且文案不同', () => {
    const light = renderAugmentationDirective('light');
    const standard = renderAugmentationDirective('standard');
    const deep = renderAugmentationDirective('deep');
    for (const d of [light, standard, deep]) {
      expect(d).toContain('=== AUGMENTATION LEVEL ===');
    }
    expect(light).not.toBe(standard);
    expect(standard).not.toBe(deep);
  });
  it('light 强调稀疏，deep 强调充分', () => {
    expect(renderAugmentationDirective('light').toLowerCase()).toContain('spars');
    expect(renderAugmentationDirective('deep').toLowerCase()).toContain('generous');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/augmentation-directive.test.ts`
Expected: FAIL（`renderAugmentationDirective` 未导出）。

- [ ] **Step 3: 实现 renderAugmentationDirective**

在 `src/server/llm/prompts/prompt-context.ts` 末尾（`renderLanguageDirective` 之后）加：

```ts
/**
 * 渲染「AUGMENTATION LEVEL」块，注入 enricher user prompt，调节 callout 密度/深度。
 * `off` 不走 enricher（service 层直接跳过该阶段），故此函数只接 light/standard/deep。
 */
export function renderAugmentationDirective(level: 'light' | 'standard' | 'deep'): string {
  const guidance: Record<typeof level, string> = {
    light:
      'Add ONLY the 1–2 highest-value callouts per major section — prioritise one [!intuition] and at most one [!example]. Keep it sparse; most sections get no callout.',
    standard:
      'Add callouts at genuine points of difficulty — typically an [!intuition] plus an occasional [!example]/[!quiz]/[!pitfall] per major section. Aim for balanced, non-repetitive coverage.',
    deep:
      'Be generous: layer [!intuition], worked [!example]s, [!quiz] self-tests, [!background] prerequisites, [!diagram]s, and [!pitfall]s throughout. Maximise learning scaffolding while staying correct and on-topic.',
  };
  return [
    '=== AUGMENTATION LEVEL ===',
    guidance[level],
    'Regardless of level: never pad with low-confidence claims (a verifier stage scrutinises every callout), and never alter the faithful prose.',
    '=== END AUGMENTATION LEVEL ===',
  ].join('\n');
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/server/llm/prompts/__tests__/augmentation-directive.test.ts`
Expected: PASS（2 用例）。

- [ ] **Step 5: 改 enricher skill 模板（v2）**

`examples/skills/ingest-enricher.md`：frontmatter `version: 1` 改为 `version: 2`。
在 `## Inputs` 段（L29）末尾追加一行：

```markdown
- `augmentationDirective` — a density/depth directive (light/standard/deep) you MUST honour when deciding how many callouts to add.
```

在 `## Rules` 段新增一条（编号接在现有 6 条之后）：

```markdown
7. **Honour `augmentationDirective`** for callout density/depth. When it asks for sparse output, add fewer but higher-value callouts; when generous, layer more types. It never licenses altering the faithful prose.
```

- [ ] **Step 6: bump MIN_SKILL_VERSIONS**

`src/server/services/ingest-service.ts` 的 `MIN_SKILL_VERSIONS`（L118-122）把 enricher 改为 2：

```ts
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'ingest-planner': 2, 'ingest-writer': 4, 'ingest-indexer': 1,
    'ingest-enricher': 2, 'ingest-verifier': 2,
    'ingest-verifier-triage': 1, 'ingest-verifier-apply': 1,
  };
```

- [ ] **Step 7: 跑 skill 装载/roundtrip 测试 + 类型检查**

Run: `npx vitest run src/server/agents/skills/__tests__`
Expected: PASS（`examples-roundtrip` 校验 enricher frontmatter 合法、id 与文件名一致、version 数值；若有断言写死 version=1 需同步改）。
Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 8: 提交**

```bash
git add examples/skills/ingest-enricher.md src/server/llm/prompts/prompt-context.ts src/server/services/ingest-service.ts src/server/llm/prompts/__tests__/augmentation-directive.test.ts
git commit -m "feat(ingest): enricher v2 接受 augmentationDirective 调节增益密度"
```

---

### Task 5: ingest-service 按 augmentationLevel 编排 + 注入指令

`off` 跳过 enricher+verify；否则把强度指令贯穿到 enricher 输入。

**Files:**
- Modify: `src/server/agents/runtime/orchestrator.ts:217-268`（`buildFanoutInput` 的 `base` 加 `augmentationDirective`）
- Modify: `src/server/services/ingest-service.ts`（读 level → 条件 steps + 注入 directive + carryKeys）
- Test: `src/server/services/__tests__/ingest-augmentation-steps.test.ts`（新建，测纯函数）

**Interfaces:**
- Consumes: `subject.augmentationLevel`、`renderAugmentationDirective`（Task 4）
- Produces: 一个可单测的纯函数 `buildIngestSteps(opts)`，把现有内联 steps 构造抽出来便于断言

- [ ] **Step 1: 写失败测试 — buildIngestSteps 按 level 增删阶段**

新建 `src/server/services/__tests__/ingest-augmentation-steps.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildIngestSteps } from '../ingest-service';

const carryKeys = ['chunkRefs', 'sources', 'subjectSlug', 'existingPages', 'outline', 'languageDirective', 'augmentationDirective'];

describe('buildIngestSteps', () => {
  it('standard：含 writer + enricher + verify', () => {
    const steps = buildIngestSteps({ inline: true, level: 'standard', carryKeys });
    const kinds = steps.map((s) => ('skillId' in s ? s.skillId : s.kind));
    expect(kinds).toContain('ingest-enricher');
    expect(steps.some((s) => s.kind === 'verify')).toBe(true);
  });
  it('off：跳过 enricher 与 verify，仅到 writer', () => {
    const steps = buildIngestSteps({ inline: true, level: 'off', carryKeys });
    expect(steps.some((s) => 'skillId' in s && s.skillId === 'ingest-enricher')).toBe(false);
    expect(steps.some((s) => s.kind === 'verify')).toBe(false);
  });
  it('inline=false：含 chunk-summarizer map 头', () => {
    const steps = buildIngestSteps({ inline: false, level: 'standard', carryKeys });
    expect(steps[0].kind).toBe('map');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/services/__tests__/ingest-augmentation-steps.test.ts`
Expected: FAIL（`buildIngestSteps` 未导出）。

- [ ] **Step 3: 抽出并导出 buildIngestSteps**

在 `src/server/services/ingest-service.ts` 顶部（handler 之外）新增导出函数，把现有内联 steps 构造（当前 L169-177）搬进来：

```ts
import type { AugmentationLevel } from '@/lib/contracts';

/**
 * 构造 ingest 流水线 steps。`level === 'off'` 时跳过 enricher + verify（退回纯忠实层）。
 * 抽为纯函数以便单测；handler 把 inline/level/carryKeys 传入。
 */
export function buildIngestSteps(opts: {
  inline: boolean;
  level: AugmentationLevel;
  carryKeys: string[];
}): PipelineStep[] {
  const { inline, level, carryKeys } = opts;
  const augmentSteps: PipelineStep[] =
    level === 'off'
      ? []
      : [
          { kind: 'fanout', skillId: 'ingest-enricher', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent', checkpointAs: 'enricher-page' },
          { kind: 'verify', fromOutput: 'plan.pages', injectPriorPageAs: 'content', checkpointAs: 'verifier-page' },
        ];
  return [
    ...(inline
      ? []
      : [{ kind: 'map', skillId: 'ingest-chunk-summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs', checkpointAs: 'chunk-summary' } as PipelineStep]),
    { kind: 'sequence', skillId: 'ingest-planner', carryThrough: carryKeys, checkpointAs: 'plan' },
    { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page', injectExistingPageForUpdate: true },
    ...augmentSteps,
  ];
}
```

- [ ] **Step 4: handler 改用 buildIngestSteps + 注入 directive**

在 `registerHandler('ingest', ...)` 里，`existingPages` 与 `languageDirective` 之后加：

```ts
  const augmentationLevel = subject.augmentationLevel;
  const augmentationDirective =
    augmentationLevel === 'off' ? '' : renderAugmentationDirective(augmentationLevel);
```

`carryKeys`（L168）末尾加 `'augmentationDirective'`：

```ts
  const carryKeys = ['chunkRefs', 'sources', 'subjectSlug', 'existingPages', 'outline', 'languageDirective', 'augmentationDirective'];
```

把内联 `const steps: PipelineStep[] = [...]`（L169-177）替换为：

```ts
  const steps = buildIngestSteps({ inline, level: augmentationLevel, carryKeys });
```

`runPipeline` 的 `initialInput`（L189-196）加 `augmentationDirective`：

```ts
    initialInput: {
      chunkRefs: inline ? fillInlineContent(prep.chunkRefs, prep.chunkStore) : prep.chunkRefs,
      sources: [{ sourceId, filename }],
      subjectSlug: subject.slug,
      existingPages,
      outline: prep.outline,
      languageDirective,
      augmentationDirective,
    },
```

顶部 import 加 `renderAugmentationDirective`（与 `renderLanguageDirective` 同源）：

```ts
import { renderLanguageDirective, renderAugmentationDirective } from '../llm/prompts/prompt-context';
```

> 若 `renderLanguageDirective` 当前从别处 import，沿用同一行追加 `renderAugmentationDirective`。

- [ ] **Step 5: orchestrator 把 directive 传给 enricher**

在 `src/server/agents/runtime/orchestrator.ts::buildFanoutInput` 的 `base` 字面量（L240-249）里，`languageDirective` 之后加一行：

```ts
  const base: Record<string, unknown> = {
    subjectSlug: carry.subjectSlug,
    existingPages: carry.existingPages,
    plan: carry.plan,
    languageDirective: carry.languageDirective,
    augmentationDirective: carry.augmentationDirective,
    ...item,
    relevantChunks,
  };
```

> writer 阶段也会收到该字段（无害，writer 忽略）；它是 per-job 常量，落在共享前缀里不破坏 DeepSeek 前缀缓存。

- [ ] **Step 6: 运行测试，确认通过 + 类型检查 + 回归**

Run: `npx vitest run src/server/services/__tests__/ingest-augmentation-steps.test.ts`
Expected: PASS（3 用例）。
Run: `npx vitest run src/server/services/__tests__/ingest-service.test.ts`
Expected: PASS（既有用例不回归；若它断言 steps 数量需同步更新）。
Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 7: 提交**

```bash
git add src/server/services/ingest-service.ts src/server/agents/runtime/orchestrator.ts src/server/services/__tests__/ingest-augmentation-steps.test.ts
git commit -m "feat(ingest): 按 subject 增益强度编排（off 跳过增益）并注入强度指令"
```

---

### Task 6: `re-enrich` job 类型 + reenrich-service

新增 job 类型与处理器：复用 runPipeline 跑 enricher→verify，现有页正文当 draft。

**Files:**
- Modify: `src/lib/contracts.ts:86`（`Job.type` union 加 `'re-enrich'`）
- Create: `src/server/services/reenrich-service.ts`
- Modify: `src/server/worker-entry.ts:34-41`（import 新 service）
- Test: `src/server/services/__tests__/reenrich-input.test.ts`（新建，测可单测的输入构造）

**Interfaces:**
- Consumes: `runPipeline`、`commitPending`、`createBudgetTracker`、`createOverlayVault`、`loadCheckpoint`、`getRuntimeRegistries`、`subjectsRepo.getById`、`pagesRepo.getPageBySlug`、`renderLanguageDirective`、`renderAugmentationDirective`、`subject.augmentationLevel`
- Produces:
  - 纯函数 `buildReenrichInitialInput(opts: { slug, title, summary, subjectSlug, draftContent, languageDirective, augmentationDirective }): unknown`
  - 纯函数 `reenrichSteps(): PipelineStep[]`（固定 `[enricher fanout, verify]`）
  - `registerHandler('re-enrich', handler)`（side-effect）

- [ ] **Step 1: 写失败测试 — re-enrich 输入构造**

新建 `src/server/services/__tests__/reenrich-input.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildReenrichInitialInput, reenrichSteps } from '../reenrich-service';

describe('reenrich input', () => {
  it('reenrichSteps 固定为 enricher fanout + verify', () => {
    const steps = reenrichSteps();
    expect(steps.map((s) => ('skillId' in s ? s.skillId : s.kind))).toEqual(['ingest-enricher', 'verify']);
    expect((steps[0] as { injectPriorPageAs?: string }).injectPriorPageAs).toBe('draftContent');
  });

  it('initialInput 把现有正文 seed 进 writerOutputs 供 enricher 读 draft', () => {
    const input = buildReenrichInitialInput({
      slug: 'eigenvalues',
      title: 'Eigenvalues',
      summary: 's',
      subjectSlug: 'general',
      draftContent: '# Eigenvalues\nbody',
      languageDirective: 'LANG',
      augmentationDirective: 'AUG',
    }) as {
      plan: { pages: Array<{ slug: string }> };
      writerOutputs: Array<{ path: string; content: string }>;
      existingPages: Array<{ slug: string }>;
      augmentationDirective: string;
    };
    expect(input.plan.pages[0].slug).toBe('eigenvalues');
    expect(input.writerOutputs[0].path).toBe('wiki/general/eigenvalues.md');
    expect(input.writerOutputs[0].content).toBe('# Eigenvalues\nbody');
    expect(input.existingPages[0].slug).toBe('eigenvalues'); // 命中 → action=update
    expect(input.augmentationDirective).toBe('AUG');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/services/__tests__/reenrich-input.test.ts`
Expected: FAIL（`reenrich-service` 不存在）。

- [ ] **Step 3: 加 job 类型**

`src/lib/contracts.ts:86` 的 `Job.type` union 末尾加 `'re-enrich'`：

```ts
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'merge' | 'split' | 'embed-index' | 're-enrich';
```

- [ ] **Step 4: 实现 reenrich-service**

新建 `src/server/services/reenrich-service.ts`：

```ts
/**
 * re-enrich 任务处理器（P4）：对存量页面手动「重新增益」。
 *
 * 复用 ingest 的 agents 流水线，但跳过 writer——现有页正文即忠实层，直接当 draft：
 *   seed writerOutputs（现有正文）→ ingest-enricher（叠 callout）→ verify（联网核查/自检）
 * 之后经 commitPending 单事务收口（不重写 index/log——标题/摘要不变）。
 *
 * 网页 source 的 raw 文件导入是 ingest-only；re-enrich 仅靠 verifier 写进页 frontmatter 的
 * sources URL 留痕（不落 raw/page_sources），简化实现、避免触碰 ingest finalize。
 */
import { randomUUID } from 'crypto';
import type { Job, PipelineStep } from '@/lib/contracts';
import type { AgentContext } from '../agents/types';
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { runPipeline } from '../agents/runtime/orchestrator';
import { createBudgetTracker } from '../agents/runtime/budget';
import { createOverlayVault } from '../agents/runtime/overlay-vault';
import { loadCheckpoint } from '../agents/runtime/checkpoint';
import { commitPending } from '../agents/tools/builtin/commit-changeset';
import {
  getAgentMaxSteps,
  getAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
  getWikiLanguage,
} from '../db/repos/settings-repo';
import { renderLanguageDirective, renderAugmentationDirective } from '../llm/prompts/prompt-context';
import { getRuntimeRegistries } from '../worker-runtime'; // 同 ingest-service.ts:27

interface ReenrichParams {
  slug: string;
  subjectId: string;
}

/** re-enrich 固定两步：现有正文当 draft → enricher → verify。 */
export function reenrichSteps(): PipelineStep[] {
  return [
    { kind: 'fanout', skillId: 'ingest-enricher', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent', checkpointAs: 'enricher-page' },
    { kind: 'verify', fromOutput: 'plan.pages', injectPriorPageAs: 'content', checkpointAs: 'verifier-page' },
  ];
}

/** 把现有页身份与正文塞进 carry：plan.pages 单页 + writerOutputs seed（enricher 读 draftContent）。 */
export function buildReenrichInitialInput(opts: {
  slug: string;
  title: string;
  summary: string;
  subjectSlug: string;
  draftContent: string;
  languageDirective: string;
  augmentationDirective: string;
}): unknown {
  const path = `wiki/${opts.subjectSlug}/${opts.slug}.md`;
  const page = { slug: opts.slug, title: opts.title, summary: opts.summary };
  return {
    plan: { pages: [page] },
    // enricher 的 injectPriorPageAs:'draftContent' 按 path 从 writerOutputs 取现有正文
    writerOutputs: [{ action: 'update', path, content: opts.draftContent }],
    subjectSlug: opts.subjectSlug,
    existingPages: [page], // 命中 → enricher/verify 用 action=update
    languageDirective: opts.languageDirective,
    augmentationDirective: opts.augmentationDirective,
  };
}

registerHandler('re-enrich', async (job: Job, emit): Promise<Record<string, unknown>> => {
  const params = JSON.parse(job.paramsJson) as Partial<ReenrichParams>;
  const { slug, subjectId } = params;
  if (!slug || !subjectId) throw new Error('re-enrich job missing slug or subjectId');

  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);
  const page = pagesRepo.getPageBySlug(subjectId, slug);
  if (!page) throw new Error(`Page "${slug}" not found in subject ${subject.slug}`);

  emit('reenrich:start', `Re-enriching ${slug}`, { subject: subject.slug, slug });

  const { skillRegistry, toolRegistry } = getRuntimeRegistries();
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'ingest-enricher': 2, 'ingest-verifier': 2,
    'ingest-verifier-triage': 1, 'ingest-verifier-apply': 1,
  };
  for (const [skillId, minVersion] of Object.entries(MIN_SKILL_VERSIONS)) {
    const s = skillRegistry.get(skillId);
    if (!s) throw new Error(`Skill not loaded: ${skillId}`);
    if (s.version < minVersion) {
      throw new Error(
        `Skill "${skillId}" is v${s.version} but re-enrich requires v${minVersion}+. ` +
        `Delete vault/.llm-wiki/skills/${skillId}.md and restart the worker to re-seed.`,
      );
    }
  }

  const budgetSnapshot = {
    maxSteps: getAgentMaxSteps(),
    maxTokensPerJob: getAgentMaxTokensPerJob(),
    maxParallelSubAgents: getAgentMaxParallelSubAgents(),
  };
  const budget = createBudgetTracker(budgetSnapshot);
  const overlay = createOverlayVault({ subjectSlug: subject.slug });
  const checkpoint = loadCheckpoint(job.id);

  const existing = await overlay.readPage(subject.slug, slug);
  if (!existing?.markdown) throw new Error(`Existing content not found for ${slug}`);

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
    chunkStore: new Map(),
    budgetSnapshot,
    checkpoint,
    citedSources: new Map(),
  };
  for (const c of checkpoint.getCitedSources()) ctx.citedSources!.set(c.url, c);

  // 手动 re-enrich：subject 即便设 off 也按 standard 跑（用户显式触发）。
  const level = subject.augmentationLevel === 'off' ? 'standard' : subject.augmentationLevel;
  const languageDirective = renderLanguageDirective(getWikiLanguage());
  const augmentationDirective = renderAugmentationDirective(level);

  await runPipeline({
    steps: reenrichSteps(),
    resolveSkill: (id) => {
      const s = skillRegistry.get(id);
      if (!s) throw new Error(`Skill not loaded: ${id}`);
      return s;
    },
    ctx,
    initialInput: buildReenrichInitialInput({
      slug,
      title: page.title,
      summary: page.summary,
      subjectSlug: subject.slug,
      draftContent: existing.markdown,
      languageDirective,
      augmentationDirective,
    }),
  });

  // 流水线把核查后页 upsert 进 ctx.pending；commitPending 提交（无 index/log meta）。
  const result = await commitPending(ctx, []);
  checkpoint.clear();
  return result as unknown as Record<string, unknown>;
});
```

> `PipelineStep` 当前在 `src/server/agents/types.ts` 导出。本文件从 `@/lib/contracts` import 它仅为类型——若 `PipelineStep` 不在 contracts，则改为 `import type { PipelineStep } from '../agents/types';`（与 `AgentContext` 同源）。实现时以 `agents/types.ts` 为准。

- [ ] **Step 5: worker-entry 注册**

`src/server/worker-entry.ts` 的 side-effect import 块（L34-41）加一行：

```ts
import './services/reenrich-service';
```

- [ ] **Step 6: 运行测试，确认通过 + 类型检查**

Run: `npx vitest run src/server/services/__tests__/reenrich-input.test.ts`
Expected: PASS（2 用例）。
Run: `npx tsc --noEmit`
Expected: 无报错（修正上面 `PipelineStep` import 来源后）。

- [ ] **Step 7: 提交**

```bash
git add src/lib/contracts.ts src/server/services/reenrich-service.ts src/server/worker-entry.ts src/server/services/__tests__/reenrich-input.test.ts
git commit -m "feat(reenrich): 新增 re-enrich job 与 reenrich-service（复用增益流水线、跳过 writer）"
```

---

### Task 7: `POST /api/re-enrich` 入队路由

**Files:**
- Create: `src/app/api/re-enrich/route.ts`
- Test: `src/app/api/re-enrich/__tests__/validate.test.ts`（新建，测 body schema）

**Interfaces:**
- Consumes: `resolveSubjectFromRequest`、`requireAuth`、`requireCsrf`、`pagesRepo.getPageBySlug`、`queue.enqueue`
- Produces: `POST /api/re-enrich` body `{ slug }` → 202 `{ jobId }`；缺 slug→400，页不存在→404，meta 页→400

- [ ] **Step 1: 写失败测试 — body schema**

新建 `src/app/api/re-enrich/__tests__/validate.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const BodySchema = z.object({ slug: z.string().trim().min(1) });

describe('re-enrich body schema', () => {
  it('接受非空 slug', () => {
    expect(BodySchema.safeParse({ slug: 'eigenvalues' }).success).toBe(true);
  });
  it('拒绝空 slug', () => {
    expect(BodySchema.safeParse({ slug: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认通过（纯 schema，先建立基线）**

Run: `npx vitest run src/app/api/re-enrich/__tests__/validate.test.ts`
Expected: PASS（schema 内联）。该测试锁定路由内 schema 形状。

- [ ] **Step 3: 实现路由**

新建 `src/app/api/re-enrich/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import * as queue from '@/server/jobs/queue';

export const runtime = 'nodejs';

const BodySchema = z.object({ slug: z.string().trim().min(1) });

const META_SLUGS = new Set(['index', 'log']);

/**
 * POST /api/re-enrich
 * Body: { slug }（subject 经 resolveSubjectFromRequest 解析）
 * 校验后入队 re-enrich 任务，返回 202 + { jobId }。
 */
export async function POST(request: NextRequest) {
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

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { subject, error } = resolveSubjectFromRequest(request, { required: true, body });
  if (error) return error;

  const { slug } = parsed.data;
  if (META_SLUGS.has(slug)) {
    return NextResponse.json({ error: 'Cannot re-enrich a meta page (index/log)' }, { status: 400 });
  }

  const page = pagesRepo.getPageBySlug(subject.id, slug);
  if (!page) {
    return NextResponse.json({ error: `Page "${slug}" not found` }, { status: 404 });
  }
  if (page.tags.includes('meta')) {
    return NextResponse.json({ error: 'Cannot re-enrich a meta page' }, { status: 400 });
  }

  const job = queue.enqueue('re-enrich', { slug, subjectId: subject.id }, subject.id);
  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: 提交**

```bash
git add src/app/api/re-enrich/route.ts src/app/api/re-enrich/__tests__/validate.test.ts
git commit -m "feat(api): POST /api/re-enrich 校验入队 re-enrich 任务"
```

---

### Task 8: Re-enrich 阅读页入口（按钮 + 对话 + SSE）

「按钮 → 对话 → enqueue → SSE → 完成失效刷新」模式。

> **⚠ 代码已变更（curate 落地后）**：旧的 `merge-button.tsx`/`merge-dialog.tsx`/`split-*` 已删除，不能作模板。当前 enqueue→SSE 模式的活样板是 `src/components/health/health-view.tsx` 的 "Tidy structure" 按钮（`POST /api/curate` + `useJobStream` 追踪 `curate:*`）——参照它。本任务给出的 reenrich-button/reenrich-dialog 代码是自洽的，可直接落地，无需依赖任何模板文件。
>
> **⚠ FrontmatterDisplay 已无 `slug` prop**（随 merge/split 移除而删）。Re-enrich 按钮需要 slug，故本任务须：① 把 `slug?: string` 加回 `FrontmatterDisplayProps` 并在组件签名解构；② 在 `page-renderer.tsx` 调用 `<FrontmatterDisplay … />` 处补 `slug={slug}`（PageRenderer 已有 `slug` prop）。

**Files:**
- Create: `src/components/wiki/reenrich-button.tsx`
- Create: `src/components/wiki/reenrich-dialog.tsx`
- Modify: `src/components/wiki/frontmatter-display.tsx`（加回 `slug` prop + 动作菜单加按钮）
- Modify: `src/components/wiki/page-renderer.tsx`（FrontmatterDisplay 调用补 `slug={slug}`）

**Interfaces:**
- Consumes: `useApiFetch`、`useJobStream`、`useCurrentSubject`、`POST /api/re-enrich`（Task 7）

- [ ] **Step 1: 实现 reenrich-button**

新建 `src/components/wiki/reenrich-button.tsx`（按钮触发对话，结构参照 health-view 的入口按钮）：

```tsx
'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { ReenrichDialog } from './reenrich-dialog';

export function ReenrichButton({ slug, title }: { slug: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-tip="Re-enrich this page (re-run augmentation)"
        className="tip tip-b shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Re-enrich
      </button>
      {open && <ReenrichDialog slug={slug} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 2: 实现 reenrich-dialog**

新建 `src/components/wiki/reenrich-dialog.tsx`（enqueue→SSE→刷新，参照 health-view 的 `useJobStream` 用法；无候选选择，直接确认）：

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { Button } from '@/components/ui/button';

const INVALIDATE_KEYS = ['pages', 'page', 'graph'];

export function ReenrichDialog({
  slug,
  title,
  onClose,
}: {
  slug: string;
  title: string;
  onClose: () => void;
}) {
  const apiFetch = useApiFetch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: subjectId } = useCurrentSubject();

  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { status, latestMessage } = useJobStream(jobId);

  useEffect(() => {
    if (status === 'completed') {
      void (async () => {
        await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
        router.refresh();
        onClose();
      })();
    } else if (status === 'failed') {
      setError('Re-enrich failed — see the job tracker for details.');
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setError(null);
    const res = await apiFetch('/api/re-enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, subjectId }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `HTTP ${res.status}`);
      return;
    }
    const b = (await res.json()) as { jobId: string };
    setJobId(b.jobId);
  }

  const running = jobId !== null && status !== 'failed';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-foreground">Re-enrich “{title}”</h2>
        <p className="mt-2 text-sm text-foreground-secondary">
          Re-run the augmentation pass: layers fresh learning callouts onto the existing faithful prose,
          then verifies them. The faithful text is preserved.
        </p>
        {running && (
          <p className="mt-3 text-xs text-foreground-tertiary">{latestMessage || 'Working…'}</p>
        )}
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button intent="ghost" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button intent="primary" onClick={start} loading={running}>
            Re-enrich
          </Button>
        </div>
      </div>
    </div>
  );
}
```

> `INVALIDATE_KEYS = ['pages', 'page', 'graph']` 直接用此字面量即可（merge-dialog 已删除，无须对齐它）；与 health-view 失效 `['pages']` 同源思路。

- [ ] **Step 3: 加回 slug prop + 接入动作菜单**

`src/components/wiki/frontmatter-display.tsx`：

1. 顶部 import 加 `import { ReenrichButton } from './reenrich-button';`
2. `FrontmatterDisplayProps` 加 `slug?: string;`，组件签名解构里加 `slug,`。
3. 动作菜单 `<div className="flex items-center gap-2 shrink-0">`（当前仅含 Edit `<Link>`，约 L54-65）里、Edit 同级加：

```tsx
          {slug && <ReenrichButton slug={slug} title={title} />}
```

`src/components/wiki/page-renderer.tsx`：在渲染 `<FrontmatterDisplay … />` 处补传 `slug={slug}`（`PageRenderer` 已有 `slug` prop）。

- [ ] **Step 4: 类型检查 + 构建**

Run: `npx tsc --noEmit`
Expected: 无报错。
Run: `npx next build`
Expected: 构建成功。

- [ ] **Step 5: 端到端手测（启动 dev:all）**

Run: `npm run dev:all`（另起终端）
手测：打开任一 wiki 页 → 点 Re-enrich → 确认 → 观察 SSE 进度 → 完成后正文出现/更新 callout。
（无自动化 e2e；用 Playwright MCP 或浏览器人工核验。）

- [ ] **Step 6: 提交**

```bash
git add src/components/wiki/reenrich-button.tsx src/components/wiki/reenrich-dialog.tsx src/components/wiki/frontmatter-display.tsx
git commit -m "feat(ui): 阅读页加 Re-enrich 入口（对话 + SSE 追踪）"
```

---

### Task 9: 注册前端 SSE 事件名 + 文档收尾

**Files:**
- Modify: 前端 job 事件白名单（若存在，如 `use-job-stream` 或事件标签映射处，注册 `reenrich:start`）
- Modify: `CLAUDE.md`（根级 Changelog 加 P4 一行）
- Modify: `src/server/services/CLAUDE.md`（services 清单加 reenrich-service）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 检查事件名是否需注册**

Run: `grep -rn "ingest:start\|merge:start\|split:start" src/hooks src/components | head`
若存在事件类型白名单/标签映射（例如把已知 `*:start` 映射到 UI 文案），追加 `reenrich:start` / `reenrich` 同款条目；若 `use-job-stream` 透传任意事件（无白名单），跳过本步。

- [ ] **Step 2: 更新文档**

在根 `CLAUDE.md` 第九节 Changelog 表末尾加一行：

```
| 2026-06-23 | 增益 P4：per-subject 增益强度 + 手动重新增益 | `subjects.augmentation_level` 列（off/light/standard/deep）贯穿契约/API/管理页；ingest 按强度编排（off 跳过 enricher+verify）并注入强度指令；新增 `re-enrich` job + `reenrich-service`（复用流水线、现有正文当 draft、跳过 writer）+ `POST /api/re-enrich` + 阅读页 Re-enrich 入口；enricher skill v2。plan 见 docs/superpowers/plans/2026-06-23-augmentation-p4-reenrich.md |
```

在 `src/server/services/CLAUDE.md` 的 services 清单/职责处补 `reenrich-service`（一句话：手动重新增益，复用 ingest 增益流水线、跳过 writer）。

- [ ] **Step 3: 全量回归**

Run: `npx vitest run`
Expected: 全绿（含既有用例）。
Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md src/server/services/CLAUDE.md src/hooks src/components
git commit -m "docs(augment): 记录 P4 变更并注册 reenrich 事件"
```

---

## Rollout 注意

- enricher skill 由 v1 升 v2：worker 启动 `seedSkillFiles` **不覆盖**已存在文件。部署后须手动删 `data/vault/.llm-wiki/skills/ingest-enricher.md` 并重启 worker，否则 ingest 因 `MIN_SKILL_VERSIONS` 守卫 fail-fast 报「outdated」。
- 默认行为不变：所有 subject 默认 `standard`，与现状一致；`off` 才退回纯忠实层。

## Self-Review 对照（spec §12 / §14 覆盖）

- §12.1 per-subject 增益强度（off/light/standard/deep）→ Task 1（列+repo）/ Task 2（API）/ Task 3（UI，落 subjects 管理页）。**存储决策**：采用 `subjects` 表一等列（非 app_settings 键编码），因 UI 落 subjects 页、Subject 契约天然承载、ingest 已加载 subject 行、删 subject 级联清理——比 §12.1 设想的 `app_settings` 键编码更干净。
- §12.2 模型分层（enricher/verifier 用 `llm-config.json` 的 `skill:` 配置）→ 已存在能力，无需本计划改动（运维在 `llm-config.json` 配 `skill:ingest-enricher`）。
- §14 手动回填动作 → Task 6/7/8（`re-enrich` job + API + 入口）。**简化**：writer 跳过（现有正文当 draft）按 §14 原意；网页 source raw 导入定为 ingest-only（re-enrich 仅 frontmatter URL 留痕），列为已知限制。
- §6.3 enricher 输入加 augmentationLevel → Task 4/5（`augmentationDirective` 注入；`off` 跳过增益阶段）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-augmentation-p4-reenrich.md`. Two execution options:

1. Subagent-Driven (recommended) — 每个 task 派新 subagent，task 间复核，迭代快。
2. Inline Execution — 本会话内按 executing-plans 批量执行 + 检查点复核。

P5 维护层（`docs/superpowers/plans/2026-06-23-augmentation-p5-maintenance.md`）依赖本计划的 `re-enrich` job 与 `reenrich-service`，须在 P4 完成后执行。

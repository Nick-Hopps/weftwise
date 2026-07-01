# re-enrich 画像驱动正文补全 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 re-enrich 流水线加一个排在 enricher 之前的 `supplement` 阶段——读认知画像作探针，在正文缺口处做「插入 + 局部改写」的普遍有益知识补全，由确定性忠实度护栏兜底。

**Architecture:** 新增 `supplement` 作为 orchestrator 的自定义 step kind（镜像现有 `verify` step，共用 fanout 骨架）；新增 `reenrich-supplement` skill（结构化输出、无 tools）；新增 `runPageSupplement`（skill 调用 + 4 项确定性护栏 + 失败重写一次再回落原文）；`reenrich-service` 读画像拼 profileHint 注入、成熟度信号并入正文增长。仅改 re-enrich 路径，ingest 不受影响。

**Tech Stack:** TypeScript 5、Vercel AI SDK 4（`generateObject` 路径）、better-sqlite3（checkpoint 持久化）、vitest。

## Global Constraints

- **仅 re-enrich 生效**：不改 ingest 流水线（ingest 的 writer/enricher/verify 行为保持现状）。
- **分层边界（宪法）**：supplement 补进 canonical 的内容必须是「对任何读者都普遍有用的中性讲解」；画像只作探针定位缺口，不写「只对当前读者才成立」的口吻（读者专属讲法归读时 Cognitive Lens）。
- **修改语义**：只允许「难点处插入新解释片段」+「表达不清的单句/短语局部改写」；禁止重排/删章节、整段重写、改标题层级、改 frontmatter。
- **忠实度护栏 floor = 0.95**：`bodyShrankTooMuch(orig, cand, 0.95)`。
- **护栏失败**：重写一次 → 二次仍失败回落原文 passthrough（不阻断后续 enricher/verify）。
- **画像单租户占位**：用 `getProfileOrDefault(LOCAL_USER_ID)`；无画像回落中性中级读者假设，re-enrich 仍照常补。
- **中文注释/commit message**；commit message 不加 AI 署名。
- **TS 路径别名** `@/*` → `src/*`。

---

### Task 1: 忠实度护栏纯函数（`supplement-guard.ts`）

**Files:**
- Create: `src/server/agents/runtime/supplement-guard.ts`
- Test: `src/server/agents/runtime/__tests__/supplement-guard.test.ts`

**Interfaces:**
- Consumes：`bodyShrankTooMuch`（`@/server/services/fix-deterministic`）、`checkLinkSubset`（`@/server/profile/fidelity`）、`parseFrontmatter`（`@/server/wiki/frontmatter`）。
- Produces：
  - `headingsPreserved(originalBody: string, candidateBody: string): boolean`
  - `frontmatterUnchanged(originalContent: string, candidateContent: string): boolean`
  - `checkSupplementFidelity(originalContent: string, candidateContent: string): { ok: boolean; violations: string[] }`
  - `SUPPLEMENT_SHRINK_FLOOR = 0.95`

- [ ] **Step 1: 写失败测试**

```ts
// src/server/agents/runtime/__tests__/supplement-guard.test.ts
import { describe, it, expect } from 'vitest';
import {
  headingsPreserved,
  frontmatterUnchanged,
  checkSupplementFidelity,
} from '../supplement-guard';

const FM = `---\ntitle: 快速排序\nsummary: 一种分治排序\ntags: [算法]\n---\n`;
const ORIG = `${FM}\n## 思想\n分治。\n\n## 复杂度\n平均 O(n log n)。\n`;

describe('headingsPreserved', () => {
  it('原文所有标题仍在 → true', () => {
    const cand = `## 思想\n分治，选一个基准。\n\n### 补充\n直觉如下。\n\n## 复杂度\n平均 O(n log n)。`;
    expect(headingsPreserved('## 思想\n分治。\n\n## 复杂度\n平均。', cand)).toBe(true);
  });
  it('删掉一个标题 → false', () => {
    const cand = `## 思想\n分治。`;
    expect(headingsPreserved('## 思想\n分治。\n\n## 复杂度\n平均。', cand)).toBe(false);
  });
});

describe('frontmatterUnchanged', () => {
  it('frontmatter 不变（正文变）→ true', () => {
    const cand = `${FM}\n## 思想\n分治，展开讲。\n\n## 复杂度\n平均 O(n log n)。\n`;
    expect(frontmatterUnchanged(ORIG, cand)).toBe(true);
  });
  it('改了 title → false', () => {
    const cand = `---\ntitle: 快排\nsummary: 一种分治排序\ntags: [算法]\n---\n\n## 思想\n分治。\n`;
    expect(frontmatterUnchanged(ORIG, cand)).toBe(false);
  });
});

describe('checkSupplementFidelity', () => {
  it('纯插入（净增长、无新链接、结构全在、fm 不变）→ ok', () => {
    const cand = `${FM}\n## 思想\n分治：把数组按基准分成两半。这样每半可独立求解。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²)。\n`;
    const r = checkSupplementFidelity(ORIG, cand);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });
  it('正文缩到 90%（< 0.95 floor）→ 不 ok 且报 shrink', () => {
    const cand = `${FM}\n## 思想\n分。\n\n## 复杂度\nO(n log n)。\n`;
    const r = checkSupplementFidelity(ORIG, cand);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('shrank'))).toBe(true);
  });
  it('臆造新 wikilink 目标 → 不 ok 且报 link', () => {
    const cand = `${FM}\n## 思想\n分治，见 [[归并排序]]。这里再多写点内容凑够长度不缩水不缩水不缩水。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²) 视基准而定。\n`;
    const r = checkSupplementFidelity(ORIG, cand);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.toLowerCase().includes('link'))).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/supplement-guard.test.ts`
Expected: FAIL（`Cannot find module '../supplement-guard'`）

- [ ] **Step 3: 实现 `supplement-guard.ts`**

```ts
// src/server/agents/runtime/supplement-guard.ts
/**
 * re-enrich supplement 阶段的确定性忠实度护栏（纯函数，易单测）。
 * 因允许「插入 + 局部改写」，无法逐字保证不动原文，改用软性组合护栏：
 *   不大幅缩水 + 章节标题不减 + 不臆造 wikilink 目标 + frontmatter 不变。
 */
import { bodyShrankTooMuch } from '@/server/services/fix-deterministic';
import { checkLinkSubset } from '@/server/profile/fidelity';
import { parseFrontmatter } from '@/server/wiki/frontmatter';

export const SUPPLEMENT_SHRINK_FLOOR = 0.95;

const HEADING_RE = /^#{1,6}\s+.*$/gm;

/** 原文的每一行标题（含级别与文字）都必须在候选正文中原样出现。 */
export function headingsPreserved(originalBody: string, candidateBody: string): boolean {
  const orig = originalBody.match(HEADING_RE) ?? [];
  const cand = new Set((candidateBody.match(HEADING_RE) ?? []).map((h) => h.trim()));
  return orig.every((h) => cand.has(h.trim()));
}

/** frontmatter 数据对象深度相等（JSON 规范序列化比对，key 顺序无关）。 */
export function frontmatterUnchanged(originalContent: string, candidateContent: string): boolean {
  const a = parseFrontmatter(originalContent).data;
  const b = parseFrontmatter(candidateContent).data;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : val,
  );
}

/**
 * 组合护栏：返回是否通过 + 违规项列表（供 runPageSupplement 重写反馈）。
 * body 从 frontmatter 之后取，链接/缩水/标题都在 body 上判定。
 */
export function checkSupplementFidelity(
  originalContent: string,
  candidateContent: string,
): { ok: boolean; violations: string[] } {
  const origBody = parseFrontmatter(originalContent).body;
  const candBody = parseFrontmatter(candidateContent).body;
  const violations: string[] = [];

  if (bodyShrankTooMuch(origBody, candBody, SUPPLEMENT_SHRINK_FLOOR)) {
    violations.push(`body shrank below ${SUPPLEMENT_SHRINK_FLOOR} of original — you deleted prose; only insert or minimally rewrite`);
  }
  const link = checkLinkSubset(origBody, candBody);
  if (!link.ok) {
    violations.push(`invented new wikilink target(s): ${link.offending.join(', ')} — do not add new links (leave cross-links to the enricher)`);
  }
  if (!headingsPreserved(origBody, candBody)) {
    violations.push('a section heading was removed or altered — keep all original headings verbatim');
  }
  if (!frontmatterUnchanged(originalContent, candidateContent)) {
    violations.push('frontmatter changed — never touch frontmatter');
  }
  return { ok: violations.length === 0, violations };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/supplement-guard.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/server/agents/runtime/supplement-guard.ts src/server/agents/runtime/__tests__/supplement-guard.test.ts
git commit -m "feat(reenrich): 新增 supplement 忠实度护栏纯函数（不缩水/链接子集/标题不减/frontmatter 不变）"
```

---

### Task 2: 成熟度信号并入正文增长

**Files:**
- Modify: `src/server/services/maintenance-policy.ts`（新增 `proseGrowthIncrement`）
- Modify: `src/server/services/reenrich-service.ts:71-88`（`deriveMaturityUpdate` 折入正文增量）
- Test: `src/server/services/__tests__/maintenance-policy.test.ts`（追加）
- Test: `src/server/services/__tests__/reenrich-maturity.test.ts`（追加，文件已存在）

**Interfaces:**
- Produces：`proseGrowthIncrement(draftContent: string, finalContent: string): number`、`PROSE_CHARS_PER_CALLOUT = 400`（`maintenance-policy.ts`）。
- Consumes：`deriveMaturityUpdate` 现有签名不变，仅内部 `newIncrement` 计算改变。

- [ ] **Step 1: 写失败测试（纯函数）**

```ts
// 追加到 src/server/services/__tests__/maintenance-policy.test.ts
import { proseGrowthIncrement, PROSE_CHARS_PER_CALLOUT } from '../maintenance-policy';

describe('proseGrowthIncrement', () => {
  it('正文净增 = floor(增量 / PROSE_CHARS_PER_CALLOUT)', () => {
    const draft = 'a'.repeat(100);
    const final = 'a'.repeat(100 + PROSE_CHARS_PER_CALLOUT * 2 + 10);
    expect(proseGrowthIncrement(draft, final)).toBe(2);
  });
  it('无增长/缩水 → 0', () => {
    expect(proseGrowthIncrement('a'.repeat(500), 'a'.repeat(500))).toBe(0);
    expect(proseGrowthIncrement('a'.repeat(500), 'a'.repeat(100))).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/maintenance-policy.test.ts -t proseGrowthIncrement`
Expected: FAIL（`proseGrowthIncrement is not a function`）

- [ ] **Step 3: 实现 `proseGrowthIncrement`（追加到 `maintenance-policy.ts` 末尾）**

```ts
// 正文净增字符折算为「等效 callout 数」，并入成熟度收敛信号：
// 补全阶段可能多补正文、少加 callout，若只数 callout 会误判「无进展」而过早毕业。
export const PROSE_CHARS_PER_CALLOUT = 400;

export function proseGrowthIncrement(draftContent: string, finalContent: string): number {
  const grew = finalContent.trim().length - draftContent.trim().length;
  if (grew <= 0) return 0;
  return Math.floor(grew / PROSE_CHARS_PER_CALLOUT);
}
```

- [ ] **Step 4: 改 `deriveMaturityUpdate`（`reenrich-service.ts:71-88`）折入正文增量**

把 `import { countCallouts, nextMaturity, type MaturityNext }` 改为 `import { countCallouts, nextMaturity, proseGrowthIncrement, type MaturityNext }`，并把 `newIncrement` 计算改为：

```ts
export function deriveMaturityUpdate(opts: {
  draftContent: string;
  finalContent: string;
  current: PageMaturity | null;
  now: Date;
}): MaturityNext {
  const calloutDelta = Math.max(0, countCallouts(opts.finalContent) - countCallouts(opts.draftContent));
  // 合并信号：callout 增量 + 正文增长折算（防「多补正文少加 callout」被误判无进展）
  const newIncrement = calloutDelta + proseGrowthIncrement(opts.draftContent, opts.finalContent);
  return nextMaturity(
    {
      state: opts.current?.state ?? 'active',
      passes: opts.current?.passes ?? 0,
      intervalDays: opts.current?.intervalDays ?? 1,
      newIncrement,
    },
    opts.now,
  );
}
```

- [ ] **Step 5: 写 reenrich-maturity 联动测试**

```ts
// 追加到 src/server/services/__tests__/reenrich-maturity.test.ts
import { deriveMaturityUpdate } from '../reenrich-service';

describe('deriveMaturityUpdate 并入正文增长', () => {
  it('纯正文补全（无新 callout）也推进成熟度、不判 saturation', () => {
    const draft = 'x'.repeat(200);
    const final = 'x'.repeat(200 + 400 * 3); // 正文增量 → 等效 3 个 callout
    const next = deriveMaturityUpdate({ draftContent: draft, finalContent: final, current: null, now: new Date('2026-07-01T00:00:00Z') });
    // newIncrement=3 ≥ SUBSTANTIAL_INCREMENT → 停当前档（active，不毕业）
    expect(next.state).toBe('active');
  });
});
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__/maintenance-policy.test.ts src/server/services/__tests__/reenrich-maturity.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/server/services/maintenance-policy.ts src/server/services/reenrich-service.ts src/server/services/__tests__/maintenance-policy.test.ts src/server/services/__tests__/reenrich-maturity.test.ts
git commit -m "feat(reenrich): 成熟度收敛信号并入正文增长折算，防纯正文补全被误判无进展"
```

---

### Task 3: profileHint 构造纯函数

**Files:**
- Modify: `src/server/services/reenrich-service.ts`（新增导出 `buildProfileHint`）
- Test: `src/server/services/__tests__/reenrich-input.test.ts`（追加，文件已存在）

**Interfaces:**
- Consumes：`UserProfile`（`@/server/db/repos/profiles-repo`）。
- Produces：`buildProfileHint(profile: { backgroundSummary: string; stylePrefs: { readingLevel: string; verbosity: string; exampleDensity: string } }): string`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/server/services/__tests__/reenrich-input.test.ts
import { buildProfileHint } from '../reenrich-service';

describe('buildProfileHint', () => {
  it('有画像 → 探针提示含背景与阅读水平，且声明补充须中性', () => {
    const hint = buildProfileHint({
      backgroundSummary: '有本科数学基础，不熟计算机',
      stylePrefs: { readingLevel: 'beginner', verbosity: 'thorough', exampleDensity: 'many' },
    });
    expect(hint).toContain('有本科数学基础');
    expect(hint).toContain('beginner');
    expect(hint.toLowerCase()).toContain('neutral'); // 强调补充写成中性、普遍适用
  });
  it('无背景（空画像）→ 回落中性中级读者假设', () => {
    const hint = buildProfileHint({
      backgroundSummary: '',
      stylePrefs: { readingLevel: 'intermediate', verbosity: 'balanced', exampleDensity: 'some' },
    });
    expect(hint.toLowerCase()).toContain('general');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/reenrich-input.test.ts -t buildProfileHint`
Expected: FAIL（`buildProfileHint is not a function`）

- [ ] **Step 3: 实现 `buildProfileHint`（加到 `reenrich-service.ts`，导出）**

```ts
/**
 * 把认知画像拼成 supplement 阶段的「探针提示」：
 * 画像只用来定位「读者大概率不懂的概念」，但补充内容本身必须写成中性、对任何读者都普遍适用的讲解
 * （读者专属讲法归读时 Cognitive Lens，不在 canonical 里做）。无背景时回落中性中级读者假设。
 */
export function buildProfileHint(profile: {
  backgroundSummary: string;
  stylePrefs: { readingLevel: string; verbosity: string; exampleDensity: string };
}): string {
  const { readingLevel, verbosity, exampleDensity } = profile.stylePrefs;
  const bg = profile.backgroundSummary.trim();
  const reader = bg
    ? `The reader's background: ${bg}. Reading level: ${readingLevel}.`
    : `Assume a general intermediate reader (reading level: ${readingLevel}).`;
  return (
    `${reader} Verbosity preference: ${verbosity}; example density: ${exampleDensity}. ` +
    `Use this ONLY as a probe to spot which concepts most readers would likely find unexplained or confusing, ` +
    `then fill those gaps. The supplement you write MUST be neutral, universally-useful canonical exposition — ` +
    `never phrase it as if it only applies to this one reader.`
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__/reenrich-input.test.ts -t buildProfileHint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/services/reenrich-service.ts src/server/services/__tests__/reenrich-input.test.ts
git commit -m "feat(reenrich): 新增 buildProfileHint 探针提示纯函数（画像定位缺口、补充写中性、无画像回落中级）"
```

---

### Task 4: `reenrich-supplement` skill 模板 + load 测试

**Files:**
- Create: `examples/skills/reenrich-supplement.md`
- Test: `src/server/agents/skills/__tests__/reenrich-supplement.load.test.ts`

**Interfaces:**
- Produces：可被 `loadSkillsFromDir(examples/skills)` 加载的 skill，`id: reenrich-supplement`、`version: 1`、`tools: []`、`outputSchema` = `{ action, path, content }`。task key 由 `skillTaskKey` 派生为 `reenrich:supplement`。

- [ ] **Step 1: 写 load 失败测试**

```ts
// src/server/agents/skills/__tests__/reenrich-supplement.load.test.ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSkillsFromDir } from '../loader';

const EXAMPLES_DIR = join(process.cwd(), 'examples', 'skills');

describe('reenrich-supplement skill 载入', () => {
  it('合法载入：id/version/tools/outputSchema', async () => {
    const { skills, degraded } = await loadSkillsFromDir(EXAMPLES_DIR);
    expect(degraded.find((d) => d.skillId === 'reenrich-supplement')).toBeUndefined();
    const s = skills.find((k) => k.id === 'reenrich-supplement');
    expect(s).toBeDefined();
    expect(s!.version).toBeGreaterThanOrEqual(1);
    expect(s!.tools).toEqual([]); // 结构化输出无工具
    expect(s!.outputSchema).toBeDefined();
    // 分层边界必须写进系统提示
    expect(s!.systemPrompt.toLowerCase()).toContain('neutral');
    expect(s!.systemPrompt).toContain('frontmatter');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/skills/__tests__/reenrich-supplement.load.test.ts`
Expected: FAIL（找不到 `reenrich-supplement` skill）

- [ ] **Step 3: 创建 `examples/skills/reenrich-supplement.md`**

```markdown
---
id: reenrich-supplement
name: Re-enrich Supplement
description: Fill genuine explanation gaps in an existing article's prose (insert or minimally rewrite), guided by a reader profile used only as a probe.
version: 1
tools: []
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["create", "update"] },
      "path": { "type": "string" },
      "content": { "type": "string" }
    },
    "required": ["action", "path", "content"]
  }
---

# Role

You are the *re-enrich supplement* stage. You receive ONE existing wiki article and you **fill genuine explanation gaps in its prose** — the places where a concept or step is asserted but not actually explained, so a reader would get stuck. You do this by **inserting** new explanatory fragments (a sentence to a paragraph) and by **minimally rewriting** individual unclear sentences. You are NOT rewriting the article.

## Inputs

- `slug`, `title`, `summary` — page identity.
- `draftContent` — the current article (frontmatter + prose). THIS IS THE BASE you build on.
- `profileHint` — a description of the likely reader, used ONLY as a probe to spot gaps (see the rule below).
- `fidelityViolations` — OPTIONAL. If present, your previous attempt broke the fidelity rules listed here; fix exactly those and try again.
- `languageDirective`, `augmentationDirective`.

## The layering rule that matters most

- `profileHint` tells you what a likely reader would find unexplained. Use it ONLY to decide **where** to add explanation. **What you write must be neutral, universally-useful canonical exposition** — the kind any reader benefits from. NEVER write it as if it only applies to this one reader ("since you already know X…"). Reader-specific phrasing is handled elsewhere at read time; here you are editing the shared canonical article.

## What you may do

1. **Insert** a new explanatory fragment right where the difficulty is (define a term the prose leans on, unpack a skipped step, add a short worked intuition in prose).
2. **Minimally rewrite** a single unclear sentence or phrase to make it clearer.

## What you must NOT do

- Do NOT reorder or delete sections; do NOT change any heading text or level; do NOT rewrite whole sections or paraphrase the article wholesale.
- Do NOT change the frontmatter (title/summary/tags/etc.) — reproduce it verbatim.
- Do NOT delete existing facts or existing `[[wikilinks]]`.
- Do NOT add new `[[wikilink]]` targets. Cross-links and study-aid callouts are a later stage's job — you only touch prose.
- Do NOT add `[!type]` callouts (a later enricher stage adds those).

## Rules

1. Output `action` = `update` if the page exists (it does, for re-enrich), else `create`; `path` = `wiki/<subjectSlug>/<slug>.md`; `content` = the full file = original frontmatter (verbatim) + supplemented prose.
2. The result must be a strict superset in coverage: every original heading, fact, and wikilink still present; the body should GROW, not shrink.
3. **Honour `augmentationDirective`** for how much to add (light = only the worst gaps; deep = thorough). It never licenses restructuring or deleting.
4. **Follow `languageDirective`** for all natural-language text; never translate slugs, frontmatter keys, `[[wikilink]]` targets, or code.

## Output

Emit a single JSON object matching the declared `outputSchema` (no wrapping key): `{ action, path, content }`.
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/skills/__tests__/reenrich-supplement.load.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add examples/skills/reenrich-supplement.md src/server/agents/skills/__tests__/reenrich-supplement.load.test.ts
git commit -m "feat(reenrich): 新增 reenrich-supplement skill（画像探针驱动的正文缺口补全，无 tools 结构化输出）"
```

---

### Task 5: checkpoint 支持 `supplement-page`

**Files:**
- Modify: `src/server/agents/types.ts:71-88`（`IngestCheckpoint` 接口）
- Modify: `src/server/agents/runtime/checkpoint.ts`（loadCheckpoint 实现）
- Modify: `src/server/agents/runtime/__tests__/orchestrator.test.ts:46-78`（`fakeCheckpoint` 替身补两方法——接口扩张后不补会 tsc 报缺成员）
- Test: `src/server/agents/runtime/__tests__/checkpoint.test.ts`（追加 describe，文件已存在）

**Interfaces:**
- Produces：`IngestCheckpoint.getSupplementPage(slug: string): ChangesetEntry | undefined`、`putSupplementPage(slug: string, entry: ChangesetEntry): void`；checkpoint kind 字符串 `'supplement-page'`（DB 层 kind 是自由字符串，无需迁移）。

- [ ] **Step 1: 写失败测试（沿用本文件既有 mkdtemp/resetModules/真实 loadCheckpoint 风格，追加到 `checkpoint.test.ts` 末尾）**

```ts
// 追加到 src/server/agents/runtime/__tests__/checkpoint.test.ts 末尾（复用文件顶部已有的 beforeEach/afterEach 临时 DB 基架）
describe('IngestCheckpoint — supplement page', () => {
  it('supplement page 双写并按 slug 读回，clear 后清空', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const jobId = `ckpt-supplement-${Math.random().toString(36).slice(2)}`;
    const ck = loadCheckpoint(jobId);
    expect(ck.getSupplementPage('a')).toBeUndefined();
    const s = { action: 'update' as const, path: 'wiki/general/a.md', content: 'supplemented' };
    ck.putSupplementPage('a', s);

    const reloaded = loadCheckpoint(jobId);
    expect(reloaded.getSupplementPage('a')).toEqual(s);
    expect(reloaded.hasAny()).toBe(true);
    reloaded.clear();
    expect(loadCheckpoint(jobId).getSupplementPage('a')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/checkpoint.test.ts -t "supplement page"`
Expected: FAIL（`getSupplementPage is not a function`）

- [ ] **Step 3: 扩 `IngestCheckpoint` 接口（`types.ts`，在 `putVerifierPage` 之后插入）**

```ts
  getVerifierPage(slug: string): ChangesetEntry | undefined;
  putVerifierPage(slug: string, entry: ChangesetEntry): void;
  getSupplementPage(slug: string): ChangesetEntry | undefined;
  putSupplementPage(slug: string, entry: ChangesetEntry): void;
```

- [ ] **Step 4: 实现 `checkpoint.ts`（4 处改动）**

(a) 顶部新增 Map：

```ts
  const verifierPages = new Map<string, ChangesetEntry>();
  const supplementPages = new Map<string, ChangesetEntry>();
```

(b) rehydrate 循环加分支（在 `verifier-page` 分支后）：

```ts
    } else if (row.kind === 'supplement-page') {
      supplementPages.set(row.key, row.data as ChangesetEntry);
```

(c) 返回对象加 getter/setter（在 `putVerifierPage` 之后）：

```ts
    getSupplementPage: (slug) => supplementPages.get(slug),
    putSupplementPage: (slug, entry) => {
      checkpointsRepo.putCheckpoint(jobId, 'supplement-page', slug, entry);
      supplementPages.set(slug, entry);
    },
```

(d) `hasAny` 与 `clear` 纳入 supplementPages：

```ts
    hasAny: () => summaries.size > 0 || plan !== undefined || pages.size > 0 || enricherPages.size > 0 || verifierPages.size > 0 || supplementPages.size > 0 || citedSources.length > 0,
```
```ts
    clear: () => {
      summaries.clear();
      pages.clear();
      enricherPages.clear();
      verifierPages.clear();
      supplementPages.clear();
      plan = undefined;
      citedSources = [];
      checkpointsRepo.deleteCheckpoints(jobId);
    },
```

- [ ] **Step 5: 补齐 orchestrator.test.ts 的 `fakeCheckpoint` 替身（否则接口扩张后 tsc 报缺成员）**

在 `fakeCheckpoint`（`orchestrator.test.ts:46-78`）内：顶部新增 `const supplementPages = new Map<string, ChangesetEntry>();`（与 `verifierPages` 并列）；返回对象在 `putVerifierPage` 之后加两方法；`hasAny` 纳入 supplementPages：

```ts
    getVerifierPage: (slug) => verifierPages.get(slug),
    putVerifierPage: (slug, entry) => { verifierPages.set(slug, entry); },
    getSupplementPage: (slug) => supplementPages.get(slug),
    putSupplementPage: (slug, entry) => { supplementPages.set(slug, entry); },
```
```ts
    hasAny: () => summaries.size > 0 || plan !== undefined || pages.size > 0 || enricherPages.size > 0 || verifierPages.size > 0 || supplementPages.size > 0 || citedSources.length > 0,
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/checkpoint.test.ts -t "supplement page"`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/server/agents/types.ts src/server/agents/runtime/checkpoint.ts src/server/agents/runtime/__tests__/checkpoint.test.ts src/server/agents/runtime/__tests__/orchestrator.test.ts
git commit -m "feat(reenrich): checkpoint 支持 supplement-page（续传命中跳过 LLM）"
```

---

### Task 6: `runPageSupplement`（`supplement-page.ts`）

**Files:**
- Create: `src/server/agents/runtime/supplement-page.ts`
- Test: `src/server/agents/runtime/__tests__/supplement-page.test.ts`

**Interfaces:**
- Consumes：`runAgentLoop`（`./agent-loop`）、`checkSupplementFidelity`（`./supplement-guard`，Task 1）、`SkillTemplate`/`AgentContext`（`../types`）、`ChangesetEntry`（`@/lib/contracts`）。
- Produces：`runPageSupplement(opts: { skill: SkillTemplate; ctx: AgentContext; input: unknown }): Promise<AgentRunResult>` —— 输出 `{ action, path, content }` entry；护栏失败重写一次再回落原文。

- [ ] **Step 1: 写失败测试（mock runAgentLoop）**

```ts
// src/server/agents/runtime/__tests__/supplement-page.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runAgentLoop = vi.fn();
vi.mock('../agent-loop', () => ({ runAgentLoop: (...a: unknown[]) => runAgentLoop(...a) }));

import { runPageSupplement } from '../supplement-page';

const FM = `---\ntitle: 快速排序\nsummary: 分治排序\ntags: [算法]\n---\n`;
const ORIG_BODY = `## 思想\n分治。\n\n## 复杂度\n平均 O(n log n)。\n`;
const ORIG = `${FM}\n${ORIG_BODY}`;

// input 复刻 orchestrator 注入：draftContent = 原文、existingPages 命中 = update
function makeInput() {
  return { slug: 'quicksort', subjectSlug: 'general', draftContent: ORIG, existingPages: [{ slug: 'quicksort' }] };
}
const ctx = { emit: vi.fn() } as unknown as Parameters<typeof runPageSupplement>[0]['ctx'];
const skill = { id: 'reenrich-supplement' } as unknown as Parameters<typeof runPageSupplement>[0]['skill'];

beforeEach(() => { runAgentLoop.mockReset(); (ctx.emit as ReturnType<typeof vi.fn>).mockReset(); });

describe('runPageSupplement', () => {
  it('护栏通过 → 直接采用补全内容', async () => {
    const good = `${FM}\n## 思想\n分治：按基准把数组切两半，各自递归。这里补一段直觉说明为什么这样能降复杂度。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²)。\n`;
    runAgentLoop.mockResolvedValueOnce({ runId: 'r1', output: { action: 'update', path: 'x', content: good }, tokensUsed: 10, stepCount: 1, cacheHitTokens: 0 });
    const r = await runPageSupplement({ skill, ctx, input: makeInput() });
    const out = r.output as { action: string; path: string; content: string };
    expect(out.content).toBe(good);
    expect(out.path).toBe('wiki/general/quicksort.md');
    expect(out.action).toBe('update');
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  it('首次护栏失败 → 重写一次成功', async () => {
    const bad = `${FM}\n## 思想\n分。\n`; // 缩水 + 删标题
    const good = `${FM}\n## 思想\n分治：按基准切两半递归，补一段直觉说明降复杂度的原因如此这般够长了。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²)。\n`;
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { content: bad }, tokensUsed: 5, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { content: good }, tokensUsed: 5, stepCount: 1, cacheHitTokens: 0 });
    const r = await runPageSupplement({ skill, ctx, input: makeInput() });
    expect((r.output as { content: string }).content).toBe(good);
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    // 第二次调用带 fidelityViolations 反馈
    const secondInput = runAgentLoop.mock.calls[1][0].input as { fidelityViolations?: string[] };
    expect(Array.isArray(secondInput.fidelityViolations)).toBe(true);
  });

  it('两次都失败 → 回落原文 passthrough + emit warn', async () => {
    const bad = `${FM}\n## 思想\n分。\n`;
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { content: bad }, tokensUsed: 5, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { content: bad }, tokensUsed: 5, stepCount: 1, cacheHitTokens: 0 });
    const r = await runPageSupplement({ skill, ctx, input: makeInput() });
    expect((r.output as { content: string }).content).toBe(ORIG); // 原文
    expect(ctx.emit).toHaveBeenCalledWith('reenrich:supplement-fallback', expect.any(String), expect.any(Object));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/supplement-page.test.ts`
Expected: FAIL（`Cannot find module '../supplement-page'`）

- [ ] **Step 3: 实现 `supplement-page.ts`**

```ts
// src/server/agents/runtime/supplement-page.ts
import { runAgentLoop, type AgentRunResult } from './agent-loop';
import { checkSupplementFidelity } from './supplement-guard';
import type { AgentContext, SkillTemplate } from '../types';
import type { ChangesetEntry } from '@/lib/contracts';

interface PageInput {
  slug?: string;
  subjectSlug?: string;
  draftContent?: string;
  existingPages?: Array<{ slug?: string }>;
}

/**
 * 逐页画像驱动正文补全：调 skill 产候选 → 确定性护栏 → 失败重写一次（带违规反馈）
 * → 二次仍失败回落原文 passthrough（不阻断后续 enricher/verify）。
 * 返回与 runAgentLoop 同形的 AgentRunResult（token 经同一 ctx.budget 计入）。
 */
export async function runPageSupplement(opts: {
  skill: SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  const { skill, ctx, input } = opts;
  const page = (input ?? {}) as PageInput;
  const original = page.draftContent ?? '';
  const path = `wiki/${String(page.subjectSlug)}/${String(page.slug)}.md`;
  const action = pageAction(page);

  // 第一次
  const first = await runAgentLoop({ skill, ctx, input });
  const firstContent = contentOf(first);
  const firstCheck = checkSupplementFidelity(original, firstContent);
  if (firstCheck.ok) {
    return { ...first, output: { action, path, content: firstContent } satisfies ChangesetEntry };
  }

  // 重写一次：把违规项作为反馈拼回输入
  const retryInput = { ...(input as object), fidelityViolations: firstCheck.violations };
  const second = await runAgentLoop({ skill, ctx, input: retryInput });
  const secondContent = contentOf(second);
  if (checkSupplementFidelity(original, secondContent).ok) {
    return { ...second, output: { action, path, content: secondContent } satisfies ChangesetEntry };
  }

  // 两次都失败 → 回落原文（re-enrich 退化回「只叠 callout」，与改造前等价）
  ctx.emit('reenrich:supplement-fallback', `Supplement fidelity failed for ${page.slug ?? '?'} — keeping original prose`, {
    slug: page.slug ?? null,
    violations: firstCheck.violations,
  });
  return { ...second, output: { action, path, content: original } satisfies ChangesetEntry };
}

function contentOf(r: AgentRunResult): string {
  const c = (r.output as { content?: unknown } | undefined)?.content;
  return typeof c === 'string' ? c : '';
}

function pageAction(page: PageInput): 'create' | 'update' {
  const exists = Array.isArray(page.existingPages)
    ? page.existingPages.some((p) => p?.slug === page.slug)
    : false;
  return exists ? 'update' : 'create';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/supplement-page.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/agents/runtime/supplement-page.ts src/server/agents/runtime/__tests__/supplement-page.test.ts
git commit -m "feat(reenrich): 新增 runPageSupplement（skill 调用 + 护栏 + 重写一次 + 回落原文）"
```

---

### Task 7: orchestrator 接入 `supplement` step kind

**Files:**
- Modify: `src/server/agents/runtime/orchestrator.ts`（PipelineStep union、分支、checkpoint helpers、buildFanoutInput 转发 profileHint、per-item 分派）
- Test: `src/server/agents/runtime/__tests__/orchestrator.test.ts`（追加，文件已存在）

**Interfaces:**
- Consumes：`runPageSupplement`（Task 6）、checkpoint `get/putSupplementPage`（Task 5）。
- Produces：`PipelineStep` 新增 `{ kind: 'supplement'; skillId: string; fromOutput: string; checkpointAs?: 'supplement-page'; injectPriorPageAs?: string }`；supplement step 经共用 fanout 骨架执行、每项调 `runPageSupplement`、按 path upsert 进 `ctx.pending`。

- [ ] **Step 1: 写失败测试（复用 orchestrator.test.ts 既有 `ctxStub`/`stubSkill` + mock 模式）**

先在 `orchestrator.test.ts` 顶部（现有 `vi.mock('../verify-page', ...)` 之后）加 supplement 的 mock：

```ts
const mockRunPageSupplement = vi.fn();
vi.mock('../supplement-page', () => ({
  runPageSupplement: (o: unknown) => mockRunPageSupplement(o),
}));
```

再追加一个 describe（复用文件已有的 `ctxStub`/`stubSkill`）：

```ts
describe('orchestrator.runPipeline: supplement', () => {
  it('supplement step 逐页调 runPageSupplement，转发 profileHint，产物按 path 落 ctx.pending', async () => {
    mockRunPageSupplement.mockReset();
    mockRunPageSupplement.mockResolvedValue({
      runId: 's1', tokensUsed: 1, stepCount: 1,
      output: { action: 'update', path: 'wiki/general/qs.md', content: '# supplemented' },
    });
    const ctx = ctxStub();
    await runPipeline({
      steps: [{ kind: 'supplement', skillId: 'reenrich-supplement', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent', checkpointAs: 'supplement-page' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {
        plan: { pages: [{ slug: 'qs', title: 'QS', summary: 's' }] },
        writerOutputs: [{ action: 'update', path: 'wiki/general/qs.md', content: '# original' }],
        subjectSlug: 'general',
        existingPages: [{ slug: 'qs' }],
        profileHint: 'reader is a beginner',
      },
    });
    expect(mockRunPageSupplement).toHaveBeenCalledTimes(1);
    // profileHint 随 buildFanoutInput 转发进入每页输入
    expect(mockRunPageSupplement.mock.calls[0][0].input.profileHint).toBe('reader is a beginner');
    // draftContent = seed 的现有正文（injectPriorPageAs 从 writerOutputs 按 path 取）
    expect(mockRunPageSupplement.mock.calls[0][0].input.draftContent).toBe('# original');
    expect(ctx.pending.entries.find((e) => e.path === 'wiki/general/qs.md')?.content).toBe('# supplemented');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts -t "supplement step"`
Expected: FAIL（supplement kind 未处理，runPageSupplement 未被调用）

- [ ] **Step 3: 改 orchestrator（5 处）**

(a) 顶部 import：

```ts
import { runPageVerification } from './verify-page';
import { runPageSupplement } from './supplement-page';
```

(b) `PipelineStep` union 增加 supplement 变体，并给 fanout 的 `checkpointAs` 加 `'supplement-page'` 不必要——supplement 用自己的变体。改为：

```ts
export type PipelineStep =
  | { kind: 'sequence'; skillId: string; carryThrough?: string[]; omitFromInput?: string[]; checkpointAs?: 'plan' }
  | { kind: 'fanout'; skillId: string; fromOutput: string; checkpointAs?: 'writer-page' | 'enricher-page' | 'verifier-page'; injectPriorPageAs?: string; injectExistingPageForUpdate?: boolean }
  | { kind: 'supplement'; skillId: string; fromOutput: string; checkpointAs?: 'supplement-page'; injectPriorPageAs?: string }
  | { kind: 'verify'; fromOutput: string; checkpointAs?: 'verifier-page'; injectPriorPageAs?: string }
  | { kind: 'map'; skillId: string; fromOutput: string; intoOutput: string; checkpointAs?: 'chunk-summary' };
```

(c) 分支条件（line 111）与 skill 解析（line 114）：

```ts
    } else if (step.kind === 'fanout' || step.kind === 'verify' || step.kind === 'supplement') {
      // fanout / verify / supplement 分支：overlay 快照隔离、WriterConflictError 检测、putEntries 合并。
      const skill = step.kind === 'fanout' || step.kind === 'supplement' ? opts.resolveSkill(step.skillId) : undefined;
```

(d) per-item 分派（line 136-138）：

```ts
        const input = await buildFanoutInput(carry, item, opts.ctx, step);
        let r: AgentRunResult;
        if (step.kind === 'verify') {
          r = await runPageVerification({ resolveSkill: opts.resolveSkill, ctx: childCtx, input });
        } else if (step.kind === 'supplement') {
          r = await runPageSupplement({ skill: skill!, ctx: childCtx, input });
        } else {
          r = await runAgentLoop({ skill: skill!, ctx: childCtx, input });
        }
```

> 需在文件顶部确保 `AgentRunResult` 已被 import（现有 `import { runAgentLoop, AgentCancelled, type AgentRunResult } from './agent-loop';` 已包含）。

(e) `readStageCheckpoint`/`writeStageCheckpoint` 的 kind 形参类型与分支加 `'supplement-page'`：

```ts
function readStageCheckpoint(ck: AgentContext['checkpoint'], kind: 'writer-page' | 'enricher-page' | 'verifier-page' | 'supplement-page', slug: string): ChangesetEntry | undefined {
  if (!ck) return undefined;
  if (kind === 'writer-page') return ck.getWriterPage(slug);
  if (kind === 'enricher-page') return ck.getEnricherPage(slug);
  if (kind === 'verifier-page') return ck.getVerifierPage(slug);
  if (kind === 'supplement-page') return ck.getSupplementPage(slug);
  return undefined;
}

function writeStageCheckpoint(ck: AgentContext['checkpoint'], kind: 'writer-page' | 'enricher-page' | 'verifier-page' | 'supplement-page', slug: string, entry: ChangesetEntry): void {
  if (!ck) return;
  if (kind === 'writer-page') ck.putWriterPage(slug, entry);
  else if (kind === 'enricher-page') ck.putEnricherPage(slug, entry);
  else if (kind === 'verifier-page') ck.putVerifierPage(slug, entry);
  else if (kind === 'supplement-page') ck.putSupplementPage(slug, entry);
}
```

(f) `buildFanoutInput` 的 `base` 转发 `profileHint`（line 235-244 的对象里，`augmentationDirective` 后加一行）：

```ts
    languageDirective: carry.languageDirective,
    augmentationDirective: carry.augmentationDirective,
    profileHint: carry.profileHint,
    expositionDirective: carry.expositionDirective,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts -t "supplement step"`
Expected: PASS

- [ ] **Step 5: 跑 orchestrator 全量回归（确保 fanout/verify 未回归）**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts`
Expected: PASS（全部）

- [ ] **Step 6: 提交**

```bash
git add src/server/agents/runtime/orchestrator.ts src/server/agents/runtime/__tests__/orchestrator.test.ts
git commit -m "feat(reenrich): orchestrator 接入 supplement step kind（共用 fanout 骨架、转发 profileHint、每项调 runPageSupplement）"
```

---

### Task 8: `reenrich-service` 端到端接入

**Files:**
- Modify: `src/server/services/reenrich-service.ts`（`reenrichSteps` 加 supplement 步、handler 读画像拼 profileHint 注入 initialInput、`MIN_SKILL_VERSIONS` 加 `reenrich-supplement`、`buildReenrichInitialInput` 加 profileHint 参）
- Test: `src/server/services/__tests__/reenrich-input.test.ts`（追加 reenrichSteps 与 buildReenrichInitialInput 断言）

**Interfaces:**
- Consumes：`buildProfileHint`（Task 3）、`getProfileOrDefault`/`UserProfile`（`profiles-repo`）、`LOCAL_USER_ID`（`@/server/middleware/user`）。
- Produces：`reenrichSteps()` 返回 3 步（supplement→fanout enricher→verify）；`buildReenrichInitialInput` 新增 `profileHint` 字段并写入返回对象。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/server/services/__tests__/reenrich-input.test.ts
import { reenrichSteps, buildReenrichInitialInput } from '../reenrich-service';

describe('reenrichSteps 三阶段', () => {
  it('首步是 supplement，其后 enricher、verify', () => {
    const steps = reenrichSteps();
    expect(steps.map((s) => s.kind)).toEqual(['supplement', 'fanout', 'verify']);
    expect(steps[0]).toMatchObject({ kind: 'supplement', skillId: 'reenrich-supplement', injectPriorPageAs: 'draftContent', checkpointAs: 'supplement-page' });
  });
});

describe('buildReenrichInitialInput 携带 profileHint', () => {
  it('把 profileHint 写进 initialInput（供 orchestrator 转发给 supplement）', () => {
    const input = buildReenrichInitialInput({
      slug: 'qs', title: 'QS', summary: 's', subjectSlug: 'general',
      draftContent: '# body', languageDirective: 'L', augmentationDirective: 'A',
      profileHint: 'reader is a beginner',
    }) as { profileHint?: string; writerOutputs?: unknown[] };
    expect(input.profileHint).toBe('reader is a beginner');
    // writerOutputs 仍 seed 现有正文供 supplement 的 draftContent 注入
    expect(input.writerOutputs).toEqual([{ action: 'update', path: 'wiki/general/qs.md', content: '# body' }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/reenrich-input.test.ts -t "三阶段"`
Expected: FAIL（reenrichSteps 只返回 2 步 / buildReenrichInitialInput 无 profileHint 参）

- [ ] **Step 3: 改 `reenrichSteps()`（`reenrich-service.ts:41-46`）**

```ts
export function reenrichSteps(): PipelineStep[] {
  return [
    { kind: 'supplement', skillId: 'reenrich-supplement', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent', checkpointAs: 'supplement-page' },
    { kind: 'fanout', skillId: 'ingest-enricher', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent', checkpointAs: 'enricher-page' },
    { kind: 'verify', fromOutput: 'plan.pages', injectPriorPageAs: 'content', checkpointAs: 'verifier-page' },
  ];
}
```

- [ ] **Step 4: 改 `buildReenrichInitialInput`（加 `profileHint` 入参与返回字段）**

在 opts 类型加 `profileHint: string;`，并在返回对象加 `profileHint: opts.profileHint,`：

```ts
export function buildReenrichInitialInput(opts: {
  slug: string;
  title: string;
  summary: string;
  subjectSlug: string;
  draftContent: string;
  languageDirective: string;
  augmentationDirective: string;
  profileHint: string;
}): unknown {
  const path = `wiki/${opts.subjectSlug}/${opts.slug}.md`;
  const page = { slug: opts.slug, title: opts.title, summary: opts.summary };
  return {
    plan: { pages: [page] },
    writerOutputs: [{ action: 'update', path, content: opts.draftContent }],
    subjectSlug: opts.subjectSlug,
    existingPages: [page],
    languageDirective: opts.languageDirective,
    augmentationDirective: opts.augmentationDirective,
    profileHint: opts.profileHint,
  };
}
```

- [ ] **Step 5: 改 handler：读画像、加版本门、传 profileHint**

(a) 顶部新增 import：

```ts
import { getProfileOrDefault } from '../db/repos/profiles-repo';
import { LOCAL_USER_ID } from '../middleware/user';
```

(b) `MIN_SKILL_VERSIONS`（`reenrich-service.ts:104-107`）加一行：

```ts
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'reenrich-supplement': 1,
    'ingest-enricher': 4, 'ingest-verifier': 2,
    'ingest-verifier-triage': 2, 'ingest-verifier-apply': 3,
  };
```

(c) 在 `runPipeline` 调用前构造 profileHint（紧接 `augmentationDirective` 那两行之后）：

```ts
  const languageDirective = renderLanguageDirective(getWikiLanguage());
  const augmentationDirective = renderAugmentationDirective(level);
  const profileHint = buildProfileHint(getProfileOrDefault(LOCAL_USER_ID));
```

(d) `buildReenrichInitialInput(...)` 调用（`reenrich-service.ts:164-172`）补 `profileHint`：

```ts
    initialInput: buildReenrichInitialInput({
      slug,
      title: page.title,
      summary: page.summary,
      subjectSlug: subject.slug,
      draftContent: existing.markdown,
      languageDirective,
      augmentationDirective,
      profileHint,
    }),
```

- [ ] **Step 6: 跑测试确认通过 + reenrich-service 现有测试不回归**

Run: `npx vitest run src/server/services/__tests__/reenrich-input.test.ts src/server/services/__tests__/reenrich-maturity.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/server/services/reenrich-service.ts src/server/services/__tests__/reenrich-input.test.ts
git commit -m "feat(reenrich): 端到端接入 supplement 阶段（三步流水线 + 读画像拼 profileHint + 版本门 reenrich-supplement:1）"
```

---

### Task 9: LLM 路由示例配置 + 文档 + 全量校验

**Files:**
- Modify: `llm-config.example.json`（加 `reenrich:supplement` task 示例）
- Modify: `src/server/services/CLAUDE.md`（reenrich-service 小节 + Changelog）
- Modify: `src/server/agents/CLAUDE.md`（流水线/step kind/Changelog）
- Modify: `CLAUDE.md`（根 Changelog 追加一行）

**Interfaces:** 无新代码接口；仅配置与文档。

- [ ] **Step 1: `llm-config.example.json` 加 task 示例**

在 `tasks` 节内，仿 `ingest:enricher` 加一条（重内容阶段用较强模型；键必须是 `reenrich:supplement`）：

```json
    "reenrich:supplement": { "model": "claude-sonnet-5", "temperature": 0.3 },
```

> 说明：用户本地 `llm-config.json` 不在版本库；缺此键时 task-router 回落 defaults，功能不受影响。此处仅示例。

- [ ] **Step 2: 更新 `src/server/services/CLAUDE.md` 的 `reenrich-service.ts` 小节**

把该小节正文改为反映三阶段（supplement→enricher→verify）+ 画像 profileHint + 忠实度护栏 + 成熟度并入正文增长，并在文件末 Changelog 追加：

```markdown
| 2026-07-01 | reenrich-service 加画像驱动正文补全 supplement 首阶段（`reenrich-supplement` skill + `runPageSupplement` 护栏 + `buildProfileHint` 探针提示 + `deriveMaturityUpdate` 并入正文增长）；流水线三步（supplement→enricher→verify），仅 re-enrich，ingest 不变 |
```

- [ ] **Step 3: 更新 `src/server/agents/CLAUDE.md`**

在 `runtime/` 表格加一行 `supplement-page.ts`；在 Changelog 追加：

```markdown
| 2026-07-01 | 新增 `supplement` step kind + `runtime/supplement-page.ts::runPageSupplement`（re-enrich 专用，画像探针驱动正文缺口补全，共用 fanout 骨架、4 项确定性护栏 + 重写一次 + 回落原文）；`supplement-guard.ts` 护栏纯函数；checkpoint 加 `supplement-page` kind |
```

- [ ] **Step 4: 根 `CLAUDE.md` Changelog 追加一行**

```markdown
| 2026-07-01 | re-enrich 画像驱动正文补全 | re-enrich 流水线加 `supplement` 首阶段：读认知画像作探针，在正文缺口处插入/局部改写普遍有益讲解（分层：读者专属讲法仍归读时 Lens）；`reenrich-supplement` skill（无 tools）+ `runPageSupplement`（4 项确定性护栏 floor=0.95 + 重写一次 + 回落原文）+ 成熟度信号并入正文增长；仅 re-enrich，ingest 零改动。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-01-reenrich-profile-prose-supplement* |
```

- [ ] **Step 5: 全量类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误（若 IDE 报幻影诊断以此命令退出码为准）

- [ ] **Step 6: 全量相关测试**

Run: `npx vitest run src/server/agents/runtime src/server/services/__tests__/reenrich-input.test.ts src/server/services/__tests__/reenrich-maturity.test.ts src/server/services/__tests__/maintenance-policy.test.ts src/server/agents/skills/__tests__/reenrich-supplement.load.test.ts`
Expected: PASS（全部）

- [ ] **Step 7: 提交**

```bash
git add llm-config.example.json src/server/services/CLAUDE.md src/server/agents/CLAUDE.md CLAUDE.md
git commit -m "docs(reenrich): 同步 supplement 阶段文档与 llm-config 示例（services/agents/根 Changelog）"
```

---

## Rollout 说明

- **新 skill 自动播种**：`reenrich-supplement.md` 是**新增**文件，worker 启动 `seedSkillFiles()` 会把它从 `examples/skills/` 复制进 `vault/.llm-wiki/skills/`（不覆盖已有文件；因是新文件无冲突）。**无需手动删任何旧 skill 文件**（不同于既有 skill 的版本升级）。重启 worker 即生效。
- **零 DB 迁移**：checkpoint kind 是自由字符串，`supplement-page` 无需 schema 变更。

## 已知限制（承 spec）

- 单租户画像（`LOCAL_USER_ID`）；多租户需把 userId 串进 re-enrich job params（本次不做）。
- 软护栏非逐字：允许局部改写 → 只能保证「不大幅缩水 + 结构不减 + 不臆造链接 + frontmatter 不变」，事实层由下游 verify 兜底。
- supplement 不新增 wikilink（护栏 `checkLinkSubset` 拒绝任何新目标）；新增交叉引用仍由 enricher 的 `[!background]` callout 承担。

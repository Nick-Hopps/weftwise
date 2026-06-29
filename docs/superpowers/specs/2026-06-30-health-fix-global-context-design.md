# Health 一键修复注入全局诊断上下文 — 设计文档

> 日期：2026-06-30
> 主题：Health「Fix issues」逐页 LLM 修复时，额外注入「整个 subject 的诊断报告」+「本页 findings 涉及的关联页正文」两块只读上下文，减少跨页问题修不掉、修复反复需要多次点击的情况。

---

## 一、背景与目标

`fix-service`（见 `2026-06-24-health-fix-findings-design.md`）的 LLM 阶段**按 `pageSlug` 分组、每页一个 commit**。当前每次 `generateStructuredOutput('fix')` 调用只拿到三样东西：

1. **本页**的正文；
2. **本页自己的** findings 切片（`findingsOnPage`）；
3. 本 subject 的页名册 `roster`（title + slug 清单，无正文）。

LLM 因此**只看到孤立的一页**，看不到整个知识库的诊断全貌，也看不到与本页冲突/关联的其他页正文。这导致两类已被用户确认的痛点：

- **跨页问题修不掉**：`contradiction`（本页与另一页事实冲突）在缺少对方页正文时无法和解，LLM 只能 `proceed=false` 跳过；`missing-crossref` / `broken-link` 的相关页信息也不足，relink 目标判断偏弱。
- **修复引入新问题 / 需要多次点击**：单页修复彼此独立、互不知情，反复点 Fix 也清不掉这些跨页项。

**目标**：在**不改 lint 产出、不改 Saga / commit 粒度、不引入 agent runtime** 的前提下，把"当前已经诊断出来的问题"作为上下文喂给逐页修复的 LLM——
1. 注入 **subject 级诊断报告**（全部可修复 findings，按页分组）；
2. 注入 **关联页正文**（本页 findings 在描述中提及的其他真实页的当前正文）。

LLM 仍**只编辑当前待修页 / 每页一个 commit**，保持可回滚、blast radius 小、token 可控。

**非目标（本次明确不做）**：

- **不自动迭代**（用户已选定方案 A，不要求"修完重扫再修一轮直到干净"的内循环）。完整消除回归仍靠现有 `validateChangeset` 守卫 + UI 修复后自动重跑 lint 暴露残留。
- 不改 `FixPageSchema`（仍返回单页 `body`），不让 LLM 一次编辑多页。
- 不做整 subject 单次大调用（token 爆 / blast radius 大，已在方案对比中否决）。
- 不改 lint 检测逻辑、不给 `LintFinding` 增结构化"对方页"字段（关联页靠描述文本启发式提取——见决策 2）。
- 不修 `orphan` / `stale-source` / `coverage-gap`（沿用原路由）。

---

## 二、关键架构决策

### 决策 1：保持「按页 commit」，仅扩充每页调用的只读上下文

不改提交粒度（每页一个 Saga changeset → 一个 commit → ⑥ 历史可逐条 revert）。改的只是 `buildFixPageUserPrompt` 的输入——多两块**只读上下文块**：

- `## Subject-wide health report (read-only context)`：本 subject 全部可修复 findings 按页分组（type + 简述）。**对每页调用都相同**，故全程**构建一次**复用。
- `## Related pages (read-only — current content)`：本页 findings 涉及的其他真实页的当前正文（title + slug + 截断 body）。**逐页计算**。

系统提示新增硬约束：这两块是**只读**，LLM 只能返回"待修页"的正文，不得臆造对其他页的编辑；`contradiction` 现在可参照对方页做和解，但仍须忠实本页、拿不准即 `proceed=false`。

### 决策 2：关联页提取靠「描述文本匹配 roster」启发式

`LintFinding = { type, severity, pageSlug, description, suggestedFix }` 是扁平结构，**没有结构化的"对方页"字段**。`contradiction` 的对方页只存在于 `description` 自由文本里（`lint-prompt.ts` 要求"name both page slugs / quote both statements"）。在不改 lint 产出的前提下，最务实的做法是**纯函数启发式**：

`findRelatedPageSlugs(pageSlug, findingsOnPage, roster, contradictionPageSlugs?) → string[]`：
- 对本页每条 finding，扫描其 `description`（必要时含 `suggestedFix`），匹配 `roster` 中任一页的 **slug**（按词边界）或 **title**（大小写不敏感、整词），命中即收为关联页；
- **排除自身**（`pageSlug`）；
- **contradiction 兜底**：若本页有 `contradiction` finding 却没从描述匹到任何关联页，则纳入 `contradictionPageSlugs`（service 从整个 worklist 预计算的"带 contradiction finding 的全部页"集合，排除自身）——很可能就是冲突对方；
- 去重、按出现顺序稳定排序、**上限 `MAX_RELATED_PAGES`（默认 4）**。

启发式可能漏召（描述没写全页名）或误召（同名词），但：误召只是多给一点只读上下文（无害，仅耗 token），漏召则退化为原行为（仅本页上下文）。可接受。

### 决策 3：关联页正文实时读盘、不缓存

逐页修复**串行**进行，前面的页可能已 commit 落盘。关联页正文用 `readPageInSubject(subject.slug, slug)` **每次实时读取**，确保拿到的是修后最新内容（而非 job 开始时的快照），不做 body 缓存防陈旧。关联页数已 cap ≤ 4，读盘开销可忽略。

### 决策 4：Token 预算护栏

- 诊断报告：按页分组，每条 finding 仅 `type + 截断描述`（`REPORT_DESC_MAX` ~200 字符），整体规模即使数百条也很小；
- 关联页：数量 cap ≤ 4，单页正文截断 `RELATED_BODY_MAX`（~8000 字符，对齐 `lint-semantic` 的 `10_000` 量级）；
- `relatedPages` 为空时**不渲染**该段（prompt 不留空标题）。

### 决策 5：纯函数与 prompt 字符串分层

数据提取（关联页 slug、报告分组）放 `fix-deterministic.ts`（纯函数、无 side effect、可单测）；字符串格式化（两段 markdown 的渲染）放 `fix-prompt.ts`（与既有 prompt 构建同处）。service 只做编排与读盘。

---

## 三、组件与数据流

```
fix-service.ts :: runFixJob
   │
   ├─ 构建 worklist（不变）：fresh deterministic ∪ snapshot semantic
   │  partitionFindings → { frontmatter, llm }
   │
   ├─ 阶段1 确定性 frontmatter（不变）
   │
   ├─ 【新】构建 subjectReport（一次）
   │     reportByPage = buildSubjectReportLines(worklist)    // 纯函数：按页分组 {slug, lines[]}
   │     rosterReportStr = renderSubjectReport(reportByPage) // prompt 层格式化
   │
   │     【新】contradictionPages = worklist 中 type==='contradiction' 的 pageSlug 集合（预计算一次）
   │
   ├─ 阶段2 LLM 逐页（按 pageSlug 分组，串行）
   │     for each [slug, findingsOnPage]:
   │        doc = readPageInSubject(subject.slug, slug)；不存在 → skip（不变）
   │        【新】relatedSlugs = findRelatedPageSlugs(slug, findingsOnPage, roster, contradictionPages) // 纯函数
   │        【新】relatedPages = relatedSlugs
   │                 .map(s => { doc:readPageInSubject(subject.slug, s) })            // 实时读盘
   │                 .filter(存在)
   │                 .map(d => ({ title, slug, body: d.body.slice(0, RELATED_BODY_MAX) }))
   │        result = generateStructuredOutput('fix', FixPageSchema, FIX_SYSTEM_PROMPT,
   │                   buildFixPageUserPrompt(
   │                     { slug, title, body },
   │                     findingsOnPage,
   │                     roster,
   │                     ctx,
   │                     【新】{ subjectReport: rosterReportStr, relatedPages }   // 第 5 个可选参数
   │                   ))
   │        !proceed / bodyShrankTooMuch / validate 失败 / 残留坏链 → skip|fail（不变）
   │        proceed → createChangeset(单页 update) → apply（1 commit/页，不变）
   │
   └─ emit fix:complete（不变）
```

### 新增 / 改动文件

| 文件 | 改动 |
|------|------|
| `src/server/services/fix-deterministic.ts` | 🆕 纯函数 `findRelatedPageSlugs(pageSlug, findingsOnPage, roster, contradictionPageSlugs?)` + `buildSubjectReportLines(worklist)` |
| `src/server/llm/prompts/fix-prompt.ts` | `buildFixPageUserPrompt` 增**第 5 个可选参数** `extra?: { subjectReport?: string; relatedPages?: {title,slug,body}[] }`；渲染两段只读上下文；`FIX_SYSTEM_PROMPT` 补充只读约束与"可参照对方页和解 contradiction"指引 |
| `src/server/services/fix-service.ts` | 阶段2 前构建报告一次；逐页前算关联页 + 实时读盘；调用处传 `extra` |
| `src/server/services/__tests__/fix-deterministic.test.ts` | 扩：`findRelatedPageSlugs`（匹配 slug/title、排除自身、contradiction 兜底、上限 cap）、`buildSubjectReportLines`（分组、截断） |
| `src/server/llm/prompts/__tests__/fix-prompt.test.ts` | 扩：含 `extra` 时渲染两段、`relatedPages` 为空时不渲染该段、`subjectReport` 缺省时不渲染 |

> `FixPageSchema` 不变；`contracts.ts` / `config-schema.ts` / 路由 / `health-view.tsx` / SSE 事件 **均无改动**——本次纯属"喂给 LLM 的上下文"扩充，对外契约与 UX 零变化。

### `buildFixPageUserPrompt` 新签名（向后兼容）

```ts
export function buildFixPageUserPrompt(
  page: { slug: string; title: string; body: string },
  findings: { type: string; description: string; suggestedFix: string | null }[],
  roster: { slug: string; title: string }[],
  ctx: PromptContext,
  extra?: {
    subjectReport?: string;                                  // 已格式化的「全局诊断报告」段正文（空/缺省=不渲染）
    relatedPages?: { title: string; slug: string; body: string }[]; // 空/缺省=不渲染
  },
): string
```

> 第 5 参数可选，既有调用点（若有）不传即退化为原行为，便于增量落地与测试。

---

## 四、关联页提取规则（`findRelatedPageSlugs` 细节）

输入：`pageSlug`（当前页）、`findingsOnPage`、`roster: {slug,title}[]`。

```
relatedSet = ∅
for finding of findingsOnPage:
  haystack = finding.description + ' ' + (finding.suggestedFix ?? '')
  for r of roster where r.slug !== pageSlug:
    if haystack 以词边界包含 r.slug  OR  haystack 大小写不敏感整词包含 r.title:
      relatedSet.add(r.slug)
// contradiction 兜底
if (findingsOnPage 有 contradiction) AND relatedSet 为空:
  for r of roster where r.slug !== pageSlug AND r.slug ∈ {其他带 contradiction finding 的页}:
    relatedSet.add(r.slug)
return [...relatedSet] 取前 MAX_RELATED_PAGES(=4)
```

> **注意**："其他带 contradiction finding 的页"需要**整个 worklist**（不止本页）才能算。因此 `findRelatedPageSlugs` 的兜底分支需要额外入参——传入"带 contradiction finding 的全部 pageSlug 集合"（由 service 从 worklist 预计算一次传入）。最终签名：
> `findRelatedPageSlugs(pageSlug, findingsOnPage, roster, contradictionPageSlugs?: Set<string>)`。

匹配用词边界正则（避免 `cat` 命中 `category`）；slug 多为 `a-z0-9-`，title 可能含空格/标点，title 匹配做转义 + 大小写不敏感。

---

## 五、Prompt 渲染（`fix-prompt.ts`）

`buildFixPageUserPrompt` 在 `### Issues to repair` 与 `### Page roster` 之间插入（仅当对应数据非空）：

```
## Subject-wide health report (read-only context)
These are ALL outstanding issues across this subject, grouped by page. Use this only to
understand the bigger picture (e.g. another page references this one). You may ONLY edit the
page under repair below — do NOT attempt to edit other pages.

### <slugA>
- broken-link: ...
- missing-crossref: ...
### <slugB>
- contradiction: ...

## Related pages (read-only — current content of pages your findings reference)
Provided so you can reconcile cross-page issues (especially contradictions). Treat as reference
only; do not copy wholesale and do not edit them.

### [[Title B]] (slug: `slugB`)
<body 截断>
```

`FIX_SYSTEM_PROMPT` 追加：

- 强调 report / related pages 为**只读上下文**，输出仍只是待修页 `body`；
- `contradiction`：现在可参照 Related pages 的对方页内容，把**本页**改得与之一致且忠实于来源；若仍无法判断哪边正确，`proceed=false`。

---

## 六、边界与错误处理

- **`extra` 全缺省**：渲染结果与改动前**逐字一致**（保证可增量、可单测对照）。
- **关联页读盘失败 / 不存在**：跳过该关联页（filter 掉），不影响主修复。
- **启发式漏召**：退化为原"仅本页上下文"行为，不报错。
- **启发式误召**：多注入若干只读页，无副作用（仅耗 token，已 cap）。
- **Token**：报告描述截断 + 关联页数/正文双 cap；最坏情况 4×8000 ≈ 32k 字符关联正文 + 小体量报告，远低于供应商上限。
- **并发 / Saga / 历史**：完全不变（仍每页一 commit、进 `operations`、可 revert）。
- **已知限制（保留）**：仍是"改本页"语义——contradiction 双向消解、整库一致性收敛超出本次范围；非自动迭代，残留项靠 UI 重跑 lint 暴露。

---

## 七、测试策略

纯函数单测（vitest）：

1. `findRelatedPageSlugs`：
   - contradiction 描述含对方 slug → 召回对方、排除自身；
   - 描述含 roster title（大小写/整词）→ 召回；
   - 词边界：`cat` 不命中 `category`；
   - contradiction 兜底：描述无匹配但有其他 contradiction 页 → 召回；
   - 上限 cap（>4 截断）、去重。
2. `buildSubjectReportLines`：按 `pageSlug` 分组、保序、描述截断到 `REPORT_DESC_MAX`。
3. `buildFixPageUserPrompt`（在 `fix-prompt.test.ts`）：
   - 传 `extra.subjectReport` → 含报告标题段；缺省 → 不含；
   - `relatedPages` 非空 → 含关联页段且含各页 body 片段；为空/缺省 → 不含该段；
   - 不传 `extra` → 输出与不含两段的基线一致。

LLM 阶段不做端到端单测（沿用项目惯例）。

---

## 八、对既有约定的遵守

- LLM 输出仍 `generateStructuredOutput('fix', ...)` + zod schema，prompt 经 `PromptContext` 注入语言指令（slug / wikilink / frontmatter key 禁翻译）。
- 复用 `readPageInSubject` / `wiki-transaction` / 既有 worklist 构建，不复刻 Saga。
- 纯函数集中在 `fix-deterministic.ts`，字符串构建在 `fix-prompt.ts`，分层与现状一致。
- 零 DB 迁移、零路由改动、零 UX 文案改动。

# 拆分一页为多页（Page Split）设计

> 日期：2026-06-22
> 状态：已确认，待写实现计划
> 关联：特性序列第 ④ 项「页面重组」拆分后的 ④c（④a 改标题+引用联动、④b 合并两页 均已合并）。至此 ④ 全部完成。

---

## 一、背景与动机

一个页 A 长得太大 / 覆盖多个主题时，需要把它拆成多个独立页。这需要 LLM 把 A 的正文切分成若干自洽的页（每页 title/body/summary），删除 A，并解决**核心难点——backlink 重指歧义**：原来的 `[[A]]` 引用在 A 删除后该指向哪个新页。

已定模型（brainstorm 决策）：

1. **解散模型**：A 删除，内容拆成 N 个独立新页（不保留 A 作索引）。
2. **重指策略 = LLM 选主页 + 统一重指**：LLM 拆分时标出一个新页为「主承接页」（最承接 A 身份的那块）；删 A 后，全库所有解析到 A 的 `[[…]]` 引用统一重指主页（复用 ④b `repointLinksToPage`，自动覆盖 title-form 与 slug-form）；个别该归属别页的引用由用户事后手改。

基建与 ④b 同构（异步 job + 单次结构化 LLM + 确定性多页 Saga），且重链**直接复用** ④b 已落地的 `src/server/wiki/relink.ts::repointLinksToPage`。

---

## 二、范围（v1）

> **A 页发起 Split → 异步 job 用 LLM 把 A 拆成 N 个独立新页（标出一个主承接页）→ 删除 A → 把本 subject 内所有解析到 A 的 `[[…]]` 引用统一重指主页 → 跳到主页。单阶段、直接提交、git 可 revert。**

### 已定决策

1. 解散 A 为 N 个独立新页；A 删除。
2. LLM 标出恰一个主承接页；所有 `[[A]]` 引用统一重指它（`repointLinksToPage`，fromSlug=A.slug、toTitle=primary.title）。
3. **slug 由服务端确定性派生**（`normalizeSlug(title)`），不让 LLM 直出 slug；冲突加后缀 `-2/-3`，排除 A 自己的 slug。
4. 新页 frontmatter 确定性拼装：`tags`/`sources` 继承 A、`created` 继承 A、`updated=now`、`title`/`body`/`summary` 来自 LLM。
5. **直接提交 + 事后审阅**（不做预览-确认两阶段）；整次拆分一个 git commit，可 `git revert`。
6. UI 提供**可选 hint**（如何拆 / 拆几页；留空 = LLM 自决）。
7. 完成后跳**主页**（A 已删，不能留在 A）。

### 明确不做（YAGNI）

- 保留 A 作索引/概览页（解散模型，A 删除）。
- 逐引用 LLM 判定重指目标（统一重指主页足够）。
- 主页继承 A 的 slug（排除 A.slug，主页用新派生 slug，引用靠 `repointLinksToPage` 重写）。
- 预览-确认两阶段。
- 跨 subject 引用重指（单事务约束）。
- 新页之间强制互相交叉链接（LLM 可自然产出，不强制）。
- 拆分 meta 系统页（index/log）。

---

## 三、架构与数据流

```
A 阅读页「Split」→ 确认弹窗（可选 hint）
   │
POST /api/split { sourceSlug, hint?, subjectId }   (requireAuth+requireCsrf+resolveSubject{required:true,body})
   │  校验：A 存在、非 meta；否则 400/404
   ▼
queue.enqueue('split', { sourceSlug, hint, subjectId }, subject.id) → { jobId }
   │
worker → split-service.runSplitJob(job, emit):
   1. 读 A（readPageInSubject）；非空校验；emit('split:start')
   2. generateStructuredOutput('split', SplitResultSchema, SPLIT_SYSTEM_PROMPT,
        buildSplitUserPrompt({title,body}, hint, ctx)) → { pages: [{title,body,summary,isPrimary}] }
   3. 若 pages.length < 2 → throw（不算拆分）
   4. existingSlugs = new Set(pagesRepo.getAllPages(subject.id).map(p=>p.slug))
      planned = planSplitPages(result.pages, existingSlugs, A.slug)   // 纯函数：派生唯一 slug + 恰一 primary
      primary = planned.find(p=>p.isPrimary)
   5. resolver = titleResolver(getTitleToSlugMap(subject.id))   // 合并前（A 仍在）
      entries: ChangesetEntry[] = []
      for p of planned:
        body' = repointLinksToPage(p.body, A.slug, primary.title, subject.slug, resolver)  // 新页正文里的 [[A]] 自引用
        content = stampSystemFrontmatter(serializeFrontmatter({title:p.title, tags:A.tags, sources:A.sources, summary:p.summary, created:A.created, updated:''}, body'), {now, existingCreated:A.created})
        entries.push(create(buildWikiPath(subject.slug, p.slug), content))
      entries.push(delete(buildWikiPath(subject.slug, A.slug)))
   6. let repointed=0
      for src of getBacklinks(subject.id, A.slug).filter(b=>b.subjectId===subject.id && b.slug!==A.slug):
        raw = serializeWikiDocument(readPageInSubject(subject.slug, src.slug))
        raw' = repointLinksToPage(raw, A.slug, primary.title, subject.slug, resolver)
        if raw'!==raw: entries.push(update(src.path, raw')); repointed++
   7. createChangeset(job.id, subject, entries) → validateChangeset → applyChangeset
   8. emit('split:complete', { sourceSlug:A.slug, pageSlugs: planned.map(p=>p.slug), primarySlug: primary.slug, referencesRepointed: repointed })
   9. return { sourceSlug, pageSlugs, primarySlug, referencesRepointed }
   │
前端 use-job-stream status==='completed' → GET /api/jobs/<jobId> 读 resultJson.primarySlug → invalidate 缓存 → router.push(/wiki/<primarySlug>?s=<subjectSlug>)
```

> 注：新页尚未入库，不会出现在 `getBacklinks(A)` 中；A 内容里的 `[[A]]` 自引用在 step 5 对每个新页正文 repoint 处理；现有引用页在 step 6 处理。A 自身不在 step 6（已 delete）。

---

## 四、纯函数契约（`src/server/wiki/split-plan.ts` 新增）

```ts
export interface LlmSplitPage {
  title: string;
  body: string;
  summary: string;
  isPrimary: boolean;
}

export interface PlannedSplitPage extends LlmSplitPage {
  slug: string;
}

/**
 * 把 LLM 产出的页清单整理为可落盘的页：
 * - slug = normalizeSlug(title)；空则兜底 'page'。
 * - 去重 + 与 existingSlugs 冲突 + 与 sourceSlug 冲突 → 加后缀 -2/-3…（保证全库唯一且不复用 A 的 slug）。
 * - 恰一个 isPrimary：若 LLM 给了 0 或 >1 个，强制只保留第一个为 primary、其余置 false。
 * 不负责 N<2 校验（由 service 在调用前 throw）。纯函数、可 node 单测。
 */
export function planSplitPages(
  pages: LlmSplitPage[],
  existingSlugs: Set<string>,
  sourceSlug: string,
): PlannedSplitPage[];
```

> slug 冲突判定集合 = `existingSlugs ∪ {sourceSlug} ∪ 已分配的新 slug`。后缀从 `-2` 起递增直到唯一。

---

## 五、LLM 接线（`src/server/llm/prompts/split-prompt.ts` 新增）

```ts
import { z } from 'zod';
import type { PromptContext } from './prompt-context';

export const SplitResultSchema = z.object({
  pages: z.array(
    z.object({
      title: z.string(),
      body: z.string().describe('Self-contained markdown body for this page, WITHOUT frontmatter.'),
      summary: z.string().describe('1-2 sentence summary of this page.'),
      isPrimary: z.boolean().describe('Exactly one page should be true: the best heir for links that pointed to the original page.'),
    }),
  ).min(2),
});
export type SplitResult = z.infer<typeof SplitResultSchema>;

export const SPLIT_SYSTEM_PROMPT: string;  // 角色：把一页拆成多个自洽的独立页
export function buildSplitUserPrompt(
  source: { title: string; body: string },
  hint: string | undefined,
  ctx: PromptContext,
): string;
```

Prompt 要求（system/user）：

- 把原页拆成**多个各自自洽**的页（每页可独立阅读）；保留所有实质内容，不要丢信息。
- **逐字保留已有的 `[[wikilink]]`**（含 `|别名`、`#锚点`、`subject:` 前缀），不新造、不翻译 slug 与链接目标。
- 每页输出 markdown 正文（**不含 frontmatter**）+ 一句摘要。
- **恰标一个 `isPrimary:true`**：最适合承接「原指向本页的链接」的那一页。
- 若给了 hint，遵循 hint 的拆分意图。
- 语言遵循 `ctx.language`（`renderLanguageDirective` 注入；slugs/wikilinks/frontmatter keys 禁止翻译）。

`'split'` 加入 `BUILTIN_LLM_TASKS`（同 ④b 的 'merge'）。

---

## 六、新增 / 改动文件

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/server/wiki/split-plan.ts` | 新增 | 纯函数 `planSplitPages` — TDD 目标 |
| `src/server/wiki/__tests__/split-plan.test.ts` | 新增 | `planSplitPages` 单测 |
| `src/server/llm/prompts/split-prompt.ts` | 新增 | `SPLIT_SYSTEM_PROMPT` / `buildSplitUserPrompt` / `SplitResultSchema` |
| `src/server/llm/prompts/__tests__/split-prompt.test.ts` | 新增 | prompt builder + schema 单测 |
| `src/server/llm/config-schema.ts` | 改动 | `BUILTIN_LLM_TASKS` 加 `'split'`（+ refine 文案） |
| `src/server/services/split-service.ts` | 新增 | `runSplitJob` handler + 末尾 `registerHandler('split', runSplitJob)` |
| `src/server/worker-entry.ts` | 改动 | 加 `import './services/split-service';` |
| `src/lib/contracts.ts` | 改动 | `Job.type` 联合加 `\| 'split'` |
| `src/app/api/split/route.ts` | 新增 | `POST` 校验 + 入队；`runtime='nodejs'` |
| `src/app/api/split/__tests__/route.test.ts` | 新增 | 路由单测 |
| `src/hooks/use-job-stream.ts` | 改动 | `namedEventTypes` 加 `'split:start'` / `'split:complete'` |
| `src/components/wiki/split-dialog.tsx` | 新增 | 确认弹窗（可选 hint）+ POST + SSE 追踪 + 完成跳主页 |
| `src/components/wiki/split-button.tsx` | 新增 | 标题行「Split」入口，打开 split-dialog |
| `src/components/wiki/frontmatter-display.tsx` | 改动 | 标题行 actions 容器加 `<SplitButton>`（与 Edit/Merge 并列；复用已有 `slug`/`title` props） |

> `repointLinksToPage`（④b）、`serializeFrontmatter`/`stampSystemFrontmatter`/`serializeWikiDocument`/`buildWikiPath`/`normalizeSlug`、`generateStructuredOutput`、Saga 三件套、`getBacklinks`/`getAllPages`/`getTitleToSlugMap` 均**复用**，不改动。

---

## 七、UI 行为

- A 阅读页标题行 actions 容器（现含 Edit、Merge）追加「Split」按钮（`Scissors`/`Split` 图标）。
- split-dialog：标题「Split “{A.title}” into multiple pages」+ 可选 hint `<textarea>`（placeholder「可选：如何拆 / 拆几页，留空让 AI 自决」）+ 提示「将把本页拆成多页并删除本页，引用重指主页；提交进 git 可 revert」+ Split/Cancel。
- 触发后用 `useJobStream(jobId)` 显示进度（`latestMessage`）；运行中禁止关闭。
- `status==='completed'`：`GET /api/jobs/<jobId>`（`useApiFetch`）读 `resultJson.primarySlug` → 失效缓存 → `router.push(/wiki/<primarySlug>?s=<subjectSlug>)` → 关闭。取不到 primarySlug 则兜底跳首页 `/`（不应发生）。
- `status==='failed'`：内联错误提示。

> 实现说明：`primarySlug` 从 job result 取（`runSplitJob` 的返回写入 `jobs.result_json`），`GET /api/jobs/[id]` 返回的 job 含 `resultJson`。比从 SSE 事件挖嵌套 data 更稳。

---

## 八、边界处理

- `POST /api/split`：A 不存在 → 404；A 为 meta（index/log）→ 400；body 非法 → 400。
- LLM 返回 `pages.length < 2` → `SplitResultSchema` 的 `.min(2)` 直接拒绝（generateStructuredOutput 抛错）→ job fail。
- slug 冲突（与现有页 / 彼此 / A 的 slug）→ `planSplitPages` 加后缀，保证唯一且不复用 A.slug。
- LLM `isPrimary` 给 0 或多个 → `planSplitPages` 兜底取第一个为 primary。
- 跨 subject 指向 A 的引用不重指 → 悬挂链接，lint/health 暴露（已知取舍）。
- A 的 `page_sources` 随级联删除丢失；其 source 已继承到每个新页 frontmatter `sources`。
- LLM 违规改动 wikilink → 质量问题，事后审阅/编辑修正，不强校验。
- 破坏性操作安全网 = 单条 git commit，可 `git revert`。

---

## 九、测试（node-only，无 RTL）

1. **`planSplitPages` 纯函数**（`split-plan.test.ts`）
   - 正常：N 页各得 `normalizeSlug(title)` slug；
   - slug 冲突现有页 → 加 `-2`；两新页同 title → 第二个 `-2`；
   - 派生 slug == sourceSlug → 加后缀（不复用 A.slug）；
   - 空 title → 兜底 'page'（再冲突加后缀）；
   - LLM 给 0 个 primary → 第一个置 primary；给 2 个 → 仅第一个保留 primary、其余 false；
   - 透传 title/body/summary 不变。
2. **`buildSplitUserPrompt` + `SplitResultSchema`**（`split-prompt.test.ts`）：语言指令注入、含原页标题/正文、含 hint（给了时）、含「保留 wikilink / 恰一 primary」要点；schema 接受 ≥2 页、拒绝 <2 / 缺字段。
3. **`POST /api/split` 路由**（`route.test.ts`，vi.mock auth/subject/pages-repo/queue）：合法入队 + 断言 enqueue 参数；A 不存在 404；meta 400；body 非法 400。
4. split-service / UI：tsc + dev 眼测（LLM + Saga + React，不做 mock 单测，与 lint/ingest/merge 一致）。

---

## 十、不变量与依赖

- 复用 `repointLinksToPage`（④b）、`extractWikiLinks`、`serializeFrontmatter`/`stampSystemFrontmatter`/`serializeWikiDocument`、`buildWikiPath`、`normalizeSlug`；**不复刻链接解析**。
- 写走现有**异步 job + 同步 Saga**：`createChangeset → validateChangeset → applyChangeset`；所有条目同一 subject、同一事务、失败 rollback。
- `POST /api/split` 顶部 `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest({required:true, body})`；只入队、202、subjectId 写进 params。
- LLM 必须 `generateStructuredOutput` + zod schema；prompt 注入 PromptContext 语言指令；**slug 不由 LLM 直出**（服务端 `normalizeSlug` 派生）。
- 客户端只用 `useApiFetch()`；POST body 显式带 `subjectId`。
- 不改 DB schema；不复用 A 的 slug（A 删除，主页用新 slug）。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，非门禁。
- commit message 中文一句话；禁止任何 AI 署名 trailer / 脚注。

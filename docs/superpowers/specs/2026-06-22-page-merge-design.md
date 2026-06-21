# 合并两页为一页（Page Merge）设计

> 日期：2026-06-22
> 状态：已确认，待写实现计划
> 关联：特性序列第 ④ 项「页面重组」拆分后的 ④b（④a 改标题+引用联动已合并；④c 拆分一页后续单独立项）

---

## 一、背景与动机

知识库长出两个讲同一主题的页（A、B）时，需要把它们合并成一页、删掉冗余的那个，并保证全库指向被删页的引用不断。这一步天然需要 LLM 融合两段正文（去重、重组、保留交叉引用），因此与 ④a（纯确定性）不同，走**异步 job + 单次结构化 LLM 调用 + 确定性 Saga**。

现状盘点（勘察结论）：

- 新增 LLM 驱动异步 job 的最小改动集约 6 处（job type 联合 + service + LLM prompt/schema + worker import + API route + SSE 事件类型），模板见 `lint-service`。
- `createChangeset(jobId, subject, entries)` 的 `entries` 可在**一个事务里同时 create/update/delete 多页**；delete 页时 `wiki_links` / `page_sources` 靠外键 `onDelete:'cascade'` 自动清，无需手动删。
- ④a 已落地 `src/server/wiki/relink.ts`，含 token 重建私有helper `replaceTargetInToken`（保 subject 前缀 / `#锚点` / `|别名`）与公开 `rewriteBacklinkText`（按 target 文本==旧标题匹配）。

---

## 二、范围（v1）

> **在 A 页发起「Merge」→ 搜选 B → 异步 job 用 LLM 把 B 的正文融合进 A（A 保留 title/slug/URL），删除 B，并把本 subject 内所有解析到 B 的 `[[…]]` 引用重链到 A。单阶段、直接提交、git 可 revert。**

### 已定决策

1. **合并模型 = 从 A 页「合并进来」**：A 是存活页，保留其 title / slug / URL / 身份；B 被删除。
2. **直接提交 + 事后审阅**（不做预览-确认两阶段）：job 内 LLM 产出后立即同事务 Saga 提交；整次合并是一个 git commit，可整体 `git revert`；不满意可用编辑器（特性②）改 A。
3. **标题/slug 保持 A 的、不可在合并中改**：想给合并结果改名，合并后用 ④a 重命名（避免 merge 与 retitle 逻辑纠缠）。
4. **LLM 只产「正文 + 摘要」**，其余确定性拼装。
5. **重链覆盖所有指向 B 的链接形式**（title-form 与 slug-form 都重链到 A），因为 B 被删，两种 form 都会断。

### 默认/确定性决策

6. `tags = union(A.tags, B.tags)`、`sources = union(A.sources, B.sources)`、`created = A.created`、`updated = now`、`title = A.title`、`summary = LLM 产出`。
7. 重链作用范围 = 本 subject 内所有指向 B 的页 **+ 合并后正文自身**（防 B 内容里残留指向 B 的自引用）。
8. 跨 subject 引用（来自别的 subject 指向 B）**不重链**（changeset 单 subject 约束）——会成为悬挂链接，由 lint/health 暴露（已知取舍，见 §七）。

### 明确不做（YAGNI）

- 预览-确认两阶段流程（pending 暂存 + 确认端点）。
- 合并中改标题/slug（走 ④a）。
- 多选 >2 页合并 / 跨 subject 合并。
- 跨 subject 引用重链。
- 合并 meta 系统页（index/log 不作为目标或源）。

---

## 三、架构与数据流

```
A 阅读页「Merge」→ 弹窗搜选 B → 确认
   │
POST /api/merge { targetSlug:A, sourceSlug:B, subjectId }   (requireAuth+requireCsrf+resolveSubject)
   │  校验：A≠B、A/B 同 subject 且都存在、非 meta；否则 400
   ▼
queue.enqueue('merge', { targetSlug, sourceSlug, subjectId }, subject.id) → 返回 { jobId }
   │
worker → merge-service.runMergeJob(job, emit):
   1. 读 A、B 两页（readPageInSubject）；emit('merge:start')
   2. generateStructuredOutput('merge', MergeResultSchema, MERGE_SYSTEM_PROMPT, buildMergeUserPrompt(A,B,ctx))
        → { mergedBody, mergedSummary }
   3. 确定性拼装 A 的新 frontmatter：title=A.title, tags=union, sources=union,
        summary=mergedSummary, created=A.created；body=mergedBody
        → mergedRaw = serializeFrontmatter(...) 再 stampSystemFrontmatter(now, A.created)
   4. titleResolver = pagesRepo.getTitleToSlugMap(subjectId) 包装
      mergedRaw' = repointLinksToPage(mergedRaw, B.slug, A.title, subject.slug, titleResolver)  // 合并体自身的 B 自引用
      entries = [ update(A.path, mergedRaw') , delete(B.path) ]
      for src of getBacklinks(subject.id, B.slug).filter(同 subject 且 slug∉{A,B}):
        raw = serializeWikiDocument(readPageInSubject(subject.slug, src.slug))
        raw' = repointLinksToPage(raw, B.slug, A.title, subject.slug, titleResolver)
        if raw' !== raw: entries.push(update(src.path, raw')); repointed++
   5. createChangeset(job.id, subject, entries) → validateChangeset → applyChangeset
   6. emit('merge:complete', { mergedSlug:A, deletedSlug:B, referencesRepointed: repointed })
   7. return { mergedSlug, deletedSlug, referencesRepointed }
   │
前端 use-job-stream 收 merge:complete → invalidate 缓存 + router.refresh（留在 A 阅读页）
```

> 注：A 自身指向 B 的引用由 step 4 的 backlink 循环覆盖（A 也在 getBacklinks(B) 里，但 step 4 已先把合并体写进 entries[0]；循环里 `slug∉{A,B}` 排除 A/B，A 的 B-引用改在合并体内由 step 4 的 `repointLinksToPage(mergedRaw,…)` 处理——合并体已含 A 原正文）。

---

## 四、纯函数契约（`src/server/wiki/relink.ts` 扩展）

```ts
import type { TitleResolver } from './wikilinks';

/**
 * 把整文件 raw 里所有「解析到 fromSlug（本 subject）」的 wikilink 改指向 toTitle。
 * 与 rewriteBacklinkText 的区别：匹配判据是「解析后的 target slug == fromSlug」
 * （用 titleResolver，覆盖 title-form 与 slug-form 两种写法），而非按 target 文本==旧标题。
 * 用于 merge：源页 B 被删后，所有指向 B 的引用（含 [[b-slug]]）都要改指 A。
 * 重写时复用 replaceTargetInToken 保留 subject 前缀 / #锚点 / |别名；按 position 从右往左替换。
 * 跨主题链接（targetSubjectSlug≠subjectSlug）与代码块内链接不动。无匹配返回原串。
 */
export function repointLinksToPage(
  raw: string,
  fromSlug: string,
  toTitle: string,
  subjectSlug: string,
  titleResolver: TitleResolver,
): string;
```

> 匹配：`extractWikiLinks(raw, { currentSubjectSlug: subjectSlug, titleResolver })` 后筛 `link.target === fromSlug && (!link.targetSubjectSlug || link.targetSubjectSlug === subjectSlug)`。`replaceTargetInToken` 已是 `relink.ts` 的模块级函数（④a 引入，未 export），`repointLinksToPage` 在同文件内直接调用即可，无需改其可见性。

---

## 五、LLM 接线（`src/server/llm/prompts/merge-prompt.ts` 新增）

```ts
import { z } from 'zod';
import type { PromptContext } from './prompt-context';

export const MergeResultSchema = z.object({
  mergedBody: z.string(),     // 融合后的 markdown 正文（不含 frontmatter）
  mergedSummary: z.string(),  // 1-2 句摘要
});

export const MERGE_SYSTEM_PROMPT: string;  // 角色：把两页融合成一页连贯正文
export function buildMergeUserPrompt(
  a: { title: string; body: string },
  b: { title: string; body: string },
  ctx: PromptContext,
): string;
```

Prompt 要求（写进 system/user）：

- 融合去重、保留两边事实、组织成连贯结构；输出 markdown 正文（**不要 frontmatter**）。
- **逐字保留两边已有的 `[[wikilink]]`**（含 `|别名`、`#锚点`、`subject:` 前缀），不新造、不删除、不翻译 slug 与链接目标。
- 语言遵循 `ctx.language`（注入方式同 ingest/lint/query 的 PromptContext header；slugs/wikilinks/frontmatter keys 禁止翻译）。

`'merge'` 作为 LLM task：`resolveTask` 对未在 `llm-config.json.tasks` 显式声明的 task 自动 fallback `defaults`，故 `BUILTIN_LLM_TASKS` **可加可不加** `'merge'`；为清晰起见加入。`llm-config.json` 可选加 `"merge": { "temperature": 0.3 }`（不入版本库，仅文档说明）。

---

## 六、新增 / 改动文件

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/server/wiki/relink.ts` | 改动 | 加 `repointLinksToPage`（复用现有 `replaceTargetInToken`）— TDD 目标 |
| `src/server/wiki/__tests__/relink.test.ts` | 改动 | 加 `repointLinksToPage` 用例 |
| `src/server/llm/prompts/merge-prompt.ts` | 新增 | `MERGE_SYSTEM_PROMPT` / `buildMergeUserPrompt` / `MergeResultSchema` |
| `src/server/llm/config-schema.ts` | 改动 | `BUILTIN_LLM_TASKS` 加 `'merge'` |
| `src/server/services/merge-service.ts` | 新增 | `runMergeJob` handler + 末尾 `registerHandler('merge', runMergeJob)` |
| `src/server/worker-entry.ts` | 改动 | 加 `import './services/merge-service';` |
| `src/lib/contracts.ts` | 改动 | `Job.type` 联合加 `\| 'merge'` |
| `src/app/api/merge/route.ts` | 新增 | `POST` 校验 + 入队；`export const runtime='nodejs'` |
| `src/hooks/use-job-stream.ts` | 改动 | `namedEventTypes` 加 `'merge:start'` / `'merge:complete'` |
| `src/components/wiki/merge-dialog.tsx` | 新增 | 页选择弹窗（搜索 + /api/pages 客户端过滤，排除 A 与 meta）+ 确认 + POST + SSE 追踪 |
| `src/components/wiki/frontmatter-display.tsx` | 改动 | 标题行加「Merge」入口（与 Edit 并列），打开 merge-dialog |
| `src/components/wiki/page-renderer.tsx` + `src/app/(app)/wiki/[...slug]/page.tsx` | 改动 | 透传 mergeable 上下文（当前 slug/subjectSlug）到 frontmatter-display（沿用 editHref 同款透传） |

---

## 七、边界处理

- `POST /api/merge`：A==B、A/B 任一不存在、不同 subject、任一为 meta 系统页（index/log）→ 400。
- LLM 产出经 `validateChangeset`（frontmatter 必填）；不合法 → 不提交、job fail、SSE `job:failed`。
- **跨 subject 指向 B 的引用不重链**（单事务约束）→ 成为悬挂链接，lint/health 会报；可后续单独处理（YAGNI）。
- 合并体里 LLM 若违规改动了 wikilink（漏保留/新造）→ 属 LLM 质量问题，事后审阅/编辑修正；不做强校验（YAGNI）。
- B 的 `page_sources` 溯源随级联删除丢失；其 source 仍并入 A 的 frontmatter `sources`（保留来源记录）。`page_sources` sidecar 不在本期重建（YAGNI）。
- 破坏性操作的安全网 = 单个 git commit，可 `git revert`。

---

## 八、测试（node-only，无 RTL）

1. **`repointLinksToPage` 纯函数**（扩 `relink.test.ts`，需传入一个简单的 `titleResolver` stub，如 `(t)=> t==='B Title'?'b':undefined`）
   - title-form `[[B Title]]` → `[[A Title]]`；
   - slug-form `[[b]]` → `[[A Title]]`（解析 target==b）；
   - 别名 `[[B Title|看]]` → `[[A Title|看]]`；锚点 `[[B Title#x]]` → `[[A Title#x]]`；
   - 不指向 B 的链接（`[[Other]]`、`[[a]]`）不动；
   - 跨主题 `[[other:B Title]]`（targetSubjectSlug≠本）不动；
   - 多处混合、右起替换不串位；code fence 内不动；无匹配返回原串。
2. merge-service / API / merge-dialog：tsc + dev 眼测（LLM 调用与 Saga 不做 mock 单测，与 lint/ingest 一致）。

---

## 九、不变量与依赖

- 复用 `extractWikiLinks`（唯一真实源）、`replaceTargetInToken`（④a）、`serializeWikiDocument` / `serializeFrontmatter` / `stampSystemFrontmatter`；**不复刻链接解析**。
- 写走现有**异步 job + 同步 Saga**：`createChangeset → validateChangeset → applyChangeset`，全部条目同一 subject、同一事务、失败 rollback。
- `POST /api/merge` 顶部 `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest({required:true, body})`；长任务只入队、立即返回 `{ jobId }`，subjectId 写进 job params。
- LLM 必须 `generateStructuredOutput` + zod schema（禁止直出 markdown 文件）；prompt 注入 PromptContext 语言指令。
- 客户端只用 `useApiFetch()`；POST body 显式带 `subjectId`。
- 不改 DB schema；不改 slug / A 的 URL / 文件路径（A 不动，B 删除）。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，非门禁。
- commit message 中文一句话；禁止任何 AI 署名 trailer / 脚注。

# wiki.patch 局部更新工具 — 设计文档

日期：2026-07-10

## 背景与动机

现有 `wiki.update` 工具是**整页正文替换**（schema 明确要求 "Full corrected markdown body … not a diff or excerpt"）。模型要改一段话，必须 `wiki.read` 读全文 → 内存改一段 → 把完整新正文整篇回传。问题：

1. **token 成本**：长页面的每次小改都要完整输出一遍正文；
2. **漏抄风险**：靠 prompt 纪律 + 忠实度护栏（`FIDELITY_PROFILES.fix`）兜底，护栏挡大幅塌缩，挡不住细粒度漏抄。

本设计新增 `wiki.patch`：old_string/new_string 精确替换（仿 Claude Code Edit 工具语义），未被 edits 提到的内容物理上不可能变。

## 决策记录

| 决策点 | 选择 |
|--------|------|
| 片段定位方式 | old_string/new_string 精确唯一匹配（非 heading 整节、非正则/模糊） |
| 批量粒度 | 单次调用支持 `edits[]` 多组替换，全成或全败，一次 Saga / 一个 git commit |
| 注入范围 | fix + query 两个 runner（与现有 `wiki.update` 对齐） |
| 与 `wiki.update` 关系 | 并存：patch 管正文局部小改；update 管改标题 / 整页重写 / 改 tags·summary。系统提示指导模型优先 patch |
| frontmatter | patch 只作用于 body；title/tags/summary/frontmatter 一律走 update，out of scope |

## 架构

### 1. 内核层 — `src/server/wiki/page-ops.ts`

```ts
export async function executePagePatch(
  jobId: string,
  subject: Subject,
  params: { slug: string; edits: Array<{ oldString: string; newString: string }> },
): Promise<{ updatedSlug: string; appliedEdits: number }>
```

- `readPageInSubject` 读页，取 **body**（不含 frontmatter）；页不存在抛错。
- 按数组顺序在内存中应用每组替换。每个 `oldString` 必须在**应用前序 edits 后的当前正文**中恰好出现一次：
  - 0 次 → 抛错 `edit #N: old_string not found — quote the page text verbatim`（顺序语义允许后一 edit 匹配前一 edit 的产物）；
  - ≥2 次 → 抛错 `edit #N: old_string matches K locations — include more surrounding context`；
  - `oldString === newString` 或 `oldString` 为空 → 抛错。
  - 任何一组失败整批拒绝，不落盘（全成或全败，仅内存操作、天然原子）。
- 拼出完整新正文后**委托现有 `executePageUpdate(jobId, subject, { slug, body })`**——坏链校验、unresolved-wikilink 拒绝、frontmatter stamp（updated 时间戳）、Saga 事务、单 git commit 全部继承，不新造第二条写路径。

### 2. 服务层 — `src/server/services/page-write.ts`

```ts
export async function patchPageInSubject(
  subject: Subject,
  input: { slug: string; edits: Array<{ oldString: string; newString: string }> },
): Promise<{ updatedSlug: string; appliedEdits: number }>
```

对齐现有 `updatePageInSubject` 包装：

- `META_PAGE_SLUGS` 保护页（index/log）拒绝；
- **断链豁免**：patch 的删链/重链修改在委托 `executePageUpdate` 时天然通过（该路径的 unresolved 检查只拦"改后残留的坏链"，不拦"删掉的坏链"）——与 `updatePageInSubject` 一致复用 `collectBrokenLinkTargets` 无需额外处理；确认实现时若 `executePageUpdate` 的 unresolved 拒绝逻辑对已确认断链误拦，则与 update 同款注入豁免集；
- 成功后 `enqueueEmbedIndex(subject.id, [slug])`。

**刻意不接忠实度护栏**（`checkRewriteFidelity` / 长度 floor）：护栏防的是 LLM 整页重写漏抄，patch 是确定性拼接，未提到的内容不可能变；长度 floor 反而会误杀"删除一段"的合法编辑。unresolved-wikilink 校验仍生效（新增链接必须可解析）。

### 3. 工具层 — `src/server/agents/tools/builtin/wiki-patch.ts`

- `name: 'wiki.patch'`，`source: 'builtin'`，`sideEffect: 'update'`；
- inputSchema：`{ slug: string, edits: Array<{ oldString: string (min 1), newString: string }> (min 1) }`；
- outputSchema：`{ ok, updatedSlug: string|null, appliedEdits: number|null, message }`；
- description 要点：局部修改现有页正文；`oldString` 必须是页面中**逐字存在**的原文片段（不要转述/省略），且需唯一；整页重写、改标题、改 tags/summary 用 `wiki.update`；坏链会导致整批拒绝；
- handler 经 `ctx.patchPage?` 委托，缺能力优雅报错（仿 `wiki-update.ts`）。

### 4. 注入与提示

- `ToolContext`（`tool-context.ts`）加 `patchPage?: (input) => Promise<{ updatedSlug; appliedEdits }>`；
- `fix-tools.ts`（fix runner）与 `query-tools.ts`（query runner）注入实现：fix 侧计入现有写 cap 计数器（与 update 同一配额），query 侧走 `patchPageInSubject`；
- `FIX_AGENTIC_SYSTEM_PROMPT` / `QUERY_AGENTIC_SYSTEM_PROMPT` 加指引：正文局部小改优先 `wiki_patch`；query 侧沿用写动作"后续轮确认"纪律（与 `wiki_update` 同级）；
- `lib/tool-activity.ts` 加映射：✏️ `Patching "<slug>" (N edits)`；`use-job-stream` 复用现有 `fix:tool` 事件，无新事件类型。

## 测试

- `page-ops` 单测（新增 `page-ops-patch.test.ts` 或并入现有 update 测试文件）：单/多 edit 成功、0 匹配报错、多匹配报错、顺序依赖（后 edit 匹配前 edit 产物）、空 oldString / old==new 拒绝、坏链整批拒绝、失败原子性（页面未变）；
- `wiki-patch` 工具单测：注入 patchPage → ok:true；ctx 缺能力 → ok:false 优雅；抛错透传 message（仿 `wiki-update.test.ts`）；
- `page-write` 包装单测：META 页拒绝、成功路径 enqueue embed。

## 不做的事（out of scope）

- frontmatter / 标题 / tags / summary 的 patch（走 `wiki.update`）；
- 正则、模糊匹配、`replace_all` 语义；
- curate runner 注入；
- 人工编辑页 UI 改动（仍整文件保存）。

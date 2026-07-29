# 实现计划：Tidy 自主修掉孤页

日期：2026-07-29
设计稿：`docs/specs/2026-07-29-curate-orphan-autofix.md`

每个任务独立可测试/可评审，完成一个提交一次。

---

## T1 单页入链判定（与 lint 共用口径）

**落点**：`src/server/services/lint-deterministic.ts` + `src/server/services/__tests__/lint-deterministic.test.ts`

从 `checkOrphanPages` 抽出可复用判定，二者共用同一实现（范式对齐既有的 `checkStaleSourcesForPage`）：

```ts
/** 该页当前是否有来自非 meta 页的入链。跨主题入链算；meta 页出链不算（由 getMetaPageKeys 排除）。 */
export function pageHasInboundLinks(subject: Subject, slug: string): boolean;
```

实现取数与 `runDeterministicChecksForSubject` 一致：`pagesRepo.getAllLinks(undefined, pagesRepo.getMetaPageKeys())` 后按 `targetSubjectId === subject.id && targetSlug === slug` 判存在。`checkOrphanPages` 改为复用同一 inbound 集合构造逻辑（行为逐条不变，由现有单测锁定）。

**先写失败测试**：
- 只有 `index` 链入 → false（meta 出链不算）
- 内容页链入 → true
- 跨主题内容页链入 → true
- 无入链 → false
- `tags` 含 `meta` 的页链入 → false（与 `checkOrphanPages` 的排除口径一致）
- 与 `checkOrphanPages` 的一致性：同一数据集下，`checkOrphanPages` 报为 orphan 的页 ⟺ `pageHasInboundLinks` 为 false

**验证**：`npx vitest run src/server/services/__tests__/lint-deterministic.test.ts`

---

## T2 归因改按事实判定

**落点**：`src/server/services/curate-service.ts` + `src/server/services/__tests__/curate-service.test.ts`

`buildCuratePerFindingOutcomes` 的 `!touchedSlugs.has(finding.pageSlug)` 分支替换为 T1 的判定。因为要读 DB，函数从纯函数变为接受一个注入的判定回调，保持可测：

```ts
function buildCuratePerFindingOutcomes(
  worklist: EnrichedLintFinding[],
  postcondition: PostconditionReport,
  hasInbound: (slug: string) => boolean,   // 由 handler 注入 pageHasInboundLinks(subject, slug)
): Record<string, CurateFindingOutcome>
```

`failed` 的三条既有路径（`allFailed` / 未归因 residual / 命中 residual）**判定顺序与逻辑一字不改**；只有落到最后那个二分支时改用 `hasInbound`。

`touchedSlugs` 计算逻辑本身保留 —— 其他 finding 类型不走这个函数，但把它删掉会让将来接入非 orphan 类型时无处可依；且它仍是 `postcondition.scope` 的权威读法。**（评审注意：若最终确认 orphan 是唯一消费者，这里应删掉未使用的 touchedSlugs 计算，避免留死代码。）**

**先写失败测试**：
- 源页被写、孤页未被 touch、孤页现在有入链 → `fixed`（当前实现为 `skipped`，即缺陷）
- 零写入、孤页仍无入链 → `skipped`
- 孤页仍无入链但有 residual 命中 → `failed`
- `verificationError` → 全 `failed`（不变）
- 未归因 residual → 全 `failed`（不变）

**验证**：`npx vitest run src/server/services/__tests__/curate-service.test.ts`

---

## T3 候选源页按语义检索扩 allowedSet

**落点**：`src/server/services/curate-service.ts` + 同一测试文件

worklist 非空时，对每个孤页用「`title` + `summary`」调 `hybridRankSlugs(subject.id, query, ORPHAN_SOURCE_CANDIDATES=5)`，过滤 meta 与孤页自身后并入 `scopeSlugs`；worklist 为空时**一次检索都不发**（零回归 + 零额外开销）。

新增常量 `ORPHAN_SOURCE_CANDIDATES = 5` 与事件 `curate:orphan-candidates`（报每个孤页选出的候选，便于日后从任务日志追溯模型的落点选择）。

**先写失败测试**：
- 带 worklist → `generateTextWithTools` 收到的 metas 含检索候选页；`hybridRankSlugs` 被调用
- 不带 worklist → `hybridRankSlugs` **零调用**，metas 与改动前逐元素相同
- 检索返回孤页自身 / meta 页 → 被过滤
- 检索返回空 → 不扩张、不抛错

**验证**：`npx vitest run src/server/services/__tests__/curate-service.test.ts`

---

## T4 `wiki.patch` 接入 curate auto（含忠实度护栏）

**落点**：`src/server/agents/tools/profiles.ts`、`src/server/services/curate-tools.ts`、`src/server/services/__tests__/curate-tools.test.ts`

1. `CURATE_AUTO_TOOLS` 追加 `'wiki.patch'`（auto/manual 同时获得，两者都受 allowedSet + cap 约束）。
2. `buildCurateToolContext` 新增 `patchPage`，与既有 `metadataPatch` / `linkEnsure` 同构：
   - `guard.canEditPage(input.slug)` —— meta 页 / 越 allowedSet / 超 update cap 全部拒绝
   - **忠实度护栏**（C1）：`readPageInSubject` 取当前正文 → `applyPatchEdits` 算候选 → `checkRewriteFidelity(…, FIDELITY_PROFILES.fix)`；不过则 emit `curate:skip` 并抛错，**不计数**
   - 过了才 `executePagePatch`，成功后 `guard.record('update')` + emit `curate:update`
   - 全程在 `runWrite` 串行临界区内（与既有写操作一致，cap 检查→执行→record 同一临界区）

**先写失败测试**：
- 越 allowedSet → 拒绝且不写
- meta 页（index/log）→ 拒绝
- 超 update cap → 拒绝
- 忠实度不过（例如删掉大半正文）→ 拒绝、`executePagePatch` 零调用、cap **不计数**
- 正常补一句含 wikilink → 通过、计一次 update、emit `curate:update`
- `wiki.patch` 出现在 auto 与 manual 两个 profile 的工具集里

**验证**：`npx vitest run src/server/services/__tests__/curate-tools.test.ts src/server/agents/tools/__tests__/`

---

## T5 prompt 补「无锚点时补一句」的纪律与优先级

**落点**：`src/server/llm/prompts/curate-prompt.ts` + `__tests__/curate-prompt.test.ts`

改 assignment 段（上一轮新增的 `renderOrphanAssignment`），把「找不到锚点就不要写」替换为**有优先级的两条路**：

1. 源页已有唯一自然锚点 → `wiki_link_ensure`（首选，改动面最小）
2. 确认无锚点 → `wiki_patch` 插入**一句**与目标真实相关的话，句中带 `[[target]]`；不得新建 `Related` 段落、不得一次插多段、不得改写周边散文

同时明确「候选源页已包含语义检索结果，请先 `wiki_read` 再决定落点」。

`CURATE_AGENTIC_SYSTEM_PROMPT` 的 `wiki_patch` 一行也要补（system prompt 现在没有它，否则模型看到工具却没有使用说明）。

**先写失败测试**：
- assignment 段含两条路的优先级文本、含 `wiki_patch`
- 含「只插一句 / 不建 Related / 不改写周边」的纪律文本
- 无 orphans 时输出仍逐字节不变（零回归）
- system prompt 含 `wiki_patch` 说明

**验证**：`npx vitest run src/server/llm/prompts/__tests__/curate-prompt.test.ts`

---

## T6 端到端真实验证（成功标准 5）

不进仓库的一次性验证，但**是本计划的验收关口**：

1. 起 worker，对 `mongol-empire` 触发一次带 remediationContext 的 Curate
2. 读 `git -C data/vault log -1 --stat` + `git diff` 确认写入内容
3. `grep mongol-empire data/vault/wiki/world-history/*.md` 确认出现真实入链
4. 跑一次 lint discovery，确认该 orphan **不再被发现**
5. 全部命令与输出贴进汇报

若模型在此环节把话写歪（写进错误位置、或插了多段），如实报告 —— 那正是 C1 记录的顾虑成真，不粉饰。

---

## T7 文档同步

**落点**：`src/server/services/CLAUDE.md`（Curate 流程 1/3/6 步 + 护栏段）、`src/server/agents/CLAUDE.md` 或 `tools` 侧 profile 表、`src/server/llm/CLAUDE.md`、`src/app/CLAUDE.md`（若 API 契约描述受影响）

要改的既有表述：
- Curate 第 1 步「seed + 一跳邻居」→ 补 orphan worklist 的检索扩张
- 第 6 步归因「未出现在 touchedSlugs 的 orphan 一律 skipped」→ 改为按当前入链事实判定
- 护栏段 caps 说明 → 补 `wiki.patch` 与忠实度护栏
- auto profile 工具清单 → 加 `wiki.patch`

**验证**：`npm test` + `npx tsc --noEmit`

---

## 提交顺序

`docs:`（spec + plan）→ T1 → T2 → T3 → T4 → T5 → T6（无提交，验收）→ T7（`docs:`）。

T2 先于 T3/T4 落地是有意的：归因缺陷不修，后面补链成功也会显示成没修，T6 无法验收。

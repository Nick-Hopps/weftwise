# 实现计划：Tidy 修 orphan 的信息断层与「假已处理」闭环

日期：2026-07-28
设计稿：`docs/specs/2026-07-28-curate-orphan-loop.md`

每个任务独立可测试/可评审，完成一个提交一次。

---

## T1 prompt 层：user prompt 接受 orphan worklist

**落点**：`src/server/llm/prompts/curate-prompt.ts` + `src/server/llm/prompts/__tests__/curate-prompt.test.ts`

`buildCurateAgenticUserPrompt` 第三参加可选字段：

```ts
opts: {
  auto: boolean;
  /** 本次 Tidy 被派来处理的 orphan finding（来自 remediationContext 的精确快照）。空/缺省则 prompt 逐字节不变。 */
  orphans?: { pageSlug: string; description: string; suggestedFix: string | null }[];
}
```

非空时在 `## Pages` **之前**插入一段（放前面：任务目标应先于素材清单出现）：

```
## This run's assignment (N orphan page(s))
These pages have NO inbound links from any non-index page. Your goal is to give each one
a genuine inbound link from a related page in scope.
- `mongol-empire`: Orphan page: … (suggested: …)

Only use `wiki_link_ensure`, and only on an anchor that ALREADY exists verbatim in the
source page's prose. If no page in scope contains a natural anchor for a target, do NOT
write anything for it — say which page you checked and why no anchor exists. Inventing an
anchor or appending a `Related` section is worse than leaving the orphan alone.
```

**理由（对应 C1/C2）**：不注入 finding ID；显式给出「找不到锚点就不写」的出路，避免逼模型伪造锚点或撞 `wiki_link_ensure` 的硬拒。

**先写失败测试**：
- 带 orphans → 含 `mongol-empire`、含 assignment 段、含「no anchor → 不要写」的纪律文本、assignment 段出现在 `## Pages` 之前
- 不带 orphans / 传空数组 → 与 `{ auto }` 单参调用的输出**逐字节相等**（零回归硬要求）
- 带 orphans 时既有 auto/manual 分支文案不变（原两个用例继续绿）
- 注入内容里不出现 64 位 hex finding ID

**验证**：`npx vitest run src/server/llm/prompts/__tests__/curate-prompt.test.ts`

---

## T2 服务层：把已解析的 worklist 接到 prompt

**落点**：`src/server/services/curate-service.ts` + `src/server/services/__tests__/curate-service.test.ts`

`curate-service.ts:192` 已经有 `worklist: EnrichedLintFinding[]`（`resolveCurateWorklist` 保证全是同 subject、同 lint 快照的 orphan，非 orphan 直接抛）。把它映射进 prompt 调用：

```ts
messages: [{ role: 'user', content: buildCurateAgenticUserPrompt(metas, promptCtx, {
  auto: seedSet !== null,
  orphans: worklist.map((f) => ({
    pageSlug: f.pageSlug,
    description: f.description,
    suggestedFix: f.suggestedFix,
  })),
}) }],
```

无 remediationContext 时 `worklist` 为 `[]`，走 T1 的零回归分支。**不新增取数、不改 scope/guard/policy/caps 任何一处** —— 本任务纯接线。

**先写失败测试**：
- 带 orphan remediationContext 的 Curate job → 捕获 `generateTextWithTools` 的 `messages[0].content`，断言含该 orphan 的 slug 与 assignment 段
- manual（`scope:'subject'`，无 context）→ 断言 content 不含 assignment 段
- 断言 `perFindingOutcomes` 归因逻辑不受影响（现有用例继续绿）

**验证**：`npx vitest run src/server/services/__tests__/curate-service.test.ts`

---

## T3 投影层：`skipped` 回归可见列表

**落点**：`src/server/services/remediation-status.ts` + `src/server/services/__tests__/remediation-status.test.ts`

`readHandledOutcome`（`remediation-status.ts:230`）的语义从「已完成验证即隐藏」收紧为「**已触达**才隐藏」：函数保持现在的判定不变，但对返回值 `'skipped'` 不再触发隐藏。

实现方式：`buildHealthSnapshot` 的循环里（`:79-89`）把条件改为「`handledOutcome` 非 null **且不是 `'skipped'`**」才 `continue`；是 `'skipped'` 时落进 `visibleFindings` 并挂 `plan`（`applyCurrentJob` 已经会算出 `status:'skipped'`，无需另造状态）。

把「为什么 `skipped` 不隐藏」的理由写成函数注释（对应 spec C3 的三档语义表），因为这一行直接推翻 2026-07-15 的统一隐藏决策，后人必须能读到取舍。

**先写失败测试**：
- Curate job `perFindingOutcomes: {id: 'skipped'}` 且 `completedAt > lint.ranAt` → finding **仍在** `findings` 里，`remediations[id].status === 'skipped'`，且**不**出现在 `recentOutcomes`
- 同时序下 `'fixed'` → 仍隐藏、仍进 `recentOutcomes`（现有用例）
- 同时序下 `'failed'` → 仍隐藏、仍进 `recentOutcomes`（现有用例）
- job-level 兼容路径（无 `perFindingOutcomes`、`writes:0` → `readCompletedWriteOutcome` 返回 `'skipped'`）同样保持可见
- Research 的 `skipped`（`dismissed`/`empty` run）→ **保持隐藏**：那是用户显式忽略，不是未触达；本次只改 fix/curate 语义
- `bySeverity` 随 `visibleFindings` 重算，多出的 skipped 条目计入

**验证**：`npx vitest run src/server/services/__tests__/remediation-status.test.ts`

---

## T4 真实数据回归

**落点**：`src/server/services/__tests__/remediation-status.test.ts`（追加一个 describe）

用 `data/wiki.db` 里实际记录的载荷作 fixture（不在测试里连真实 DB —— 那会让用例随 Nick 的操作漂移）：

- finding：`6f79135a…` orphan / `mongol-empire` / subject `5691a847…`
- curate job `e97dbcfd`：`completedAt = 2026-07-28T11:59:28.145Z`，`resultJson` 用真实那份（`writes:0` / `postconditionStatus:'clean'` / `semanticStatus:'not-needed'` / `perFindingOutcomes` skipped）
- lint baseline `b1cf6556`：`ranAt = 2026-07-28T11:59:0x`（早于 curate 完成 → 命中 `completedAfterSnapshot`，即「Tidy 刚跑完还没重新 lint」这个时序）

断言：该 orphan 可见且 `status === 'skipped'`。这正是当前实现会隐藏它的时序，也就是 bug 本身。

**另跑一次真实 DB 校对**（一次性脚本，不进仓库）：直接以 `readonly` 打开 `data/wiki.db`，取真实 lint + jobs 喂 `buildHealthSnapshot`，确认改动前隐藏、改动后可见且为 `skipped`。属于「完成前验证」，输出贴进最终汇报。

**验证**：`npx vitest run src/server/services/__tests__/remediation-status.test.ts`

---

## T5 文档同步

**落点**：`src/server/services/CLAUDE.md`（Curate 流程第 6 步 + Health 状态恢复段 + Changelog）、`src/server/llm/prompts/CLAUDE.md`（若有 curate-prompt 条目）

要改的既有表述（当前是本次改动前的口径）：
- services/CLAUDE.md「状态恢复」段：「无论逐 finding 结果为 fixed/failed/skipped，都从当前 findings 移除」→ 改为「fixed/failed 移除；**skipped 表示未触达，保留在列表并标注**」
- lint-service 段同一句口径同步
- Curate 段补一句：带 remediation context 时 worklist 会注入 user prompt

**验证**：`npm test`（全量）+ `npx tsc --noEmit`

---

## 提交顺序

`docs:`（spec + plan）→ T1 → T2 → T3 → T4 → T5（`docs:`）。

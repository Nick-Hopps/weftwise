# 实现计划：Contradiction 修不动对侧页

日期：2026-07-30
设计稿：`docs/specs/2026-07-30-contradiction-fix-write-scope.md`
分支：`feat/contradiction-fix-scope`（worktree `.claude/worktrees/feat+contradiction-fix-scope`，基线 `6e7d79ab`）

基线：`npx vitest run src/server/services/__tests__/fix-service.test.ts src/server/services/__tests__/fix-deterministic.test.ts src/server/services/__tests__/remediation-status.test.ts src/server/llm/prompts/__tests__/fix-prompt.test.ts` → 4 文件 / 148 用例全绿（2026-07-30 05:49 实测）。

按 TDD 推进：每个任务先写失败测试 → 确认以预期原因失败 → 最小实现转绿。**每完成一个任务提交一次。**

测试策略：写侧门控与 outcome 都在 `runFixJob` 层测。既有用例（`fix-service.test.ts:622`）已经在 mock 掉的 `generateTextWithTools` 回调里直接驱动编译好的工具（`opts.tools.wiki_update.execute(...)`）并断言 out-of-scope 行为 —— 沿用这个模式，走真实代码路径，不为可测性额外导出内部函数（`fixWritableSlugs` 例外：它是可独立复用的纯函数）。

---

## T1 `fixWritableSlugs`：contradiction 白名单含 `evidence[].pageSlug`

**问题**：`fix-service.ts:326` 的白名单是 `worklist.map(f => f.pageSlug)`，contradiction 的对侧页只在 `evidence[]` 里，永远进不去（spec 一节根因）。

**改动**：
- `fix-deterministic.ts` 新增纯函数（与 `partitionFindings` / `buildFixWorklist` 同属该模块的「findings 分桶/合并」职责）：
  ```
  fixWritableSlugs(worklist: LintFinding[]): Set<string>
  ```
  逐条取 `pageSlug`；**仅当 `type === 'contradiction'`** 时并入 `evidence?.map(e => e.pageSlug)`；`evidence` 缺失/为空时只有 `pageSlug`。空串与非字符串丢弃。
- `fix-service.ts:326` 改为 `scopeFixWrites(baseContext, fixWritableSlugs(worklist))`。

**测试**（`fix-deterministic.test.ts`）：
- contradiction + evidence `[A, B]` → `{A, B}`（**核心断言，先失败**）；
- contradiction 无 `evidence` 字段 → `{pageSlug}`（旧快照兼容）；
- `missing-crossref` 带 evidence → 只有 `{pageSlug}`（C1 不扩这一类）；
- 多条 finding 混合 → 去重合并；evidence 里出现 `pageSlug` 自身不产生重复。

**验证**：`npx vitest run src/server/services/__tests__/fix-deterministic.test.ts`

---

## T2 写入被门控拒绝时留痕

**问题**：`fix:tool` 事件接的是 AI SDK `onStepFinish`，只报「发起了哪些 tool call」，被拒的 `wiki_patch` 照样记「Patching…」，`job_events` 里查不到任何失败（spec 放大器 2）。

**改动**（`fix-service.ts`）：
- `scopeFixWrites` 改为在闭包里记账：`assertAllowed` 抛错前把被拒 slug 记进闭包 Set，函数返回 `{ context, blockedSlugs }`（**不 match 错误字符串**，C2）。
- 记账同时 emit 一条 `fix:scope-blocked`（走既有 `emit`，含被拒 slug 与允许清单）。
- `assertAllowed` 的错误消息带上允许清单，供模型自我纠正（C3 后半）。

**测试**（`fix-service.test.ts`，沿用 `:622` 的驱动模式）：
- 单条 contradiction（`pageSlug: a`，evidence `[a, b]`）+ 模型 `wiki_update` 写 `c` → 抛错且 `emit` 收到 `fix:scope-blocked`，data 含 `c` 与允许清单 `[a, b]`（**先失败**）；
- 同场景写 `b` → **成功**（T1 生效后不再被拒，这条同时锁住 T1 的接线）；
- 无越界写入的 job → 不产生 `fix:scope-blocked` 事件。

**验证**：`npx vitest run src/server/services/__tests__/fix-service.test.ts`

---

## T3 被拒 + 零写入 → `failed`（真正主动留着仍 `skipped`）

**问题**：`buildPerFindingOutcomes`（`fix-service.ts:104`）只看 `touchedSlugs`，零写入一律 `skipped`，UI 渲染成「无需更改」。

**改动**（`fix-service.ts`）：
- `buildPerFindingOutcomes(worklist, postcondition, blockedWrite: boolean)`：新增分支 —— `blockedWrite && LLM_FIX_TYPES.has(finding.type) && 该 finding 零写入` → `failed`，其余判据与顺序完全不变（`verificationError` / residual 归因 / `touchedSlugs` / 语义状态）。
- 调用点（`:376`）传 `blockedSlugs.size > 0`。
- 在函数注释里写清 C2 的归因精度：逐条精确、批量偏保守，宁可多报失败也不静默。

**测试**（`fix-service.test.ts`）：
- 单条 contradiction + 越界写被拒 + 零写入 → `perFindingOutcomes` 为 `failed`（**核心断言，先失败**）；
- 单条 contradiction + 模型什么都没写、无被拒 → 仍 `skipped`（C2 诚实性，防过度修正）；
- 有被拒但该 finding 实际写成功（触达 `touchedSlugs`）→ `fixed`，不被 `blockedWrite` 污染；
- 确定性类型（`missing-frontmatter`）零写入 + 有被拒 → 仍 `skipped`（只影响 `LLM_FIX_TYPES`）。

**验证**：同上

---

## T4 prompt 事前告知可写页

**改动**：
- `fix-prompt.ts::buildFixAgenticUserPrompt(reportLines, roster, ctx, writableSlugs)` 增一节「Writable pages」，渲染白名单 slug；清单为空时不输出该节（无 context 的全量 Fix 路径不收窄写侧，不该出现这一节）。
- `fix-service.ts` 调用点传 `fixWritableSlugs(worklist)`；无 `remediationContext` 时传空。

**测试**（`fix-prompt.test.ts`）：
- 传 `[a, b]` → prompt 含这两个 slug 且落在 Writable pages 一节内；
- 传空 → 不出现该节标题；
- 既有 9 条用例不回归（`reportLines` / roster 渲染不变）。

**验证**：`npx vitest run src/server/llm/prompts/__tests__/fix-prompt.test.ts`

---

## T5 `failed` 不再从 Health 列表隐藏

**问题**：`isUntouchedSkip`（`remediation-status.ts:236`）只放过 `skipped`，`failed` 仍被 `readHandledOutcome` 移出列表 —— T3 一上线，这行会从「留着但骗人」退化成「直接消失」（spec 一节末）。

**改动**（`remediation-status.ts`）：
- `isUntouchedSkip` → `isUnresolvedOutcome(action, outcome)`：`(outcome === 'skipped' || outcome === 'failed') && (action === 'fix' || action === 'curate')`。
- 更新 `:82` 调用点与 `readHandledOutcome` 的函数注释（语义从「未触达」升级为「未解决」）。
- `fixed` 隐藏语义、Research 的 `skipped` 隐藏语义均不动（C4）。

**测试**（`remediation-status.test.ts`）：
- fix job 在快照之后完成、`perFindingOutcomes` 为 `failed` → finding 留在 `findings`、`remediations[id].status === 'failed'`、`bySeverity` 计入、**不进** `recentOutcomes`（**核心断言，先失败**）；
- curate job 同上；
- `fixed` → 仍移出列表并进 `recentOutcomes`（零回归）；
- Research 的 `skipped`（dismissed/empty）→ 仍移出列表（零回归）；
- 既有 89 条用例全绿。

**验证**：`npx vitest run src/server/services/__tests__/remediation-status.test.ts`

---

## T6 真实端到端验收（成功标准 5）

**前置**：记录 `git -C data/vault rev-parse HEAD` 以便回退；确认 worker 在跑。

**步骤**：
1. 起服务 + worker，在 `world-history` 跑一次 discovery，确认 `92fa9c4e…`（1377 拉古萨检疫矛盾）回到 Health 列表且为 critical；
2. 点该行 Fix，观察 job 日志：应看到模型 `wiki_read` 两页后 `wiki_patch`/`wiki_update` **`black-death-europe` 成功**，不再出现 `fix:scope-blocked`；
3. 验落点：`black-death-europe` 的「来自非流行地区」已改正、`data/vault` 产出 commit、job `resultJson.perFindingOutcomes` 为 `fixed`、该行从列表移除并进近期摘要；
4. 反向验证（可选，不额外烧 LLM）：用 T2 的日志证据确认门控仍然拦得住白名单外的页 —— 单测已覆盖，此处只在真实日志里确认没有越界写入。

**产出**：把完整命令、日志片段、DB 查询结果贴进本文件末尾的验收记录，作为「本轮跑出的验证输出」。

**回退**：结果不满意 → `git -C data/vault reset --hard <记录的 HEAD>` 并删掉该 fix job 的 operations。

---

## T7 同步模块文档（`docs:` 提交）

**改动**：
- `src/server/services/CLAUDE.md`：
  - **Fix scope** 段（`:136`）：写侧收窄口径改为「所选 findings 的 `pageSlug`，contradiction 并入 `evidence[].pageSlug`」，补一句为什么（对侧页才是错的那页）；
  - Fix 流程段（`:190`）：补 `blockedWrite → failed` 的判据与归因精度；
  - 状态恢复段（`:104` / `:132`）：`isUntouchedSkip` → `isUnresolvedOutcome`，说明 `failed` 与 `skipped` 同样留在列表；
  - 变更年表补一行 2026-07-30，点明这是与 7-29 orphan 同族的「处置落点 ≠ finding.pageSlug」缺陷。
- `AGENTS.md`：若「关键架构决策」表里需要一行「处置写侧白名单按 finding 涉及页」，一并补上。

**验证**：`npm run lint`；`npx vitest run src/server/services src/server/llm/prompts` 不低于基线。

---

## 任务依赖

```
T1 ──▶ T2 ──▶ T3 ──▶ T5 ──▶ T6 ──▶ T7
 └────▶ T4 (可与 T2/T3 并行，只依赖 T1 的 fixWritableSlugs)
```

T5 必须在 T6 之前：否则真实跑一次 Fix 时，若模型仍未修成，行会直接消失，看不到失败态。

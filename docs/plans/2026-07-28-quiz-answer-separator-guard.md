# 实现计划：Quiz 答案分隔符护栏与存量修复

日期：2026-07-28
设计稿：`docs/specs/2026-07-28-quiz-answer-separator-guard.md`

每个任务独立可测试/可评审，完成一个提交一次。

---

## T1 纯函数：判定 + 确定性修复

**落点**：`src/server/wiki/quiz-separator.ts`（新增）+ `src/server/wiki/__tests__/quiz-separator.test.ts`（新增）

放 `wiki/` 而非 `agents/runtime/` 的理由：与 `wiki/rewrite-fidelity.ts` 同构 —— 纯内容校验函数放 `wiki/`，由 `agents/runtime/` 的护栏与 `scripts/` 共同消费。

**导出**：

```ts
export interface QuizSeparatorViolation {
  /** blockquote 起始行（1-based），用于报告定位 */
  line: number;
  /** callout 标题行文本，便于人读 */
  head: string;
  /** setext-separator：写了 `---` 但缺空行被解析成标题；missing-separator：只有答案标签行 */
  reason: 'setext-separator' | 'missing-separator';
}

export function findQuizSeparatorViolations(markdown: string): QuizSeparatorViolation[];

export function repairQuizSeparator(markdown: string): {
  content: string;
  repaired: QuizSeparatorViolation[];
  unrepaired: QuizSeparatorViolation[];
};
```

**判定口径（保守）**：quiz callout 的 mdast 子节点里没有 `thematicBreak`，**且**满足以下之一才算违规：

1. blockquote 原文里有独立的 `---` / `***` / `___` 行（被解析成 setext heading）→ `setext-separator`
2. 有答案标签行 → `missing-separator`。标签集合：`答` / `答案` / `参考答案` / `A` / `Answer`，行首（允许 `**`/`*`/`_` 包裹）后接 `:` 或 `：`

**只有问题、没有答案标签的 quiz 不是违规** —— 205 处存量正是这个形态，是既有设计。刻意不把「子节点数 > 2」当作违规信号：问题 + 提示段是合法形态，实测 73 处受损块全部有标签，无需这条易误判的启发式。

**修复规则（按优先级）**：

1. `setext-separator` → 在 `---` 行前后各补一个空 `>` 行。零猜测、与语言无关。
2. `missing-separator` → 在标签行前插入 `>` / `> ---` / `>` 三行；标签行与问题同段（软换行）时该插入天然完成拆段。
3. 都不命中 → 留在 `unrepaired` 里，内容逐字不动。

**实现约束**：解析用 `unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter,['yaml'])`，与 `markdown-client.ts` 的渲染管线对齐 —— 判定必须与渲染同一套解析，否则护栏和渲染会各说各话。修复在**原始文本行**上做（按 blockquote 的 `position` 定位），不做 mdast → markdown 序列化，避免把整页其他部分重排。

**先写失败测试**，覆盖：
- 正常形态（有 `---` + 空行）→ 零违规、`repair` 后内容**逐字节不变**
- 纯问题形态 → 零违规、内容不变
- setext 形态 → `setext-separator`，修复后再判定为零违规
- 四种标签（`答：` / `答案：` / `A:` / `参考答案：`）× 同段 / 分段 / 三段结构
- 强调包裹（`**答：**`）
- 一页多个 quiz 混合（守约的不动、受损的修）
- 幂等：`repair(repair(x)) === repair(x)`
- 无标签且无 `---` 的多段 quiz → 不判违规、不改动（防误判）
- 非 quiz callout（`[!pitfall]` 里有 `---`）不受影响

**验证**：`npx vitest run src/server/wiki/__tests__/quiz-separator.test.ts`

---

## T2 enricher 护栏接入

**落点**：
- `src/server/agents/runtime/quiz-separator-guard.ts`（新增）
- `src/server/agents/runtime/orchestrator.ts`（`PipelineStep` 加 `quizSeparatorGuard?: boolean`；fanout 分支接入）
- `src/server/services/ingest-service.ts`、`src/server/services/reenrich-service.ts`（enricher step 打开该 flag）
- `src/server/agents/runtime/__tests__/quiz-separator-guard.test.ts`（新增）

**`reconcileQuizSeparator`**（与 `reconcileMergeUpdateFidelity` 同构）：

1. 产物合规 → **原样返回 `first`**（零回归硬要求：不得改动守约产物的任何一个字节）
2. 违规 → `rerun({ quizSeparatorViolations })` 重写一次
3. 重写后合规 → 返回重写结果
4. 重写后仍违规 → `repairQuizSeparator` 确定性修复 + `emit('ingest:warn', ...)`；`unrepaired` 非空时 warn 里带上条目

**flag 而非按 `skillId` 硬编码**：与 `injectExistingPageForUpdate` 同一范式，把「哪个阶段需要这道护栏」留在 service 的 step 声明里。ingest 与 re-enrich 共用同一个 enricher step，两处各自打开。

**验证**：`npx vitest run src/server/agents/runtime/__tests__/quiz-separator-guard.test.ts src/server/agents/runtime/__tests__/orchestrator.test.ts`

---

## T3 commit 前零成本终审

**落点**：`src/server/agents/runtime/commit-pending.ts` + `src/server/agents/runtime/__tests__/commit-pending.test.ts`

在 `mergedEntries` 算出后、`createChangeset` 之前，对每个非 `auxiliary`、非 `delete` 条目跑 `findQuizSeparatorViolations`，有违规则 `ctx.emit('ingest:warn', ...)` 带 path 与逐条 violation。**不改内容、不阻断、不调 LLM**。

这条日志是将来排查「是哪一阶段吃掉的分隔符」的唯一凭据 —— enricher 护栏之后仍出现，就说明是 verify 阶段。

**验证**：`npx vitest run src/server/agents/runtime/__tests__/commit-pending.test.ts`

---

## T4 存量迁移脚本

**落点**：`scripts/repair-quiz-separator.ts`（新增）+ `package.json` 加 `vault:repair-quiz-separator` script

行为：
1. 扫 `<vaultPath>/wiki/**/*.md`，对每个文件跑 `repairQuizSeparator`
2. `--dry-run`（默认行为要求显式 `--apply` 才落盘）打印每处的文件:行、标题、修复前后片段
3. `--apply` 落盘，并对实际改动的页按 subject 分组调 `indexTouchedPages(subjectId, slugs)` 同步 `content_hash` 与 FTS body
4. 打印汇总：扫描页数、修复处数、`unrepaired` 清单
5. **不执行任何 git 操作**（约束 C4）

**验证**：
- `npm run vault:repair-quiz-separator` （dry-run）→ 报告 73 处待修、0 处 unrepaired
- 逐条抽查报告
- `-- --apply` 落盘 → 重跑扫描：`spoiled` 0 / `ok` 103 / `question-only` 205
- 抽查 `pages.content_hash` 与文件实际 hash 一致
- `git -C data/vault diff --stat` 只出现预期的 `.md` 文件

---

## T5 skill v8

**落点**：
- `examples/skills/ingest-enricher.md`（v7 → v8，Quiz 章节补两条）
- `src/server/services/ingest-service.ts::MIN_SKILL_VERSIONS`（7 → 8）
- `src/server/services/reenrich-service.ts::MIN_SKILL_VERSIONS`（7 → 8）
- `src/server/agents/skills/builtin-manifest.ts::BUILTIN_UPGRADE_HASHES`（追加 v7 原版 SHA-256）
- `src/server/agents/skills/__tests__/builtin-manifest.test.ts`（断言 v7 hash 在白名单、当前模板 hash 不在）

补的两条：
1. 禁止自造 `问：` / `答：` / `Q:` / `A:` 标签前缀 —— 问题与答案由 `---` 分隔，本身不需要标签
2. `---` 前后必须各留一个空 `>` 行，否则 CommonMark 会把它解析成 setext 标题而不是分隔符

**顺序要求**：v7 hash 必须在改模板**之前**算（`shasum -a 256 examples/skills/ingest-enricher.md`）。三处任一漏改都会让既有 vault 卡版本门（`src/server/agents/CLAUDE.md` 2026-07-26 条明确记过这个坑）。

**验证**：
- `shasum -a 256 data/vault/.llm-wiki/skills/ingest-enricher.md` 命中新增白名单条目
- `npx vitest run src/server/agents/skills/__tests__/builtin-manifest.test.ts src/server/agents/skills/__tests__/skill-contracts.test.ts`

---

## T6 文档同步

**落点**：
- `src/server/wiki/CLAUDE.md`（新增 `quiz-separator.ts` 条目 + changelog）
- `src/server/agents/CLAUDE.md`（`quiz-separator-guard.ts` + orchestrator flag + commit-pending 终审 + changelog）
- `src/lib/CLAUDE.md`（说明渲染层**刻意不做**语言标记兜底，指向本 spec —— 避免后人以为这是遗漏）
- 根 `CHANGELOG.md` + `AGENTS.md`（若测试基线计数需更新）

---

## 最终验证（宣称完成前必须跑出来）

1. `npm test` 全绿
2. 迁移后重跑扫描：`spoiled` = 0
3. 阅读页真实打开 `mongol-empire`，确认那一块呈现为折叠态 + 「显示答案」按钮（不靠推断）

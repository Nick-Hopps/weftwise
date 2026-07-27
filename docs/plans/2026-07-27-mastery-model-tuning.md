# Plan：掌握度模型调优与复习闭环

日期：2026-07-27
设计稿：[docs/specs/2026-07-27-mastery-model-tuning.md](../specs/2026-07-27-mastery-model-tuning.md)

按 TDD 推进，每个任务独立可验证、独立提交。

**依赖关系**：任务 1（连击）、2（入参上限）、3（read beacon）、4（索引）**互不依赖**，
可任意顺序。任务 5（`explainMastery` + `dueAt`）依赖任务 1 落地后的连击语义；
任务 6（`?due=1`）依赖 5；任务 7（Dashboard 区块）依赖 6；任务 8（观测脚本）依赖 5。

**建议顺序**：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9。前四个是独立缺陷修复，
先清掉能让后面的改动跑在干净的基线上。

---

## 任务 1：连击改用滚动最小间隔

**先写失败测试**：`src/server/profile/__tests__/mastery.test.ts` 新增 describe
「连击按滚动间隔折叠（决策 1）」：

- **UTC 跨日但间隔 1 小时 → 连击 1**（本任务的核心断言；用
  `2026-07-25T23:30:00Z` 与 `2026-07-26T00:30:00Z` 两条 strong 正证据，
  对应北京时间早 7:30 / 8:30。当前实现会算 2，此测试必红）
- 间隔 24h → 2；间隔恰好 `STREAK_MIN_GAP_HOURS` → 2；差 1 分钟 → 1
- 同一坐五条 → 1（既有用例语义不变，换个 describe 重申）
- 乱序输入不影响结果（内部已排序）
- 未来时间戳导致的负间隔不计数

**实现**：`src/server/profile/mastery.ts`

- 删 `dayKey`，新增 `export const STREAK_MIN_GAP_HOURS = 16`
- `computeStreak` 的 `days: Set` 折叠改为线性扫描：维护 `lastCountedAt`，
  第一条计数；其后 `createdAt - lastCountedAt >= STREAK_MIN_GAP_HOURS` 才计数并推进游标
- **`lastPositiveAt` 保持取最后一条正证据**（不是最后一条被计数的）——
  它的语义是「最近一次表现出掌握」，挪走会让同一坐的第二次答对反而缩短有效期

**验证**：`npx vitest run src/server/profile/__tests__/mastery.test.ts`
（既有 27 条用例必须全绿——连击改动只应影响「同一坐」的语义，而那条的期望值本就是 1）

## 任务 2：`/api/evidence` 入参上限 + `detail` 截断

**先写失败测试**：

- `src/app/api/evidence/__tests__/route.test.ts`：超长 `slug`（513 字符）→ 400；
  超长 `anchor`（257 字符）→ 400；两者都断言**表里无新行**
- `src/server/db/repos/__tests__/evidence-repo.test.ts`：`detail` 序列化后 > 4096 →
  落库的 `detail_json` 是 `{"truncated":true,"bytes":N}`，且**证据行本身存在**；
  正常 `detail` 原样落库；`detail` 缺省仍为 `null`

**实现**：

- `src/app/api/evidence/route.ts`：zod `slug: z.string().min(1).max(512)`、
  `anchor: z.string().max(256).optional()`
- `src/server/db/repos/evidence-repo.ts`：新增
  `export const MAX_DETAIL_BYTES = 4096`；序列化后超限则替换为
  `{ truncated: true, bytes }` 并 `console.warn`

> 截断**必须在 repo 层**：服务端还有三个生产方（`/api/query` 的 `selection-ask` /
> `citation-hit`、`/api/lens` 的 `reshape-request`）经 `recordEvidence` 直接调 repo，
> 绕过路由。闸门装在唯一写入口才有意义——为此单独断言一次 `recordEvidence` 路径。

**验证**：`npx vitest run src/app/api/evidence src/server/db/repos/__tests__/evidence-repo.test.ts`

## 任务 3：read beacon 区分「滚到底」与「不足一屏」

**先写失败测试**：`src/components/wiki/__tests__/use-page-read-beacon.test.ts`
按 spec 第五节决策 3 的五行矩阵逐行断言。核心失败用例：

```
不足一屏（scrollable:false, progress:100）
  → 内容变长（scrollable:true, progress:5）
  → 停留 30s
  → shouldFireReadBeacon === false     ← 当前实现返回 true
```

**实现**：`src/components/wiki/use-page-read-beacon.ts`

- `ReadBeaconState`：`reachedBottom` 拆为粘性 `scrolledToBottom` +
  非粘性 `fitsInViewport`
- `advanceReadBeacon(state, { progress, scrollable, visibleMsDelta })`：
  `scrollable === false` → `fitsInViewport = true`、不动 `scrolledToBottom`；
  `scrollable === true && progress >= READ_PROGRESS_THRESHOLD` →
  `scrolledToBottom = true`、`fitsInViewport = false`
- `shouldFireReadBeacon`：`(scrolledToBottom || fitsInViewport) && visibleMs >= READ_DWELL_MS`
- hook 侧：抽 `readScroller(el)` 得 `{ progress, scrollable }`；
  **timer tick 里也调它**（内容变长可能在用户完全没滚动时发生，只监听 scroll 感知不到）

**验证**：`npx vitest run src/components/wiki/__tests__/use-page-read-beacon.test.ts`

## 任务 4：`listStyleEvidence` 专用索引

**先写失败测试**：`src/server/db/__tests__/indexes.test.ts` 新增一条，
断言 `SELECT ... FROM page_evidence WHERE user_id = ? AND kind IN (?,?) AND created_at > ?`
的 plan `USING INDEX` 且不 `SCAN page_evidence`。

**实现**：`src/server/db/client.ts::ensureIndexes` 加

```sql
CREATE INDEX IF NOT EXISTS page_evidence_style_idx
  ON page_evidence(user_id, kind, created_at);
```

> 放 `ensureIndexes` 而非 `ensureTables`：该函数注释已写明索引必须在此重建，
> 否则会随表重建被丢弃；`CREATE INDEX IF NOT EXISTS` 幂等，既有安装启动即补。
> 本次不改表结构，**不需要** `db:generate` 迁移。

**验证**：`npx vitest run src/server/db/__tests__/indexes.test.ts`

## 任务 5：`dueAt` 进 verdict + `explainMastery` + `isDueForReview`

**先写失败测试**：`mastery.test.ts` 新增三个 describe：

- `dueAt`：仅 `mastered` 时非空；`dueAt < expiresAt` 恒成立；
  逐档对应 `masteryWindowDays(n).dueDays`
- `isDueForReview`：未到期 false；恰好到期 true；
  `exposed` / `struggling` / `unknown` 一律 false（**过期回落的不进清单**，决策 4）
- `explainMastery` 与 `deriveMastery` 一致：同输入下
  `explainMastery(...).verdict` 与 `deriveMastery(...)` 深相等（**防两份判定漂移**）；
  五条规则各自的 `rule` 序号；`blockedByStrengthGate` 只在规则 3 被门槛挡下时 true

**实现**：

- `src/lib/contracts.ts`：`MasteryVerdictLite` 加 `dueAt: string | null`；
  新增 `MasteryDueEntry` / `MasteryDueResult`
- `src/server/profile/mastery.ts`：把现有判定主体改名为 `explainMastery` 并补解释字段；
  `deriveMastery` 变成 `explainMastery(...).verdict` 的薄封装（**方向不能反**——
  报告与线上判定共用同一段逻辑才不会漂移）；新增 `isDueForReview`

**验证**：`npx vitest run src/server/profile/ src/app/api/mastery`
（`/api/mastery` 既有用例会因响应多一个 `dueAt` 字段而调整，一并跑）

## 任务 6：`GET /api/mastery?due=1`

**先写失败测试**：`src/app/api/mastery/__tests__/route.test.ts`

- 按 `dueAt` 升序返回
- 排除 meta 页（与另两条分支同口径）
- 未到期 / 已失效 / 非 `mastered` 的页不出现
- 超上限截断且 `total` 反映真实总数
- 空库返回 `{ entries: [], total: 0 }`
- 证据指向已删页时跳过（不 500）

**实现**：`src/app/api/mastery/route.ts` 加 `?due=1` 分支，
与批量分支共用同一次 `listForSubject` + meta 页排除 + `deriveMastery`；
`DUE_LIMIT = 20`。

**验证**：`npx vitest run src/app/api/mastery`

## 任务 7：Dashboard「该复习了」区块

- 新增 `src/components/dashboard/due-for-review.tsx`：`'use client'`，
  React Query `['mastery-due', subjectId]` 走 `useApiFetch`（GET 自动注入 subjectId）；
  渲染标题 + 相对到期时间 + `Link` 到 `/wiki/<slug>?s=<subjectSlug>`；
  **空 / 失败整体不渲染**（不占位、不报错——它是锦上添花的提醒，不该给首页添噪）
- `src/app/(app)/page.tsx`：在「最近页面」同级挂载
- `src/lib/i18n/messages/{zh-CN,en}.ts`：区块标题、到期文案、超出上限提示

**验证**：`npx vitest run`（全量，确认无回归）+ 人工：
`npm run db:seed-mastery-evidence` 后开首页确认区块出现、链接正确、清空证据后消失。

## 任务 8：`scripts/mastery-report.ts` 观测脚本

- 新增脚本：可选 `--subject=<slug>`，缺省遍历全部 subject；
  逐 slug `explainMastery` 后按 spec 决策 7 的七项聚合并打印
- `package.json` 加 `"mastery:report": "tsx scripts/mastery-report.ts"`
- 聚合逻辑抽成纯函数 `summarizeMasteryReport(entries)` 放脚本同目录或
  `src/server/profile/mastery-report.ts`，单测覆盖：空输入、四态计数、
  `blockedByStrengthGate` 计数、kind 分布

**验证**：`npx vitest run src/server/profile/` + 真实库跑一次
`npm run mastery:report` 贴输出。

## 任务 9：文档与 changelog

- `src/server/profile/mastery.ts`：补两条语义注释——
  ① 连击为何用滚动间隔而非日历日（时区）；
  ② **过期回落 `exposed` 后再答对，连击不从 1 重来**——它按最后一条 strong 负证据起算，
  从间隔重复角度这是对的（间隔越长仍答对 = 记忆越强），但「过期 ≠ 降档」这条语义
  一直只存在于讨论里，不写下来将来会被当 bug 修掉
- `src/server/db/CLAUDE.md`：新索引 + 决策 6 的保留策略（只折叠 12 个月以上的
  exposure / weak negative，**正证据与 strong negative 永久保留**，
  因为连击派生要扫完整正证据历史）
- `src/server/CLAUDE.md` / `src/app/CLAUDE.md` / `src/components/CLAUDE.md` /
  `src/lib/CLAUDE.md`：changelog 各一行
- 根 `AGENTS.md`：测试基线数字若变化则同步

**验证**：`npm test` 全量 + `npm run lint`

# P5 Final Fix Report

## Fix 1: CLAUDE.md 方法名修正

**文件**: `src/server/db/CLAUDE.md`
- 将 `maturity-repo.ts` 条目中的虚构方法名（`initMaturity / getMaturity / updateMaturity / listDue / listForSubject`）替换为实际导出名（`get / ensureRow / listDue / applyAfterEnrich / bumpNeighbor / pruneOrphans`）。

**文件**: `src/server/services/CLAUDE.md`
- 将 `maintenance-policy.ts` 条目中的 `shouldGraduate`（不存在）替换为实际导出（`SPACING_LADDER / countCallouts / nextMaturity`）。
- 将 `maintenance-scheduler.ts` 条目中的 `listDue 过滤、每轮上限` 描述替换为实际导出函数名 `runMaintenanceSweep`。

## Fix 2: bumpNeighbor 去掉无效 CASE

**文件**: `src/server/db/repos/maturity-repo.ts`
- 原 `state = CASE WHEN state = 'active' THEN 'active' ELSE 'active' END` 两个分支结果相同，属于空操作。
- 替换为 `state = 'active', -- dormant/graduated → active（唤醒复活）`。
- 行为完全等价；`maturity-repo.test.ts` 全部通过。

## Fix 3: backlink 查询约束同主题

**文件**: `src/server/wiki/indexer.ts`，函数 `collectNeighborSlugs`
- 原 backlink 子查询仅过滤 `target_subject_id = ? AND target_slug = ?`，未限制 source 端 subject。
- 新增 `AND subject_id = ?` 并传入相同 `subjectId`，使 backlink 来源与调用契约对齐（只看本 subject 内的入链）。
- `indexer-wakeup.test.ts` 全部通过。

## Fix 4: reenrich-service meta 页守卫

**文件**: `src/server/services/reenrich-service.ts`
- 在 `registerHandler('re-enrich', ...)` 顶部、参数解析后、subject/page 查询前，新增：
  ```ts
  if (slug === 'index' || slug === 'log') throw new Error('Cannot re-enrich a meta page (index/log)');
  ```
- 使 meta 安全不变式在消费层本地生效，不依赖未来调用方自觉。

## Fix 5: 边界测试（maintenance-policy）

**文件**: `src/server/services/__tests__/maintenance-policy.test.ts`
- 新增用例 **阶梯顶端钳制**：`intervalDays=60, newIncrement=1` → `intervalDays===60`（Math.min 钳制，不超出 SPACING_LADDER 最大档）。
- 新增用例 **graduation 边界**：`passes=1, intervalDays=7, newIncrement=0` → `state==='active', passes===2`（2 < GRADUATE_AFTER_PASSES=3，不毕业）+ 阶梯 +2（idx=2 → ni=4 → 60d）。

## Fix 6: 边界测试（maintenance-tick）

**文件**: `src/server/jobs/__tests__/maintenance-tick.test.ts`
- 新增用例 **精确等于节律**：`shouldSweep(<恰好 intervalHours 前>, 24, NOW) === true`（验证 `>=` 而非 `>` 的边界行为）。

## Fix 7: contracts.ts dormant 状态注释

**文件**: `src/lib/contracts.ts`
- 在 `MaturityState` 联合类型前加注释，说明 `'dormant'` 当前为保留/未使用状态（nextMaturity 仅发出 'active'/'graduated'；bumpNeighbor 复活为 'active'）；为未来冬眠模式预留，不移除。

## 验证结果

- `npx tsc --noEmit`：无输出（0 错误）。
- 目标四文件测试：4 passed (16 tests)。
- 全套测试：74 passed (486 tests)，耗时 ~3s。

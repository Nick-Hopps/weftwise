# Plan：维护到期页面预览

对应 spec：`docs/specs/2026-07-20-maintenance-due-pages-preview.md`
分支：`feat/maintenance-due-pages-preview`（worktree）

## 任务拆分

### T1 repo：`listDueDetailed`（TDD）

- 文件：`src/server/db/repos/maturity-repo.ts`、
  `src/server/db/repos/__tests__/maturity-repo.test.ts`
- 先写失败测试：
  1. 返回 title / subjectSlug / subjectName / nextDueAt / priority / state，
     排序 `priority DESC, next_due_at ASC`，排除未到期与 graduated；
  2. `subjectIds` 过滤与空数组短路（返回 `[]`）；
  3. maturity 孤儿行（无 pages 行）→ `title: null` 且仍返回。
- 实现：LEFT JOIN pages（复合键）+ JOIN subjects，WHERE/ORDER 与 `listDue` 一致。
- 验证：`npx vitest run src/server/db/repos/__tests__/maturity-repo.test.ts`

### T2 契约 + API 路由（TDD）

- 文件：`src/lib/contracts.ts`（`MaintenanceDuePage` / `MaintenanceDuePagesResult`，
  紧邻 `MaintenanceStatus`）；
  `src/app/api/maintenance/due-pages/route.ts`（`runtime='nodejs'`，`requireAuth`，
  scope 读 settings-repo，`DUE_PAGES_LIMIT = 100`）；
  路由测试 `src/app/api/maintenance/due-pages/__tests__/route.test.ts`
  （参照 `api/reset/__tests__/route.test.ts` 的真实 DB + 请求构造模式）。
- 断言：total 与 countDue 一致、entries 有界、scope=subjects 只含所选、
  未鉴权 401（若 status 路由测试有同样断言则对齐）。
- 验证：`npx vitest run src/app/api/maintenance/due-pages/__tests__/route.test.ts`

### T3 UI + i18n

- 文件：`src/components/layout/settings-content.tsx`（MaintenancePanel 状态行
  加 View/Hide 按钮 + 展开列表子组件 `MaintenanceDuePagesList`）、
  `src/lib/i18n/messages/{en,zh-CN}.ts`（新增 key：
  `settings.maintenance.viewDuePages` / `hideDuePages` / `duePagesEmpty` /
  `dueSince` / `duePagesMore`）。
- 交互：懒加载 query（`enabled: open`）；Link 点击 `closeSettingsDialog()`；
  错误显示 `common.unavailable`。
- 验证：`npx tsc --noEmit`；`npm run dev` 手动走查（Settings → Automation →
  Maintenance → View）。

### T4 文档同步 + 收尾

- `src/app/CLAUDE.md` API 表 + Changelog；`src/components/CLAUDE.md` Changelog；
  `src/server/db/CLAUDE.md` maturity-repo 行更新。
- 全量验证：`npx tsc --noEmit` + `npx vitest run`（存量不回归）。
- 提交：`docs:` 与 `feat:` 成对；完成后提醒是否 `--no-ff` 回合 main 并清理 worktree。

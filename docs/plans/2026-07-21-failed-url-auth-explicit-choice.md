# Plan：失败 URL 授权任务显式重试或取消

对应 spec：`docs/specs/2026-07-21-failed-url-auth-explicit-choice.md`
分支：`feat/失败授权任务显式决策`（worktree）

## 任务拆分

### T1 锁定 cancelled auth 恢复边界（TDD）

- 文件：
  - `src/lib/ingest-auth.ts`
  - `src/lib/__tests__/ingest-auth.test.ts`
  - `src/components/shared/jobs-panel-state.ts`
  - `src/components/shared/__tests__/jobs-panel-state.test.ts`
- 先写失败测试：
  1. `result.error.code=url-auth-required` 但 `cancelled=true` 时不恢复任务；
  2. SSE 历史在 auth challenge 后出现 `job:cancelled` 时不再返回 challenge。
- 最小实现后运行定向测试。

### T2 将全局授权恢复改为显式双动作（TDD）

- 文件：
  - `src/components/shared/jobs-panel.tsx`
  - `src/components/shared/url-auth-recovery-state.ts`
  - `src/components/shared/__tests__/url-auth-recovery-state.test.ts`
  - `src/lib/i18n/messages/{en,zh-CN}.ts`
- 先把状态测试改为：发现 challenge 不打开对话框；只有显式 retry 才选择一个请求；关闭后
  清除选择但保留任务。
- 任务行新增授权重试与取消按钮；取消调用通用 API，成功后移除，失败显示行内错误。
- 删除自动提示队列和不再需要的 prompted challenge 状态。
- 运行相关组件/helper 定向测试。

### T3 文档与全量验证

- 更新 `src/components/CLAUDE.md` 的 URL auth 行为说明。
- 检查 diff 不含凭证、任务数据或无关变更。
- 验证：
  - `npx vitest run src/lib/__tests__/ingest-auth.test.ts src/components/shared/__tests__/jobs-panel-state.test.ts src/components/shared/__tests__/url-auth-recovery-state.test.ts`
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npx vitest run`
  - `npm run build`
- 按任务边界提交；完成后等待确认再用 `--no-ff` 回合 main 并清理 worktree。

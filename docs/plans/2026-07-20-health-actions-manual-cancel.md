# Health 三类处置操作手动中断实现计划

**目标：** 让 Health 的「整理」「修复」「研究」三个操作在 pending/running 时可从原按钮手动停止，并保证 Research 真正停止后台模型/搜索工作且不落候选 run。

**架构：** 客户端继续以现有 workflow job ID 和 SSE 为唯一事实源，新增小型取消请求 helper 与按钮展示派生；服务端扩展结构化 LLM 和 Tavily 搜索的 abort 边界，由 Research job 统一轮询取消标记并在持久化前 fail closed。

**Spec：** `docs/specs/2026-07-20-health-actions-manual-cancel.md`

## 全局约束

- 严格 TDD：每个行为先写失败测试并确认失败原因，再做最小实现。
- 复用 `POST /api/jobs/:id/cancel`、`useJobStream`、action gate 与 active jobs 恢复，不复制终态状态机。
- 不扩展到 Health check、Re-ingest 或 Research import 子任务。
- 取消不承诺回滚 Fix/Curate 已提交的独立写入。

## Task 1：客户端取消契约与三个按钮交互

**文件：**

- 修改：`src/components/health/remediation-ui.ts`
- 修改：`src/components/health/__tests__/remediation-ui.test.ts`
- 修改：`src/components/health/health-view.tsx`
- 修改：`src/lib/i18n/messages/en.ts`
- 修改：`src/lib/i18n/messages/zh-CN.ts`

1. 先为取消响应解析与运行态按钮派生写失败测试，覆盖成功、409 幂等、服务端错误与三种 workflow。
2. 运行 Health 定向测试，确认旧实现因 helper/状态缺失失败。
3. 实现取消 helper 和按钮派生；三个按钮在 workflow busy 且持有 job ID 时原位显示 Square + Stop。
4. 为每个 action 保存 cancelling 状态；调用通用取消 API，失败显示工作区错误，成功等待 SSE 终态并失效查询。
5. 重跑 Health 测试转绿。
6. 提交：`feat: 为 Health 三类处置接入手动停止`

## Task 2：Research 全链路响应取消

**文件：**

- 修改：`src/server/llm/provider-registry.ts`
- 修改：`src/server/llm/__tests__/provider-registry-cancel.test.ts`
- 修改：`src/server/search/web-search.ts`
- 修改：`src/server/search/__tests__/web-search.test.ts`
- 修改：`src/server/services/research-service.ts`
- 修改：`src/server/services/__tests__/research-service.test.ts`

1. 先写失败测试：结构化输出响应外部 signal；web search 传递外部 signal；Research 取消后抛 `AgentCancelled` 且不调用 `persistResearchRun`。
2. 分别运行三个定向测试，确认旧实现以预期原因失败。
3. 给 `generateStructuredOutput` 和 `webSearch` 增加可选 signal，正确合并现有 timeout 并清理监听器。
4. 在 Research job 中建立取消 controller，覆盖 query、search、triage 与持久化前闸门；finally 清理轮询。
5. 重跑定向测试转绿，并回归 Fix/Curate provider cancellation 测试。
6. 提交：`feat: 让 Research 全链路响应任务取消`

## Task 3：文档同步与完整验证

**文件：**

- 修改：`src/components/CLAUDE.md`
- 修改：`src/server/services/CLAUDE.md`
- 修改：`src/server/CLAUDE.md`

1. 更新 Health UI、Research service、structured output 与 web search 的取消语义。
2. 运行：
   - Health/Research/provider/web-search/jobs 定向测试；
   - `npm test -- --run`；
   - `npx tsc --noEmit`；
   - `npm run lint`；
   - `npm run build`；
   - `git diff --check`。
3. 浏览器核验当前 Subject 下三类可执行动作：运行态按钮稳定替换、停止后无重复触发、错误与活动区无重叠。
4. 提交：`docs: 同步 Health 处置任务取消说明`

## Task 4：交付前检查

1. 亲自检查 worktree diff、提交序列、版本变更与最终 tree。
2. 保持 feature branch/worktree，不主动合回 `main`。
3. 向 Nick 报告验证结果，并询问是否使用 `--no-ff` 回合主分支及清理 worktree。

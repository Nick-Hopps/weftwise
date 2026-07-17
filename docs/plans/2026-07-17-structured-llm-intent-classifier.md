# Ask AI 统一结构化 LLM 意图分类实施计划

**日期：** 2026-07-17
**设计：** `docs/specs/2026-07-17-structured-llm-intent-classifier.md`
**分支：** `feat/structured-llm-intent`
**Worktree：** `.worktrees/structured-llm-intent`

## Task 1：统一分类契约与服务

**涉及文件：**

- `src/server/llm/prompts/query-prompt.ts`
- `src/server/llm/prompts/__tests__/query-prompt.test.ts`
- `src/server/services/query-intent.ts`
- `src/server/services/__tests__/query-intent.test.ts`

步骤：

1. 先写失败测试，定义统一 intent 枚举、目标引用和 request/reset-confirmation 两种上下文。
2. 确认测试因旧 `SelectionIntentSchema` 与正则函数仍存在而失败。
3. 最小实现 `classifyQueryIntent`，复用 `query` task 的 `generateStructuredOutput`。
4. 增加确定性的上下文收窄、QueryMode 映射和 Re-enrich 目标解析纯函数。
5. 删除 `resolveQueryMode`、自然语言 Re-enrich 正则与旧选区专用分类器。

验证：

```bash
npx vitest run src/server/llm/prompts/__tests__/query-prompt.test.ts src/server/services/__tests__/query-intent.test.ts
```

提交：

```bash
git commit -m "feat: 统一 Ask AI 结构化意图分类"
```

## Task 2：Query 路由统一分流与重置协议

**涉及文件：**

- `src/app/api/query/route.ts`
- `src/app/api/query/__tests__/route.test.ts`

步骤：

1. 先改 route 测试，使每个请求只依赖统一分类结果。
2. 增加 `intentContext` body 校验和重置 requested/confirm/cancel/unclear SSE 契约。
3. 用结构化目标替代 Re-enrich 正则提取，并保留 PendingAction 预览路径。
4. 保持 canonical/reshape 配图、Query profile 和 conversation 持久化边界不变。
5. 确认分类失败由 service 保守回退，不导致 route 500。

验证：

```bash
npx vitest run src/app/api/query/__tests__/route.test.ts src/server/services/__tests__/query-intent.test.ts
```

提交：

```bash
git commit -m "feat: 接入统一意图路由与重置协议"
```

## Task 3：聊天重置状态接线

**涉及文件：**

- `src/components/chat/chat-interface.tsx`
- `src/components/chat/reset-confirmation-state.ts`
- `src/components/chat/__tests__/reset-confirmation-state.test.ts`

步骤：

1. 先为纯状态转换写失败测试，覆盖 requested/confirm/cancel/unclear。
2. 删除客户端重置请求和 yes/no 正则。
3. 普通输入统一发送 `/api/query`；确认态只附加 `intentContext: 'reset-confirmation'`。
4. 处理 reset-confirmation SSE；仅 confirm 在流结束后调用现有 `/api/reset`。
5. 验证取消、模糊回复、请求取消和会话切换不会误执行重置。

验证：

```bash
npx vitest run src/components/chat/__tests__/reset-confirmation-state.test.ts src/app/api/query/__tests__/route.test.ts
```

提交：

```bash
git commit -m "feat: 统一聊天重置意图分类流程"
```

## Task 4：文档与完整验证

**涉及文件：**

- `src/app/CLAUDE.md`
- `src/components/CLAUDE.md`
- `src/server/services/CLAUDE.md`
- `src/server/llm/CLAUDE.md`

步骤：

1. 同步 API、前端状态、服务分类与 prompt 文档。
2. 搜索确认生产代码不再存在自然语言意图正则。
3. 运行全量测试、lint、build 和 diff 检查。

验证：

```bash
npm test -- --run
npm run lint
npm run build
git diff --check
rg -n "RESET_INTENT_PATTERNS|detectResetIntent|detectConfirmation|resolveQueryMode|resolveDirectReenrichSlug|classifySelectionIntent" src
```

提交：

```bash
git commit -m "docs: 同步统一结构化意图分类架构"
```

## Task 5：合并与清理

```bash
git checkout main
git merge --no-ff feat/structured-llm-intent -m "merge: 合并 feat/structured-llm-intent：统一结构化 LLM 意图分类"
git worktree remove .worktrees/structured-llm-intent
git branch -d feat/structured-llm-intent
```

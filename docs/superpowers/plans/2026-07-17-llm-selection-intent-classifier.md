# Ask AI 选区意图 LLM 分类实施计划

**日期：** 2026-07-17
**设计：** `docs/superpowers/specs/2026-07-17-llm-selection-intent-classifier-design.md`
**分支：** `feat/llm-query-intent`
**Worktree：** `.worktrees/llm-query-intent`

## Task 1：结构化 LLM 分类器

**涉及文件：**

- `src/server/services/query-intent.ts`
- `src/server/services/__tests__/query-intent.test.ts`
- `src/server/llm/prompts/query-prompt.ts`
- `src/server/llm/prompts/__tests__/query-prompt.test.ts`

步骤：

1. 先写失败测试，定义 `SelectionIntentSchema`、prompt builder 和真实口语样例的分类契约。
2. 确认测试因缺少 LLM 分类接口失败。
3. 最小实现 `classifySelectionIntent`，通过依赖注入测试结构化调用、有效输出和异常时 `other` 回退。
4. 删除选区配图正则及其对 `resolveQueryMode` 的特殊分支。
5. 把 Query Agentic prompt 拆成按真实工具能力生成的 builder。

验证：

```bash
npx vitest run src/server/services/__tests__/query-intent.test.ts src/server/llm/prompts/__tests__/query-prompt.test.ts
```

提交：

```bash
git commit -m "feat: 使用 LLM 分类 Ask AI 选区意图"
```

## Task 2：Query API 与客户端原始问题接线

**涉及文件：**

- `src/app/api/query/route.ts`
- `src/app/api/query/__tests__/route.test.ts`
- `src/components/chat/chat-interface.tsx`
- 相关客户端测试

步骤：

1. 先写 route 失败测试：canonical 图片意图进入 propose；Reshape 确定性拒绝；`other` 与分类异常保持 read。
2. API schema 增加可选 `userQuestion`；有选区时以原始问题调用分类器。
3. route 使用分类结果选择 mode，并把真实能力传给 prompt builder。
4. Chat 请求同时发送主 Query 上下文 `question` 与原始输入 `userQuestion`。
5. 确认没有选区的现有问答、保存和 re-enrich 路径不变。

验证：

```bash
npx vitest run src/app/api/query/__tests__/route.test.ts src/components/chat/__tests__
```

提交：

```bash
git commit -m "feat: 接入选区 LLM 意图路由"
```

## Task 3：文档与全量验证

**涉及文件：**

- `src/app/CLAUDE.md`
- `src/server/services/CLAUDE.md`
- `src/server/llm/CLAUDE.md`

步骤：

1. 更新 API、服务与 prompt 架构说明。
2. 运行定向测试、全量测试、lint、build 与 diff 检查。
3. 确认 `llm-config.example.json` 无变化。

验证：

```bash
npm test -- --run
npm run lint
npm run build
git diff --check
git diff -- llm-config.example.json
```

提交：

```bash
git commit -m "docs: 同步选区 LLM 意图分类架构说明"
```

## Task 4：合并与清理

```bash
git checkout main
git merge --no-ff feat/llm-query-intent -m "merge: 合并 feat/llm-query-intent：使用 LLM 识别选区配图意图"
git worktree remove .worktrees/llm-query-intent
git branch -d feat/llm-query-intent
```

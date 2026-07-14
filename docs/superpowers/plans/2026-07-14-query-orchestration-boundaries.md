# Query 编排边界执行计划

**目标：** 锁定空库、空答案与工具失败的唯一终态，禁止流式错误继续按成功回答收口。

**分支：** `feat/query-orchestration-boundaries`  
**Worktree：** `.worktrees/query-orchestration-boundaries`  
**状态：** 已完成

## Task 1：失败边界红测

1. `runQuery` 的工具/模型调用拒绝时原样抛出；
2. 流式 `error` part 只发送一次 error；
3. 流式迭代器抛错走同一错误终态；
4. 两类失败均不发送 fallback/citations/done，不落会话、不评估 coverage。

## Task 2：成功空结果回归

1. active Subject 空库仍进入 agentic 工具循环；
2. 无错误的空流回落 `NO_QUERY_CONTEXT_ANSWER`；
3. fallback 正常提取 citation、持久化会话、发送 done 并评估 coverage。

## Task 3：最小实现

1. 把 `fullStream` 的 error part 转为异常，交由外层 catch 单点发 SSE error；
2. 保持 iterator/setup 异常共用同一收口；
3. 不改变正常 answer、pending-action、tool-call 与 save-to-wiki 路径。

## Task 4：文档与验证

1. 更新 App/Services 文档与根测试基线；
2. 运行定向 Vitest；
3. 运行全量 Vitest、`npx tsc --noEmit`、`npm run lint`、`npm run build`；
4. 确认 `git diff --check` 与 `llm-config.example.json` 无差异；
5. 中文单句提交，以 `--no-ff` 合并回 main 并清理 worktree/分支。

## 执行结果

- Task 1–4 均已完成；
- 红测复现 `error → fallback → citations → done` 双终态，最小修复后统一为单一 error；
- 定向 Vitest：2 个文件、25 个用例通过；
- 全量 Vitest：239 个文件、2115 个用例通过；
- TypeScript、ESLint 与生产构建通过；ESLint 仅保留仓库既有 warning；
- `llm-config.example.json` 无差异；
- Git 合并与 worktree 清理在本计划提交后执行。

# Worker 与数据库不变量测试收尾执行计划

**目标：** 补齐 worker 心跳、job 租约/领取、pages 复合身份与手动 FTS 一致性测试，并修复红测暴露的最小边界缺陷。

**分支：** `feat/job-db-invariant-tests`  
**Worktree：** `.worktrees/job-db-invariant-tests`
**状态：** 已完成

## Task 1：Worker 心跳红测

1. 用 deferred handler 与 fake timers 覆盖 30 秒首跳和连续续租；
2. 覆盖 completed/failed/retry 后定时器清理；
3. 覆盖心跳异常不影响任务成功；
4. 在真实 jobs repo 覆盖终态任务不被旧心跳续租。

## Task 2：Job 租约与 claim 不变量

1. 覆盖同一 pending job 只领取一次及 type filter；
2. 覆盖过期前、恰好过期、过期后的 claim/reclaim；
3. 覆盖 requeue 本身不改 attempt，下一次 claim 精确加一；
4. 统一 claim/reclaim 的 `<= now` 到期语义。

## Task 3：Pages 复合主键与 FTS

1. 覆盖跨 Subject 同 slug、同 Subject 冲突与 path 全局唯一；
2. 覆盖 upsert/delete 精确复合身份；
3. 覆盖 FTS update 替换、Subject 隔离、新旧内容命中；
4. 覆盖 deleteFtsEntry/deletePage 精确删除。

## Task 4：文档与验证

1. 更新根、jobs、db、server 模块测试基线与“仍待补充”；
2. 运行定向 Vitest；
3. 运行全量 Vitest、`npx tsc --noEmit`、`npm run lint`、`npm run build`；
4. 确认 `git diff --check` 与 `llm-config.example.json` 无差异；
5. 使用中文单句提交；
6. 以 `--no-ff` 合并回 main，删除 worktree 和特性分支。

## 执行结果

- Task 1–4 均已完成；
- 核心定向 Vitest：3 个文件、60 个用例通过；相关 jobs 回归集：4 个文件、65 个用例通过；
- 全量 Vitest：239 个文件、2103 个用例通过；
- TypeScript、ESLint、生产构建通过；
- `llm-config.example.json` 无差异；
- Git 合并与 worktree 清理在本计划提交后执行。

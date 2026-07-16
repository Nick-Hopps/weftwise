# Re-enrich 快速失败可见性实施计划

## 任务 1：锁定内置 skill 安全升级契约

- 文件：`src/server/agents/skills/builtin-manifest.ts`、`src/server/agents/skills/registry.ts`、`src/server/agents/skills/__tests__/registry.test.ts`。
- 内容：先写失败测试，覆盖历史原版自动升级、用户改版不覆盖，再实现 hash 白名单与原子替换。
- 验证：`npx vitest run src/server/agents/skills/__tests__/registry.test.ts`。

## 任务 2：锁定 queued 快速终态恢复

- 文件：`src/components/shared/jobs-panel-state.ts`、`src/components/shared/global-job-tracker.tsx`、`src/components/shared/__tests__/jobs-panel-state.test.ts`。
- 内容：先写失败测试，覆盖未列出 queued 行切入 SSE、running 行保留、dismissed 行不恢复，再接入轮询合并。
- 验证：`npx vitest run src/components/shared/__tests__/jobs-panel-state.test.ts`。

## 任务 3：同步模块文档

- 文件：`src/server/agents/CLAUDE.md`、`src/components/CLAUDE.md`。
- 内容：记录 hash 门控升级和快速终态 SSE 恢复语义。
- 验证：检查文档与实现命名、行为一致。

## 任务 4：完成回归验证

- 内容：运行两组定向测试、相关测试、lint 与生产构建；核对 diff 与提交落点。
- 验证：`npx vitest run src/server/agents/skills/__tests__/registry.test.ts src/components/shared/__tests__/jobs-panel-state.test.ts`、`npm run lint`、`npm run build`。

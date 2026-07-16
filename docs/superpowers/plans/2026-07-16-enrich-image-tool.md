# 计划：enrich 图片生图工具

## 任务 1：补齐图片资产与 Saga 契约（已完成）

- 文件：`src/lib/contracts.ts`、`src/server/wiki/wiki-store.ts`、`src/server/wiki/wiki-transaction.ts`、`src/server/agents/runtime/commit-pending.ts`、`src/app/api/assets/[...path]/route.ts`。
- 内容：支持 base64 asset changeset、路径/大小/MIME 校验、同一 Saga 写入与 subject-scoped 读取。
- 验证：资产校验、事务写入、API 路由单测。

## 任务 2：接入 enrich 图片工具与模型路由（已完成）

- 文件：`src/server/agents/tools/builtin/image-generate.ts`、`src/server/agents/tools/tool-context.ts`、`src/server/agents/runtime/orchestrator.ts`、`examples/skills/ingest-enricher.md`、`llm-config.example.json`。
- 内容：调用 Gemini image response、暂存 asset、把 Markdown 图片引用返回 enrich；checkpoint 恢复时带回 asset entry。
- 验证：skill contract、agent loop 组合路径回归测试、TypeScript 检查。

## 任务 3：运行针对性与全量验证（已完成）

- 命令：`npm run test -- ...`（相关 Vitest 用例）、`npm run lint`、必要时 `npm run build`。
- 检查：工具权限隔离、失败降级、现有 ingest 测试无回归。

验证结果：完整 Vitest `259` 个文件 / `2243` 个用例通过；`npm run lint` 通过（仅仓库既存 warning）；`npx tsc --noEmit` 仍受既有 `reenrich-service.test.ts:140` 参数签名错误阻断。

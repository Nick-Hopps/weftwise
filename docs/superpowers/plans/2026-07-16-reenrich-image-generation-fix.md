# Re-enrich 图片生成可靠性修复实施计划

## 任务 1：锁定 Unicode 页面身份回归

- 修改：`src/server/agents/tools/builtin/__tests__/image-generate.test.ts`
- 修改：`src/server/agents/runtime/__tests__/agent-loop.test.ts`
- 新增行为：工具输入不含 `pageSlug`；运行时用 `3d图形学基础` 绑定 asset；非页面 agent 不获得生图能力。
- 失败验证：`npm run test -- src/server/agents/tools/builtin/__tests__/image-generate.test.ts src/server/agents/runtime/__tests__/agent-loop.test.ts`

## 任务 2：实现运行时可信身份

- 修改：`src/server/agents/tools/builtin/image-generate.ts`
- 修改：`src/server/agents/tools/tool-context.ts`
- 修改：`src/server/agents/runtime/agent-loop.ts`
- 修改：相关调用点与类型测试。
- 转绿验证：运行任务 1 的测试。

## 任务 3：锁定并实现图片路由预检

- 修改：`src/server/agents/tools/builtin/__tests__/image-generate.test.ts`
- 修改：`src/server/agents/tools/builtin/image-generate.ts`
- 修改：`llm-config.example.json`（保持示例契约）
- 本地配置：`llm-config.json` 增加 `ingest:image` Google Gemini 路由。
- 验证：图片路由纯函数测试；实际解析 `ingest:image` 输出 provider/model。

## 任务 4：强化按需生图决策

- 修改：`examples/skills/ingest-enricher.md`
- 修改：`src/server/agents/skills/__tests__/skill-contracts.test.ts`
- 行为：视觉主题且无解释性位图时至少生成一张；已有位图不重复；流程/关系图继续优先 Mermaid。
- 验证：skill contract 与 loader 测试。

## 任务 5：全链路验证与文档同步

- 修改：`src/server/agents/CLAUDE.md`
- 修改：`src/server/llm/CLAUDE.md`
- 运行：针对性 Vitest。
- 运行：`npm run lint`。
- 运行：`npx tsc --noEmit`。
- 检查：worktree diff、feature commit、主分支 `--no-ff` merge 与清理。

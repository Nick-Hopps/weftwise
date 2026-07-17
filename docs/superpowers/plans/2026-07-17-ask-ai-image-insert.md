# Ask AI 选区配图插入实施计划

**目标：** 在 canonical 阅读页选中完整 Markdown 块后，通过 Ask AI PendingAction 批准并启动单图生成，最终把图片资产与正文引用原子提交。

**设计：** `docs/superpowers/specs/2026-07-17-ask-ai-image-insert-design.md`  
**分支：** `feat/ask-ai-image-insert`  
**Worktree：** `.worktrees/ask-ai-image-insert`

## Task 1：结构化选区与块级源位置

涉及文件：

- `src/lib/contracts.ts`
- `src/lib/markdown-client.ts`
- `src/lib/selection-text.ts`
- `src/hooks/use-text-selection.ts`
- `src/components/wiki/page-renderer.tsx`
- `src/components/wiki/selection-ask-button.tsx`
- `src/components/wiki/wiki-reading-view.tsx`
- `src/stores/ui-store.ts`
- `src/components/chat/chat-interface.tsx`
- 对应 `__tests__`

步骤：

1. 先写失败测试：Markdown 渲染为每个可见顶层块输出 start/end offset；选区能组合单块和跨块范围。
2. 新增共享 `SelectionAnchorInput` 与 source kind 契约。
3. 在 `renderMarkdown` 增加可选 selection block 标记插件，只由阅读页启用。
4. `useTextSelection` 读取 Range 两端所属顶层块，输出块范围。
5. ui-store 信箱与 Chat `Passage` 保留结构化 selection；发送请求时把它放到独立 `selection` body 字段。
6. `WikiReadingView` 给 canonical/reshape 选区标记真实 source kind。
7. 验证：

```bash
npx vitest run src/lib/__tests__/markdown-client.test.tsx src/lib/__tests__/selection-text.test.ts src/stores/__tests__/ui-store.test.ts
```

完成后提交：`feat: 为 Ask AI 选区增加 Markdown 块锚点`

## Task 2：服务端锚点解析与 Query 提案工具

涉及文件：

- `src/server/wiki/markdown-block-anchor.ts`
- `src/server/wiki/__tests__/markdown-block-anchor.test.ts`
- `src/server/services/query-intent.ts`
- `src/server/services/query-tools.ts`
- `src/server/services/query-service.ts`
- `src/app/api/query/route.ts`
- `src/server/agents/tools/tool-context.ts`
- `src/server/agents/tools/profiles.ts`
- `src/server/agents/tools/builtin/wiki-image-insert.ts`
- `src/server/agents/tools/builtin/index.ts`
- `src/server/llm/prompts/query-prompt.ts`
- `src/lib/tool-activity.ts`
- 对应测试

步骤：

1. 先写失败测试：顶层块解析覆盖段落、跨块、列表、表格、代码块、callout、offset 移动和重复块歧义。
2. 实现纯函数：验证客户端范围、生成持久化块锚点、在当前正文唯一重定位。
3. 先写失败测试：有 canonical selection 的配图命令进入 propose；Reshape 配图命令确定性拒绝；普通选区问题保持 read。
4. `/api/query` strict 解析可选 selection，并把它绑定到 Query tool context。
5. 新增 `wiki.image.insert` propose builtin；模型输入只含 prompt/alt/ratio/style，slug/anchor 由上下文注入。
6. Query prompt 要求 read current page 后单次提出插图，禁止宣称已生成。
7. tool activity 只展示目标页和视觉请求摘要，不暴露块原文或 offset。
8. 验证：

```bash
npx vitest run src/server/wiki/__tests__/markdown-block-anchor.test.ts src/server/services/__tests__/query-intent.test.ts src/server/agents/tools/__tests__/profiles.test.ts src/server/agents/tools/builtin/__tests__/registry.test.ts src/app/api/query/__tests__/route.test.ts
```

完成后提交：`feat: 接入 Ask AI 选区配图提案工具`

## Task 3：PendingAction 契约、审批与迁移

涉及文件：

- `src/lib/contracts.ts`
- `src/server/services/pending-action-payload.ts`
- `src/server/services/pending-action-service.ts`
- `src/server/services/pending-action-finalizer.ts`
- `src/server/services/workflow-tools.ts`
- `src/server/db/schema.ts`
- `src/server/db/client.ts`
- `drizzle/*`
- PendingAction / migration 对应测试

步骤：

1. 先写失败测试：`workflow-image-insert-start` 预览持久化服务端规范化锚点与 image request，批准前零 job。
2. 扩展 `PendingActionOperation`、workflow input 与 preview 的可选 `imageInsert` 详情。
3. 实现专用 `createPendingImageInsertActionPreview`：页面/meta/sourceKind/锚点校验，保存 preHead 与提示。
4. 批准时重新规划；HEAD/锚点变化沿用 stale preview 或 fail-closed。
5. `finalizeWorkflowStartAction` 支持 `image-insert`，job insert 与 action applied 同一事务。
6. 扩展 schema CHECK 与启动期原子迁移；运行 `npm run db:generate` 生成 Drizzle migration。
7. 验证：

```bash
npx vitest run src/server/services/__tests__/pending-action-payload.test.ts src/server/services/__tests__/pending-action-service-preview.test.ts src/server/services/__tests__/pending-action-service-approval.test.ts src/server/db/__tests__/pending-actions-migration.test.ts
```

完成后提交：`feat: 增加选区配图审批与原子任务启动`

## Task 4：后台生图与 Saga 原子插入

涉及文件：

- `src/server/services/image-insert-service.ts`
- `src/server/services/__tests__/image-insert-service.test.ts`
- `src/server/worker-entry.ts`
- `src/lib/contracts.ts`
- `src/server/wiki/markdown-block-anchor.ts`
- `src/server/agents/tools/builtin/image-generate.ts`（仅复用，必要时抽取安全 helper）
- `src/server/services/embedding-enqueue.ts`

步骤：

1. 先写失败测试：worker 生成一张图片，并在选中顶层块后插入 `[!diagram]`。
2. 先写失败测试：page update 与 base64 asset create 位于同一个 changeset；任一失败零写入。
3. 实现 `image-insert` handler：subject/params 校验、锚点预检、生图、稳定 HEAD 双检、重新定位、单 changeset apply。
4. 生图期间轮询 cancel 并 abort；生成后/apply 前再次检查，取消不得写 vault。
5. 按 jobId 恢复已 applied operation，覆盖 commit 后崩溃重试，不重复生成。
6. 成功后 best-effort 入队 embedding；注册 worker side-effect import。
7. 验证：

```bash
npx vitest run src/server/services/__tests__/image-insert-service.test.ts src/server/wiki/__tests__/wiki-transaction.test.ts src/server/agents/tools/builtin/__tests__/image-generate.test.ts
```

完成后提交：`feat: 原子生成并插入选区配图`

## Task 5：审批详情、任务状态与页面刷新

涉及文件：

- `src/components/chat/pending-action-card.tsx`
- `src/components/chat/__tests__/pending-action-card.test.tsx`
- `src/lib/job-started-event.ts`
- `src/lib/__tests__/job-started-event.test.ts`
- `src/components/shared/jobs-panel.tsx`
- `src/components/shared/__tests__/*`

步骤：

1. 先写失败测试：插图审批卡显示选区摘要、prompt、alt、比例/风格和批准后生成提示。
2. PendingActionCard 增加 `Proposed illustration` 专用信息层级，复用现有按钮与状态。
3. action → job event 映射为 `image-insert`；Tasks 动词显示 `Illustrating`。
4. image-insert 完成时失效页面缓存并 `router.refresh()`；失败/取消沿用现有详情。
5. 验证：

```bash
npx vitest run src/components/chat/__tests__/pending-action-card.test.tsx src/lib/__tests__/job-started-event.test.ts src/components/shared/__tests__/jobs-panel-state.test.ts
```

完成后提交：`feat: 展示选区配图审批与任务状态`

## Task 6：文档同步与最终验证

涉及文件：

- `src/app/CLAUDE.md`
- `src/components/CLAUDE.md`
- `src/lib/CLAUDE.md`
- `src/server/CLAUDE.md`
- `src/server/agents/CLAUDE.md`
- `src/server/db/CLAUDE.md`
- `src/server/jobs/CLAUDE.md`
- `src/server/llm/CLAUDE.md`
- `src/server/services/CLAUDE.md`
- 根 `AGENTS.md`（仅架构索引/测试基线确需更新时）

步骤：

1. 同步选区锚点、Query 工具、PendingAction、job、Saga 与 UI 文档。
2. 运行全部定向测试并记录完整输出与退出码。
3. 运行：

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
git diff --check
git diff -- llm-config.example.json
```

4. 检查 feature diff、提交序列、主工作树与 worktree 落点。
5. 文档同步提交：`docs: 同步 Ask AI 选区配图架构说明`
6. 回到 main：

```bash
git merge --no-ff feat/ask-ai-image-insert -m "merge: 合并 feat/ask-ai-image-insert：支持 Ask AI 选区配图插入"
```

7. 删除 worktree 与分支，确认 main clean 且最终文件、migration、提交均落在目标分支。

## 完成判据

- canonical 选区可生成插图 PendingAction，批准前零图片调用和零页面写入；
- Reshape 配图命令被确定性拒绝，普通问答不受影响；
- 插入位置严格位于最后一个选中顶层 Markdown 块之后；
- 图片资产与正文引用同一 Saga、同一 git commit；
- 取消、锚点失效、模型失败和 stale HEAD 不产生孤立资产或正文修改；
- Query 不持有 `image.generate` 或任何真实页面写能力；
- Tasks 展示、页面完成刷新和错误详情完整；
- 全量测试、TypeScript、lint、build 通过；
- `llm-config.example.json` 无差异；
- 以单 feature 分支和 `--no-ff` merge commit 合回 main，worktree/分支已清理。

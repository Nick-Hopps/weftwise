# 正文插图展示优化实施计划

**目标：** 移除选区配图的空 `[!diagram]` 包装，并为阅读页正文图片提供不打断阅读的统一尺寸约束。

**设计：** `docs/specs/2026-07-20-body-image-layout.md`
**分支：** `feat/body-image-layout`
**Worktree：** `.worktrees/body-image-layout`

## Task 1：锁定标准图片插入格式

涉及文件：

- `src/server/services/image-insert-service.ts`
- `src/server/services/__tests__/image-insert-service.test.ts`

步骤：

1. 把纯函数与 job 测试改为期望标准 Markdown 图片，确认测试因旧 `[!diagram]` 输出失败。
2. 将纯函数更名为 `insertImageAfterAnchor`，只插入 `![alt](url)`。
3. 保持锚点定位、换行、alt 转义、Changeset、恢复与取消语义不变。
4. 运行：

```bash
npx vitest run src/server/services/__tests__/image-insert-service.test.ts
```

完成后提交：`fix: 移除正文插图的空 diagram 标记`

## Task 2：约束阅读页正文图片尺寸

涉及文件：

- `src/components/wiki/page-renderer.tsx`
- `src/components/wiki/__tests__/page-renderer.test.tsx`

步骤：

1. 先写失败测试，断言阅读页正文图片具有居中、等比缩放、最大宽度和最大视口高度样式。
2. 为 `PageRenderer` 的正文图片增加统一 Tailwind descendant 样式，不影响 Mermaid 与其他渲染表面。
3. 运行：

```bash
npx vitest run src/components/wiki/__tests__/page-renderer.test.tsx src/lib/__tests__/markdown-client.test.ts
```

完成后提交：`fix: 优化阅读页正文图片尺寸`

## Task 3：文档同步与最终验证

涉及文件：

- `src/components/CLAUDE.md`
- `src/server/services/CLAUDE.md`

步骤：

1. 同步插图 Markdown 格式与阅读页图片排版约束。
2. 提交文档：`docs: 同步正文插图展示说明`
3. 运行：

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

4. 检查 worktree、分支、提交序列和最终 diff；完成后提醒是否使用 `--no-ff` 回合主分支并清理 worktree。

# 编辑模式性能与白屏修复实现计划

## Task 1：锁定轻量编辑器契约

**文件：**

- 新增 `src/components/wiki/__tests__/md-editor.test.ts`
- 修改 `src/components/wiki/md-editor.tsx`

**步骤：**

1. 用 `vi.mock` 替换 `next/dynamic` 和 UI store，捕获动态 loader/options 与传给编辑器的 props。
2. 写失败测试，要求默认 `preview="edit"`、`highlightEnable={false}`。
3. 写失败测试，要求 loader 使用 `@uiw/react-md-editor/nohighlight`，且动态加载提供非空状态占位。
4. 运行 `npm test -- --run src/components/wiki/__tests__/md-editor.test.ts`，确认测试因现有 `live` / 默认高亮 / 无 fallback 失败。

## Task 2：实施编辑优先与按需预览

**文件：**

- 修改 `src/components/wiki/md-editor.tsx`
- 新增 `src/components/wiki/deferred-editor-preview.tsx`
- 修改 `src/components/wiki/page-editor.tsx`
- 修改 `src/components/CLAUDE.md`

**步骤：**

1. 动态 import 改为 `nohighlight`，增加全高 loading fallback。
2. 默认使用 edit 模式并关闭全文 syntax highlight。
3. 新增 400ms 延迟预览组件，保证 textarea 与保存值不延迟。
4. `page-editor` 的自定义 preview 改为延迟组件。
5. 更新组件架构文档，记录编辑优先、按需预览和性能边界。
6. 重跑 Task 1 测试转绿，再运行相关 wiki 组件测试。

## Task 3：真实浏览器与完整验证

**验证命令：**

- `npm test -- --run src/components/wiki/__tests__/md-editor.test.ts`
- `npm test -- --run src/components/wiki/__tests__`
- `npm test`
- `npm run lint`
- `npm run build`

**浏览器回归：**

1. 在隔离 worktree 启动 Next.js。
2. 打开中等页与最大页编辑路由，确认 textarea 存在、默认 preview DOM 不存在、控制台无错误。
3. 记录初始资源，确认未加载 Mermaid chunk。
4. 点击 Live，确认预览出现且 Mermaid 仅此时按需加载。
5. 连续输入字符，确认输入即时、预览延迟合并更新、Save 启用。
6. 截图保存到 `output/playwright/` 作为本轮验证证据（不提交）。


# 正文固定目录实现计划

## 范围

实现阅读页正文目录，包括 Markdown 标题锚点、当前章节跟踪、宽/窄内容区自适应展示，以及普通阅读和 Sources 分栏两种滚动模式。

## 任务 1：建立标题目录模型与锚点合同

涉及文件：

- `src/lib/article-toc.ts`
- `src/lib/__tests__/article-toc.test.ts`
- `src/lib/markdown-client.ts`
- `src/lib/__tests__/markdown-client.test.ts`

步骤：

1. 先写失败测试，覆盖二至四级筛选、格式化文本、中文、重复标题和空标题兜底。
2. 用 `remark-parse` AST 实现目录提取和唯一 ID 分配。
3. 先写失败测试，证明只有显式开启时渲染标题 ID，且 ID 与目录模型一致。
4. 为 `renderMarkdown()` 增加 `headingAnchors` 选项并转绿。

验证：

```bash
npx vitest run src/lib/__tests__/article-toc.test.ts src/lib/__tests__/markdown-client.test.ts
```

## 任务 2：实现目录交互组件

涉及文件：

- `src/components/wiki/article-toc.tsx`
- `src/components/wiki/__tests__/article-toc.test.ts`

步骤：

1. 先为当前章节判定纯函数写失败测试，覆盖页首、章节之间和文末。
2. 实现滚动容器监听、active heading 更新、平滑跳转和 hash 更新。
3. 实现宽内容区粘性目录与窄内容区粘性入口/浮层，两者复用同一交互状态。
4. 补齐键盘、Escape、外部点击和 ARIA 状态。

验证：

```bash
npx vitest run src/components/wiki/__tests__/article-toc.test.ts
```

## 任务 3：接入 Wiki 阅读页

涉及文件：

- `src/components/wiki/page-renderer.tsx`
- `src/components/wiki/wiki-reading-view.tsx`
- `src/app/globals.css`
- `src/components/CLAUDE.md`

步骤：

1. `PageRenderer` 显式开启正文 heading anchors，并为标题设置跳转安全偏移。
2. `WikiReadingView` 从当前展示内容生成目录；原文/Reshape 切换时同步替换。
3. 让普通阅读使用 `#main-content`、Sources 分栏使用左侧正文容器作为目录观测上下文。
4. 用 CSS container query 决定常驻侧栏与紧凑入口，不依赖整个 viewport 宽度。
5. 更新组件导航文档。

验证：

```bash
npx vitest run src/lib/__tests__/article-toc.test.ts src/lib/__tests__/markdown-client.test.ts src/components/wiki/__tests__/article-toc.test.ts src/components/wiki/__tests__/reading-progress.test.ts
npm run lint
npm run build
```

## 任务 4：真实页面验证

场景：

- 宽桌面普通阅读：目录常驻、滚动高亮、点击跳转、Context 开关后不重叠。
- 窄桌面/移动端：紧凑入口保持可达，展开层不遮挡或溢出屏幕。
- Sources 分栏：目录退化为紧凑入口，点击在左栏内滚动，右栏不受影响。
- 重复中文标题和 Reshape 切换：锚点唯一、目录即时更新。

验证方式：启动开发服务器后使用 Playwright 截图和交互检查，同时确认浏览器控制台无错误。

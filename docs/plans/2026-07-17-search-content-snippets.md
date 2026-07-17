# 搜索正文片段实现计划

## 范围

修复 FTS 正文片段选择，并在全局命令面板中安全、高亮地展示最多两行命中上下文。

## 任务 1：锁定正文片段契约

涉及文件：

- `src/server/db/repos/__tests__/pages-repo-invariants.test.ts`
- `src/server/db/repos/pages-repo.ts`

步骤：

1. 先写失败测试，构造标题不含查询词、正文包含查询词的页面。
2. 断言 snippet 来自正文、包含命中词和受控高亮标记，并且不退化为标题。
3. 把 FTS `snippet()` 目标列切换为正文列，使测试转绿。

验证：

```bash
npx vitest run src/server/db/repos/__tests__/pages-repo-invariants.test.ts
```

## 任务 2：实现安全高亮与两行展示

涉及文件：

- `src/lib/search-snippet.ts`
- `src/lib/__tests__/search-snippet.test.ts`
- `src/components/search/command-palette.tsx`
- `src/components/CLAUDE.md`

步骤：

1. 先写失败测试，覆盖普通文本、多个命中、任意 HTML、未闭合标记和空片段。
2. 实现只解析受控 `<mark>` 定界符的纯函数。
3. 命令面板用 React 文本节点和 `<mark>` 节点渲染片段，不使用 HTML 注入。
4. 片段调整为最多两行，并保持图标、标题和箭头的稳定布局。
5. 更新组件导航文档。

验证：

```bash
npx vitest run src/lib/__tests__/search-snippet.test.ts
```

## 任务 3：集成与真实界面验证

场景：

- 搜索正文独有词：显示对应正文上下文并高亮命中词。
- 搜索含多处命中词：片段可扫描且不显示原始标记。
- 窄屏：结果片段限制两行，标题、文件图标和跳转箭头不重叠。
- 键盘上下选择、Enter 跳转和 Escape 关闭保持可用。

验证：

```bash
npx vitest run src/server/db/repos/__tests__/pages-repo-invariants.test.ts src/lib/__tests__/search-snippet.test.ts
npm test -- --run
npx tsc --noEmit
npm run lint
npm run build
```

启动开发服务器后使用真实浏览器检查桌面与移动视口，并确认控制台无错误。

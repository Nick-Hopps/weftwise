# 阅读偏好、Diagram 预览与 Usage 项目过滤实现计划

## 任务 1：页面默认版本记忆

涉及文件：

- 新增 `src/lib/page-view-preference.ts`
- 新增 `src/lib/__tests__/page-view-preference.test.ts`
- 修改 `src/components/wiki/wiki-reading-view.tsx`

步骤：

1. 先写失败测试，覆盖 subject/page 隔离、非法值回退、存储异常降级。
2. 实现 `canonical | reshape` 偏好读写边界。
3. 阅读页加载偏好并在原文/Reshape 切换时持久化；换页时读取目标页偏好。

验证：

```bash
npx vitest run src/lib/__tests__/page-view-preference.test.ts src/hooks/__tests__/use-lens-state.test.ts src/components/wiki/__tests__/page-actions-reshape.test.ts
```

## 任务 2：Diagram 全屏预览

涉及文件：

- 修改 `src/components/wiki/mermaid-diagram.tsx`
- 新增 `src/components/wiki/mermaid-preview.tsx`
- 新增 `src/components/wiki/__tests__/mermaid-preview.test.ts`
- 修改 `src/app/globals.css`
- 修改 `src/lib/i18n/messages/{en,zh-CN}.ts`

步骤：

1. 先写失败测试，锁定 50%–200% 的缩放纯逻辑和预览 UI 结构。
2. 抽出可复用 Mermaid SVG 渲染宿主，正文成功后显示预览入口。
3. 用 portal 实现全屏预览，支持缩放/复位/关闭、Esc、遮罩关闭与 body 滚动锁。
4. 调整 SVG 样式，使正文继续按宽度适配，预览使用自然宽度并可滚动。

验证：

```bash
npx vitest run src/components/wiki/__tests__/mermaid-preview.test.ts src/components/wiki/__tests__/mermaid-theme.test.ts src/components/wiki/__tests__/page-renderer.test.ts
```

## 任务 3：Usage 项目归因与过滤

涉及文件：

- 修改 `src/server/db/schema.ts`
- 新增 Drizzle migration 与 snapshot
- 修改 `src/server/db/repos/usage-repo.ts`
- 修改所有 Usage 记录入口及其调用方
- 修改 `src/app/api/usage/route.ts`
- 修改 `src/components/layout/settings-content.tsx`
- 修改 `src/lib/contracts.ts`
- 修改 `src/lib/i18n/messages/{en,zh-CN}.ts`
- 扩展 Usage repo、provider registry、agent loop、image tool 与设置 UI 测试

步骤：

1. 先扩展真实 SQLite repo 测试，要求记录 `subjectId` 并支持时间+项目组合过滤，确认红灯。
2. 扩展 schema/repo 并生成单一迁移；旧行保持未归因。
3. 从 AgentContext、各 service 的 Subject 参数、Query/Reshape、Embedding 和 image 工具显式传递 `subjectId`。
4. 扩展 Usage API 的 `subjectId` 校验与查询参数。
5. 设置页加载项目列表，增加 All projects/单项目下拉；query key 与 URL 同时包含筛选值。

验证：

```bash
npx vitest run src/server/db/repos/__tests__/usage-repo.test.ts src/server/llm/__tests__/provider-registry-usage.test.ts src/server/agents/runtime/__tests__/agent-loop-usage.test.ts src/server/agents/tools/builtin/__tests__/image-generate.test.ts src/components/layout/__tests__/settings-content.test.ts
```

## 任务 4：文档、回归与提交

涉及文件：

- 修改 `AGENTS.md`、`src/components/CLAUDE.md`、`src/server/db/CLAUDE.md`、`src/app/CLAUDE.md`

步骤：

1. 同步模块导航、API/数据表说明与测试数。
2. 审查 `git diff --check`、迁移内容和所有调用点，确认没有未归因的已知 subject 调用。
3. 运行全量验证并记录完整输出与退出码。
4. 按任务最小提交；文档与实现形成 `docs:` / `feat:` 提交组。

验证：

```bash
npm test
npm run lint
npm run build
git diff --check
git status --short
```

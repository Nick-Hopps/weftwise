# 中英双语国际化实现计划

## 基线与范围

- 基线分支：`main`（`6ba185e`）
- 特性分支：`feat/i18n-zh-en`
- worktree：`.worktrees/i18n-zh-en`
- 设计文档：`docs/specs/2026-07-20-zh-en-internationalization.md`
- 范围：产品 UI 中英双语、浏览器级语言偏好、服务端/客户端一致格式化；不翻译知识内容

## Task 1：提交设计与计划

涉及文件：

- `docs/specs/2026-07-20-zh-en-internationalization.md`
- `docs/plans/2026-07-20-zh-en-internationalization.md`

验证：

```bash
git diff --check
```

提交：`docs: 设计中英双语国际化支持`

## Task 2：以 TDD 建立 locale 与消息运行时

涉及文件：

- `src/lib/i18n/config.ts`
- `src/lib/i18n/messages/en.ts`
- `src/lib/i18n/messages/zh-CN.ts`
- `src/lib/i18n/translator.ts`
- `src/lib/i18n/server.ts`
- `src/lib/i18n/__tests__/i18n.test.ts`
- `src/components/i18n-provider.tsx`
- `src/components/providers.tsx`
- `src/app/layout.tsx`

步骤：

1. 先写 locale cookie / `Accept-Language` 优先级、别名归一、消息键与占位符一致、参数插值和格式化的失败测试。
2. 运行测试并确认因模块尚不存在或行为未实现而失败。
3. 最小实现纯函数 locale 解析、完整双语字典契约、客户端 Provider 和服务端 helper。
4. 根布局接入服务端 locale、localized metadata 与 `<html lang>`。

验证：

```bash
npx vitest run src/lib/i18n/__tests__/i18n.test.ts
npx tsc --noEmit
```

提交：`feat: 建立中英双语国际化运行时`

## Task 3：迁移应用骨架、设置与 Subject 界面

涉及文件：

- `src/components/layout/{header,sidebar,shell,settings-dialog,settings-nav,settings-content,settings-categories,settings-rows}.tsx`
- `src/components/layout/{subject-switcher,context-panel,context-panel-sheet,context-panel-context-tab}.tsx`
- `src/components/search/command-palette.tsx`
- `src/components/subjects/*.tsx`
- `src/app/(app)/subjects/page.tsx`
- 对应纯逻辑测试与消息字典

步骤：

1. 为设置分类的 localized view model 和语言切换行为补失败测试。
2. 在 General / 通用设置增加界面语言选择，并保留独立的内容语言设置。
3. 将应用骨架、导航、Subject 与搜索的可见文案及无障碍标签迁入字典。

验证：

```bash
npx vitest run src/components/layout/__tests__ src/lib/i18n/__tests__
npx tsc --noEmit
```

提交：`feat: 国际化应用骨架与设置界面`

## Task 4：迁移 Wiki、Ask AI 与任务反馈

涉及文件：

- `src/components/wiki/**`
- `src/components/chat/**`
- `src/components/shared/**`
- `src/components/layout/{ask-ai-floating-panel,context-panel-chat-tab,ingest-pill}.tsx`
- 对应测试与消息字典

步骤：

1. 将阅读、编辑、Reshape、对话、审批、任务状态与错误外壳文案迁入字典。
2. 保留 Wiki 内容、LLM 回答、任务日志和后端原始错误原文。
3. 运行现有相关行为测试，确认状态机与业务契约未变化。

验证：

```bash
npx vitest run src/components/wiki/__tests__ src/components/chat/__tests__ src/components/shared/__tests__
npx tsc --noEmit
```

提交：`feat: 国际化阅读对话与任务界面`

## Task 5：迁移 Dashboard、Ingest 与运维工作区

涉及文件：

- `src/app/(app)/**`
- `src/components/{health,tags,history,graph}/**`
- `src/components/error-boundary.tsx`
- 对应测试与消息字典

步骤：

1. 迁移 Dashboard、Ingest、Source 与 Server Component 页面文案。
2. 迁移 Health、Tags、History、Graph 的标题、筛选、状态、动作与日期格式。
3. 将日期和数字改为显式使用当前 locale，去除固定 `en-US` 与环境隐式 locale。

验证：

```bash
npx vitest run src/components/health/__tests__ src/components/tags/__tests__ src/components/graph/__tests__
npx tsc --noEmit
```

提交：`feat: 国际化采集与知识运维界面`

## Task 6：覆盖审计、真实 UI 冒烟与全量验证

步骤：

1. 扫描产品目录中残留的用户可见硬编码文案，逐项判断迁移或明确列入非翻译范围。
2. 分别以 `en`、`zh-CN` 渲染 Dashboard、Settings、Wiki、Ingest、Health，检查首屏、切换、刷新持久化与控制台错误。
3. 执行全量验证并检查特性分支相对基线的完整 diff。

验证：

```bash
npx tsc --noEmit
npm test
npm run lint
npm run build
git diff --check
git status --short
```

提交：仅在覆盖审计产生代码修正时，使用 `fix: 补全中英双语界面覆盖`

完成后提醒是否按 `--no-ff` 回合 `main`，并在获得确认后删除 worktree 与特性分支。

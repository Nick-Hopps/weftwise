# 实现计划：产品界面国际化覆盖审计与补全

- 日期：2026-07-20
- 设计稿：[docs/specs/2026-07-20-ui-i18n-coverage-audit.md](../specs/2026-07-20-ui-i18n-coverage-audit.md)

## 任务 1：建立硬编码文案审计契约（TDD）

**涉及文件**：

- `src/lib/i18n/__tests__/ui-coverage.test.ts`
- `src/lib/i18n/__tests__/i18n.test.ts`

**步骤**：

1. 用 TypeScript AST 收集 JSX 直接文本、可见条件/模板字符串与常见可见属性。
2. 显式允许品牌、技术名、键帽和技术错误详情；排除测试文件、路由/CSS/枚举等非渲染字面量。
3. 首次运行并确认测试因当前硬编码界面文案失败，输出按文件和行号排序的审计清单。

**验证**：`npm test -- src/lib/i18n/__tests__/ui-coverage.test.ts src/lib/i18n/__tests__/i18n.test.ts`

## 任务 2：补齐通用、阅读与共享任务界面

**涉及文件**：

- Cognitive Lens、Graph、Wiki 辅助组件与 Dashboard/Wiki route
- `src/components/shared/{jobs-panel-state,jobs-panel,progress-toast}.ts*`
- `src/lib/tool-activity.ts`
- 消息目录及相关测试

**行为**：首次引导、图谱、HTML 安全提示、选区 Ask AI、跨 Subject 缺页提示、metadata、日期与共享任务标题完整响应 locale；agent 持久化日志保持原文。

**验证**：

- `npm test -- src/lib/i18n src/components/graph src/components/shared src/lib/__tests__/tool-activity.test.ts`
- `npx tsc --noEmit`

## 任务 3：补齐 Tags 工作区

**涉及文件**：`src/components/tags/*`、消息目录与 Tags 测试。

**行为**：标签组合模式、数量、日期、Review 说明、治理动作/placeholder/tooltip/错误兜底全部本地化；tag/page 名称保持原文。

**验证**：`npm test -- src/components/tags src/lib/i18n`

## 任务 4：补齐 Health 工作区

**涉及文件**：

- `src/components/health/{health-view,finding-row,research-backlog-section,postcondition-summary}.ts*`
- 对应测试与消息目录

**行为**：范围、指标、finding 类型/严重度/处置、运行状态、Research backlog、postcondition 与客户端兜底本地化；finding 描述和服务端原始错误保持原文。

**验证**：`npm test -- src/components/health src/lib/i18n`

## 任务 5：补齐 Ingest、Source 与零散产品兜底

**涉及文件**：

- `src/app/(app)/_components/{dashboard-ingest-hero,ingest-live-view,ingest-workbench,ingest-task-switcher,source-viewer}.tsx`
- Chat、History、metadata 补漏文件
- 对应测试与消息目录

**行为**：进度阶段、任务状态、输入校验、批量结果、按钮、Source 空态与安全提示完整本地化；来源内容、文件名与 API 原始错误保持原文。

**验证**：`npm test -- src/app/(app)/_components src/components/chat src/components/history src/lib/i18n`

## 任务 6：全仓复扫与完成验证

1. 运行 AST 覆盖测试，确保只剩 spec 允许的固定字面量。
2. 运行 TypeScript、lint、全量测试与 build；基线失败必须在 `main` 对照复现并记录。
3. 启动 worktree 开发服务器，验证英文/简体中文切换和关键页面加载；无浏览器实例时明确记录限制。
4. 审阅 diff、提交落点与 worktree 状态。

**验证**：

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`
- `git diff --check`

## 提交序列

1. `docs: 设计产品界面国际化覆盖审计`
2. `fix: 补齐通用阅读与任务界面国际化`
3. `fix: 补齐 Tags 工作区国际化`
4. `fix: 补齐 Health 工作区国际化`
5. `fix: 补齐 Ingest 与 Source 界面国际化`
6. `fix: 补齐国际化审计盲区`

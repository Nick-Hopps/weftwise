# 产品界面国际化覆盖审计与补全

- 日期：2026-07-20
- 状态：已定稿
- 关联计划：[docs/plans/2026-07-20-ui-i18n-coverage-audit.md](../plans/2026-07-20-ui-i18n-coverage-audit.md)

## 一、背景与问题

应用已建立 `en` / `zh-CN` 类型安全消息目录，但初版迁移主要依赖人工逐页检查。Research 候选弹窗的遗漏证明当前机制只能校验“已加入目录的键是否完整”，不能发现“根本没有接入 `t()` 的界面文案”。

本轮对 `src/app/**/*.tsx`、`src/components/**/*.tsx` 以及向 UI 返回展示文案的纯函数做交叉审计，确认残留集中在以下区域：

1. Health 主工作区、finding 行、Research backlog、postcondition 通知；
2. Tags 目录、组合标签页、Review 队列与治理弹窗；
3. Ingest 工作台、实时进度、任务切换器、Dashboard 采集状态与 Source 查看器；
4. Cognitive Lens 首次引导、Graph 空态/提示、HTML Source 安全提示、选区 Ask AI；
5. Wiki 跨 Subject 缺页提示、页面 metadata、Dashboard 日期/标题；
6. 共享任务标题、少量 Chat/History 产品兜底文案。

## 二、目标与成功标准

**目标**：补齐所有已识别的产品固定界面文案，并增加可重复的源代码覆盖审计，避免后续新增页面再次绕过消息目录。

**成功标准**：

1. 上述区域的标题、按钮、状态、空态、校验错误、辅助说明、placeholder、tooltip、`aria-label`、metadata 与日期格式均响应当前 locale。
2. 枚举状态通过 `Record<DomainEnum, MessageKey>` 或等价穷举映射约束，新增状态时由 TypeScript 提示补翻译。
3. UI 专用纯函数不再直接返回固定英文/中文展示句子；改为返回消息键/结构化数据，或显式接收翻译函数。
4. 英中目录键与具名占位符继续完全一致。
5. 新增源代码审计测试能检测 JSX 文本、可见字符串表达式和常见可见属性中的新硬编码文案；仅允许有明确理由的固定字面量。
6. 定向测试、全量测试、TypeScript、lint 与生产构建按基线约束完成验证。

## 三、国际化边界

### 必须进入消息目录

- 产品按钮、状态、标题、空态、帮助说明；
- 产品生成的错误兜底与客户端输入校验；
- placeholder、tooltip、`aria-label`、页面 metadata；
- 产品生成的日期、数字和计数句子；
- 任务类型标题、Health finding/status/remediation 标签、postcondition 外壳。

### 保持原文

- Wiki/Source/LLM/Research 候选内容、Subject/Tag/Page 名称；
- 服务端和第三方返回的原始错误详情；
- worker/agent 持久化日志文本与 git diff；
- URL、slug、job ID、枚举值、路由、CSS 类；
- `weftwise 织识`、`PDF`、`HTML`、`Markdown` 等品牌/技术名；
- `Esc`、`⌘K` 等真实键帽字符，以及语言选择器中的语言自称。

## 四、方案比较

### 方案 A：补文案 + TypeScript AST 覆盖测试（推荐）

- 继续使用现有消息目录和 `useI18n()` / `getServerI18n()`。
- 测试通过 TypeScript AST 识别直接 JSX 文本、条件表达式返回的可见字符串，以及 `title/label/description/placeholder/aria-label/alt` 等属性。
- 对品牌、技术名和快捷键维护小型显式 allowlist。
- 优点：零新依赖；直接堵住本次遗漏类型；可在现有 Vitest 中执行。
- 缺点：静态分析只能覆盖确定性字面量，复杂间接数据仍需组件测试与人工审计配合。

### 方案 B：只完成本轮人工替换

- 优点：改动最小。
- 缺点：无法阻止下一批组件再次硬编码；Research 弹窗问题会重演。

### 方案 C：引入 `eslint-plugin-i18next`

- 优点：现成规则覆盖广。
- 缺点：增加依赖与 ESLint 配置迁移成本；对路由、枚举、测试数据和技术字面量误报较多，仍需大量规则豁免。

**结论**：采用方案 A。

## 五、实现原则

### 枚举与纯函数

- `jobTypeVerb`、`jobActivityTitle`、Health finding/remediation/status 标签改为返回 `MessageKey`，渲染边界调用 `t()`。
- postcondition formatter 接收 `TranslationFunction`，只对产品外壳翻译；finding 原始描述保持原文。
- Ingest phase 定义保存消息键，不保存英文 label/verb。

### 错误边界

- API 返回的 `data.error` / `Error.message` 原样展示，以保留诊断信息。
- 网络失败、非法响应、空输入等客户端自行生成的兜底进入消息目录。

### 日期与计数

- Client Component 使用 `useI18n().formatDate/formatNumber`。
- Server Component 使用 `getServerI18n()` 返回的 formatter。
- 不继续调用隐式 locale 的 `toLocaleDateString(undefined, ...)`。

## 六、预计落点

| 模块 | 主要文件 |
|------|----------|
| 覆盖审计 | `src/lib/i18n/__tests__/ui-coverage.test.ts` |
| 消息目录 | `src/lib/i18n/messages/{en,zh-CN}.ts` |
| 通用/阅读 | `cognitive-lens-onboarding.tsx`、Graph、Wiki 辅助组件、Dashboard/Wiki route |
| 任务 | `jobs-panel-state.ts`、`jobs-panel.tsx`、`tool-activity.ts`、`progress-toast.tsx` |
| Tags | `src/components/tags/*` |
| Health | `src/components/health/{health-view,finding-row,research-backlog-section,postcondition-summary}.ts*` |
| Ingest/Source | `src/app/(app)/_components/{ingest-live-view,ingest-workbench,ingest-task-switcher,source-viewer}.tsx` |
| 细节补漏 | Chat、History、metadata 与对应测试 |

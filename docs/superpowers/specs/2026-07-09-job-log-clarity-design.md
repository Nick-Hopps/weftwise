# 任务日志可读性改进（fix / curate 工具循环 + lint）— 设计

日期：2026-07-09
状态：待评审

## 问题

当前 fix / curate / lint 任务运行时，`JobDetailDialog` / `ProgressToast` 里的事件日志看不出任务当前在做什么：

1. **fix 阶段2 / curate（tool-loop）**：`generateTextWithTools`（`src/server/llm/provider-registry.ts`）没有逐步回调。只有写工具命中 guard 时才 emit（`fix:page`、`curate:merge` 等）；模型调 `wiki.read` / `wiki.search` / `wiki.list` 读页的整个过程零事件，循环跑几分钟日志一片空白。对比 ingest 走 agent-loop 有 `onToolCall → agent:step`，体验差距明显。
2. **lint**：semantic 阶段是把全库页面一次性喂给单次 `generateStructuredOutput`，开始事件（`lint:semantic:start`）不含页数/模型等上下文，结束事件不含 findings 分类统计，用户既不知道这次扫了多少页、也不知道要等多久、结束后要点进 Health 页才知道结果概貌。

## 目标与非目标

**目标**：
- fix / curate 工具循环期间，每次工具调用（含只读）都产生一条人类可读的日志事件。
- lint semantic 阶段的开始/结束事件补充上下文（页数、模型标签、分类统计），不改调用结构。

**非目标**：
- 不把 lint semantic 改成分批扫描（contradiction / crossref 需要全局视野，且用户已确认只补上下文）。
- 不动 ingest / re-enrich / research / query 的事件体系。
- 不改 DB schema、API、prompt、工具行为本身。

## 方案选择

选定 **方案 A：`generateTextWithTools` 加 `onToolCall` 回调**。

- 在 `generateText` 调用上挂 AI SDK 的 `onStepFinish`（每步结束回传该步 `toolCalls`），透传为可选回调。单点改动，与 `agent-loop.ts` 既有的 `onToolCall → agent:step` 模式对齐；不传回调的调用方（如 save-as-page）零影响。
- 否决方案 B（在工具定义层包装 emit）：只读工具来自共享 registry，query 也在用，包装会污染共享定义或到处复制。
- 否决方案 C（换 `streamTextWithTools` 流式消费）：该入口不支持 `shouldCancel`，取消信号会丢，改造面大而收益与 A 相近。

## 设计

### 1. `provider-registry.ts::generateTextWithTools`

opts 新增：

```ts
/** 每步结束时对该步每个 tool call 回调一次；回调抛错被吞掉，不影响主流程。 */
onToolCall?: (info: { tool: string; args: unknown }) => void;
```

实现：`generateText` 参数加 `onStepFinish: (step) => { for (const tc of step.toolCalls) { try { opts.onToolCall?.({ tool: tc.toolName, args: tc.input }) } catch { /* swallow */ } } }`。

工具名此时已是下划线形式（`compile.ts:18` 把 `wiki.read` 归一化为 `wiki_read`），与 `src/lib/tool-activity.ts` 的映射键一致。

### 2. 共享文案辅助

`src/lib/tool-activity.ts` 新增纯函数：

```ts
/** 组装单行日志文案，如 `📄 Reading "some-page"…`。 */
export function toolActivityLine(tool: string, args: unknown): string
```

= `icon + verb + summarizeToolArgs`（三个既有函数拼装）。chat UI 不改（它自己排版），仅 job 日志用。

### 3. `fix-service.ts`

- 阶段2 进入 tool-loop 前 emit `fix:agent:start`：`Analyzing N finding(s) across M page(s) with the model…`（N=语义 findings 数，M=roster 页数）。
- `generateTextWithTools('fix', { ..., onToolCall: (info) => emit('fix:tool', toolActivityLine(info.tool, info.args), { tool: info.tool }) })`。

### 4. `curate-service.ts`

- tool-loop 前 emit `curate:agent:start`：`Reviewing N candidate page(s) (mode: auto|manual, caps: merge≤5 split≤5 delete≤5 create≤5)…`。
- 同样传 `onToolCall` → emit `curate:tool`。

### 5. `lint-service.ts`

- `lint:semantic:start` message 改为含上下文：`Subject "x": running LLM semantic analysis on N page(s) with <logLabel> (single pass, may take a few minutes)…`；模型标签经 `resolveTask('lint').logLabel` 获取（try/catch，解析失败回落省略模型名）。
- `lint:semantic:done` / `lint:complete` 补分类统计：message 追加如 `(2 critical, 5 warning, 3 info; broken-link×4, contradiction×2, …)`，data 带 `{ bySeverity, byType }`。统计聚合写成导出的纯函数 `summarizeFindings(findings)` 放在 `lint-service.ts` 内（既有 `groupBySeverity` 在 `src/components/health/lint-findings.ts` 客户端目录，server 不反向依赖 components，故不复用）。

### 6. 前端 `use-job-stream.ts`

事件类型白名单补注册：`fix:agent:start`、`fix:tool`、`curate:agent:start`、`curate:tool`。日志行文案由服务端 message 直出，`JobDetailDialog` / `ProgressToast` 自动受益，无其他前端改动。

## 错误处理

- `onToolCall` 回调内部异常吞掉（try/catch），绝不影响 LLM 循环。
- `resolveTask('lint')` 解析失败（配置缺失）不抛给 lint 主流程，回落省略模型名。

## 事件量评估

每个 tool-loop 步至多几条事件，`maxSteps` 有界（fix/curate 各有常量上限），`pruneOldJobEvents` 已有清理机制，无膨胀风险。

## 测试

- `provider-registry` 单测：mock `generateText`，断言 `onStepFinish` 触发时 `onToolCall` 按 toolCalls 逐个回调、回调抛错不冒泡、不传回调不报错。
- `tool-activity` 单测：`toolActivityLine` 各工具文案。
- `lint-service` 既有测试更新：semantic start/done 事件 message/data 断言。
- fix/curate service：emit 断言（若既有测试结构允许，补 `fix:tool` / `curate:agent:start` 触发断言）。

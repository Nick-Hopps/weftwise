[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **llm**

# `src/server/llm/` — 多供应商 LLM 抽象

## 模块职责

在 Vercel AI SDK 的基础上，提供**按任务路由 + 多供应商 profile** 的统一入口，支持：

- 8 种供应商（Anthropic / OpenAI / Google / DeepSeek / Mistral / xAI / Ollama / OpenAI-compatible）。
- 内置任务 —— `query` / `lint` / `merge` / `split` / `curate` / `fix` / `embedding` —— 每类可单独指定模型、温度、超时、provider options 等；多阶段流水线（ingest）按 `ingest:<stage>` 逐阶段路由。
- 结构化输出（`generateObject` + Zod schema）与流式文本（`streamText`）。

### 全部已知 task（`llm-config.json::tasks` 可路由的 key）

`tasks` 是扁平 `z.record`，key 分两类。`resolveTask` / `resolveSkillModel` 均**只读完全匹配的顶层 key**（无前缀回退；多阶段流水线的某阶段用 `<pipeline>:<stage>`，由 agent-loop 从 skill id 派生）。

| 类别 | task key | 用途 |
|------|----------|------|
| 内置 | `query` | Ask AI 工具循环问答 + 引用 |
| 内置 | `lint` | 体检：扫全库 findings |
| 内置 | `merge` | 融合两页（由 `wiki/page-ops.ts` 内部调用，非独立 job） |
| 内置 | `split` | 拆一页为多页（由 `wiki/page-ops.ts` 内部调用，非独立 job） |
| 内置 | `curate` | agent 策展：tool-loop（模型自驱读页后调 wiki.merge/split/delete/create） |
| 内置 | `fix` | 体检修复：逐页修 lint findings |
| 内置 | `embedding` | 向量嵌入（仅 openai / openai-compatible / ollama 供应商） |
| 阶段 | `ingest:planner` | ingest：规划页面切分 |
| 阶段 | `ingest:chunk-summarizer` | ingest：大文件分片摘要（map 阶段） |
| 阶段 | `ingest:writer` | ingest：写/并入页面正文（fanout 阶段） |
| 阶段 | `ingest:enricher` | ingest：叠加 callout 增益层 |
| 阶段 | `ingest:verifier` | ingest：参数化自检（联网核查降级回落） |
| 阶段 | `ingest:verifier-triage` | ingest：联网核查 triage（挑存疑断言+query） |
| 阶段 | `ingest:verifier-apply` | ingest：联网核查 apply（证据驱动改 callout） |

> **没有 `ingest` 这个整体 task**——multi-agent 重构后流水线按 `ingest:<stage>` 逐阶段路由（由 `agent-loop::skillTaskKey(skill.id)` 把 skill id `ingest-<stage>` 的首个连字符换冒号派生；id/文件名仍用连字符，冒号只在路由 key）。`<pipeline>:<stage>` 是**开放命名空间**（schema 正则 `^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$`），上表 8 个 ingest 阶段是 `examples/skills/` 的种子 skill。每个阶段的 task 配置**可选**：缺省则继承 `defaults`，skill frontmatter 可再覆盖（合并序 `defaults < tasks['<pipeline>:<stage>'] < frontmatter`）。`llm-config.example.json` 把 8 个阶段全列出作参考，并演示按阶段分层路由（机械阶段如 summarizer / triage / indexer 走便宜模型，重推理阶段走强模型）。

## 入口与启动

- 配置加载：`config-loader.ts::getLLMConfig()`（读 `llm-config.json`，无则使用默认）。
- 语言模型工厂：`provider-factory.ts::getLanguageModel(route)`。
- 任务解析：`task-router.ts::resolveTask(task, overrides?)` —— **合并顺序 defaults < task < call-site override**。

## 对外接口

### `provider-registry.ts`

```ts
generateStructuredOutput<T>(
  task: LLMTask,
  schema: ZodType<T>,
  systemPrompt: string,
  userPrompt: string,
  overrides?: LLMRouteOverride,
): Promise<T>

streamTextResponse(task, systemPrompt, userPrompt, overrides?): StreamTextResult

streamTextWithTools(task, opts: { system, messages, tools, maxSteps, abortSignal? }): StreamTextResult

generateTextWithTools(task, opts: { system, messages, tools, maxSteps, shouldCancel?, onToolCall? }): Promise<{ text: string }>
// shouldCancel?: () => boolean — 传入时每 2s 轮询一次，为真则 abort 并抛出 AgentCancelled（复用 agents/runtime/agent-loop.ts）；不传则零开销、行为不变。curate/fix 传 () => queue.isCancelRequested(jobId)。
// onToolCall?: (info: { tool: string; args: unknown }) => void — 经 `onStepFinish` 在每次工具调用落地时同步触发（每个 toolCall 一次），供调用方（fix/curate service）emit 可读的任务日志事件；不传则零开销、行为不变。

generateEmbeddings(texts: string[]): Promise<number[][]>

isEmbeddingConfigured(): boolean

embeddingModelId(): string
```

`streamTextWithTools` / `generateTextWithTools` 是工具循环版入口（供 query agentic 问答使用）：
- 接受 `tools`（AI SDK `Tool` 字典）与 `maxSteps` 最大步数；
- 底层调 AI SDK `streamText` / `generateText`（`{tools, maxSteps}` 参数）；
- 同样自带超时 AbortController + 统一日志。

前两个（非工具循环）自带：
- AbortController 超时（`route.timeoutMs`，默认 8 分钟）。
- 统一日志前缀 `[LLM][Task: ...][Model: ...]`。
- 错误上下文补全（`usage` / `finishReason` / `cause`）。

后三个（向量模型，⑧）：
- `generateEmbeddings` — embedMany 包装，支持 openai / openai-compatible / ollama；其余供应商抛 `LLMConfigError`。
- `isEmbeddingConfigured` — 检查 `tasks.embedding.model` 是否配置，不配置 false（允许优雅降级）。
- `embeddingModelId` — 返回配置的嵌入模型名（不配置时抛 `LLMConfigError`）。

### `task-router.ts` / `provider-factory.ts`

```ts
resolveTask(task, overrides?) → ResolvedTaskRoute

getLanguageModel(route: ResolvedTaskRoute) → LanguageModel

getEmbeddingModel(route: ResolvedTaskRoute) → LanguageModel  // ⑧ 向量模型工厂
```

`ResolvedTaskRoute` 同时包含 AI SDK 的 `CallSettings`（`maxTokens` / `temperature` / `topP` / ...）和应用级字段（`timeoutMs` / `logLabel`）。
`getEmbeddingModel` 路由 embedding task 到相应 provider 的向量模型（openai / openai-compatible / ollama；其余 provider 直接抛错）。

### `config-schema.ts`

用 zod 定义的：
- `LLMTaskSchema`（内置 `query|lint|merge|split|curate|fix|embedding` 枚举 + 开放 `<pipeline>:<stage>` 形式）、`LLMProviderKindSchema`（8 种 provider）。
- 每种 provider 的 discriminated union（`AnthropicProfileSchema` / ... / `OpenAICompatibleProfileSchema`）。
- `LLMRouteOverride`（可在单次调用处覆盖路由）。
- `tasks` key space 支持 `embedding` 内置任务与 `<pipeline>:<stage>` 阶段任务（⑧ 向量）。

### `prompts/`

每个任务一个文件，每个文件导出：

- `*_SYSTEM_PROMPT` 常量；
- `build*UserPrompt(...)` 函数；
- `*Schema`（Zod）—— LLM 必须严格吐出该结构。

| 文件 | 用途 |
|------|------|
| `ingest-prompt.ts` | **多阶段**：plan → page body → index body。对应 `IngestPlanSchema / PageBodySchema / IndexBodySchema` |
| `query-prompt.ts` | 回答用户问题 + 引用；`buildQueryUserPrompt` 加可选 history 参注入多轮 transcript。`QueryResponseSchema`。**agentic 工具循环新增**：`QUERY_AGENTIC_SYSTEM_PROMPT`（指示模型使用工具自驱检索，不预载上下文；**CITE INLINE 纪律**——要求模型在每条基于 wiki 内容的陈述后内联标注支撑页的精确 slug `[[slug]]`，未标注视为无引用，引用改由服务层流后确定性解析而非模型二次结构化输出）+ `buildAgenticUserContent(question, ctx, opts?)` （构造工具循环用的用户消息，可选 `currentPageSlug` 提示当前页）+ `CoverageSchema`/`COVERAGE_SYSTEM_PROMPT`/`buildCoverageUserPrompt`（独立的 coverage 判定小调用：只喂问题+答案判断本轮回答是否被 wiki 内容充分支撑，与引用生成解耦；退役旧 `generateQueryCitations`/`QueryCitationsSchema` 二次结构化输出 + `[unverified]` 前缀机制）。 |
| `lint-prompt.ts` | 扫描整库/单页的 lint finding。 |
| `merge-prompt.ts` | 融合两页正文与摘要（由 `page-ops.ts` 内部调用，不再是独立 job）。`MergeResultSchema` |
| `split-prompt.ts` | 拆一页成多页（由 `page-ops.ts` 内部调用，不再是独立 job）。`SplitResultSchema` (pages.min(2)，恰一 isPrimary) |
| `curate-prompt.ts` | 🆕 agentic tool-loop 策展 prompt：`CURATE_AGENTIC_SYSTEM_PROMPT`（保守策展系统提示，工具使用规范）+ `buildCurateAgenticUserPrompt(pages, ctx, opts)` builder；退休旧 triage/confirm 三套 schema（`CurateTriageSchema`/`CurateMergeConfirmSchema`/`CurateSplitConfirmSchema`）|
| `fix-prompt.ts` | 🆕 agentic tool-loop 修复 prompt：`FIX_AGENTIC_SYSTEM_PROMPT` + `buildFixAgenticUserPrompt(reportLines, roster, ctx)`（逐页 `FixPageSchema` 三件套已退休） |

### `client.ts` / `errors.ts`

- 低层 wrapper；
- `LLMConfigError`（配置错误）；
- 主要消费者是 `task-router` 和 `provider-factory`。

## 配置文件（`llm-config.json`）

示例结构（参考 `llm-config.example.json`）：

```jsonc
{
  "providers": {
    "primary": { "provider": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" },
    "cheap":   { "provider": "openai",    "apiKeyEnv": "OPENAI_API_KEY" },
    "local":   { "provider": "ollama",    "baseURL": "http://localhost:11434" }
  },
  "defaults": { "profile": "primary", "model": "claude-3-5-sonnet-20241022", "maxTokens": 8192 },
  "tasks": {
    "ingest": { "temperature": 0.2 },
    "query":  { "profile": "cheap", "model": "gpt-4o-mini" },
    "lint":   { "profile": "local", "model": "llama3.1" },
    "embedding": { "profile": "cheap", "model": "text-embedding-3-small" }
  }
}
```

- `llm-config.json` 入 `.gitignore`（含 API key 引用时避免泄漏）。
- 必须提供 `defaults.profile` + `defaults.model`，否则 `resolveTask` 抛 `LLMConfigError`。
- ⑧ `tasks.embedding` 可选（不配置则向量检索 no-op，query 回落纯 FTS）；仅 openai / openai-compatible / ollama 支持（需配置 `textEmbeddingModel`）。

## `PromptContext` & wikiLanguage 注入

`prompts/prompt-context.ts` 导出：
- `interface PromptContext { language: string; subject?: SubjectContextLite }`
- `renderLanguageDirective(language)` — 渲染 `=== OUTPUT LANGUAGE ===` 块

5 个 user prompt builder（plan / pageBody / index / query / lint）签名末参数都是 `ctx: PromptContext`，并在返回字符串顶部插入 `renderLanguageDirective(ctx.language)`。指令明确禁止翻译 slug、`[[wikilink]]` 目标、frontmatter 键、code block —— 否则会破坏 wiki 图。

服务层从 `db/repos/settings-repo::getWikiLanguage()` 读取语言（**不在** `llm-config.json` 里 —— 它是个用户运行时设置，不是 LLM 路由配置）。

## 扩展指南

- **新增 provider**：
  1. 在 `config-schema.ts::LLMProviderKindSchema` 增加字面量；
  2. 增加对应的 `XxxProfileSchema` 并入 discriminated union；
  3. 在 `provider-factory.ts::getLanguageModel` 添加 `case 'xxx'` 分支。
- **新增任务类型**：
  1. 扩展 `LLMTaskSchema`（开放字符串：内置枚举 + `<pipeline>:<stage>` 正则）；
  2. 新建 `prompts/<task>-prompt.ts`；
  3. 在 `llm-config.json::tasks` 给出默认配置；
  4. Service 层调 `generateStructuredOutput('<task>', ...)`。
- **为 ingest 某阶段指定专属模型**：在 `llm-config.json::tasks` 添加 `"ingest:<stage>": { "model": "...", "temperature": 0.1 }`（如 `"ingest:planner"`）。task key 由 `agent-loop::skillTaskKey` 从 skill id 派生（`ingest-planner` → `ingest:planner`），`config.tasks` 为 `z.record`（开放 key），无需改 schema。
- **临时换模型**：调用点传 `overrides: { profile, model, temperature }`，优先级最高。

**Phase 1 新增**：

- `LLMTaskSchema` 接受 `<pipeline>:<stage>` 形式的 key（如 `ingest:planner`），不限于内置枚举值。
- `LLMConfigFile.tasks` 为 `z.record`（开放字典），`llm-config.json` 可直接写任意 `"ingest:xxx"` 节。
- `provider-registry.ts` 新增导出 `resolveModel(route: ResolvedTaskRoute): LanguageModel`，供 `agent-loop.ts` 直接获取模型实例（不经过 `generateStructuredOutput` 包装）。

## 测试与质量

建议优先覆盖：

- `resolveTask`：三层合并顺序、`undefined` 不应 clobber 默认值。
- `config-loader`：`llm-config.json` 缺字段时的错误文案。

## 常见问题 (FAQ)

- **切换供应商会不会出格式问题？**
  所有任务都用 `generateObject` + Zod schema 做"契约化输出"。一个 LLM 若拒绝生成合格 JSON 会在 `AI SDK` 层抛错并被 worker 捕获 → 判定为不可重试。
- **如何本地调试？**
  把 `llm-config.json::defaults.profile` 切到 `"ollama"`，模型换本地可跑的（如 `llama3.1`）。`timeoutMs` 可调到 30 分钟以应对本地推理慢。

## 相关文件清单

```
src/server/llm/
├── client.ts                  # 低层 wrapper
├── config-loader.ts           # 读取并缓存 llm-config.json
├── config-schema.ts           # Zod schema（providers / tasks / overrides）
├── errors.ts                  # LLMConfigError
├── provider-factory.ts        # ResolvedTaskRoute → LanguageModel + getEmbeddingModel（⑧）
├── provider-registry.ts       # generateStructuredOutput / streamTextResponse + generateEmbeddings/isEmbeddingConfigured/embeddingModelId（⑧）
├── task-router.ts             # defaults ← task ← overrides 合并
└── prompts/
    ├── prompt-context.ts      # PromptContext interface + renderLanguageDirective
    ├── ingest-prompt.ts       # 多阶段 plan / page-body / index
    ├── query-prompt.ts        # 用户问答 + 引用
    ├── lint-prompt.ts         # 全库扫查
    ├── merge-prompt.ts        # 融合两页（由 page-ops 调用）
    ├── split-prompt.ts        # 拆分一页（由 page-ops 调用）
    ├── curate-prompt.ts       # agentic tool-loop 策展 prompt（CURATE_AGENTIC_SYSTEM_PROMPT + builder；triage/confirm 已退休）
    └── fix-prompt.ts          # agentic tool-loop 修复 prompt（FIX_AGENTIC_SYSTEM_PROMPT + buildFixAgenticUserPrompt；FixPageSchema 已退休）
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |
| 2026-04-26 | wikiLanguage：新增 `PromptContext` + `renderLanguageDirective`；5 个 user prompt builder 接入 `ctx: PromptContext`；文件清单补 `prompts/prompt-context.ts` |
| 2026-04-27 | LLMTaskSchema 接受 `skill:<id>` key；`config.tasks` 改为 `z.record`（开放字典）；`provider-registry` 导出 `resolveModel` 供 agent-loop 使用 |
| 2026-06-22 | 新增内置 task `merge`（`BUILTIN_LLM_TASKS` 加 'merge'）+ `prompts/merge-prompt.ts`（`MERGE_SYSTEM_PROMPT` / `buildMergeUserPrompt` / `MergeResultSchema`），供合并两页融合正文（④b）|
| 2026-06-22 | 新增内置 task `split` + `prompts/split-prompt.ts`（`SPLIT_SYSTEM_PROMPT` / `buildSplitUserPrompt` / `SplitResultSchema`，`pages.min(2)`、恰一 `isPrimary`），供拆分一页（④c）|
| 2026-06-22 | `query-prompt.ts` buildQueryUserPrompt 加可选 history 参（多轮记忆注入 transcript 段）；供 ⑦ 对话持久化 + 多轮记忆 |
| 2026-06-22 | 新增内置 task `embedding` + `provider-factory.getEmbeddingModel(route)` + `provider-registry.generateEmbeddings/isEmbeddingConfigured/embeddingModelId`（⑧ 向量语义检索）；llm-config `tasks.embedding` 仅 openai-compatible 支持；未配置时向量检索 no-op 回落纯 FTS |
| 2026-06-23 | 新增内置 task `curate`（`BUILTIN_LLM_TASKS` 加 'curate'）+ `prompts/curate-prompt.ts`（`CurateTriageSchema` / `CurateMergeConfirmSchema` / `CurateSplitConfirmSchema` + 对应 system prompt + builder）；`merge`/`split` task 保留（由 `page-ops.ts` 内部调用，不再对应独立 job 类型）|
| 2026-06-30 | `curate-prompt.ts` 重写为 agentic tool-loop 版本：新增 `CURATE_AGENTIC_SYSTEM_PROMPT`（保守策展系统提示，工具使用规范 + 保守原则）+ `buildCurateAgenticUserPrompt(pages, ctx, opts)`；退休旧 triage/confirm 三套 schema+builder（`CurateTriageSchema`/`CurateMergeConfirmSchema`/`CurateSplitConfirmSchema`）|
| 2026-06-24 | 新增内置 task `fix`（`LLMTaskSchema` 加 `'fix'`）+ `prompts/fix-prompt.ts`（`FixPageSchema`：`proceed`/`reason`/`body`/`summary?` + `buildFixPageUserPrompt(page, findings, roster, ctx)`）；供 `fix-service` 逐页修复 lint findings |
| 2026-06-25 | `provider-registry` 新增 `streamTextWithTools` / `generateTextWithTools`（工具循环版 stream/generate，底层 AI SDK `streamText`/`generateText` with tools+maxSteps）；`query-prompt.ts` 新增 `QUERY_AGENTIC_SYSTEM_PROMPT` + `buildAgenticUserContent`（agentic 工具循环问答用），供 `query-service` agentic 重构使用 |
| 2026-06-26 | 路由命名空间统一：skill 阶段 task key `skill:ingest-xxx` → `ingest:xxx`（`agent-loop::skillTaskKey` 把 id 首个连字符换冒号派生）；移除已无用的内置 `ingest` task（生产零引用，仅旧测试用过）；`LLMTaskSchema` 正则 `^skill:…` → 通用 `^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$`；`llm-config.example.json` 同步改 `ingest:*`；顺修文档：skill frontmatter 模型覆盖字段实为 `model:`（非 `llm_override:`），router mode 值为 `task-router-only`（非 `config-only`）|
| 2026-06-26 | `prompt-context.ts` 新增 `renderExpositionDirective(level)`（writer 讲解深度指令，`off`=纯忠实）；`renderAugmentationDirective` guidance 收窄为四类脚手架（intuition/example 下沉 writer 正文）。配合 ingest writer v6 / enricher v3 / verifier v2 |
| 2026-06-27 | Cognitive Lens：新增 `prompts/reshape-prompt.ts`（`RESHAPE_PAGE/SECTION_SYSTEM_PROMPT` 纯呈现硬约束=不改事实/不新增 wikilink/新增脚手架包 callout + `buildReshape{Page,Section}UserPrompt` 注入双维画像与语言指令）；`provider-registry` 加 `isReshapeConfigured()`（`resolveTask('reshape:page').model` 含 defaults 兜底，未配置 false 供优雅降级）；`reshape:page`/`reshape:section` 走开放 `<pipeline>:<stage>` 路由（无需改 schema），`llm-config.example.json` 加两条参考配置 |
| 2026-06-30 | `fix-prompt.ts` 重写为 agentic tool-loop 版本：新增 `FIX_AGENTIC_SYSTEM_PROMPT` + `buildFixAgenticUserPrompt`；退休 `FixPageSchema`/`FIX_SYSTEM_PROMPT`/`buildFixPageUserPrompt`（Spec 3 fix→tool-loop）|
| 2026-07-07 | Ask AI 内联引用 + 确定性解析：`QUERY_AGENTIC_SYSTEM_PROMPT` 新增 CITE INLINE 纪律（要求模型答案正文内联标注 `[[slug]]` 作依据，引用改由 `query-service.ts::extractCitationsFromAnswer` 流后确定性解析，不再需要模型二次结构化输出）；新增 `CoverageSchema`/`COVERAGE_SYSTEM_PROMPT`/`buildCoverageUserPrompt`（独立 coverage 判定小调用，只喂问题+答案，供 `assessCoverageInBackground` 异步 fire-and-forget 调用）；退役 `generateQueryCitations`/`QueryCitationsSchema`/`QueryCitationsResult` 与 `[unverified]` 前缀机制 |
| 2026-07-09 | `generateTextWithTools` 新增可选 `onToolCall?: (info: { tool, args }) => void`（经 `onStepFinish` 每次工具调用同步触发）；供 `fix-service`/`curate-service` emit 可读任务日志事件（任务日志可读性改进）|

---

_生成时间：2026-04-22 00:25:29_

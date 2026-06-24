[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **llm**

# `src/server/llm/` — 多供应商 LLM 抽象

## 模块职责

在 Vercel AI SDK 的基础上，提供**按任务路由 + 多供应商 profile** 的统一入口，支持：

- 8 种供应商（Anthropic / OpenAI / Google / DeepSeek / Mistral / xAI / Ollama / OpenAI-compatible）。
- 内置任务 —— `ingest` / `query` / `lint` / `merge` / `split` / `curate` / `fix` / `embedding` —— 每类可单独指定模型、温度、超时、provider options 等。
- 结构化输出（`generateObject` + Zod schema）与流式文本（`streamText`）。

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

generateEmbeddings(texts: string[]): Promise<number[][]>

isEmbeddingConfigured(): boolean

embeddingModelId(): string
```

前两个自带：
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
- `LLMTaskSchema`（内置 `ingest|query|lint|merge|split|curate|fix|embedding` 枚举 + 开放 `skill:*` 前缀）、`LLMProviderKindSchema`（8 种 provider）。
- 每种 provider 的 discriminated union（`AnthropicProfileSchema` / ... / `OpenAICompatibleProfileSchema`）。
- `LLMRouteOverride`（可在单次调用处覆盖路由）。
- `tasks` key space 支持 `embedding` 内置任务与 `skill:<id>` 动态任务（⑧ 向量）。

### `prompts/`

每个任务一个文件，每个文件导出：

- `*_SYSTEM_PROMPT` 常量；
- `build*UserPrompt(...)` 函数；
- `*Schema`（Zod）—— LLM 必须严格吐出该结构。

| 文件 | 用途 |
|------|------|
| `ingest-prompt.ts` | **多阶段**：plan → page body → index body。对应 `IngestPlanSchema / PageBodySchema / IndexBodySchema` |
| `query-prompt.ts` | 回答用户问题 + 引用；`buildQueryUserPrompt` 加可选 history 参注入多轮 transcript。`QueryResponseSchema` |
| `lint-prompt.ts` | 扫描整库/单页的 lint finding。 |
| `merge-prompt.ts` | 融合两页正文与摘要（由 `page-ops.ts` 内部调用，不再是独立 job）。`MergeResultSchema` |
| `split-prompt.ts` | 拆一页成多页（由 `page-ops.ts` 内部调用，不再是独立 job）。`SplitResultSchema` (pages.min(2)，恰一 isPrimary) |
| `curate-prompt.ts` | 🆕 strategy 策展三阶段 schema + prompt builder：`CurateTriageSchema`（候选 merge/split 清单）/ `CurateMergeConfirmSchema`（go/no-go）/ `CurateSplitConfirmSchema`（go/no-go）|
| `fix-prompt.ts` | 🆕 逐页修复 lint findings：`FixPageSchema`（`proceed` 自我门控 + `reason` + `body` + `summary?`）+ `buildFixPageUserPrompt(page, findings, roster, ctx)` |

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
  1. 扩展 `LLMTaskSchema`（现为 `z.union` 支持 `skill:<id>` 格式的开放字符串）；
  2. 新建 `prompts/<task>-prompt.ts`；
  3. 在 `llm-config.json::tasks` 给出默认配置；
  4. Service 层调 `generateStructuredOutput('<task>', ...)`。
- **为 skill 指定专属模型**：在 `llm-config.json::tasks` 添加 `"skill:<id>": { "model": "...", "temperature": 0.1 }`。`resolveTask` 识别 `skill:` 前缀，`config.tasks` 已改为 `z.record`（开放 key），无需修改 schema。
- **临时换模型**：调用点传 `overrides: { profile, model, temperature }`，优先级最高。

**Phase 1 新增**：

- `LLMTaskSchema` 接受 `skill:<id>` 形式的 key（如 `skill:ingest-planner`），不限于 `ingest|query|lint` 三个枚举值。
- `LLMConfigFile.tasks` 由枚举 key 改为 `z.record`（开放字典），`llm-config.json` 可直接写任意 `"skill:xxx"` 节。
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
    ├── curate-prompt.ts       # 🆕 agent 策展三阶段 schema + prompt builder
    └── fix-prompt.ts          # 🆕 逐页修复 lint findings（FixPageSchema + buildFixPageUserPrompt）
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
| 2026-06-24 | 新增内置 task `fix`（`LLMTaskSchema` 加 `'fix'`）+ `prompts/fix-prompt.ts`（`FixPageSchema`：`proceed`/`reason`/`body`/`summary?` + `buildFixPageUserPrompt(page, findings, roster, ctx)`）；供 `fix-service` 逐页修复 lint findings |

---

_生成时间：2026-04-22 00:25:29_

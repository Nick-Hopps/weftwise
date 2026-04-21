[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **llm**

# `src/server/llm/` — 多供应商 LLM 抽象

## 模块职责

在 Vercel AI SDK 的基础上，提供**按任务路由 + 多供应商 profile** 的统一入口，支持：

- 8 种供应商（Anthropic / OpenAI / Google / DeepSeek / Mistral / xAI / Ollama / OpenAI-compatible）。
- 三类任务 —— `ingest` / `query` / `lint` —— 每类可单独指定模型、温度、超时、provider options 等。
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
```

两者都自带：
- AbortController 超时（`route.timeoutMs`，默认 8 分钟）。
- 统一日志前缀 `[LLM][Task: ...][Model: ...]`。
- 错误上下文补全（`usage` / `finishReason` / `cause`）。

### `task-router.ts`

```ts
resolveTask(task, overrides?) → ResolvedTaskRoute
```

`ResolvedTaskRoute` 同时包含 AI SDK 的 `CallSettings`（`maxTokens` / `temperature` / `topP` / ...）和应用级字段（`timeoutMs` / `logLabel`）。

### `config-schema.ts`

用 zod 定义的：
- `LLMTaskSchema`（枚举）、`LLMProviderKindSchema`（8 种 provider）。
- 每种 provider 的 discriminated union（`AnthropicProfileSchema` / ... / `OpenAICompatibleProfileSchema`）。
- `LLMRouteOverride`（可在单次调用处覆盖路由）。

### `prompts/`

每个任务一个文件，每个文件导出：

- `*_SYSTEM_PROMPT` 常量；
- `build*UserPrompt(...)` 函数；
- `*Schema`（Zod）—— LLM 必须严格吐出该结构。

| 文件 | 用途 |
|------|------|
| `ingest-prompt.ts` | **多阶段**：plan → page body → index body。对应 `IngestPlanSchema / PageBodySchema / IndexBodySchema` |
| `query-prompt.ts` | 回答用户问题 + 引用。`QueryResponseSchema` |
| `lint-prompt.ts` | 扫描整库/单页的 lint finding。 |

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
    "lint":   { "profile": "local", "model": "llama3.1" }
  }
}
```

- `llm-config.json` 入 `.gitignore`（含 API key 引用时避免泄漏）。
- 必须提供 `defaults.profile` + `defaults.model`，否则 `resolveTask` 抛 `LLMConfigError`。

## 扩展指南

- **新增 provider**：
  1. 在 `config-schema.ts::LLMProviderKindSchema` 增加字面量；
  2. 增加对应的 `XxxProfileSchema` 并入 discriminated union；
  3. 在 `provider-factory.ts::getLanguageModel` 添加 `case 'xxx'` 分支。
- **新增任务类型**：
  1. 扩展 `LLMTaskSchema` 枚举；
  2. 新建 `prompts/<task>-prompt.ts`；
  3. 在 `llm-config.json::tasks` 给出默认配置；
  4. Service 层调 `generateStructuredOutput('<task>', ...)`。
- **临时换模型**：调用点传 `overrides: { profile, model, temperature }`，优先级最高。

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
├── provider-factory.ts        # ResolvedTaskRoute → LanguageModel
├── provider-registry.ts       # generateStructuredOutput / streamTextResponse
├── task-router.ts             # defaults ← task ← overrides 合并
└── prompts/
    ├── ingest-prompt.ts       # 多阶段 plan / page-body / index
    ├── query-prompt.ts        # 用户问答 + 引用
    └── lint-prompt.ts         # 全库扫查
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |

---

_生成时间：2026-04-22 00:25:29_

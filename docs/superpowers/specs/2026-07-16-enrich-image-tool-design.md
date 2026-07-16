# 设计：enrich 图片生图工具

## 背景与目标

当前 `ingest-enricher` 只能手写 Mermaid 图示。项目已配置 Google Gemini 3.1 Flash Image 模型，需要在 enrich 阶段提供一个受控的真实图片生成工具，帮助模型生成解释性配图。

本期生成 PNG/JPEG/WebP 位图并作为 vault asset 与页面 Markdown 一起提交；Mermaid 仍由 enrich 直接生成，工具不把 Mermaid 当作图片输出类型。

## 成功标准

1. `ingest-enricher` 能看见且只通过 `image.generate` 请求真实图片。
2. 工具生成真实图片，输出稳定的 asset URL、alt 文本与页面 slug；提示词/尺寸受限，调用次数由 enrich agent 按需决定。
3. 生图调用使用独立 `ingest:image` 路由，可在 `llm-config.json` 指向 Gemini 3.1 Flash Image；示例配置提供默认项。
4. 图片与页面在同一 changeset/Saga 中提交；工具未注入或生图失败时，enricher 仍可按现有流程完成。
5. 既有 planner/writer/query 工具权限不扩大，工具只进入 `ingest:enricher` profile。

## 方案与取舍

### 方案 A（推荐）：enricher tool-loop + vault asset Saga

增加 `image.generate` builtin。enricher 从无工具结构化路径切到“工具 + finish”组合路径；工具内部调用 Gemini 图像模型，返回图片字节并把 asset entry 暂存到当前 changeset，模型把返回的 Markdown 引用插入页面。

- 优点：复用现有工具治理、审计与 finish schema；图片与页面原子提交；未来可扩展图片类型。
- 代价：需要扩展 changeset/vault 写入与只读 asset API；每张图多一次模型调用。

### 方案 B：enricher 单次输出 Mermaid

只修改 prompt/schema，让 enrich 直接产出 Mermaid，不增加工具。

- 优点：改动最小、无额外调用。
- 缺点：没有使用 Gemini image 路由，无法按工具治理限制调用，后续扩展图片类型需要再次改 enrich schema。

本期采用方案 A；不新增数据库索引，asset 只由 vault/git 管理。

## 约束与护栏

- `image.generate` 只接受当前页面 slug、图片提示词、alt 与可选比例/风格；输出只允许 PNG/JPEG/WebP。
- `prompt`、`context` 有长度上限；输出去除 Markdown fence，拒绝空结果并限制最大源码长度。
- 工具不直接写文件、不改变 `ctx.pending`；由 enricher 负责把返回代码插入 `[!diagram]` callout。
- 工具仅挂在 `ingest:enricher` profile，planner/writer/其它 runner 不可见。
- 生图路由独立为 `ingest:image`，默认示例为 `google-default` + `gemini-3.1-flash-image-preview`，用户配置可覆盖。

## 影响文件

- `src/server/agents/tools/builtin/image-generate.ts`：工具契约、Gemini 图片调用与 asset entry。
- `src/server/agents/tools/builtin/index.ts`：注册工具。
- `src/server/agents/tools/tool-context.ts`：注入 enrich 生图能力与 pending asset 暂存。
- `src/server/agents/tools/profiles.ts`：新增 enrich profile 与 allowlist。
- `src/server/agents/runtime/agent-loop.ts`：enricher 使用独立 profile，并允许工具组合路径。
- `examples/skills/ingest-enricher.md`：声明工具、调用纪律与输出使用方式。
- `llm-config.example.json`：新增 `ingest:image` 路由示例（Gemini image response）。
- `src/app/api/assets/[...path]/route.ts`：subject-scoped asset 读取接口。
- `src/server/wiki/wiki-store.ts`、`src/server/wiki/wiki-transaction.ts`、`src/lib/contracts.ts`：二进制 changeset 编码与 asset 校验。
- 相邻单测：工具契约、profile 隔离、Mermaid 清理与 enrich skill 契约。

# Re-enrich 图片生成可靠性修复设计

## 背景

`image.generate` 已进入 `ingest-enricher` 工具集，re-enrich 也会复用该阶段，但真实任务 `faa22030-c2d4-401e-9a60-18b2793f341d` 没有发起图片调用。现场证据显示：

- 工具注册、skill v5 与运行时 `generateImage` 注入均正常；
- 页面 slug 为 `3d图形学基础`，而工具输入只允许 ASCII `pageSlug`；
- 页面 slug 本身按项目契约支持 Unicode，图片工具私自收窄了身份规则；
- enricher 对流程图优先选择 Mermaid，且“是否生成位图”完全交给模型自由判断；
- 本机 `llm-config.json` 未配置 `ingest:image`，该任务会继承默认 DeepSeek 文本模型，而非 Gemini 图片模型；
- 现有测试仅用 `linear-algebra` 覆盖 ASCII slug，没有锁定 re-enrich + Unicode 页面场景。

## 目标与成功标准

1. 模型不再提供或伪造当前页面 slug，图片资产始终绑定运行时正在 enrich 的页面。
2. Unicode 页面 slug 能生成合法的 ASCII asset 文件名，并保持 `assetFor` 为真实页面 slug。
3. 缺失或错误的 `ingest:image` 路由能在 worker 执行前给出明确错误，不把请求静默路由到文本模型。
4. 对依赖空间形态、视觉外观或材质差异理解的页面，且正文尚无解释性位图时，enricher 明确优先生成一张位图；纯流程、关系或可编辑拓扑继续优先 Mermaid。
5. 重跑已有位图的页面不会重复堆叠同类图片。

## 约束

- 不改变 Saga、asset API 或页面 Markdown 契约。
- 不强制所有页面生成图片，避免装饰性图片与重复成本。
- 页面 slug 继续使用项目唯一 Unicode-aware 规则，不在图片工具内复制另一套 slug 规范。
- 图片模型仍通过独立 `ingest:image` task 路由，不硬编码 provider 或模型名称。

## 方案比较

### 方案 A：放宽 `pageSlug` 正则

让工具输入接受 Unicode slug，继续由模型传入。

- 优点：改动最小。
- 缺点：模型仍可传错页面；Unicode slug 不能直接用于当前只接受 ASCII 的 asset 文件名；调用边界仍不可信。

### 方案 B：运行时注入页面身份（推荐）

从 `image.generate` 输入移除 `pageSlug`。`runAgentLoop` 从当前 fanout 输入提取可信 slug，并把它注入 `agentToolContext`；图片工具只接收视觉需求。asset 文件名使用 UUID，`assetFor` 保存真实 Unicode slug。

- 优点：消除身份伪造和规则漂移；Unicode/嵌套页面身份不再影响文件名；checkpoint attachment 可稳定关联当前页。
- 缺点：需要调整 tool context、agent loop 与测试接口。

### 方案 C：新增 re-enrich 专用图片阶段

在 supplement 与 enricher 之间增加固定图片判断/生成阶段。

- 优点：调用决策更确定。
- 缺点：重复一套 enrich 逻辑，增加一次 LLM 调用与编排复杂度；不符合 YAGNI。

采用方案 B，并在现有 enricher prompt 中增加清晰的视觉主题决策表，不新增流水线阶段。

## 设计

### 可信页面身份

- `ImageGenerateInputSchema` 删除 `pageSlug`，并使用严格对象拒绝旧字段。
- `agentToolContext(agentCtx, currentPageSlug)` 仅在存在当前页 slug 时注入 `generateImage`。
- `runAgentLoop` 从当前输入的顶层 `slug` 读取页面身份；非页面步骤不会获得图片能力。
- `generateImageAsset(input, subjectSlug)` 只负责模型调用和 UUID 文件名；页面归属由 tool context 写入 `assetFor`。

### Asset 文件名

使用 `<uuid>.<ext>`，保持现有 `wiki-transaction` 的 ASCII asset 路径约束。页面身份只存在于 `assetFor` 和 Markdown URL 的 subject 目录上下文，不再编码进文件名。

### 路由预检

新增纯函数校验 `ingest:image` 解析结果必须是支持图片响应的 Google provider，并在 worker 构造图片调用时 fail-fast。错误信息指出需要在 `llm-config.json` 配置独立任务路由。

本地 `llm-config.json` 同步补充：

- profile：`google`
- model：`gemini-3.1-flash-image-preview`
- `responseModalities: ["IMAGE"]`
- `imageConfig.imageSize: "1K"`

### 生图决策

Prompt 使用三段判断：

1. 页面是否依赖空间形态、视觉外观、材质、光照、解剖、构图等仅靠文本难以形成心智模型的内容；
2. draft 中是否已经存在解释性 raster image；
3. Mermaid/KaTeX 是否已经足以表达纯流程、关系、公式或可编辑拓扑。

满足 1 且不满足 2/3 时，至少调用一次 `image.generate`。已有合适位图时禁止重复生成。

## 测试策略

- schema：工具输入不再接收 `pageSlug`。
- Unicode：运行时 slug `3d图形学基础` 生成 ASCII asset path，`assetFor` 保持原 slug。
- 隔离：无当前页面 slug 的 agent context 不注入图片能力。
- 路由：Google 图片路由通过，默认 DeepSeek/Anthropic 路由失败并给出明确提示。
- Prompt：锁定视觉主题触发、已有位图去重与 Mermaid 边界。
- 回归：reenrich step、profile、image tool、agent loop、wiki transaction 相关测试。


# Reshape 自由重塑与版本体验设计

## 背景

当前 Reshape 虽然不写回 vault，但仍沿用 canonical 写路径的保真护栏，Prompt 也把“新增脚手架”描述得比“改写原文”更具体，实际产物容易退化为“原文 + callout”。此外，页面虽然把结果写入 `page_renditions`，但只把它当缓存：用户必须再次点击才读取，无法主动刷新，也无法取消正在进行的请求；重塑模型也不能调用现有 `image.generate` 补充视觉说明。

## 目标与成功标准

1. Reshape 可以按画像自由重组、删改、扩写或压缩正文，不再执行长度、链接、标题或 frontmatter 保真检查。
2. 模型可按需调用生图工具，并在返回 Markdown 中嵌入持久化图片。
3. 每页最新一次成功重塑结果跨会话保留；页面再次进入时可直接查看该版本。
4. 已重塑状态支持 Refresh；生成状态支持 Cancel。
5. Refresh/Cancel/失败不得删除或覆盖上一个成功版本，也不得留下孤立图片。
6. canonical vault、SQLite 页面索引与 git 历史始终不受 Reshape 影响。

## 方案比较

### 方案 A：继续同步请求，SQLite 持久化最新版本（推荐）

- `GET /api/lens/[...slug]` 读取已保存版本；`POST` 强制生成新版本。
- 客户端使用 `AbortController` 取消 POST，信号贯通文本模型和生图模型。
- 文本与图片全部生成完成后，在一个 SQLite 事务中替换当前 rendition。
- 优点：改动集中、交互直接、复用现有表与 React Query，不引入 worker/job 生命周期。
- 缺点：关闭页面会取消当前生成；只保留每页最新成功版本。

### 方案 B：改为 worker job

- Refresh 入队，SSE 监听进度，取消走 jobs cancel。
- 优点：关闭页面仍可继续、天然有任务审计。
- 缺点：读侧功能引入完整长任务编排，交互和数据结构明显变重，不符合当前需求的 YAGNI 边界。

### 方案 C：把重塑结果写入 vault 派生目录

- 优点：可由 git 管理与外部工具查看。
- 缺点：读侧个性化产物污染 canonical 仓库，图片也进入 Saga，违背 Cognitive Lens 的隔离原则。

选择方案 A。

## 详细设计

### 1. 自由重塑 Prompt

重写 `RESHAPE_PAGE_SYSTEM_PROMPT`：

- 明确 canonical 仅是输入素材，输出是独立的个性化阅读版本；
- 允许移动、合并、拆分、改写、删减、扩写段落，允许改变标题层级与叙事顺序；
- 要求以画像适配为第一目标，禁止默认复制原文后只追加 callout；
- 允许使用已有知识帮助解释，不再宣称事实/链接必须与 canonical 等价；
- 可在视觉说明确有帮助时调用 `image_generate`，并把工具返回 URL 以标准 Markdown 图片语法放到最相关位置；
- 仍只输出 Markdown body，不输出 frontmatter 或过程说明。

服务层删除 `checkRewriteFidelity`、二次重试与 fallback。模型异常或取消由路由处理，旧持久化版本不变。

### 2. 生图工具

复用 `generateImageAsset()` 的 Google `ingest:image` 路由和图片生成约束，在 Reshape 服务中提供只含一个工具的最小工具集：

- 模型输入：`prompt`、`alt`、可选比例与风格；
- 工具输出：`/api/rendition-assets/<assetId>`；
- 图片先保存在本次请求内存中，不写 vault；
- 图片调用接收与文本相同的 `AbortSignal`；
- 仅当最终文本成功产出后，图片与 Markdown 才原子写入 SQLite。

### 3. 持久化模型

保留 `page_renditions` “每个 subject/page 最新成功版本一行”的模型，并把它从“可丢弃缓存”提升为用户可随时查看的派生内容。新增 `page_rendition_assets`：

| 字段 | 作用 |
|---|---|
| `id` | URL 使用的 UUID 主键 |
| `subject_id` / `slug` | 归属的 rendition 页面 |
| `media_type` | PNG/JPEG/WebP |
| `data_base64` | 图片内容 |
| `created_at` | 创建时间 |

`replaceRendition()` 在单事务内删除该页旧图片、upsert Markdown、插入新图片。Refresh 生成期间继续展示旧版本；成功后原子替换；失败或取消不执行事务。

`GET /api/rendition-assets/[id]` 鉴权后返回图片，带 immutable cache header。UUID 每次刷新都会变化，旧 URL 不会和新内容串缓存。

canonical hash 与画像版本仍随 rendition 保存，用于 UI 辨识版本所基于的输入，但不再用于隐藏已保存版本：即使 canonical 或画像后来变化，用户仍可查看最后成功的重塑版，并可主动 Refresh 更新。

### 4. API 协议

- `GET /api/lens/[...slug]`
  - 有持久化版本：返回 `{ renderedMd, source: 'saved', stale }`；
  - 无版本：返回 `{ renderedMd: canonical, source: 'canonical', stale: false }`；
  - 不触发 LLM。
- `POST /api/lens/[...slug]`
  - `requireAuth + requireCsrf + required subject`；
  - 强制生成，成功后原子替换并返回 `{ renderedMd, source: 'generated', stale: false }`；
  - 请求 abort、模型失败或生图失败均不覆盖旧版本。

### 5. UI 状态

视觉主张：保持阅读面安静，把 Reshape 操作限制在现有标题动作与细状态行，不新增卡片或弹窗。

内容计划：标题动作栏负责首次触发；正文上方状态行负责版本状态及后续操作。

交互主张：

- 初次点击 Reshape：POST 生成；加载态显示旋转图标与 Cancel；
- 已有保存版本：点击 Reshape 后立即显示保存版，不自动重生成；
- 已重塑态：Show original/Show reshaped 与 Refresh 并列；
- Refresh：保留当前内容显示，状态行进入 refreshing，并提供 Cancel；成功后无闪烁替换；
- Cancel：abort 当前请求并恢复到请求前状态；首次生成取消后回到 idle，刷新取消后继续显示旧重塑版。

## 边界与非目标

- 本期只保存“最新成功版本”，不做版本时间线和多版本选择。
- 不把 rendition 或其图片写入 vault/git，也不进入 Wiki 搜索、反向链接或 embedding 索引。
- 不要求每次重塑都生成图片；工具由模型按解释价值决定。
- 不改段级 Reshape 的产品入口；其服务移除保真护栏，但本期交互聚焦整页。

## 验证

- Prompt 单测锁定自由改写、反对仅追加、允许生图和 Markdown 嵌图。
- Service 单测先证明旧护栏会回落，再改为接受大幅缩写；覆盖工具调用、abort 贯通。
- Repo 真实 SQLite 测试覆盖跨重开读取、Markdown+图片原子替换和旧图片清理。
- Route 测试覆盖 GET 不生成、POST 强制生成、失败/取消不写入。
- Hook/组件测试覆盖首次生成、持久化版本读取、Refresh、Cancel 及旧内容保留。

# Ask AI 选区配图插入设计

日期：2026-07-17
状态：已确认，待实现

## 一、背景

阅读页已经支持选中正文后打开 Ask AI，并把选区纯文本作为引用发送到 `/api/query`。系统也已经具备 `image.generate`：它通过显式 `ingest:image` 路由调用 Google 图片模型，把 PNG/JPEG/WebP 资产与页面正文放进同一个 Saga changeset。

两条能力尚未连通：

1. Ask AI 的 Query runner 只有读取和 PendingAction 提案权限，不能直接生图或修改页面；
2. 当前选区只有渲染后的文本与最近标题，没有 Markdown 源位置，不能可靠表达“在这段内容下方”；
3. `image.generate` 只在 ingest/re-enrich 的 enricher 上下文注入，图片暂存在当前 AgentContext；
4. Reshape 内容可能不存在于 canonical 正文，不能作为原文写入锚点。

## 二、目标与成功标准

用户在 canonical 原文中选中一段内容，通过 Ask AI 输入“帮我在这段内容下方生成一张配图”后：

1. Ask AI 读取当前页面并生成一张插图的视觉请求；
2. 系统只创建可恢复的 PendingAction，批准前不调用生图模型、不修改页面；
3. 审批卡展示目标页、选区摘要、图片 prompt、alt、比例与风格；
4. 用户批准后原子入队 `image-insert` 后台任务；
5. worker 在完整 Markdown 块边界重新定位选区，调用现有图片模型；
6. 图片资产与 `[!diagram]` Markdown 引用在同一个 Saga changeset 和 git commit 中落地；
7. 选区失效、图片生成失败、任务取消或提交冲突时，正文不变且不留下孤立资产；
8. 任务完成后，当前阅读页刷新并展示新图片。

## 三、已确认的产品决策

1. 采用“先审批插图计划，再生成并直接插入”，审批前不展示真实图片；
2. 暂不允许针对 Reshape 内容发起配图插入；普通 Reshape 选区问答不受影响；
3. “下方”按完整 Markdown 块解释，不按字符位置插入；
4. 沿用现有格式：

```md
> [!diagram]
> ![描述性 alt](/api/assets/<subject>/<filename>)
```

5. 一次操作只生成一张图片；多图由用户发起多次独立操作；
6. 一次批准同时授权本次付费生图调用与 canonical 页面写入。

## 四、方案比较

### 方案 A：Query 直接生图并写入

- 优点：交互最短；
- 缺点：绕过 Query 的提案治理，模型持有真实写能力；生图后写入失败还需要额外清理。

不采用。

### 方案 B：先生成真实图片，再批准插入

- 优点：用户批准前可查看真实产物；
- 缺点：拒绝也会产生模型费用；需要临时资产表、TTL 和垃圾回收；PendingAction 恢复必须保存二进制。

作为未来“候选图预览”能力保留，本期不采用。

### 方案 C：先批准意图，worker 生图并原子插入（采用）

- Query 只获得 `sideEffect:'propose'` 的 `wiki.image.insert`；
- PendingAction 持久化可信页面锚点与视觉请求；
- 批准时原子创建 `image-insert` job；
- worker 内存持有生成结果，最终与页面一起走 Saga。

该方案不新增临时资产表，符合现有治理和 YAGNI 边界。

## 五、结构化选区锚点

### 5.1 客户端输入

`PageRenderer` 的 Markdown pipeline 为每个可见的顶层 mdast block 输出源位置属性。选区 hook 从 Range 起点和终点向上找到所属顶层 block，形成：

```ts
interface SelectionAnchorInput {
  sourceKind: 'canonical' | 'reshape';
  quote: string;
  section: string | null;
  blockStart: number;
  blockEnd: number;
}
```

`blockStart/blockEnd` 是当前渲染 Markdown body 的 UTF-16 offset，范围覆盖从首个选中顶层块开头到最后一个选中顶层块结尾。前端不提交 page slug、原始块文本或 hash；page slug 继续由当前路由作为可信上下文绑定。

选区仍作为可见 Reference chip 与问题上下文发送，同时在 `/api/query` body 的 `selection` 字段中独立发送结构化锚点，禁止从拼接后的自然语言反解析位置。

### 5.2 服务端规范化

创建提案时，服务端读取当前 canonical body，并用与渲染端一致的 remark parse/GFM/math 规则验证：

- start 必须等于某个顶层块的开始 offset；
- end 必须等于同一或后续顶层块的结束 offset；
- quote 非空且不超过既有选区上限；
- `sourceKind` 必须为 `canonical`；
- 页面存在且不是 meta page。

服务端随后补齐持久化锚点：

```ts
interface PersistedMarkdownBlockAnchor {
  start: number;
  end: number;
  markdown: string;
  prefix: string;
  suffix: string;
  quote: string;
  section: string | null;
}
```

`markdown` 是完整块范围原文；`prefix/suffix` 是有界相邻上下文。客户端不能提供这些字段，避免把任意字符串伪装成已验证正文。

### 5.3 重定位与失效

预览、批准与 worker 提交前都调用同一纯函数：

1. 优先校验原 offset 上的完整块文本；
2. offset 已移动时，在新的顶层块边界中查找相同 `markdown`；
3. 多个候选时用 prefix/suffix 收窄；
4. 最终不是唯一候选则 fail-closed，提示重新选择。

插入位置永远是最后一个被选中顶层块之后：段落、列表、表格、代码块、blockquote/callout 均保持完整。

## 六、Query 与工具治理

### 6.1 请求协议

`POST /api/query` 增加可选 `selection` 字段。普通问题和没有选区的 Ask AI 保持兼容。

意图分类新增“选区配图”识别：仅当存在选区，并且问题同时表达生成/添加图片和插入到正文的意图时进入 `query:propose`。教程、能力询问、否定句仍为 read。

当 `sourceKind='reshape'` 且命中配图意图时，路由确定性返回“请切换至 Original 后重新选择”，不调用 Query LLM、不创建 PendingAction。其他 Reshape 选区问题继续正常问答。

### 6.2 `wiki.image.insert`

模型可见输入只包含视觉需求：

```ts
{
  prompt: string;
  alt: string;
  aspectRatio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
  style?: string;
}
```

工具不接受 slug、offset、块文本或 subject。`ToolContext` 从当前请求绑定可信 `pageSlug + selection`，调用专用 `createPendingImageInsertActionPreview`。

工具标记 `sideEffect:'propose'`，只进入 `query:propose`。Query profile 仍不包含 `image.generate`、页面写工具或 queue 能力。

Query prompt 要求：

1. 先 `wiki.read` 当前页，结合选区及相邻内容形成教育性视觉请求；
2. 只调用一次 `wiki.image.insert`；
3. alt 必须描述图片传达的信息；
4. 避免依赖密集文字、品牌、logo、水印或未经正文支持的标签；
5. 工具返回 PendingAction 后说明需点击 Approve，不宣称已经生成或插入。

## 七、PendingAction 与审批

新增 operation：`workflow-image-insert-start`。

它属于 workflow preview：

- `kind='workflow'`；
- `affectedPages=[{ slug, action:'update' }]`；
- `diff=null`，因为审批前尚无图片 URL；
- `preHead` 保存创建预览时的 vault HEAD；
- preview 增加可选 `imageInsert` 展示数据，包含选区摘要和视觉请求；
- warnings 明确“真实图片将在批准后生成”。

批准时：

1. 校验 payload hash；
2. 重新读取页面并解析锚点；
3. HEAD 或预览变化时沿用现有 stale preview 机制要求再次批准；
4. 在 SQLite IMMEDIATE transaction 内创建 `image-insert` job 并把 action 标记 applied；
5. 返回 jobId，客户端派发全局任务启动事件。

PendingAction applied 表示“工作流已成功启动”，真实页面结果由 job 终态和 Tasks 面板展示。

`pending_actions.operation` CHECK 需要同步更新 Drizzle schema、Drizzle migration 与启动期原子兼容迁移，保留历史行。

## 八、`image-insert` 后台任务

### 8.1 参数

```ts
{
  subjectId: string;
  slug: string;
  anchor: PersistedMarkdownBlockAnchor;
  request: ImageGenerateInput;
}
```

### 8.2 执行流程

1. 校验 job subject 与 params subject 一致；
2. 读取 subject、canonical 页面和当前锚点；
3. emit `image-insert:start` 与 `image-insert:generating`；
4. 调用现有 `generateImageAsset(request, subject.slug, ..., abortSignal)`；
5. 生成完成后检查任务是否取消；
6. 在稳定 HEAD 快照下重新读取页面并唯一重定位锚点；
7. 在块后插入 `[!diagram]` callout，并更新系统拥有的 `updated`；
8. 构造一个 changeset：页面 update entry + base64 auxiliary asset create entry；
9. `validateChangeset` 后以稳定 HEAD 作为 `expectedPreHead` 调用 `applyChangeset`；
10. 成功后 best-effort 入队 embedding 回填并返回 asset URL、operationId、commitSha。

生成期间不持有 vault lock。图片字节只在 worker 内存中存在；若锚点或 HEAD 在提交前失效，changeset 不 apply，资产不会写入 vault。

### 8.3 取消与恢复

- 生图时用轮询的 AbortController 响应 job cancel；
- 生图返回后和 apply 前再次检查取消状态；
- worker 的 attempt fencing 继续阻止已取消/旧 attempt 覆盖终态；
- handler 启动时先按 jobId 查询已 applied operation，覆盖“commit 成功、job complete 前崩溃”的重试窗口，禁止重复生图和重复插入；
- 图片生成前失败可按既有 worker 临时错误策略重试；页面锚点失效属于不可重试业务失败。

## 九、UI

### 9.1 选区与 Reshape

- canonical 正文选区携带块锚点；
- Reshape 选区仍能打开 Ask AI 并进行问答，但 `sourceKind='reshape'`；
- 对 Reshape 配图命令显示短提示，要求切换 Original，不隐藏整个 Ask AI 入口。

### 9.2 审批卡

`PendingActionCard` 对 `workflow-image-insert-start` 显示 `Proposed illustration`，包含：

- 目标页；
- 选区摘要；
- Illustration prompt；
- Alt text；
- Aspect ratio / style（有值时）；
- “图片将在批准后生成并插入”的说明。

保持现有 Approve/Reject、状态和错误展示，不新增模态或嵌套卡片。

### 9.3 任务追踪

- `jobStartedDetailForAction` 把 action 映射为 `type:'image-insert'`；
- Tasks 面板动词为 `Illustrating`，label 使用页面 slug；
- job 完成时失效 pages/page-detail 并 `router.refresh()`，使当前 SSR 阅读页显示新内容；
- job 失败/取消沿用现有详情与错误展示。

## 十、安全与不变量

1. Subject 由现有 `/api/query` 与 PendingAction 服务绑定，模型不能选择其他 Subject；
2. slug 和选区锚点由运行时上下文注入，不进入模型输入；
3. Query 永远不获得真实生图或写工具；
4. 图片沿用 8 MiB、PNG/JPEG/WebP 与 subject-scoped asset path 限制；
5. alt/style/prompt 有长度上限；Markdown alt 在插入前转为安全单行文本；
6. 页面和图片必须同一 changeset，要么同时提交，要么都不提交；
7. 不为取消、失败或拒绝的操作保存临时图片；
8. 不允许 meta 页、跨 Subject 页或 Reshape body 成为目标。

## 十一、非目标

- 审批前真实图片预览；
- 一次生成多张候选图；
- 已生成图片的局部重绘、替换或版本历史；
- 在无选区时由 Ask AI 自行选择插图位置；
- 在 Reshape、Sources、Chat 消息或其他非 canonical 内容中插入；
- 新增图片模型配置；继续复用 `ingest:image`；
- 新增独立 Route Handler 或临时资产表。

## 十二、测试与验收

1. Markdown 渲染测试锁定顶层块 source offset；选区测试覆盖单块、跨块、列表、表格、代码块与 callout；
2. 锚点纯函数测试覆盖初始解析、offset 移动重定位、重复块歧义和失效；
3. Query intent/route 测试覆盖 canonical propose、Reshape 确定性拒绝、普通问答不变；
4. registry/profile/tool-context 测试证明 Query 只有提案工具，其他 runner 不获得该工具；
5. PendingAction 测试覆盖创建、刷新、批准原子入队、重复批准与跨 Subject；
6. 启动迁移和 Drizzle migration 测试保留旧行并接受新 operation；
7. image-insert service 测试覆盖单图生成、完整块插入、页面+资产同 changeset、取消、陈旧锚点、提交后重试恢复；
8. UI 测试覆盖插图审批详情、job 映射与完成刷新；
9. 定向测试、全量 Vitest、TypeScript、lint、build 通过；
10. `git diff -- llm-config.example.json` 为空。

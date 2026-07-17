# Ask AI 选区意图 LLM 分类设计

**日期：** 2026-07-17
**状态：** 已确认，待实现

## 一、背景与问题

Ask AI 的选区配图能力当前依赖 `query-intent.ts` 中的中文/英文正则识别。真实输入“在这下面生成一张图片说明”没有命中既有语序，导致请求被归类为 `query:read`。系统提示词仍描述 `wiki_image_insert`，模型因此知道工具名称，却没有收到该工具，最终错误回复“当前环境中不可用”。

问题不是再补一条正则即可长期解决：自然语言存在大量语序、指代、同义词和上下文变化，继续扩大正则会形成难以审计的规则集合。

## 二、目标

1. 带结构化正文选区的 Ask AI 请求，使用 LLM 判断是否为“生成并插入选区配图”的执行意图。
2. LLM 只输出有限枚举，不决定页面、Subject、offset、工具名或权限。
3. canonical 选区的配图执行意图进入 `query:propose`；Reshape 选区的相同意图继续确定性拒绝。
4. 分类失败、超时或输出无效时保守回退为普通问答，不暴露 propose 工具。
5. Query 系统提示词必须与本次真实工具集一致，不能描述未下发的工具。

## 三、非目标

- 不把所有 Wiki 写操作意图改为 LLM 分类。
- 不改变 PendingAction、批准、`image-insert` job、Saga 或图片模型路由。
- 不允许 LLM 根据自然语言自行构造 slug 或 Markdown offset。
- 不为无结构化选区的普通聊天开放 `wiki.image.insert`。

## 四、方案比较

### 方案 A：继续扩充正则

优点是无额外 LLM 延迟和成本。缺点是语义覆盖不可控，否定、能力询问、指代和语序组合会持续产生漏判或误判。不能解决根因，不采用。

### 方案 B：让主 Query 模型自行尝试工具

优点是少一次模型调用。缺点是必须提前把 propose 工具暴露给所有选区请求，扩大权限面；模型是否调用工具也无法在进入工具循环前用于 Reshape 确定性拒绝。不采用。

### 方案 C：独立结构化 LLM 分类器（推荐）

在进入主 Query 工具循环前，对带选区的请求执行一次小型结构化分类，只输出 `image-insert` 或 `other`。服务端再结合可信的 `selection.sourceKind` 决定拒绝或授权。

优点：自然语言覆盖好，权限决策仍由服务端完成，分类器可独立测试和保守降级。代价是选区请求增加一次小调用和少量延迟。

## 五、设计

### 5.1 分类契约

新增：

```ts
type SelectionIntent = 'image-insert' | 'other';
```

结构化输出只含：

```ts
{
  intent: 'image-insert' | 'other';
}
```

`image-insert` 的语义是：用户明确要求现在生成一张解释性图片，并把它插入当前选区附近。以下均为 `other`：

- 询问系统是否有能力生成图片；
- 教程、假设、否定或取消请求；
- 解释选区中已有图片；
- 只要求提供 prompt，但不要求插入正文；
- 普通问答。

分类输入包含原始用户问题，不包含拼接后的 Passage 文本，避免引用内容干扰意图。结构化选区本身只作为“该请求具备可信锚点”的事实，不把正文发送给分类器。

### 5.2 路由顺序

```text
解析请求
  -> 若 selection 存在，LLM classifySelectionIntent(question)
  -> image-insert + reshape：确定性提示切回 Original
  -> image-insert + canonical：query:propose
  -> other：沿用既有 resolveQueryMode，且不因选区开放配图工具
  -> 编译对应 ToolProfile
  -> 运行主 Query
```

前端当前把 Passage 与问题拼成 `backendQuestion`。为避免分类器看到大段引用文本，API body 增加可选 `userQuestion`，仅用于意图分类与会话标题/持久化；`question` 继续作为主 Query 上下文。服务端严格校验两者，客户端统一发送原始输入。

### 5.3 失败策略

`classifySelectionIntent` 捕获 LLM 调用错误并返回 `other`，记录一条不含正文/选区内容的 warning。失败不会返回 500，也不会打开 `query:propose`。

请求被客户端取消时不应继续启动主 Query；分类调用沿用 `query` task 的超时约束。本阶段不新增 LLM task 或配置项，避免要求用户修改 `llm-config.json`。

### 5.4 Prompt 与工具一致性

把 Agentic Query prompt 改为按 mode 构建：

- `read` prompt 不列出 mutation-only 工具；
- `propose` prompt 才列出审批提案工具；
- `wiki_image_insert` 仅在 canonical 选区的 `image-insert` 分类结果下出现。

这避免模型把“文档里描述的条件可用工具”误认为运行时应该存在。

## 六、安全边界

- 分类结果不是授权凭证；只有 canonical `selection` 加 `image-insert` 结果才能选择 propose profile。
- `wiki.image.insert` handler 仍从 `ToolContext` 读取可信 page slug 和 block anchor。
- Query 仍没有 `image.generate` 或页面写工具。
- PendingAction 批准后才生图和写入正文。
- 分类失败只会减少能力，不会扩大能力。

## 七、成功标准

1. “在这下面生成一张图片说明”被 LLM 分类结果驱动进入 canonical propose 流程。
2. 同义表达不再依赖正则枚举。
3. 否定、能力询问和解释图片仍保持 read。
4. Reshape 配图请求仍不调用主 Query。
5. 分类失败时主 Query 使用 read profile。
6. read prompt 不出现 `wiki_image_insert`，实际工具与提示词一致。

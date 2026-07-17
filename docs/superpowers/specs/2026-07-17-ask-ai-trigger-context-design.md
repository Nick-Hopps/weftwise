# Ask AI 触发定位、新会话与用户引用设计

## 背景

Ask AI 已迁移为可拖动悬浮工作面，但当前触发语义仍有三处漂移：

- 正文空白处双击传入的是指针坐标，定位层却把它当成“附近锚点”，额外偏移并在边缘翻转，导致面板左上角不在双击处。
- 无坐标入口首次打开固定在右上安全位，且打开动作不会结束当前会话；关闭后再次触发会继续旧对话。
- 正文选区和手动 Passage 引用只在输入框发送前可见，用户消息入列与会话持久化时都不保存引用关系。

## 目标

- 桌面空白处双击时，面板左上角使用双击坐标；只有为保证面板可操作时才做视口约束。
- Header、Dashboard、快捷键等无坐标入口优先复用上次面板位置；没有历史位置时居中。
- 每次“打开 Ask AI”都进入一段新的空白会话；首条消息发送后仍由既有 `/api/query` 按需创建持久化会话，避免产生空会话记录。
- 用户消息携带正文引用时，在消息中展示一个可点击胶囊，以“页面标题 · 章节/短摘要”说明引用位置；不展开完整选中文字，重新打开历史会话后仍能恢复。
- 保留选区末端附近定位、拖动、移动端 Sheet、SSE、审批卡片和会话切换能力。

## 非目标

- 不改变 Assistant 回答引用的确定性提取逻辑。
- 不新增“打开面板即创建会话”的 API，也不保存没有任何消息的空会话。
- 不扩展为跨页面引用选择器；本轮用户引用仍来自当前阅读页。
- 不持久化面板位置到浏览器刷新之后；“上次位置”指当前应用会话内最近一次定位或拖动位置。

## 方案比较

### 方案 A：只在入口处清空 `currentConversationId`

优点：改动最小。

缺点：当 ID 本来就是 `null` 时 React 不会观察到新触发；输入、临时引用、消息和进行中的 SSE 可能残留。用户引用若只放在前端消息对象中，历史会话重载后也会丢失。

### 方案 B：触发代次 + 角色区分的消息证据（推荐）

每次打开时递增非持久化的 `askAiInvocationId`，同时清空 `currentConversationId`。悬浮面板用该代次作为聊天工作面的 React `key`，从而在新触发时重建局部会话状态并取消旧实例中的流。服务端继续在首条消息到达时创建会话。

用户引用使用独立 `UserMessageReference` 契约；数据库复用 `messages.citations_json` 作为消息证据 JSON 容器，并由消息角色决定反序列化为用户引用或 Assistant 引用，不做数据库迁移。

优点：新会话边界明确；即使当前 ID 已为空也能重置；旧流不会串入新会话；引用可持久恢复；不产生空会话。

缺点：`citations_json` 的历史列名比实际语义更窄，需要在 repo 文档中明确它现在承载角色相关的消息证据。

### 方案 C：每次触发都调用服务端创建会话

优点：会话 ID 在打开瞬间就稳定存在。

缺点：会产生大量未发送消息的空会话；打开依赖网络；需要额外清理策略和失败态，超出本次需求。

## 推荐设计

采用方案 B。

### 1. 触发状态

`ui-store` 增加两项瞬态状态：

- `askAiAnchorMode: 'trigger' | 'selection' | null`：区分“面板左上角就是触发点”和“面板出现在选区附近”。
- `askAiInvocationId: number`：每次 `openAskAi` 或 `askAboutSelection` 调用递增。

所有打开动作同时把 `currentConversationId` 设为 `null`。普通打开清掉未消费的旧选区信箱；选区打开原子写入新的信箱。关闭只改变可见性和锚点，不清除最后位置。

聊天内容以 `askAiInvocationId` 为 `key`。关闭时仍保留原实例，使后台流可以继续；下次重新触发时才卸载旧实例、取消旧流并得到真正的空白会话。

### 2. 桌面定位

定位分为三条互斥路径：

1. `trigger`：以双击坐标作为候选左上角，再用 16px 安全区约束；常规位置下最终 `left/top` 与指针坐标完全相同。
2. `selection`：延续现有“选区末端外偏 16px，空间不足时翻转”的附近定位，避免遮挡选区。
3. 无锚点：已有 `askAiPosition` 时约束后复用；否则按面板实际尺寸在视口中居中。

移动端继续忽略桌面坐标，统一打开 Bottom Sheet。

### 3. 用户引用契约

新增 `UserMessageReference`：

```ts
interface UserMessageReference {
  pageSlug: string;
  pageTitle?: string;
  subjectSlug: string;
  section: string | null;
  excerpt: string;
}
```

客户端发送时从已固定的 Passage 生成即时展示对象，并在 `/api/query` body 中发送有界的 `messageReferences`（只含章节与摘录）。服务端用已经解析的 Subject 和当前 `pageSlug` 补全可信页面身份，并从页面仓库读取标题快照后持久化；客户端不能通过该字段伪造跨 Subject 跳转。旧引用缺少 `pageTitle` 时回退为解码后的 slug。

`ConversationMessage` 同时暴露：

- `references`：仅用户消息有值；
- `citations`：仅 Assistant 消息有值。

旧消息 JSON 保持兼容：旧用户消息得到 `references: null`，旧 Assistant 引用继续按原格式读取。

### 4. 消息展示

用户消息正文上方最多展示一个紧凑胶囊，内容为“页面标题 · 摘要”。摘要优先使用章节名；章节缺失时将摘录压缩空白并截断到 36 个字符，绝不展示全部选中文字或引用数量。点击胶囊使用首个引用的 `citationHref()` 精确导航到对应页面。Assistant 消息继续使用现有可折叠 `Sources` 区块，二者不混用标签。

## 数据流

```text
触发入口
  -> ui-store: invocation + 1, conversationId = null, anchor mode/point
  -> FloatingPanel: 计算位置 + 用 invocation key 重建 Chat
  -> Chat: 消费选区信箱（若有）
  -> 用户发送: 本地 user message 携带 references
  -> POST /api/query: messageReferences + pageSlug
  -> route: Subject/page 补全 -> user evidence JSON
  -> messages.citations_json
  -> 历史会话 GET: role=user -> references；role=assistant -> citations
```

## 错误与边界

- 双击靠近右下角时，以面板完整可操作优先，左上角会被约束到安全区内。
- `messageReferences` 非空但缺少 `pageSlug` 时返回 400，不落库不创建会话。
- 引用数量、章节和摘录长度在 API schema 中设上限，避免把展示元数据变成无界存储。
- 旧会话切换仍由 ConversationSwitcher 驱动；只有新的 Ask AI 外部触发会强制进入新会话。
- 新触发发生在旧流进行中时，React key 变化触发旧 Chat 卸载，沿用现有清理逻辑中止请求和 reader。

## 成功标准

- 常规空白处双击后，面板 `left/top` 等于双击 `clientX/clientY`。
- 首次无坐标打开时居中；拖动或锚点打开并关闭后，无坐标入口复用最后位置。
- 连续两次触发即使会话尚未发送过消息，也得到两个独立的空白聊天工作面；旧 SSE 不写入新实例。
- 选区或 Passage 引用在发送后的用户消息中以单个“页面标题 · 章节/短摘要”胶囊提示，并在历史会话重载后保持；消息块不展开完整选中文字。
- 旧 Assistant citations、选区配图结构化 selection、审批卡片和移动端 Sheet 行为不回归。

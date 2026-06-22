# 对话持久化 + 多轮记忆（Conversation Persistence）设计

> 日期：2026-06-22
> 状态：已确认，待写实现计划
> 关联：特性序列第 ⑦ 项「对话持久化」

---

## 一、背景与动机

现状勘察结论（已核实）：

- chat 消息 = `src/components/chat/chat-interface.tsx` 的 `useState<ChatMessage[]>`，纯 React 内存态，**刷新/卸载即丢**。
- 每次 `POST /api/query`（默认流式模式）是**无状态**的：body 只发 `question`（单条），LLM 只看「当前问题 + FTS 上下文」，**不含历史轮次**。当前"对话"只是 UI 累积的独立问答对。
- 流式模式 = `ReadableStream` SSE：emit `answer-delta`（多次）→ `citations` → `done { subjectId }`；服务端已累积 `fullAnswer`，`citations` 由 `generateQueryCitations` 二次调用算出。
- chat 只活在右侧上下文面板的 chat tab（`context-panel-chat-tab.tsx` 内嵌 `chat-interface`），**无独立 chat 页**。
- 无任何 conversation/message 表；`save-to-wiki` / save-as-page 是另走的一次性模式。
- `streamQueryAnswer(systemPrompt, question, context, subject, signal)` 走 `streamTextResponse('query', system, buildQueryUserPrompt(question, context, ctx), signal)`；`buildQueryUserPrompt(question, relevantPages, ctx)` 在 `query-prompt.ts:66`。
- `ChatMessage = { role: 'user'|'assistant'; content: string; citations?: Citation[] }`，`Citation = { pageSlug; excerpt }`（`message-list.tsx`）。
- `ui-store` 当前 `version: 4`，`migratePersisted` 处理历史版本，`partialize` 持久化 `currentSubjectId/Slug` 等；`setCurrentSubject` 在 `set({ currentSubjectId, currentSubjectSlug })`。

---

## 二、范围（v1）

> **新增 `conversations`/`messages` 表持久化每轮问答（含 citations）；chat tab 顶部加紧凑切换器（New / 选历史会话 / 重命名 / 删除）；同时打通多轮记忆——把本会话近期历史轮次喂给 LLM。全程 subject-scoped。**

### 已定决策

1. **多轮记忆纳入 v1**（非仅持久化）：`streamQueryAnswer` + `buildQueryUserPrompt` 接受本会话近期历史，渲染为 prompt 内一个有界 transcript 段。
2. **多轮注入走 prompt transcript 段**：不改 `streamTextResponse` 单 prompt 签名（最小侵入）；`generateQueryCitations` 不接历史（引用只关乎当前答案对页的引用）。
3. **管理入口 = chat tab 内紧凑切换器**：不新增页面，复用现有 `chat-interface`。
4. **命名 = 确定性派生 + 手动重命名**：新会话标题从首个 user 问题派生（截首行 ≤60 字，无额外 LLM 调用）；切换器内可手动重命名（PATCH）。
5. **创建走 `/api/query` 隐式**：无 `conversationId` 时服务端创建会话；不单设 `POST /api/conversations`（YAGNI）。
6. **持久化 best-effort**：流末（`fullAnswer` + citations 就绪）落库；客户端中断则 user 消息已存、assistant 可能未存——可接受。
7. **FTS 仍按当前问题检索**：纯追问（如"再讲讲"）可能命中 0 上下文仍回 `NO_QUERY_CONTEXT_ANSWER`；v1 接受，FTS 拼接近期问题列为后续。

### 明确不做（YAGNI）

- 独立 `(app)/chat` 页（管理入口走 chat tab 切换器）。
- LLM 生成会话标题（确定性派生足够）。
- 显式 `POST /api/conversations`（隐式创建）。
- FTS 检索拼接历史问题（追问语义增强，后续）。
- 跨会话/全文搜索会话历史、会话导出。
- save-to-wiki / save-as-page 模式的对话持久化（一次性保存，不变）。

---

## 三、架构与数据流

### 新表（`db/schema.ts` + `db/client.ts::ensureTables`，无 legacy 迁移）

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,            -- 'user' | 'assistant'
  content TEXT NOT NULL,
  citations_json TEXT,          -- assistant 的 Citation[]（JSON）；user 为 NULL
  created_at TEXT NOT NULL
);
```

> `ON DELETE CASCADE`：会话随 subject 删除而级联（会话是可丢弃数据，不像 jobs/operations 用 SET NULL）；messages 随 conversation 级联。`foreign_keys=ON` 已开启。

### 查询流（`POST /api/query` 默认流式模式扩展）

```
body 增 conversationId?: string（无 = 新会话）
  ├─ resolveSubjectFromRequest（不变）
  ├─ 解析/校验 conversationId：若提供，conversationsRepo.getConversation → 必须存在且 subjectId===subject.id，否则按"新会话"处理（防跨 subject 注入）
  ├─ 确定 activeConversationId：
  │     有效传入 → 用之
  │     否则 → conversationsRepo.create(subject.id, deriveConversationTitle(question))
  ├─ history = conversationsRepo.listMessages(activeConversationId) 取末 MAX_HISTORY_MESSAGES(=8) 条 → [{role,content}]
  ├─ context = prepareQueryContext(question, subject.id, pageSlug)（FTS 仍按当前问题，不变）
  ├─ 流式：streamQueryAnswer(system, question, context, subject, signal, history) → 累积 fullAnswer + emit answer-delta
  │     （context.length===0 分支：emit NO_QUERY_CONTEXT_ANSWER；fullAnswer 取该兜底文案）
  ├─ citations = generateQueryCitations(question, fullAnswer, context, subject)（不传 history）→ emit citations
  ├─ 落库（best-effort，try/catch 包裹，失败仅 log 不影响响应）：
  │     conversationsRepo.appendMessage(activeConversationId, 'user', question, null)
  │     conversationsRepo.appendMessage(activeConversationId, 'assistant', fullAnswer, JSON.stringify(citations))
  │     conversationsRepo.touch(activeConversationId)  -- 更新 updated_at
  └─ emit done { subjectId, conversationId: activeConversationId }
```

> save-as-page / save-to-wiki 分支：完全不变，不持久化对话。

### 会话管理路由（subject-scoped）

```
GET    /api/conversations            requireAuth                列表（updated_at DESC）：[{ id, title, updatedAt }]
GET    /api/conversations/[id]       requireAuth                会话详情 + messages（跨 subject → 404）
PATCH  /api/conversations/[id]       requireAuth + requireCsrf  重命名 { title }（跨 subject → 404；空 title → 400）
DELETE /api/conversations/[id]       requireAuth + requireCsrf  删除（级联删 messages；跨 subject → 404）
```

> `/api/conversations*` 不在 `useApiFetch` 的 `SUBJECT_AGNOSTIC` 列表 → GET 自动注入 `?subjectId`；写操作 body 带 `subjectId`。

### 多轮注入（最小侵入）

```
buildQueryUserPrompt(question, relevantPages, ctx, history?: {role,content}[])
  history 非空 → 在 "## User question" 段之前插入：
    ## Conversation so far
    **User**: ...
    **Assistant**: ...
    （末 MAX_HISTORY_MESSAGES 条，由调用方截断后传入）
streamQueryAnswer(..., history?) → buildQueryUserPrompt(question, context, ctx, history)
generateQueryCitations 调用 buildQueryUserPrompt 时不传 history（默认 []）
```

### 前端（chat tab 内）

```
ui-store（v4 → v5 迁移）:
  + currentConversationId: string | null
  + setCurrentConversation(id: string | null)
  setCurrentSubject 内重置 currentConversationId = null（切 subject 清空当前会话）
  partialize 持久化 currentConversationId；migrate v4→v5 默认 null

conversation-switcher.tsx（新，chat tab 顶部）:
  - React Query ['conversations', subjectId] 拉 GET /api/conversations
  - 显示当前会话标题 + 下拉：New（setCurrentConversation(null) + 清空 chat-interface 消息）/ 选历史 / 重命名（PATCH）/ 删除（DELETE）
  - 删除当前会话 → 回落最近会话或 null

chat-interface.tsx（改）:
  - 监听 currentConversationId：变化时若非 null，GET /api/conversations/[id] 载入 messages → setMessages；null → 清空
  - 发送：body 带 conversationId = currentConversationId
  - done 事件：读 conversationId → setCurrentConversation(id) + invalidate ['conversations', subjectId]

context-panel-chat-tab.tsx（改）: 顶部嵌入 <ConversationSwitcher/>
```

---

## 四、改动契约

### `src/lib/contracts.ts`（新增）

```ts
export interface Conversation {
  id: string;
  subjectId: SubjectId;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  citations: { pageSlug: string; excerpt: string }[] | null;
  createdAt: string;
}
```

### `src/server/db/repos/conversations-repo.ts`（新，原生 better-sqlite3）

```ts
export function createConversation(subjectId: string, title: string): Conversation;
export function listConversations(subjectId: string): Conversation[];      // updated_at DESC
export function getConversation(id: string): Conversation | null;          // 不限 subject，调用方守卫
export function renameConversation(id: string, title: string): void;       // 同时 touch updated_at
export function deleteConversation(id: string): void;                      // 级联删 messages（FK）
export function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  citationsJson: string | null,
): ConversationMessage;
export function listMessages(conversationId: string): ConversationMessage[]; // created_at/rowid ASC
export function touchConversation(id: string): void;                       // 更新 updated_at = now
```

### `src/server/wiki/` 或 `services/` 纯函数 `deriveConversationTitle`

放 `src/server/services/conversation-title.ts`（纯函数，可测）：

```ts
// 取首行、trim、折叠空白、截 ≤60 字；空/全空白兜底 'New conversation'
export function deriveConversationTitle(question: string): string;
```

### `src/server/llm/prompts/query-prompt.ts`（改）

```ts
buildQueryUserPrompt(
  question: string,
  relevantPages: { slug; title; content; isCurrent? }[],
  ctx: PromptContext,
  history?: { role: 'user' | 'assistant'; content: string }[],   // ← 新增，默认 []
): string
// history 非空时在 "## User question" 前插入 "## Conversation so far" transcript 段
```

### `src/server/services/query-service.ts`（改）

```ts
streamQueryAnswer(systemPrompt, question, context, subject, abortSignal?, history?)   // ← 加 history 透传给 buildQueryUserPrompt
// generateQueryCitations 不变（buildQueryUserPrompt 不传 history）
```

### `src/app/api/query/route.ts`（改，仅默认流式分支）

- body schema 加 `conversationId: z.string().optional()`。
- 流式前：解析/校验 conversationId（跨 subject 视作新会话）→ 确定 activeConversationId（必要时 create）→ 取 history（末 8 条）。
- 流式：`streamQueryAnswer(..., history)`。
- citations 后：`appendMessage`×2 + `touchConversation`（try/catch best-effort）。
- `done` 事件数据：`{ subjectId, conversationId: activeConversationId }`。

### `src/app/api/conversations/route.ts`（新）`GET`；`src/app/api/conversations/[id]/route.ts`（新）`GET`/`PATCH`/`DELETE`

### `src/stores/ui-store.ts`（改）

- 加 `currentConversationId: string | null` + `setCurrentConversation`；`version: 5` + migrate v4→v5（默认 null）；`partialize` 加该字段；`setCurrentSubject` 内重置为 null。

### 前端组件

- `src/components/chat/conversation-switcher.tsx`（新）
- `src/components/chat/chat-interface.tsx`（改：载入/保存/切换接线）
- `src/components/layout/context-panel-chat-tab.tsx`（改：嵌入 switcher）

---

## 五、新增 / 改动文件清单

| 文件 | 类型 |
|------|------|
| `src/lib/contracts.ts` | 改（Conversation / ConversationMessage）|
| `src/server/db/schema.ts` + `src/server/db/client.ts` | 改（两表 ensureTables）|
| `src/server/db/repos/conversations-repo.ts` | 新 |
| `src/server/db/repos/__tests__/conversations-repo.test.ts` | 新 |
| `src/server/services/conversation-title.ts` | 新（纯函数）|
| `src/server/services/__tests__/conversation-title.test.ts` | 新 |
| `src/server/llm/prompts/query-prompt.ts` | 改（history transcript 段）|
| `src/server/llm/prompts/__tests__/query-prompt.test.ts` | 改（加 history 渲染用例）|
| `src/server/services/query-service.ts` | 改（streamQueryAnswer 透传 history）|
| `src/app/api/query/route.ts` | 改（conversationId + 落库 + done 回传）|
| `src/app/api/conversations/route.ts` | 新（GET 列表）|
| `src/app/api/conversations/[id]/route.ts` | 新（GET/PATCH/DELETE）|
| `src/app/api/conversations/[id]/__tests__/route.test.ts` | 新 |
| `src/app/api/conversations/__tests__/route.test.ts` | 新 |
| `src/stores/ui-store.ts` | 改（currentConversationId + v5）|
| `src/components/chat/conversation-switcher.tsx` | 新 |
| `src/components/chat/chat-interface.tsx` | 改 |
| `src/components/layout/context-panel-chat-tab.tsx` | 改 |

> 不改 Saga / git / provider-registry 签名 / `seedSkillFiles`。

---

## 六、测试（node-only 优先）

1. **`conversations-repo`**（临时库夹具，FK 开启故先插 subjects）：create/list(updated_at DESC)/appendMessage+listMessages(ASC)/rename(+touch)/delete 级联删 messages/getConversation 跨 subject 仍返回（守卫在路由）。
2. **`deriveConversationTitle`**（纯函数）：取首行、折叠空白、截 ≤60、空/全空白 → 'New conversation'、含换行只取首行。
3. **`buildQueryUserPrompt` history 段**（扩 query-prompt.test）：history 为空 → 无 "Conversation so far" 段；非空 → 段存在且含 user/assistant 标注、置于 User question 之前；既有语言指令用例不回归。
4. **conversations 路由**：GET 列表（mock repo）；GET [id] 跨 subject → 404；PATCH 空 title → 400、跨 subject → 404；DELETE 跨 subject → 404。
5. **/api/query 持久化接线**：偏集成；窄 mock 测试——传 conversationId 跨 subject → 当作新会话（create 被调）；done 事件含 conversationId。多轮 LLM 行为眼测。
6. 切换器 UI、载入/切换/删除回落：眼测。

> 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，非门禁。

---

## 七、边界与已知取舍

- **持久化 best-effort**：落库在流末，客户端中断可能只存 user 消息；不做补偿。
- **多轮 FTS 局限**：FTS 仍按当前问题，纯追问可能命中 0 上下文（回兜底文案）。v1 接受。
- **历史预算**：仅末 `MAX_HISTORY_MESSAGES=8` 条进 prompt（有界，防超长）；更细的 token 预算/摘要列为后续。
- **跨 subject 守卫**：会话/消息均 subject-scoped；`/api/conversations/[id]` 与 `/api/query` 的 conversationId 都做 `conv.subjectId === subject.id` 校验（query 不匹配时静默当新会话，避免泄漏他 subject 历史）。
- **currentConversationId 持久化**：刷新后按持久化 id 载入；若该 id 在当前 subject 下 404（切了 subject / 被删）→ 客户端回落最近会话或新会话态。
- save-as-page / save-to-wiki 模式不持久化对话（一次性保存，不变）。

## 八、不变量与依赖

- 不改 Saga / git-service / `streamTextResponse` 签名 / provider 路由 / `seedSkillFiles`。
- 多轮历史只在流式答案 prompt 注入；citations 调用不接历史。
- 前端数据请求一律 `useApiFetch()`；写操作 body 显式带 `subjectId` 并经 `requireCsrf`。
- 会话/消息严格 subject-scoped（conversations.subject_id），删 subject 级联清理。
- commit message 中文一句话；禁止任何 AI 署名 trailer / 脚注。

# 对话持久化 + 多轮记忆 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 持久化每轮问答（conversations/messages 表）+ chat tab 内会话切换器（New/选/重命名/删除）+ 多轮记忆（把本会话近期历史喂给 LLM）。

**Architecture:** 新增两张 subject-scoped 表 + conversations-repo；`/api/query` 默认流式分支接 `conversationId`（无则建会话）、载末 8 条历史注入 `buildQueryUserPrompt` 的 transcript 段、流末 best-effort 落库、`done` 回传 conversationId；会话 CRUD 走新路由；前端切换器 + ui-store `currentConversationId`(v5)。

**Tech Stack:** Next.js 15 App Router + React 19；better-sqlite3 原生 SQL；Vercel AI SDK streamText；Zustand persist；TanStack Query；vitest（node-only）。

关联 spec：`docs/superpowers/specs/2026-06-22-conversation-persistence-design.md`。

## Global Constraints

- 思考英文；task/plan/spec/comment/commit message 用**中文**；commit message 一句话；**禁止任何 AI 署名 trailer/脚注**（无 `Co-Authored-By`、无 "Generated with Claude Code"）。
- 门禁 = `npx tsc --noEmit` 0 + `npx vitest run` 全绿；`npm run lint` BASE 即坏，**非**门禁。
- **不**改 Saga / git-service / `streamTextResponse` 签名 / provider 路由 / `seedSkillFiles`；新表无 legacy 迁移（仅 `tableExists` 守卫的 CREATE）。
- 会话/消息严格 subject-scoped（`conversations.subject_id`，ON DELETE CASCADE）；`messages.conversation_id` ON DELETE CASCADE；`foreign_keys=ON`（测试须先插 subjects）。
- 多轮历史只在**流式答案** prompt 注入（`buildQueryUserPrompt` 的 `history` 参）；`generateQueryCitations` 不接历史。
- 路由：写操作 `requireAuth`+`requireCsrf`+`resolveSubjectFromRequest({required:true, body})`；只读 `requireAuth`+`resolveSubjectFromRequest({required:true})`。跨 subject 访问会话 → 404；`/api/query` 的 conversationId 跨 subject → 静默当新会话。
- `operations.changeset_json` 等既有约定不变。`conversations.changeset` 无关。
- 前端数据请求一律 `useApiFetch()`（GET 自动注入 subjectId）；写操作 body 显式带 `subjectId`。
- 持久化 best-effort：落库在流末，try/catch 包裹，失败仅 log 不影响响应。

---

### Task 1: 持久化层（contracts + 两表 + conversations-repo）

**Files:**
- Modify: `src/lib/contracts.ts`（加 `Conversation` / `ConversationMessage`，建议在 `Changeset` 之后、`HistoryEntry` 附近）
- Modify: `src/server/db/schema.ts`（加 Drizzle `conversations` / `messages` 表声明）
- Modify: `src/server/db/client.ts`（加 `migrateConversations()` / `migrateMessages()` 并在 `ensureTables` 注册）
- Create: `src/server/db/repos/conversations-repo.ts`
- Test: `src/server/db/repos/__tests__/conversations-repo.test.ts`

**Interfaces:**
- Produces（contracts）:
  ```ts
  interface Conversation { id: string; subjectId: SubjectId; title: string; createdAt: string; updatedAt: string }
  interface ConversationMessage { id: string; conversationId: string; role: 'user'|'assistant'; content: string; citations: { pageSlug: string; excerpt: string }[] | null; createdAt: string }
  ```
- Produces（repo）:
  ```ts
  createConversation(subjectId: string, title: string): Conversation
  listConversations(subjectId: string): Conversation[]          // updated_at DESC
  getConversation(id: string): Conversation | null              // 不限 subject
  renameConversation(id: string, title: string): void           // 同时 touch updated_at
  deleteConversation(id: string): void
  appendMessage(conversationId: string, role: 'user'|'assistant', content: string, citationsJson: string | null): ConversationMessage
  listMessages(conversationId: string): ConversationMessage[]   // created_at/rowid ASC
  touchConversation(id: string): void                           // updated_at = now
  ```
- Consumes: `getRawDb`（`../client`）；id 用 `crypto.randomUUID()`；时间用 `new Date().toISOString()`。

- [ ] **Step 1: contracts 加类型**

在 `src/lib/contracts.ts` 的 `HistoryEntry` 之后追加：

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

- [ ] **Step 2: Drizzle schema 加表**

在 `src/server/db/schema.ts` 末尾追加（紧跟 `ingestCheckpoints` 之后）：

```ts
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  subjectId: text('subject_id')
    .notNull()
    .references(() => subjects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  citationsJson: text('citations_json'),
  createdAt: text('created_at').notNull(),
});
```

- [ ] **Step 3: client.ts 建表 + 注册**

在 `src/server/db/client.ts` 的 `migrateIngestCheckpoints` 之后追加两个函数：

```ts
function migrateConversations(): void {
  const sqlite = rawSqlite!;
  if (tableExists('conversations')) return;
  sqlite.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function migrateMessages(): void {
  const sqlite = rawSqlite!;
  if (tableExists('messages')) return;
  sqlite.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
}
```

在 `ensureTables` 内 `migrateIngestCheckpoints();` 之后、`ensurePagesFts();` 之前插入：

```ts
    migrateConversations();
    migrateMessages();
```

- [ ] **Step 4: 写失败测试**

新建 `src/server/db/repos/__tests__/conversations-repo.test.ts`（夹具同 `operations-repo.test.ts`；FK 开启故先插 subjects；slug 用 `sub-a`/`sub-b` 避开自动 seed 的 general）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conversations-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const { getRawDb } = await import('../../client');
  const db = getRawDb();
  const sub = db.prepare(
    `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  );
  sub.run('s1', 'sub-a', 'Sub A', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  sub.run('s2', 'sub-b', 'Sub B', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  return import('../conversations-repo');
}

describe('conversations-repo', () => {
  it('create + list（仅本 subject）', async () => {
    const repo = await setup();
    const c1 = repo.createConversation('s1', '问题 A');
    repo.createConversation('s2', '别的 subject');
    expect(c1.subjectId).toBe('s1');
    expect(c1.title).toBe('问题 A');
    const list = repo.listConversations('s1');
    expect(list.map((c) => c.id)).toEqual([c1.id]);
  });

  it('listConversations 按 updated_at DESC（touch 后置顶）', async () => {
    const repo = await setup();
    const a = repo.createConversation('s1', 'A');
    const b = repo.createConversation('s1', 'B');
    // b 较新 → 先返回；touch a 后 a 置顶
    expect(repo.listConversations('s1').map((c) => c.id)).toEqual([b.id, a.id]);
    repo.touchConversation(a.id);
    expect(repo.listConversations('s1')[0].id).toBe(a.id);
  });

  it('appendMessage + listMessages（ASC，citations 反序列化）', async () => {
    const repo = await setup();
    const c = repo.createConversation('s1', 'A');
    repo.appendMessage(c.id, 'user', '问题', null);
    repo.appendMessage(c.id, 'assistant', '答案', JSON.stringify([{ pageSlug: 'p', excerpt: 'e' }]));
    const msgs = repo.listMessages(c.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0].citations).toBeNull();
    expect(msgs[1].citations).toEqual([{ pageSlug: 'p', excerpt: 'e' }]);
  });

  it('renameConversation 改标题', async () => {
    const repo = await setup();
    const c = repo.createConversation('s1', '旧');
    repo.renameConversation(c.id, '新');
    expect(repo.getConversation(c.id)?.title).toBe('新');
  });

  it('deleteConversation 级联删 messages', async () => {
    const repo = await setup();
    const c = repo.createConversation('s1', 'A');
    repo.appendMessage(c.id, 'user', '问题', null);
    repo.deleteConversation(c.id);
    expect(repo.getConversation(c.id)).toBeNull();
    expect(repo.listMessages(c.id)).toEqual([]);
  });

  it('getConversation 未知 id → null', async () => {
    const repo = await setup();
    expect(repo.getConversation('nope')).toBeNull();
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/conversations-repo.test.ts`
Expected: FAIL（找不到模块 `../conversations-repo`）

- [ ] **Step 6: 实现 repo**

新建 `src/server/db/repos/conversations-repo.ts`：

```ts
import { getRawDb } from '../client';
import type { Conversation, ConversationMessage } from '@/lib/contracts';

interface RawConv {
  id: string;
  subject_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
interface RawMsg {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  citations_json: string | null;
  created_at: string;
}

function mapConv(r: RawConv): Conversation {
  return {
    id: r.id,
    subjectId: r.subject_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapMsg(r: RawMsg): ConversationMessage {
  let citations: ConversationMessage['citations'] = null;
  if (r.citations_json) {
    try {
      const parsed = JSON.parse(r.citations_json);
      if (Array.isArray(parsed)) citations = parsed;
    } catch {
      citations = null;
    }
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content,
    citations,
    createdAt: r.created_at,
  };
}

export function createConversation(subjectId: string, title: string): Conversation {
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: crypto.randomUUID(),
    subjectId,
    title,
    createdAt: now,
    updatedAt: now,
  };
  getRawDb()
    .prepare(
      `INSERT INTO conversations (id, subject_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`,
    )
    .run(conv.id, conv.subjectId, conv.title, conv.createdAt, conv.updatedAt);
  return conv;
}

export function listConversations(subjectId: string): Conversation[] {
  const rows = getRawDb()
    .prepare(
      `SELECT id, subject_id, title, created_at, updated_at FROM conversations
       WHERE subject_id = ? ORDER BY updated_at DESC, rowid DESC`,
    )
    .all(subjectId) as RawConv[];
  return rows.map(mapConv);
}

export function getConversation(id: string): Conversation | null {
  const r = getRawDb()
    .prepare(`SELECT id, subject_id, title, created_at, updated_at FROM conversations WHERE id = ?`)
    .get(id) as RawConv | undefined;
  return r ? mapConv(r) : null;
}

export function renameConversation(id: string, title: string): void {
  getRawDb()
    .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, new Date().toISOString(), id);
}

export function deleteConversation(id: string): void {
  getRawDb().prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

export function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  citationsJson: string | null,
): ConversationMessage {
  const msg: RawMsg = {
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    role,
    content,
    citations_json: citationsJson,
    created_at: new Date().toISOString(),
  };
  getRawDb()
    .prepare(
      `INSERT INTO messages (id, conversation_id, role, content, citations_json, created_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(msg.id, msg.conversation_id, msg.role, msg.content, msg.citations_json, msg.created_at);
  return mapMsg(msg);
}

export function listMessages(conversationId: string): ConversationMessage[] {
  const rows = getRawDb()
    .prepare(
      `SELECT id, conversation_id, role, content, citations_json, created_at FROM messages
       WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(conversationId) as RawMsg[];
  return rows.map(mapMsg);
}

export function touchConversation(id: string): void {
  getRawDb()
    .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}
```

> 注意：`listConversations` 用 `ORDER BY updated_at DESC, rowid DESC`——同一毫秒（同 ISO 字符串）下用 rowid 兜底稳定排序（测试里 create 顺序 a→b，updated_at 相同则 b 的 rowid 大→先返回）。

- [ ] **Step 7: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/server/db/repos/__tests__/conversations-repo.test.ts`
Expected: PASS（6 个用例）

```bash
npx tsc --noEmit
git add src/lib/contracts.ts src/server/db/schema.ts src/server/db/client.ts src/server/db/repos/conversations-repo.ts src/server/db/repos/__tests__/conversations-repo.test.ts
git commit -m "feat: 对话持久化层（conversations/messages 表 + conversations-repo + 契约）"
```

---

### Task 2: `deriveConversationTitle` 纯函数

**Files:**
- Create: `src/server/services/conversation-title.ts`
- Test: `src/server/services/__tests__/conversation-title.test.ts`

**Interfaces:**
- Produces: `export function deriveConversationTitle(question: string): string`（取首行、折叠空白、trim、截 ≤60；空/全空白 → `'New conversation'`）。

- [ ] **Step 1: 写失败测试**

新建 `src/server/services/__tests__/conversation-title.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { deriveConversationTitle } from '../conversation-title';

describe('deriveConversationTitle', () => {
  it('普通问题原样（trim）', () => {
    expect(deriveConversationTitle('  什么是向量检索  ')).toBe('什么是向量检索');
  });
  it('只取首行', () => {
    expect(deriveConversationTitle('第一行问题\n第二行补充')).toBe('第一行问题');
  });
  it('折叠内部多空白为单空格', () => {
    expect(deriveConversationTitle('a    b\tc')).toBe('a b c');
  });
  it('超 60 字截断', () => {
    const long = 'x'.repeat(80);
    expect(deriveConversationTitle(long)).toHaveLength(60);
  });
  it('空 / 全空白 → 兜底', () => {
    expect(deriveConversationTitle('')).toBe('New conversation');
    expect(deriveConversationTitle('   \n  ')).toBe('New conversation');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/services/__tests__/conversation-title.test.ts`
Expected: FAIL（找不到模块 `../conversation-title`）

- [ ] **Step 3: 实现**

新建 `src/server/services/conversation-title.ts`：

```ts
const MAX_TITLE_LEN = 60;

/** 从首个用户问题派生会话标题：取首行、折叠空白、trim、截 ≤60；空则兜底。 */
export function deriveConversationTitle(question: string): string {
  const firstLine = (question ?? '').split('\n')[0] ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return 'New conversation';
  return collapsed.slice(0, MAX_TITLE_LEN);
}
```

- [ ] **Step 4: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/server/services/__tests__/conversation-title.test.ts`
Expected: PASS（5 个用例）

```bash
npx tsc --noEmit
git add src/server/services/conversation-title.ts src/server/services/__tests__/conversation-title.test.ts
git commit -m "feat: deriveConversationTitle 纯函数（会话标题确定性派生）"
```

---

### Task 3: 多轮 prompt（`buildQueryUserPrompt` history 段 + `streamQueryAnswer` 透传）

**Files:**
- Modify: `src/server/llm/prompts/query-prompt.ts`（`buildQueryUserPrompt` 加可选 `history` 参 + 渲染 transcript 段）
- Modify: `src/server/services/query-service.ts`（`streamQueryAnswer` 加可选 `history` 参并透传）
- Test: `src/server/llm/prompts/__tests__/query-prompt.test.ts`（加 history 渲染用例，不破坏既有语言指令用例）

**Interfaces:**
- Consumes: 既有 `buildQueryUserPrompt(question, relevantPages, ctx)`（`query-prompt.ts:66`）、`streamQueryAnswer(systemPrompt, question, context, subject, abortSignal?)`（`query-service.ts`）。
- Produces:
  ```ts
  buildQueryUserPrompt(question, relevantPages, ctx, history?: { role: 'user'|'assistant'; content: string }[]): string
  streamQueryAnswer(systemPrompt, question, context, subject, abortSignal?, history?: { role:'user'|'assistant'; content:string }[])
  ```
  `history` 非空 → 在 "## User question" 段之前插入 "## Conversation so far" transcript；默认 `[]`。

- [ ] **Step 1: 写失败测试**

在 `src/server/llm/prompts/__tests__/query-prompt.test.ts` 末尾（既有 describe 之后）追加：

```ts
import { describe as describe2, it as it2, expect as expect2 } from 'vitest';

describe2('buildQueryUserPrompt – conversation history', () => {
  const ctx = { language: 'English' as const };

  it2('history 为空 → 不含 "Conversation so far" 段', () => {
    const out = buildQueryUserPrompt('What is X?', [], ctx);
    expect2(out).not.toContain('Conversation so far');
  });

  it2('history 非空 → 含 transcript 段且置于 User question 之前', () => {
    const out = buildQueryUserPrompt('追问？', [], ctx, [
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '第一个回答' },
    ]);
    expect2(out).toContain('Conversation so far');
    expect2(out).toContain('第一个问题');
    expect2(out).toContain('第一个回答');
    // transcript 段在 "User question" 之前
    expect2(out.indexOf('Conversation so far')).toBeLessThan(out.indexOf('User question'));
  });
});
```

> 注意：本测试沿用文件顶部已 import 的 `buildQueryUserPrompt`；若文件顶部 import 名不同请对齐。`ctx` 形状参考既有用例（`ctxChinese`/`ctxEnglish`）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/query-prompt.test.ts`
Expected: FAIL（第 4 个参数不被接受 / 无 "Conversation so far"）

- [ ] **Step 3: 实现 query-prompt history 段**

修改 `src/server/llm/prompts/query-prompt.ts` 的 `buildQueryUserPrompt`：

1. 签名加第四参：

```ts
export function buildQueryUserPrompt(
  question: string,
  relevantPages: { slug: string; title: string; content: string; isCurrent?: boolean }[],
  ctx: PromptContext,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
): string {
```

2. 在函数内（`return` 之前）构造 transcript 段：

```ts
  const historySection =
    history.length === 0
      ? ''
      : `## Conversation so far
${history
  .map((m) => `**${m.role === 'assistant' ? 'Assistant' : 'User'}**: ${m.content}`)
  .join('\n\n')}

---

`;
```

3. 在返回模板里，把 `historySection` 插到 "## User question" 段之前。即把现有 return 的结尾结构改为：

```ts
  return `${languageDirective}${subjectSection}## Relevant wiki pages

${pagesSection}

---

${historySection}## User question
${currentPageHint}${question}`;
```

> 以现有文件实际 return 模板为准对齐（保留既有 `languageDirective`/`subjectSection`/`pagesSection`/`currentPageHint`/`question` 拼接），只在 "## User question" 前插入 `${historySection}`。

- [ ] **Step 4: query-service 透传 history**

修改 `src/server/services/query-service.ts` 的 `streamQueryAnswer`：

```ts
export function streamQueryAnswer(
  systemPrompt: string,
  question: string,
  context: QueryContextPage[],
  subject: Subject,
  abortSignal?: AbortSignal,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
) {
  const promptCtx: PromptContext = {
    language: getWikiLanguage(),
    subject: subjectCtxFrom(subject),
  };
  return streamTextResponse(
    'query',
    systemPrompt,
    buildQueryUserPrompt(question, context, promptCtx, history),
    abortSignal,
  );
}
```

> `generateQueryCitations` 不动（其 `buildQueryUserPrompt(...)` 调用不传 history，走默认 `[]`）。

- [ ] **Step 5: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/server/llm/prompts/__tests__/query-prompt.test.ts`
Expected: PASS（既有用例 + 2 个新用例）

```bash
npx tsc --noEmit
git add src/server/llm/prompts/query-prompt.ts src/server/services/query-service.ts src/server/llm/prompts/__tests__/query-prompt.test.ts
git commit -m "feat: 查询 prompt 注入多轮历史 transcript（streamQueryAnswer 透传 history）"
```

---

### Task 4: 会话 CRUD 路由

**Files:**
- Create: `src/app/api/conversations/route.ts`（GET 列表）
- Create: `src/app/api/conversations/[id]/route.ts`（GET 详情 / PATCH 重命名 / DELETE）
- Test: `src/app/api/conversations/__tests__/route.test.ts`
- Test: `src/app/api/conversations/[id]/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `requireAuth`/`requireCsrf`、`resolveSubjectFromRequest`、`conversations-repo`（Task 1）。
- Produces:
  - `GET /api/conversations` → `{ id, title, updatedAt }[]`（直接返回 `listConversations` 结果亦可，含全字段）。
  - `GET /api/conversations/[id]` → `{ conversation: Conversation, messages: ConversationMessage[] }`（跨 subject → 404）。
  - `PATCH /api/conversations/[id]` `{ title }` → 200（空 title → 400；跨 subject → 404）。
  - `DELETE /api/conversations/[id]` → 200（跨 subject → 404）。

- [ ] **Step 1: 写失败测试（列表）**

新建 `src/app/api/conversations/__tests__/route.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolve = vi.fn();
const mockList = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/conversations-repo', () => ({
  listConversations: (id: unknown) => mockList(id),
}));

import { GET } from '../route';

function call() {
  return GET(new NextRequest('http://localhost/api/conversations?subjectId=s1'));
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockList.mockReset();
});

describe('GET /api/conversations', () => {
  it('返回本 subject 会话列表', async () => {
    mockList.mockReturnValue([{ id: 'c1', subjectId: 's1', title: 'A', createdAt: 't', updatedAt: 't' }]);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json())[0].id).toBe('c1');
    expect(mockList).toHaveBeenCalledWith('s1');
  });

  it('subject 缺失 → 透传 error，不查 repo', async () => {
    mockResolve.mockReturnValue({ subject: null, error: NextResponse.json({ error: 'x' }, { status: 400 }) });
    expect((await call()).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/app/api/conversations/__tests__/route.test.ts`
Expected: FAIL（找不到 `../route`）

- [ ] **Step 3: 实现列表路由**

新建 `src/app/api/conversations/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as conversationsRepo from '@/server/db/repos/conversations-repo';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { subject, error } = resolveSubjectFromRequest(request, { required: true });
  if (error) return error;

  return NextResponse.json(conversationsRepo.listConversations(subject.id));
}
```

- [ ] **Step 4: 写失败测试（[id]）**

新建 `src/app/api/conversations/[id]/__tests__/route.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGet = vi.fn();
const mockList = vi.fn();
const mockRename = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/conversations-repo', () => ({
  getConversation: (id: unknown) => mockGet(id),
  listMessages: (id: unknown) => mockList(id),
  renameConversation: (id: unknown, t: unknown) => mockRename(id, t),
  deleteConversation: (id: unknown) => mockDelete(id),
}));

import { GET, PATCH, DELETE } from '../route';

function req(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/conversations/c1', {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}
const params = { params: Promise.resolve({ id: 'c1' }) };

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockGet.mockReset();
  mockGet.mockReturnValue({ id: 'c1', subjectId: 's1', title: 'A', createdAt: 't', updatedAt: 't' });
  mockList.mockReset();
  mockList.mockReturnValue([]);
  mockRename.mockReset();
  mockDelete.mockReset();
});

describe('GET /api/conversations/[id]', () => {
  it('返回会话 + messages', async () => {
    const res = await GET(req('GET'), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation.id).toBe('c1');
    expect(Array.isArray(body.messages)).toBe(true);
  });
  it('未知 → 404', async () => {
    mockGet.mockReturnValue(null);
    expect((await GET(req('GET'), params)).status).toBe(404);
  });
  it('跨 subject → 404', async () => {
    mockGet.mockReturnValue({ id: 'c1', subjectId: 's2', title: 'A', createdAt: 't', updatedAt: 't' });
    expect((await GET(req('GET'), params)).status).toBe(404);
  });
});

describe('PATCH /api/conversations/[id]', () => {
  it('重命名 → 200', async () => {
    const res = await PATCH(req('PATCH', { title: '新', subjectId: 's1' }), params);
    expect(res.status).toBe(200);
    expect(mockRename).toHaveBeenCalledWith('c1', '新');
  });
  it('空 title → 400，不改', async () => {
    const res = await PATCH(req('PATCH', { title: '   ', subjectId: 's1' }), params);
    expect(res.status).toBe(400);
    expect(mockRename).not.toHaveBeenCalled();
  });
  it('跨 subject → 404', async () => {
    mockGet.mockReturnValue({ id: 'c1', subjectId: 's2', title: 'A', createdAt: 't', updatedAt: 't' });
    expect((await PATCH(req('PATCH', { title: '新', subjectId: 's1' }), params)).status).toBe(404);
    expect(mockRename).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/conversations/[id]', () => {
  it('删除 → 200', async () => {
    const res = await DELETE(req('DELETE', { subjectId: 's1' }), params);
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith('c1');
  });
  it('跨 subject → 404，不删', async () => {
    mockGet.mockReturnValue({ id: 'c1', subjectId: 's2', title: 'A', createdAt: 't', updatedAt: 't' });
    expect((await DELETE(req('DELETE', { subjectId: 's1' }), params)).status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: 运行确认失败（[id]）**

Run: `npx vitest run "src/app/api/conversations/[id]/__tests__/route.test.ts"`
Expected: FAIL（找不到 `../route`）

- [ ] **Step 6: 实现 [id] 路由**

新建 `src/app/api/conversations/[id]/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as conversationsRepo from '@/server/db/repos/conversations-repo';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const { subject, error } = resolveSubjectFromRequest(request, { required: true });
  if (error) return error;

  const { id } = await params;
  const conversation = conversationsRepo.getConversation(id);
  if (!conversation || conversation.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  return NextResponse.json({
    conversation,
    messages: conversationsRepo.listMessages(id),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { subject, error } = resolveSubjectFromRequest(request, { required: true, body });
  if (error) return error;

  const title = typeof (body as { title?: unknown }).title === 'string'
    ? (body as { title: string }).title.trim()
    : '';
  if (title.length === 0) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const { id } = await params;
  const conversation = conversationsRepo.getConversation(id);
  if (!conversation || conversation.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  conversationsRepo.renameConversation(id, title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { subject, error } = resolveSubjectFromRequest(request, { required: true, body });
  if (error) return error;

  const { id } = await params;
  const conversation = conversationsRepo.getConversation(id);
  if (!conversation || conversation.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  conversationsRepo.deleteConversation(id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/app/api/conversations/__tests__/route.test.ts "src/app/api/conversations/[id]/__tests__/route.test.ts"`
Expected: PASS（列表 2 + [id] 8 = 10 用例）

```bash
npx tsc --noEmit
git add src/app/api/conversations/
git commit -m "feat: 会话 CRUD 路由（GET 列表 + GET/PATCH/DELETE [id]，subject 守卫）"
```

---

### Task 5: `/api/query` 持久化接线

**Files:**
- Modify: `src/app/api/query/route.ts`（仅默认流式分支：`conversationId` 入参 + 确定/创建会话 + 载历史 + 流末落库 + `done` 回传 conversationId）
- Test: `src/app/api/query/__tests__/route.test.ts`（新建；窄 mock 驱动流式）

**Interfaces:**
- Consumes: `conversations-repo`（Task 1）、`deriveConversationTitle`（Task 2）、`streamQueryAnswer`（Task 3，带 history）、既有 `prepareQueryContext`/`generateQueryCitations`/`QUERY_STREAM_SYSTEM_PROMPT`/`NO_QUERY_CONTEXT_ANSWER`。
- 行为：body 加 `conversationId?`；无/跨 subject → `createConversation(subject.id, deriveConversationTitle(question))`；有效同 subject → 用之；载 `listMessages` 末 `MAX_HISTORY_MESSAGES=8` 条作 history；流末 `appendMessage`×2 + `touchConversation`（try/catch）；`done` 数据 `{ subjectId, conversationId }`。

- [ ] **Step 1: 写失败测试**

新建 `src/app/api/query/__tests__/route.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockPrepare = vi.fn();
const mockStream = vi.fn();
const mockCitations = vi.fn();
const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockListMsgs = vi.fn();
const mockAppend = vi.fn();
const mockTouch = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/jobs/queue', () => ({ enqueue: vi.fn(() => ({ id: 'job-x' })) }));
vi.mock('@/server/services/query-service', () => ({
  prepareQueryContext: (...a: unknown[]) => mockPrepare(...a),
  streamQueryAnswer: (...a: unknown[]) => mockStream(...a),
  generateQueryCitations: (...a: unknown[]) => mockCitations(...a),
  runQuery: vi.fn(),
  streamQueryAnswer_unused: undefined,
  NO_QUERY_CONTEXT_ANSWER: 'NO_CONTEXT',
  QUERY_STREAM_SYSTEM_PROMPT: 'SYS',
}));
vi.mock('@/server/services/conversation-title', () => ({
  deriveConversationTitle: (q: string) => `T:${q.slice(0, 5)}`,
}));
vi.mock('@/server/db/repos/conversations-repo', () => ({
  createConversation: (s: unknown, t: unknown) => mockCreate(s, t),
  getConversation: (id: unknown) => mockGet(id),
  listMessages: (id: unknown) => mockListMsgs(id),
  appendMessage: (...a: unknown[]) => mockAppend(...a),
  touchConversation: (id: unknown) => mockTouch(id),
}));

import { POST } from '../route';

function call(body: unknown) {
  return POST(new NextRequest('http://localhost/api/query', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

async function readSSE(res: Response): Promise<string> {
  return await new Response(res.body).text();
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockPrepare.mockReset();
  mockPrepare.mockReturnValue([{ slug: 'p', title: 'P', content: 'c' }]);
  mockStream.mockReset();
  mockStream.mockReturnValue({
    textStream: (async function* () { yield 'hello'; })(),
  });
  mockCitations.mockReset();
  mockCitations.mockResolvedValue([]);
  mockCreate.mockReset();
  mockCreate.mockImplementation((s: string) => ({ id: 'new-conv', subjectId: s, title: 'T', createdAt: 't', updatedAt: 't' }));
  mockGet.mockReset();
  mockListMsgs.mockReset();
  mockListMsgs.mockReturnValue([]);
  mockAppend.mockReset();
  mockTouch.mockReset();
});

describe('POST /api/query 流式持久化', () => {
  it('无 conversationId → 创建会话，done 回传新 id，落库 user+assistant', async () => {
    const res = await call({ question: '你好世界', subjectId: 's1' });
    const sse = await readSSE(res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(sse).toContain('event: done');
    expect(sse).toContain('new-conv');
    expect(mockAppend).toHaveBeenCalledTimes(2);
    expect(mockTouch).toHaveBeenCalledWith('new-conv');
  });

  it('传跨 subject 的 conversationId → 当作新会话（create 被调）', async () => {
    mockGet.mockReturnValue({ id: 'c-other', subjectId: 's2', title: 'X', createdAt: 't', updatedAt: 't' });
    const res = await call({ question: '问题', subjectId: 's1', conversationId: 'c-other' });
    await readSSE(res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockAppend).toHaveBeenCalled();
  });

  it('有效同 subject conversationId → 不创建，载历史，done 回传该 id', async () => {
    mockGet.mockReturnValue({ id: 'c1', subjectId: 's1', title: 'A', createdAt: 't', updatedAt: 't' });
    const res = await call({ question: '追问', subjectId: 's1', conversationId: 'c1' });
    const sse = await readSSE(res);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockListMsgs).toHaveBeenCalledWith('c1');
    expect(sse).toContain('c1');
    expect(mockTouch).toHaveBeenCalledWith('c1');
  });
});
```

> 注意：mock `@/server/services/query-service` 时**必须列全** route 实际 import 的导出（`prepareQueryContext` / `streamQueryAnswer` / `generateQueryCitations` / `runQuery` / `NO_QUERY_CONTEXT_ANSWER` / `QUERY_STREAM_SYSTEM_PROMPT`）。实现 Step 后若报某导出 undefined，按 route 顶部 import 清单补齐 mock。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/app/api/query/__tests__/route.test.ts`
Expected: FAIL（route 尚未接 conversation 逻辑：未调 createConversation / done 无 conversationId）

- [ ] **Step 3: 实现接线**

修改 `src/app/api/query/route.ts`：

1. 顶部 import 增：

```ts
import * as conversationsRepo from '@/server/db/repos/conversations-repo';
import { deriveConversationTitle } from '@/server/services/conversation-title';
```

2. `QueryBodySchema` 加字段：

```ts
  conversationId: z.string().optional(),
```

3. 在默认流式模式段（`// Default: streaming SSE mode` 之后、构造 stream 之前）解析会话与历史：

```ts
  const MAX_HISTORY_MESSAGES = 8;

  // 确定/创建会话（跨 subject 的 conversationId 静默当新会话，防泄漏他 subject 历史）
  const requestedConvId = parsed.data.conversationId;
  let activeConversationId: string;
  if (requestedConvId) {
    const existing = conversationsRepo.getConversation(requestedConvId);
    activeConversationId =
      existing && existing.subjectId === subject.id
        ? existing.id
        : conversationsRepo.createConversation(subject.id, deriveConversationTitle(trimmedQuestion)).id;
  } else {
    activeConversationId = conversationsRepo.createConversation(
      subject.id,
      deriveConversationTitle(trimmedQuestion),
    ).id;
  }

  const history = conversationsRepo
    .listMessages(activeConversationId)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));
```

> `trimmedQuestion` 在现有代码中已于流式段定义（`const trimmedQuestion = question.trim();`）。把上面这段放在 `trimmedQuestion` 定义之后。

4. 空上下文分支（`if (context.length === 0)`）落库 + done 带 conversationId：

```ts
        if (context.length === 0) {
          emit('answer-delta', { delta: NO_QUERY_CONTEXT_ANSWER });
          emit('citations', { citations: [] });
          persistTurn(NO_QUERY_CONTEXT_ANSWER, []);
          emit('done', { subjectId: subject.id, conversationId: activeConversationId });
          closeStream();
          return;
        }
```

5. 正常分支：流式累积 `fullAnswer` → citations 后落库 + done。把 citations 之后、原 `done`/`closeStream` 处改为：

```ts
        // ...（既有 streamedCitations 计算逻辑保持）
        emit('citations', { citations: streamedCitations });
        persistTurn(fullAnswer, streamedCitations);
        emit('done', { subjectId: subject.id, conversationId: activeConversationId });
        closeStream();
```

> 以现有 return 模板/emit 顺序为准对齐：只把 `done` 的数据从 `{ subjectId: subject.id }` 改为 `{ subjectId: subject.id, conversationId: activeConversationId }`，并在 `done` 之前调 `persistTurn(...)`。

6. 在 stream `start(controller)` 内定义 best-effort 落库 helper（放在 `closeStream`/`emit` 定义附近）：

```ts
      const persistTurn = (
        answer: string,
        cits: { pageSlug: string; excerpt: string }[],
      ) => {
        try {
          conversationsRepo.appendMessage(activeConversationId, 'user', trimmedQuestion, null);
          conversationsRepo.appendMessage(
            activeConversationId,
            'assistant',
            answer,
            JSON.stringify(cits),
          );
          conversationsRepo.touchConversation(activeConversationId);
        } catch (err) {
          console.error('[query] persist conversation turn failed', err);
        }
      };
```

7. 把 `streamQueryAnswer(...)` 调用补上 `history` 实参：

```ts
        const answerStream = streamQueryAnswer(
          QUERY_STREAM_SYSTEM_PROMPT,
          trimmedQuestion,
          context,
          subject,
          request.signal,
          history,
        );
```

- [ ] **Step 4: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/app/api/query/__tests__/route.test.ts`
Expected: PASS（3 个用例）

```bash
npx tsc --noEmit
git add src/app/api/query/route.ts src/app/api/query/__tests__/route.test.ts
git commit -m "feat: /api/query 接入会话持久化（conversationId 入参 + 载历史 + 流末落库 + done 回传）"
```

---

### Task 6: ui-store 加 `currentConversationId`（v4 → v5）

**Files:**
- Modify: `src/stores/ui-store.ts`

**Interfaces:**
- Produces: `currentConversationId: string | null` + `setCurrentConversation(id: string | null)`；`setCurrentSubject` 内重置 `currentConversationId = null`；persist `version: 5` + migrate v4→v5 默认 null + partialize 持久化。

> 本任务无独立单测（migrate 函数未导出）；门禁 = `npx tsc --noEmit` + `npx vitest run`（全套不回归）。

- [ ] **Step 1: 接口与默认值**

在 `UIState` 接口里加（`currentSubjectSlug` 附近）：

```ts
  currentConversationId: string | null;
  setCurrentConversation: (id: string | null) => void;
```

store 初始值（`currentSubjectSlug: GENERAL_SUBJECT_SLUG,` 之后）：

```ts
      currentConversationId: null,
```

- [ ] **Step 2: setter + setCurrentSubject 重置**

加 setter（`setCurrentSubject` 之后）：

```ts
      setCurrentConversation: (id) => set({ currentConversationId: id }),
```

`setCurrentSubject` 改为同时清空当前会话：

```ts
      setCurrentSubject: (subject) => {
        set({
          currentSubjectId: subject.id,
          currentSubjectSlug: subject.slug,
          currentConversationId: null,
        });
        syncSubjectCookie(subject.slug);
      },
```

- [ ] **Step 3: persist v5 + migrate + partialize**

`LegacyPersistedState` 加可选字段：

```ts
  currentConversationId?: string | null;
```

`migratePersisted` 的 `if (version >= 4)` 分支返回值加：

```ts
      currentConversationId: prev.currentConversationId ?? null,
```

其余 `version >= 3` / `>= 2` / 默认分支各加 `currentConversationId: null,`。

persist 配置：`version: 4` 改为 `version: 5`；`partialize` 返回对象加：

```ts
        currentConversationId: s.currentConversationId,
```

- [ ] **Step 4: tsc + 全套测试 + 提交**

Run: `npx tsc --noEmit`
Expected: 0 errors

Run: `npx vitest run`
Expected: 全套通过（无回归）

```bash
git add src/stores/ui-store.ts
git commit -m "feat: ui-store 加 currentConversationId（v4→v5 迁移，切 subject 重置）"
```

---

### Task 7: 前端 —— 会话切换器 + chat-interface 接线 + chat-tab 嵌入

> 无自动化单测（UI+集成），交付后 Nick 眼测。组件代码完整给出；如 `Button`/`IconButton` 的 `intent`/`variant`/`size` 名、`useCurrentSubject` 返回形与实际不符，按 `src/components/ui/*` 与 `src/hooks/use-current-subject.ts` 实际命名校正（语义不变；注意 ⑥ 已确认 `Button` 用 `intent=`）。

**Files:**
- Create: `src/components/chat/conversation-switcher.tsx`
- Modify: `src/components/chat/chat-interface.tsx`
- Modify: `src/components/layout/context-panel-chat-tab.tsx`

**Interfaces:**
- Consumes: `useApiFetch`、`useUIStore`（`currentConversationId`/`setCurrentConversation`，Task 6）、`useCurrentSubject`、`Conversation`/`ConversationMessage`（contracts）、`GET/PATCH/DELETE /api/conversations*`、`GET /api/conversations/[id]`。

- [ ] **Step 1: 会话切换器**

新建 `src/components/chat/conversation-switcher.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { Plus, Pencil, Trash2, ChevronDown } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { cn } from '@/lib/cn';
import type { Conversation } from '@/lib/contracts';

export function ConversationSwitcher() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const { id: subjectId } = useCurrentSubject();
  const currentId = useUIStore((s) => s.currentConversationId);
  const setCurrent = useUIStore((s) => s.setCurrentConversation);
  const [open, setOpen] = useState(false);

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/conversations');
      if (!res.ok) return [] as Conversation[];
      return (await res.json()) as Conversation[];
    },
    enabled: !!subjectId,
    staleTime: 10_000,
  });

  const current = conversations.find((c) => c.id === currentId) ?? null;

  const rename = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      await apiFetch(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, subjectId }),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/api/conversations/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
    },
    onSuccess: (_d, id) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (id === currentId) setCurrent(null);
    },
  });

  return (
    <div className="relative border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-sm text-foreground hover:bg-subtle"
        >
          <span className="truncate">{current?.title ?? '新对话'}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" />
        </button>
        <button
          type="button"
          title="新对话"
          onClick={() => { setCurrent(null); setOpen(false); }}
          className="rounded-md p-1 text-foreground-secondary hover:bg-subtle hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <div className="absolute left-3 right-3 top-full z-command mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-surface shadow-lg">
          {conversations.length === 0 ? (
            <p className="px-3 py-2 text-xs italic text-foreground-tertiary">暂无历史对话</p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={cn(
                  'flex items-center gap-1 px-2 py-1.5 text-sm hover:bg-subtle',
                  c.id === currentId && 'bg-subtle',
                )}
              >
                <button
                  type="button"
                  onClick={() => { setCurrent(c.id); setOpen(false); }}
                  className="min-w-0 flex-1 truncate text-left text-foreground"
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  title="重命名"
                  onClick={() => {
                    const next = window.prompt('重命名对话', c.title);
                    if (next && next.trim()) rename.mutate({ id: c.id, title: next.trim() });
                  }}
                  className="rounded p-1 text-foreground-tertiary hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => { if (window.confirm('删除该对话？')) remove.mutate(c.id); }}
                  className="rounded p-1 text-foreground-tertiary hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

> `z-command` 是项目已用的浮层 z-index 类（④b/④c 弹窗同款）。重命名/删除用浏览器原生 `prompt`/`confirm`（v1 最小实现，与项目无现成 dialog 原语时一致）。

- [ ] **Step 2: chat-interface 接线**

修改 `src/components/chat/chat-interface.tsx`：

1. 顶部补 import：

```tsx
import { useQueryClient } from '@tanstack/react-query'; // 若已存在则跳过
import type { ConversationMessage } from '@/lib/contracts';
```

2. 组件内取会话状态（与现有 hooks 同处）：

```tsx
  const currentConversationId = useUIStore((s) => s.currentConversationId);
  const setCurrentConversation = useUIStore((s) => s.setCurrentConversation);
  const apiFetchClient = useApiFetch();
```

> `useApiFetch` 从 `@/lib/api-fetch` import；若组件当前用裸 `apiFetch`，载入历史用 `useApiFetch()`（自动带 subjectId）。

3. 监听 `currentConversationId` 变化载入/清空消息：

```tsx
  useEffect(() => {
    let cancelled = false;
    if (!currentConversationId) {
      setMessages([]);
      return;
    }
    (async () => {
      try {
        const res = await apiFetchClient(`/api/conversations/${currentConversationId}`);
        if (!res.ok) { if (!cancelled) setMessages([]); return; }
        const data = (await res.json()) as { messages: ConversationMessage[] };
        if (cancelled) return;
        setMessages(
          data.messages.map((m) => ({
            role: m.role,
            content: m.content,
            citations: m.citations ?? [],
          })),
        );
      } catch {
        if (!cancelled) setMessages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [currentConversationId, apiFetchClient]);
```

4. 发送时带 `conversationId`（在构造 `queryBody` 处）：

```tsx
      const conversationId = useUIStore.getState().currentConversationId;
      if (conversationId) queryBody.conversationId = conversationId;
```

5. SSE parser 增加 `done` 分支（在 `answer-delta`/`citations` 的 if-else 链里追加）：

```tsx
            } else if (event === 'done') {
              const convId = (data as { conversationId?: string }).conversationId;
              if (convId) {
                if (convId !== useUIStore.getState().currentConversationId) {
                  setCurrentConversation(convId);
                }
                queryClient.invalidateQueries({ queryKey: ['conversations'] });
              }
            }
```

> `queryClient` 组件内已有（`const queryClient = useQueryClient();`，见现有代码）。注意：`done` 回传新会话 id 时 `setCurrentConversation(convId)` 会触发 Step 3 的 useEffect——但此时消息已在内存且 conversationId 刚由本次对话产生，重新拉取会得到刚落库的同一份，UI 不闪烁可接受；若担心闪烁，可在 setCurrentConversation 后不依赖重拉（v1 接受重拉）。

- [ ] **Step 3: chat-tab 嵌入切换器**

修改 `src/components/layout/context-panel-chat-tab.tsx`：

```tsx
'use client';

import { ChatInterface } from '@/components/chat/chat-interface';
import { ConversationSwitcher } from '@/components/chat/conversation-switcher';

export function ContextPanelChatTab() {
  return (
    <div className="flex flex-col h-full">
      <ConversationSwitcher />
      <div className="min-h-0 flex-1">
        <ChatInterface variant="embedded" hideHeader />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: tsc + 全套测试 + 提交**

```bash
npx tsc --noEmit
npx vitest run
git add src/components/chat/conversation-switcher.tsx src/components/chat/chat-interface.tsx src/components/layout/context-panel-chat-tab.tsx
git commit -m "feat: chat tab 会话切换器 + chat-interface 载入/保存/切换接线（⑦ 前端）"
```

- [ ] **Step 5: 手工眼测（Nick）**

`npm run dev:all` → 打开 chat tab → 提问（流式答案）→ 刷新页面，对话仍在（切换器显示标题）→ 追问，LLM 能联系上一轮 → New 开新对话 → 切回旧对话载入历史 → 重命名/删除生效 → 切 subject 后会话清空（不串显他 subject）。

---

## 自审清单（写计划后自查，已完成）

- **Spec 覆盖**：两表+repo（T1）/ deriveTitle（T2）/ 多轮 prompt（T3）/ 会话 CRUD 路由（T4）/ query 落库接线（T5）/ ui-store v5（T6）/ 前端切换器+接线（T7）—— spec 各节均有对应任务。
- **占位扫描**：无 TBD/TODO；每步含完整代码与确切命令/预期。
- **类型一致性**：`Conversation`/`ConversationMessage`（T1 定义，T4/T5/T7 消费字段一致）；repo 方法名（createConversation/listConversations/getConversation/renameConversation/deleteConversation/appendMessage/listMessages/touchConversation）T4/T5 调用与 T1 定义逐一对齐；`buildQueryUserPrompt` 第四参 history（T3 定义，T5 经 streamQueryAnswer 传入）；`done` 事件 `{subjectId, conversationId}`（T5 发、T7 收）；`currentConversationId`/`setCurrentConversation`（T6 定义，T7 消费）。
- **YAGNI**：无显式 POST 创建（隐式）；命名确定性（无 LLM）；管理入口在 chat tab（无新页）。

# 版本历史 / diff（Version History）设计

> 日期：2026-06-22
> 状态：已确认，待写实现计划
> 关联：特性序列第 ⑥ 项「版本历史 / diff」

---

## 一、背景与动机

应用所有 vault 写入都经 Saga（`createChangeset → validateChangeset → applyChangeset`），每次 `applyChangeset` 都在 `operations` 表插入一行（含 `preHead` / `postHead` / `changesetJson` / `subjectId` / `status`），并产生**恰好一次 git commit**（message 含 `[subject:<slug>]` 前缀）。因此 `operations` 表 + vault git 历史**已经是一份完整、可追溯的写操作日志**——但目前没有任何 UI 暴露它，用户无法「看每次 ingest / 编辑 / 合并 / 拆分改了什么」，也无法回滚。

现状勘察结论（已核实）：

- `operations` 列：`id`（恒为新 UUID = `changeset.id`）/ `jobId` / `subjectId` / `preHead`（notNull）/ `postHead`（可空，提交成功才写）/ `changesetJson`（notNull）/ `status`（默认 `pending`）。**无时间戳列**。
- `status` 取值：`pending`（插入时）→ `applied`（提交成功，同时写 postHead）；Saga 失败路径 `rollbackChangeset` 置 `rolled-back`（此时 postHead 仍为 null，从未提交）。
- `operations.id` 恒为新 UUID（`createChangeset` 每次 `randomUUID()`），故 `INSERT OR REPLACE INTO operations` **实际从不替换** → 等价纯 INSERT → **`rowid` 单调递增 = 插入时序 = 时间顺序**。
- `jobId`：异步任务（`ingest` / `merge` / `split` / `save-to-wiki`）= 真实 `jobs.id`；同步编辑（`PUT /api/pages`）与删除（`DELETE`）= `crypto.randomUUID()`（合成，**不在 jobs 表**）。
- git-service 已具备全部读能力：`getDiff(fromSha, toSha)` / `getFileAtCommit(path, sha)` / `getVaultHead()` / `restoreToHead(sha)`。
- 前端已有 `(app)/health`、`(app)/tags` 两个顶级只读页 + 侧边栏入口（`src/components/layout/sidebar.tsx` 内 `<Link href="/health">` 风格）可照搬。

---

## 二、范围（v1）

> **为当前 subject 提供一个全局「操作时间线」视图：倒序列出每次写操作（ingest / 编辑 / 删除 / 合并 / 拆分），展开看整次 unified diff，并能把任意一次操作以「前向 Saga 还原」方式安全回滚。**

### 已定决策

1. **入口形态 = 全局操作时间线**：新增 `(app)/history` 顶级页 + 侧边栏 History 入口（仿 /health /tags）。**非**页面级历史（后者列为后续）。
2. **v1 含回滚**：查看（历史列表 + diff）与回滚同一 spec 交付。
3. **取数以 `operations` 表为主、git 仅补充显示时间戳**：
   - 列表 = `operations` 行（subject-scoped，`post_head IS NOT NULL` 且 `status IN ('applied','reverted')`），按 `rowid DESC` 排序。
   - 「受影响页 + 动作」直接从 `changeset_json` 解析（无需 git name-status）。
   - 「操作类型」经 `LEFT JOIN jobs` 取 `jobs.type`；无 jobs 行（同步编辑/删除）则从 changeset 动作推断。
   - 「时间」由 `getVaultLog` 批量取 `postHead → date` 补充；取不到则显示 `null`（不影响排序）。
4. **回滚机制 = 前向 Saga 还原**（**非** git reset / git revert）：把受影响页恢复到操作前（`preHead`）内容，作为一次**新的、可再次回滚的**提交；复用现有 `validateChangeset / applyChangeset` 全链路。
5. **语义取舍 = 覆盖式还原 + 确认弹窗**：若被回滚操作**之后**这些页又被修改过，前向还原会**覆盖**那些后续修改。v1 不做自动 stale 探测，靠回滚确认弹窗明确告知风险（自动探测列为后续增强）。
6. **回滚为同步**：无 LLM、纯文件还原 + 一次 Saga，与现有编辑 `PUT` 同形，不走 job / SSE。
7. **diff 渲染 = 染色 unified diff**：`getDiff(preHead, postHead)` 原始 unified diff 文本，前端按行染色（`+` 绿 / `-` 红 / `@@` 青 / 文件头加粗），滚动 monospace 块。YAGNI：不做 side-by-side / word-level / markdown 渲染 diff。

### 明确不做（YAGNI）

- 页面级历史（阅读页 History 标签 + 单页 `git log --follow`）。
- 自动 stale 探测（被回滚操作之后是否又有改动并量化提示）。
- git reset / git revert 式回滚（破坏性或可能冲突）。
- 回滚走异步 job / SSE 进度。
- DB schema 变更（不加时间戳列；`operations` 现有列够用，`reverted` 是新增的自由文本 `status` 值，无 CHECK 约束、无需迁移）。
- 跨 subject 聚合时间线（时间线 subject-scoped，与全 app 一致）。

---

## 三、架构与数据流

```
GET /api/history            (requireAuth；useApiFetch 自动注入 ?subjectId)
  └─ resolveSubjectFromRequest(required:true)
  └─ operationsRepo.listForSubject(subjectId)
        SELECT o.*, j.type AS job_type
        FROM operations o LEFT JOIN jobs j ON j.id = o.job_id
        WHERE o.subject_id = ? AND o.post_head IS NOT NULL
              AND o.status IN ('applied','reverted')
        ORDER BY o.rowid DESC
  └─ getVaultLog(limit) → Map<sha, { date, message }>           // 仅补显示时间戳/message
  └─ 每行：changeset_json → affectedPages[{slug,action}] + 推断 type → HistoryEntry[]

GET /api/history/[id]/diff  (requireAuth；useApiFetch 自动注入 ?subjectId)
  └─ resolveSubjectFromRequest(required:true)
  └─ op = operationsRepo.getById(id)
  └─ if !op || op.subjectId !== subject.id → 404            // 跨 subject 守卫
  └─ getDiff(op.preHead, op.postHead) → { diff: string }

POST /api/history/[id]/revert   (requireAuth + requireCsrf；body 带 subjectId)
  └─ resolveSubjectFromRequest(required:true, body)
  └─ op = operationsRepo.getById(id)
  └─ if !op || op.subjectId !== subject.id → 404
  └─ if op.status === 'reverted' → 409（已回滚）
  └─ entries = buildRevertEntries(op, fileAtPreHead, currentExists)   // 纯函数
        每个受影响 path：
          preHead 有该文件 → 还原旧内容（当前存在=update / 当前不存在=create）
          preHead 无该文件（op 新建了它）→ delete
  └─ cs = createChangeset(randomUUID(), subject, entries)
  └─ validateChangeset(cs)；invalid → 422 { errors }
  └─ applyChangeset(cs)                                       // 新提交 + 重索引 + 新 operation 行
  └─ operationsRepo.markReverted(op.id)                       // status='reverted'
  └─ 200 { revertedOperationId, newCommitSha, affectedSlugs }
```

关键点：

- **排序靠 `rowid DESC`**（操作 id 恒不冲突 → 纯 INSERT → rowid = 时序），不依赖 git；git 仅用于显示时间戳。
- **类型标注**：`job_type` 存在 → 直接用（`ingest` / `merge` / `split` / `save-to-wiki`）；为 null（同步编辑/删除）→ 从 changeset 动作推断：全 `delete` = `delete`，否则 = `edit`。`HistoryEntry.type` 存机器值，中文 label 由前端映射。
- **回滚是前向写**：inverse changeset 经完整 Saga，天然得到校验 / SQLite 重索引 / git 提交 / 崩溃回滚保护；产物本身是一条新的 `applied` operation，可再次回滚（= redo）。
- **回滚 inverse 的 create/update 判定**：`buildRevertEntries` 用注入的 `currentExists(path)` 判定——preHead 有内容且当前文件存在 → `update`；preHead 有内容但当前不存在（被后续删了）→ `create`；preHead 无该文件 → `delete`。

---

## 四、改动契约

### `src/lib/contracts.ts`（新增域类型）

```ts
export interface HistoryAffectedPage {
  slug: string;
  action: 'create' | 'update' | 'delete';
}

export interface HistoryEntry {
  id: string;                 // operation id
  sha: string | null;         // postHead
  date: string | null;        // ISO 时间（git 取不到则 null）
  type: string;               // 'ingest'|'merge'|'split'|'save-to-wiki'|'edit'|'delete'
  message: string;            // commit message（含 [subject:<slug>] 前缀，原样）
  affectedPages: HistoryAffectedPage[];
  status: 'applied' | 'reverted';
}
```

### `src/server/db/repos/operations-repo.ts`（新增，纯 better-sqlite3 SQL）

```ts
export interface OperationRow {
  id: string;
  jobId: string;
  subjectId: string;
  preHead: string;
  postHead: string | null;
  changesetJson: string;
  status: string;
  jobType: string | null;     // LEFT JOIN jobs.type
}

// 时间线列表：subject-scoped，仅已提交且 applied/reverted，rowid 倒序
export function listForSubject(subjectId: string): OperationRow[];
// 单行（回滚 / diff 用）；不限 subject，由调用方做 subject 守卫
export function getById(id: string): OperationRow | null;
// 用户回滚后标记原操作；与 Saga 失败的 'rolled-back' 区分
export function markReverted(id: string): void;   // UPDATE operations SET status='reverted' WHERE id=?
```

### `src/server/git/git-service.ts`（改动）

```ts
export interface VaultCommit { sha: string; date: string; message: string }

// 纯函数：解析 `git log --pretty=format:%H%x1f%cI%x1f%s` 的原始输出
export function parseGitLog(raw: string): VaultCommit[];

// 取 vault 提交日志（默认 limit 2000），内部 git.raw(['log', ...]) → parseGitLog
export async function getVaultLog(limit?: number): Promise<VaultCommit[]>;
```

> 复用 `git.raw([...])`（simple-git 已在用）。分隔符用 `\x1f`（单元分隔符，正文不会出现），换行分隔提交。

### `src/server/wiki/revert.ts`（新增，纯函数）

```ts
import type { ChangesetEntry } from '@/lib/contracts';

/**
 * 由一次操作的 changeset 条目 + 注入的「该 path 在 preHead 的内容」「该 path 当前是否存在」
 * 计算回滚（inverse）changeset 条目。
 * - fileAtPreHead(path): preHead 该文件内容；不存在返回 null
 * - currentExists(path): 该文件当前是否存在（决定 inverse 用 create 还是 update）
 */
export function buildRevertEntries(
  originalEntries: ChangesetEntry[],
  fileAtPreHead: (path: string) => string | null,
  currentExists: (path: string) => boolean,
): ChangesetEntry[];
```

判定逻辑（按受影响 path 去重后逐一）：

| preHead 该文件 | 当前文件 | inverse 动作 | content |
|----------------|----------|--------------|---------|
| 有内容 | 存在 | `update` | preHead 内容 |
| 有内容 | 不存在 | `create` | preHead 内容 |
| 无（null） | —— | `delete` | `null` |

### 路由

| 文件 | 方法 | 鉴权 | 行为 |
|------|------|------|------|
| `src/app/api/history/route.ts` | `GET` | `requireAuth` | 列表（见数据流）|
| `src/app/api/history/[id]/diff/route.ts` | `GET` | `requireAuth` | 单次 diff（subject 守卫 → 404）|
| `src/app/api/history/[id]/revert/route.ts` | `POST` | `requireAuth` + `requireCsrf` | 回滚（subject 守卫 → 404；已回滚 → 409；校验失败 → 422）|

> 三个路由都 `resolveSubjectFromRequest`（GET 用 query，POST 用 body）。`/api/history*` 不在 `useApiFetch` 的 `SUBJECT_AGNOSTIC` 列表 → GET 自动注入 `?subjectId`，POST 调用方在 body 带 `subjectId`。

### 前端

| 文件 | 职责 |
|------|------|
| `src/app/(app)/history/page.tsx` | 时间线页（React Query + `useApiFetch`，仿 /tags /health）|
| `src/components/history/operation-list.tsx` | 倒序列表：每项显示 类型徽标 / 时间 / 受影响页（截断 +N）/ 已回滚标记 / 展开 diff / 回滚按钮 |
| `src/components/history/operation-diff.tsx` | 懒加载 `GET /diff`，染色 unified diff 展示（纯展示组件）|
| `src/components/history/revert-button.tsx` | 回滚按钮 + 确认弹窗（明确「将恢复到操作前内容、作为新提交、其后对这些页的修改会被覆盖」）；成功后失效 history query + `router.refresh()` |
| `src/components/layout/sidebar.tsx` | 加 History 入口（`<Link href="/history">`，active = `pathname.startsWith('/history')`）|

中文类型 label 映射（前端）：`ingest`→摄入 / `save-to-wiki`→保存 / `merge`→合并 / `split`→拆分 / `edit`→编辑 / `delete`→删除。

---

## 五、新增 / 改动文件清单

| 文件 | 类型 |
|------|------|
| `src/lib/contracts.ts` | 改（加 `HistoryEntry` / `HistoryAffectedPage`）|
| `src/server/db/repos/operations-repo.ts` | 新增 |
| `src/server/db/repos/__tests__/operations-repo.test.ts` | 新增（轻量）|
| `src/server/git/git-service.ts` | 改（`parseGitLog` + `getVaultLog`）|
| `src/server/git/__tests__/git-service.test.ts` | 新增（仅测 `parseGitLog` 纯函数）|
| `src/server/wiki/revert.ts` | 新增 |
| `src/server/wiki/__tests__/revert.test.ts` | 新增 |
| `src/app/api/history/route.ts` | 新增 |
| `src/app/api/history/[id]/diff/route.ts` | 新增 |
| `src/app/api/history/[id]/revert/route.ts` | 新增 |
| `src/app/api/history/[id]/revert/__tests__/route.test.ts` | 新增（404 / 跨 subject / 已回滚 / 422）|
| `src/app/(app)/history/page.tsx` | 新增 |
| `src/components/history/operation-list.tsx` | 新增 |
| `src/components/history/operation-diff.tsx` | 新增 |
| `src/components/history/revert-button.tsx` | 新增 |
| `src/components/layout/sidebar.tsx` | 改（History 入口）|

> 不改 DB schema、不改 Saga 主控、不改 git-service 既有函数签名、不改 `seedSkillFiles`。

---

## 六、测试（node-only，无 RTL）

1. **`parseGitLog`**（纯函数）：多行 `%H␟%cI␟%s` → `VaultCommit[]`；空输入 → `[]`；message 含空格/标点保真；尾部空行不产生空项。
2. **`buildRevertEntries`**（纯函数，注入假 `fileAtPreHead` / `currentExists`）：
   - 原 op 仅 `create` 一页（preHead 无该文件）→ inverse `delete`；
   - 原 op `update` 一页（preHead 有内容、当前存在）→ inverse `update` + preHead 内容；
   - 原 op `delete` 一页（preHead 有内容、当前不存在）→ inverse `create` + preHead 内容；
   - preHead 有内容但当前已被删（不存在）→ inverse `create`；
   - 多条目混合 + 同 path 去重。
3. **`operations-repo`**（轻量，建临时库或复用现有 db 测试夹具）：`listForSubject` 只返回本 subject、`post_head` 非空、`status IN (applied,reverted)`、rowid 倒序；`markReverted` 改对状态。
4. **revert 路由**（仿 merge/split 路由测试）：未知 id → 404；op.subjectId ≠ 当前 subject → 404；`status='reverted'` → 409；inverse 校验失败 → 422。
5. diff 染色、列表 UI、确认弹窗：眼测（dev）。

> 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，非门禁。

---

## 七、边界与已知取舍

- **覆盖式还原**：被回滚操作之后对同一批页的修改会被前向还原覆盖；靠确认弹窗告知，不做自动 stale 探测（后续增强）。
- **类型推断**：同步编辑/删除无 jobs 行，靠 changeset 动作区分 `edit`/`delete`；无法进一步区分（如「改标题联动」也归为 `edit`）——可接受。
- **时间戳**：来自 git commit 时间；若 `postHead` 超出 `getVaultLog` 窗口（默认 2000 条）则该项时间显示为空，**排序不受影响**（靠 rowid）。窗口截断不影响列表完整性（列表源是 operations 行，非 git log）。
- **无 operation 行的提交**（初始 seed / 历史遗留）：列表源是 operations 表，天然不含它们——不显示、自然不可回滚。
- **回滚已回滚的操作**：禁止（409）；其生成的 revert 操作本身是一条新 `applied` 行，从它再回滚 = redo。
- **跨 subject**：时间线、diff、回滚均 subject-scoped；operations 行的 `subjectId` 为权威，路由做守卫。

---

## 八、不变量与依赖

- 不改 DB schema / Saga 主控 / git-service 既有签名 / `seedSkillFiles`。
- 回滚复用 `createChangeset / validateChangeset / applyChangeset`（Saga 契约不变）；inverse changeset 严格单 subject（与 `validateChangeset` 约束一致）。
- 新 status 值 `'reverted'` 与 Saga 失败的 `'rolled-back'` 语义区分：前者 = 用户回滚已提交操作（`post_head` 非空），后者 = apply 失败从未提交（`post_head` 为 null）；时间线 `post_head IS NOT NULL` 过滤天然排除后者。
- 前端数据请求一律 `useApiFetch()`（自动带 subject）；写操作（回滚）body 显式带 `subjectId` 并经 `requireCsrf`。
- commit message 中文一句话；禁止任何 AI 署名 trailer / 脚注。

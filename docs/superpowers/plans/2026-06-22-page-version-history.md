# 版本历史 / diff 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前 subject 提供一个写操作时间线视图（看每次 ingest/编辑/删除/合并/拆分改了什么）+ 单次操作的染色 diff + 以「前向 Saga 还原」方式安全回滚任意一次操作。

**Architecture:** 取数以 `operations` 表为主（`rowid DESC` 排序、`LEFT JOIN jobs` 取类型、`changeset_json` 解析受影响页），git 仅用于补充显示时间戳与 commit message。回滚 = 读受影响页在 `preHead` 的内容、组成 inverse changeset、走现有 `createChangeset → validateChangeset → applyChangeset` 全链路（一次新的可再回滚提交，非 git reset）。

**Tech Stack:** Next.js 15 App Router + React 19 + TypeScript；better-sqlite3（raw SQL）；simple-git；TanStack React Query；Tailwind + 设计系统原语；vitest（node-only 单测）。

关联 spec：`docs/superpowers/specs/2026-06-22-page-version-history-design.md`。

## Global Constraints

- 思考用英文，所有 task/plan/spec/comment/commit message 用**中文**；commit message 一句话总结，**禁止任何 AI 署名 trailer / 脚注**（无 `Co-Authored-By`、无 "Generated with Claude Code"）。
- 门禁 = `npx tsc --noEmit` + `npx vitest run` 全绿；`npm run lint` 在 BASE 即坏，**非**门禁。
- **不**改 DB schema（不加列）；新 `status` 值 `'reverted'` 是自由文本，无 CHECK 约束、无需迁移。
- **不**改 Saga 主控（`wiki-transaction.ts`）、**不**改 git-service 既有函数签名、**不**改 `seedSkillFiles`。
- 回滚 inverse changeset 严格单 subject（与 `validateChangeset` 约束一致）。
- 路由：写操作（回滚）必须 `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest({required:true, body})`；只读路由 `requireAuth` + `resolveSubjectFromRequest({required:true})`。
- 前端数据请求一律 `useApiFetch()`（GET 自动注入 `?subjectId`）；写操作在 body 显式带 `subjectId`，**禁止**手写 `fetch('/api/...')`。
- 状态语义：`'applied'`=已提交生效；`'reverted'`=用户回滚已提交操作（`post_head` 非空）；`'rolled-back'`=Saga apply 失败从未提交（`post_head` 为 null）。时间线只取 `post_head IS NOT NULL AND status IN ('applied','reverted')`。
- `operations.changeset_json` 存的是 **`ChangesetEntry[]`**（不是整个 Changeset）：`JSON.parse` 直接得到条目数组。
- vault 文件绝对路径 = `vaultPath(entry.path)`（`@/server/config/env`）；某 commit 下的文件内容 = `getFileAtCommit(entry.path, sha)`（entry.path 即 vault 相对路径）。

---

### Task 1: git-service —— `parseGitLog` 纯函数 + `getVaultLog`

**Files:**
- Modify: `src/server/git/git-service.ts`（在文件末尾追加 `VaultCommit` 接口、`parseGitLog`、`getVaultLog`；不动既有函数）
- Test: `src/server/git/__tests__/git-service.test.ts`（新建，仅测 `parseGitLog`）

**Interfaces:**
- Produces:
  - `export interface VaultCommit { sha: string; date: string; message: string }`
  - `export function parseGitLog(raw: string): VaultCommit[]`
  - `export function getVaultLog(limit?: number): Promise<VaultCommit[]>`（默认 limit=2000）
- Consumes: 既有 `getVaultGit()`（同文件）。

- [ ] **Step 1: 写失败测试**

新建 `src/server/git/__tests__/git-service.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseGitLog } from '../git-service';

const US = '\x1f'; // unit separator，与 --pretty=format:%x1f 一致

describe('parseGitLog', () => {
  it('解析多条提交为 {sha,date,message}', () => {
    const raw = [
      `abc123${US}2026-06-22T10:00:00+08:00${US}[subject:general] 编辑 Foo`,
      `def456${US}2026-06-21T09:30:00+08:00${US}[subject:general] 摄入 3 页`,
    ].join('\n');
    expect(parseGitLog(raw)).toEqual([
      { sha: 'abc123', date: '2026-06-22T10:00:00+08:00', message: '[subject:general] 编辑 Foo' },
      { sha: 'def456', date: '2026-06-21T09:30:00+08:00', message: '[subject:general] 摄入 3 页' },
    ]);
  });

  it('空输入返回空数组', () => {
    expect(parseGitLog('')).toEqual([]);
  });

  it('忽略尾部/中间空行', () => {
    const raw = `abc${US}2026-06-22T10:00:00Z${US}msg one\n\n`;
    const out = parseGitLog(raw);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('msg one');
  });

  it('message 中的空格与标点保真', () => {
    const raw = `s1${US}2026-06-22T10:00:00Z${US}[subject:general] 拆分 A → B, C`;
    expect(parseGitLog(raw)[0].message).toBe('[subject:general] 拆分 A → B, C');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/git/__tests__/git-service.test.ts`
Expected: FAIL（`parseGitLog` is not a function / 未导出）

- [ ] **Step 3: 实现**

在 `src/server/git/git-service.ts` **末尾追加**（不改任何既有函数）：

```ts
export interface VaultCommit {
  sha: string;
  date: string;
  message: string;
}

/**
 * 解析 `git log --pretty=format:%H%x1f%cI%x1f%s` 的原始输出。
 * 每行一个提交，字段用单元分隔符 \x1f 分隔（正文不会出现该字符）。
 */
export function parseGitLog(raw: string): VaultCommit[] {
  if (!raw) return [];
  const commits: VaultCommit[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\x1f');
    const sha = parts[0];
    if (!sha) continue;
    commits.push({
      sha,
      date: parts[1] ?? '',
      message: parts.slice(2).join('\x1f'),
    });
  }
  return commits;
}

/**
 * 取 vault git 提交日志（最新在前，默认上限 2000 条）。
 * 仅用于给时间线补充显示时间戳/commit message；列表完整性由 operations 表保证。
 */
export async function getVaultLog(limit = 2000): Promise<VaultCommit[]> {
  const git = getVaultGit();
  try {
    const raw = await git.raw([
      'log',
      '-n',
      String(limit),
      '--pretty=format:%H%x1f%cI%x1f%s',
    ]);
    return parseGitLog(raw);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/server/git/__tests__/git-service.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: tsc + 提交**

```bash
npx tsc --noEmit
git add src/server/git/git-service.ts src/server/git/__tests__/git-service.test.ts
git commit -m "feat: git-service 增加 parseGitLog + getVaultLog（供版本历史时间线取时间戳）"
```

---

### Task 2: `wiki/revert.ts` —— `buildRevertEntries` 纯函数

**Files:**
- Create: `src/server/wiki/revert.ts`
- Test: `src/server/wiki/__tests__/revert.test.ts`

**Interfaces:**
- Consumes: `ChangesetEntry`（`@/lib/contracts`，已存在：`{ action: 'create'|'update'|'delete'; path: string; content: string | null }`）。
- Produces:
  ```ts
  export function buildRevertEntries(
    originalEntries: ChangesetEntry[],
    fileAtPreHead: (path: string) => string | null,
    currentExists: (path: string) => boolean,
  ): ChangesetEntry[]
  ```

判定规则（按受影响 path 去重逐一）：preHead 无该文件（`null`）→ `delete`；preHead 有内容且当前存在 → `update`(旧内容)；preHead 有内容但当前不存在 → `create`(旧内容)。

- [ ] **Step 1: 写失败测试**

新建 `src/server/wiki/__tests__/revert.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildRevertEntries } from '../revert';
import type { ChangesetEntry } from '@/lib/contracts';

const P = 'wiki/general/a.md';

describe('buildRevertEntries', () => {
  it('原操作新建一页（preHead 无该文件）→ 回滚为 delete', () => {
    const original: ChangesetEntry[] = [{ action: 'create', path: P, content: '# A' }];
    const out = buildRevertEntries(original, () => null, () => true);
    expect(out).toEqual([{ action: 'delete', path: P, content: null }]);
  });

  it('原操作更新一页（preHead 有、当前存在）→ 回滚为 update + 旧内容', () => {
    const original: ChangesetEntry[] = [{ action: 'update', path: P, content: '# A new' }];
    const out = buildRevertEntries(original, () => '# A old', () => true);
    expect(out).toEqual([{ action: 'update', path: P, content: '# A old' }]);
  });

  it('原操作删除一页（preHead 有、当前不存在）→ 回滚为 create + 旧内容', () => {
    const original: ChangesetEntry[] = [{ action: 'delete', path: P, content: null }];
    const out = buildRevertEntries(original, () => '# A old', () => false);
    expect(out).toEqual([{ action: 'create', path: P, content: '# A old' }]);
  });

  it('preHead 有内容但当前已被后续删除（不存在）→ 回滚为 create', () => {
    const original: ChangesetEntry[] = [{ action: 'update', path: P, content: '# A new' }];
    const out = buildRevertEntries(original, () => '# A old', () => false);
    expect(out).toEqual([{ action: 'create', path: P, content: '# A old' }]);
  });

  it('多条目混合 + 同 path 去重', () => {
    const P2 = 'wiki/general/b.md';
    const original: ChangesetEntry[] = [
      { action: 'create', path: P, content: '# A' },
      { action: 'update', path: P2, content: '# B new' },
      { action: 'update', path: P, content: '# A again' }, // 同 path，应被去重
    ];
    const fileAtPreHead = (p: string) => (p === P2 ? '# B old' : null);
    const out = buildRevertEntries(original, fileAtPreHead, () => true);
    expect(out).toEqual([
      { action: 'delete', path: P, content: null },
      { action: 'update', path: P2, content: '# B old' },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/wiki/__tests__/revert.test.ts`
Expected: FAIL（找不到模块 `../revert`）

- [ ] **Step 3: 实现**

新建 `src/server/wiki/revert.ts`：

```ts
import type { ChangesetEntry } from '@/lib/contracts';

/**
 * 由一次操作的 changeset 条目计算回滚（inverse）条目。
 * - fileAtPreHead(path): 该文件在操作前（preHead）的内容；不存在返回 null
 * - currentExists(path): 该文件当前是否存在（决定 inverse 用 create 还是 update）
 *
 * 判定：
 *   preHead 无该文件        → delete（操作新建了它）
 *   preHead 有 + 当前存在   → update（恢复旧内容）
 *   preHead 有 + 当前不存在 → create（重建旧内容）
 */
export function buildRevertEntries(
  originalEntries: ChangesetEntry[],
  fileAtPreHead: (path: string) => string | null,
  currentExists: (path: string) => boolean,
): ChangesetEntry[] {
  const seen = new Set<string>();
  const result: ChangesetEntry[] = [];
  for (const entry of originalEntries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const prior = fileAtPreHead(entry.path);
    if (prior === null) {
      result.push({ action: 'delete', path: entry.path, content: null });
    } else if (currentExists(entry.path)) {
      result.push({ action: 'update', path: entry.path, content: prior });
    } else {
      result.push({ action: 'create', path: entry.path, content: prior });
    }
  }
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/server/wiki/__tests__/revert.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: tsc + 提交**

```bash
npx tsc --noEmit
git add src/server/wiki/revert.ts src/server/wiki/__tests__/revert.test.ts
git commit -m "feat: wiki/revert.ts buildRevertEntries 纯函数（计算回滚 inverse changeset 条目）"
```

---

### Task 3: `operations-repo` —— 时间线取数

**Files:**
- Create: `src/server/db/repos/operations-repo.ts`
- Test: `src/server/db/repos/__tests__/operations-repo.test.ts`

**Interfaces:**
- Consumes: `getRawDb`（`../client`）。
- Produces:
  ```ts
  export interface OperationRow {
    id: string;
    jobId: string;
    subjectId: string;
    preHead: string;
    postHead: string | null;
    changesetJson: string;
    status: string;
    jobType: string | null; // LEFT JOIN jobs.type；同步编辑/删除无 jobs 行 → null
  }
  export function listForSubject(subjectId: string): OperationRow[];
  export function getById(id: string): OperationRow | null;
  export function markReverted(id: string): void;
  ```

- [ ] **Step 1: 写失败测试**

新建 `src/server/db/repos/__tests__/operations-repo.test.ts`（夹具同 `checkpoints-repo.test.ts`：临时 `DATABASE_PATH` + `vi.resetModules()`；注意 `foreign_keys=ON`，须先插 subjects 再插 operations/jobs；为避免与自动 seed 的 `general` slug 撞 UNIQUE，测试用 slug `sub-a`/`sub-b`）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operations-repo-'));
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
  db.prepare(
    `INSERT INTO jobs (id, type, status, subject_id, created_at) VALUES (?,?,?,?,?)`,
  ).run('job-ing', 'ingest', 'completed', 's1', '2026-01-01T00:00:00Z');
  const insOp = db.prepare(
    `INSERT INTO operations (id, job_id, subject_id, pre_head, post_head, changeset_json, status)
     VALUES (?,?,?,?,?,?,?)`,
  );
  // 插入顺序即 rowid 顺序；listForSubject 应按 rowid DESC 返回
  insOp.run('opA', 'job-ing', 's1', 'pre', 'shaA', '[]', 'applied'); // 有 jobs → jobType=ingest
  insOp.run('opB', 'edit-uuid', 's1', 'pre', 'shaB', '[]', 'applied'); // 无 jobs → jobType=null
  insOp.run('opP', 'jp', 's1', 'pre', null, '[]', 'pending'); // post_head NULL → 排除
  insOp.run('opX', 'jx', 's2', 'pre', 'shaX', '[]', 'applied'); // 其它 subject → 排除
  insOp.run('opR', 'jr', 's1', 'pre', 'shaR', '[]', 'reverted'); // reverted → 包含
  return import('../operations-repo');
}

describe('operations-repo', () => {
  it('listForSubject：仅本 subject + post_head 非空 + applied/reverted，按 rowid 倒序', async () => {
    const repo = await setup();
    expect(repo.listForSubject('s1').map((r) => r.id)).toEqual(['opR', 'opB', 'opA']);
  });

  it('listForSubject：LEFT JOIN 出 jobType（同步编辑无 jobs 行 → null）', async () => {
    const repo = await setup();
    const rows = repo.listForSubject('s1');
    expect(rows.find((r) => r.id === 'opA')?.jobType).toBe('ingest');
    expect(rows.find((r) => r.id === 'opB')?.jobType).toBeNull();
  });

  it('getById：返回任意 subject 的行；未知 id → null', async () => {
    const repo = await setup();
    expect(repo.getById('opX')?.subjectId).toBe('s2');
    expect(repo.getById('nope')).toBeNull();
  });

  it('markReverted：把状态改为 reverted', async () => {
    const repo = await setup();
    repo.markReverted('opA');
    expect(repo.getById('opA')?.status).toBe('reverted');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/operations-repo.test.ts`
Expected: FAIL（找不到模块 `../operations-repo`）

- [ ] **Step 3: 实现**

新建 `src/server/db/repos/operations-repo.ts`：

```ts
import { getRawDb } from '../client';

export interface OperationRow {
  id: string;
  jobId: string;
  subjectId: string;
  preHead: string;
  postHead: string | null;
  changesetJson: string;
  status: string;
  jobType: string | null;
}

interface RawRow {
  id: string;
  job_id: string;
  subject_id: string;
  pre_head: string;
  post_head: string | null;
  changeset_json: string;
  status: string;
  job_type: string | null;
}

const SELECT_COLS = `o.id, o.job_id, o.subject_id, o.pre_head, o.post_head, o.changeset_json, o.status, j.type AS job_type`;

function mapRow(r: RawRow): OperationRow {
  return {
    id: r.id,
    jobId: r.job_id,
    subjectId: r.subject_id,
    preHead: r.pre_head,
    postHead: r.post_head,
    changesetJson: r.changeset_json,
    status: r.status,
    jobType: r.job_type ?? null,
  };
}

/** 时间线：本 subject、已提交（post_head 非空）、applied/reverted，按 rowid 倒序（=时间倒序）。 */
export function listForSubject(subjectId: string): OperationRow[] {
  const rows = getRawDb()
    .prepare(
      `SELECT ${SELECT_COLS}
       FROM operations o LEFT JOIN jobs j ON j.id = o.job_id
       WHERE o.subject_id = ? AND o.post_head IS NOT NULL
             AND o.status IN ('applied','reverted')
       ORDER BY o.rowid DESC`,
    )
    .all(subjectId) as RawRow[];
  return rows.map(mapRow);
}

/** 单行（回滚 / diff 用）；不限 subject，由调用方做 subject 守卫。 */
export function getById(id: string): OperationRow | null {
  const r = getRawDb()
    .prepare(
      `SELECT ${SELECT_COLS}
       FROM operations o LEFT JOIN jobs j ON j.id = o.job_id
       WHERE o.id = ?`,
    )
    .get(id) as RawRow | undefined;
  return r ? mapRow(r) : null;
}

/** 用户回滚一次已提交操作后标记原操作；与 Saga 失败的 'rolled-back' 语义区分。 */
export function markReverted(id: string): void {
  getRawDb().prepare(`UPDATE operations SET status = 'reverted' WHERE id = ?`).run(id);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/operations-repo.test.ts`
Expected: PASS（4 个用例）

> 若 INSERT 因列名不符报错，对照 `src/server/db/client.ts` 的 `CREATE TABLE` 校正（已核：subjects=id/slug/name/description/created_at/updated_at；jobs 含 id/type/status/subject_id/created_at；operations=id/job_id/subject_id/pre_head/post_head/changeset_json/status）。

- [ ] **Step 5: 提交**

```bash
npx tsc --noEmit
git add src/server/db/repos/operations-repo.ts src/server/db/repos/__tests__/operations-repo.test.ts
git commit -m "feat: operations-repo（时间线取数 listForSubject/getById/markReverted）"
```

---

### Task 4: contracts 域类型 + `wiki/history.ts` —— `buildHistoryEntries` 纯函数

**Files:**
- Modify: `src/lib/contracts.ts`（新增 `HistoryAffectedPage` / `HistoryEntry`，建议加在 `ChangesetEntry`/`Changeset` 附近）
- Create: `src/server/wiki/history.ts`
- Test: `src/server/wiki/__tests__/history.test.ts`

**Interfaces:**
- Consumes: `OperationRow`（Task 3，type-only）、`VaultCommit`（Task 1，type-only）、`ChangesetEntry`/`HistoryEntry`（contracts）、`parseWikiPath`（`./page-identity`）。
- Produces:
  ```ts
  export function buildHistoryEntries(
    rows: OperationRow[],
    commitBySha: Map<string, VaultCommit>,
  ): HistoryEntry[]
  ```

- [ ] **Step 1: 加 contracts 类型**

在 `src/lib/contracts.ts` 的 `Changeset` 接口之后追加：

```ts
export interface HistoryAffectedPage {
  slug: string;
  action: 'create' | 'update' | 'delete';
}

export interface HistoryEntry {
  id: string;             // operation id
  sha: string | null;     // postHead
  date: string | null;    // commit ISO 时间；git 取不到则 null
  type: string;           // 'ingest'|'merge'|'split'|'save-to-wiki'|'edit'|'delete'
  message: string;        // commit message（含 [subject:<slug>] 前缀，原样）
  affectedPages: HistoryAffectedPage[];
  status: 'applied' | 'reverted';
}
```

- [ ] **Step 2: 写失败测试**

新建 `src/server/wiki/__tests__/history.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildHistoryEntries } from '../history';
import type { OperationRow } from '../../db/repos/operations-repo';
import type { VaultCommit } from '../../git/git-service';

function row(p: Partial<OperationRow> = {}): OperationRow {
  return {
    id: 'op1', jobId: 'j1', subjectId: 's1', preHead: 'pre', postHead: 'post',
    changesetJson: '[]', status: 'applied', jobType: null, ...p,
  };
}

describe('buildHistoryEntries', () => {
  it('jobType 存在时直接用作 type，并填充 date/affectedPages', () => {
    const rows = [row({
      jobType: 'ingest',
      changesetJson: JSON.stringify([{ action: 'create', path: 'wiki/general/a.md', content: '# A' }]),
    })];
    const map = new Map<string, VaultCommit>([
      ['post', { sha: 'post', date: '2026-06-22T00:00:00Z', message: '[subject:general] 摄入' }],
    ]);
    const out = buildHistoryEntries(rows, map);
    expect(out[0].type).toBe('ingest');
    expect(out[0].date).toBe('2026-06-22T00:00:00Z');
    expect(out[0].message).toBe('[subject:general] 摄入');
    expect(out[0].affectedPages).toEqual([{ slug: 'a', action: 'create' }]);
  });

  it('无 jobType 且全 delete → type=delete', () => {
    const rows = [row({
      jobType: null,
      changesetJson: JSON.stringify([{ action: 'delete', path: 'wiki/general/a.md', content: null }]),
    })];
    expect(buildHistoryEntries(rows, new Map())[0].type).toBe('delete');
  });

  it('无 jobType 且含 update → type=edit', () => {
    const rows = [row({
      jobType: null,
      changesetJson: JSON.stringify([{ action: 'update', path: 'wiki/general/a.md', content: '# A2' }]),
    })];
    expect(buildHistoryEntries(rows, new Map())[0].type).toBe('edit');
  });

  it('postHead 不在 commit map → date 为 null、message 为空串', () => {
    const out = buildHistoryEntries([row({ postHead: 'missing' })], new Map());
    expect(out[0].date).toBeNull();
    expect(out[0].message).toBe('');
  });

  it('status=reverted 透传', () => {
    expect(buildHistoryEntries([row({ status: 'reverted' })], new Map())[0].status).toBe('reverted');
  });

  it('changeset_json 损坏时降级为空 affectedPages，不抛', () => {
    const out = buildHistoryEntries([row({ changesetJson: 'not-json' })], new Map());
    expect(out[0].affectedPages).toEqual([]);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/server/wiki/__tests__/history.test.ts`
Expected: FAIL（找不到模块 `../history`）

- [ ] **Step 4: 实现**

新建 `src/server/wiki/history.ts`：

```ts
import { parseWikiPath } from './page-identity';
import type { ChangesetEntry, HistoryEntry } from '@/lib/contracts';
import type { OperationRow } from '../db/repos/operations-repo';
import type { VaultCommit } from '../git/git-service';

function inferType(jobType: string | null, entries: ChangesetEntry[]): string {
  if (jobType) return jobType;
  const allDelete = entries.length > 0 && entries.every((e) => e.action === 'delete');
  return allDelete ? 'delete' : 'edit';
}

/**
 * 把 operations 行 + git 提交元数据合成为前端 HistoryEntry。
 * - 受影响页 / 类型推断：来自 changeset_json（无 jobType 时按动作推断 edit/delete）
 * - 时间 / message：按 postHead 从 commitBySha 取，缺失则 null/''
 */
export function buildHistoryEntries(
  rows: OperationRow[],
  commitBySha: Map<string, VaultCommit>,
): HistoryEntry[] {
  return rows.map((row) => {
    let entries: ChangesetEntry[] = [];
    try {
      const parsed = JSON.parse(row.changesetJson);
      if (Array.isArray(parsed)) entries = parsed as ChangesetEntry[];
    } catch {
      entries = [];
    }
    const commit = row.postHead ? commitBySha.get(row.postHead) : undefined;
    return {
      id: row.id,
      sha: row.postHead,
      date: commit?.date ?? null,
      type: inferType(row.jobType, entries),
      message: commit?.message ?? '',
      affectedPages: entries.map((e) => ({
        slug: parseWikiPath(e.path)?.slug ?? e.path,
        action: e.action,
      })),
      status: row.status === 'reverted' ? 'reverted' : 'applied',
    };
  });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/server/wiki/__tests__/history.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit
git add src/lib/contracts.ts src/server/wiki/history.ts src/server/wiki/__tests__/history.test.ts
git commit -m "feat: HistoryEntry 契约 + wiki/history.ts buildHistoryEntries（operations 行 + git 时间合成时间线条目）"
```

---

### Task 5: 只读路由 —— `GET /api/history`（列表）+ `GET /api/history/[id]/diff`

**Files:**
- Create: `src/app/api/history/route.ts`
- Create: `src/app/api/history/[id]/diff/route.ts`
- Test: `src/app/api/history/__tests__/route.test.ts`
- Test: `src/app/api/history/[id]/diff/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `requireAuth`、`resolveSubjectFromRequest`、`operationsRepo.{listForSubject,getById}`、`getVaultLog`、`getDiff`、`buildHistoryEntries`。
- Produces:
  - `GET /api/history` → `HistoryEntry[]`
  - `GET /api/history/[id]/diff` → `{ diff: string }`

- [ ] **Step 1: 写失败测试（列表）**

新建 `src/app/api/history/__tests__/route.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolve = vi.fn();
const mockList = vi.fn();
const mockGetVaultLog = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/operations-repo', () => ({
  listForSubject: (id: unknown) => mockList(id),
}));
vi.mock('@/server/git/git-service', () => ({
  getVaultLog: () => mockGetVaultLog(),
}));

import { GET } from '../route';

function call() {
  return GET(new NextRequest('http://localhost/api/history?subjectId=s1'));
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockList.mockReset();
  mockGetVaultLog.mockReset();
  mockGetVaultLog.mockResolvedValue([]);
});

describe('GET /api/history', () => {
  it('返回合成后的 HistoryEntry[]', async () => {
    mockList.mockReturnValue([
      { id: 'opA', jobId: 'j', subjectId: 's1', preHead: 'pre', postHead: 'shaA',
        changesetJson: JSON.stringify([{ action: 'update', path: 'wiki/general/a.md', content: '# A' }]),
        status: 'applied', jobType: 'ingest' },
    ]);
    mockGetVaultLog.mockResolvedValue([{ sha: 'shaA', date: '2026-06-22T00:00:00Z', message: '[subject:general] 摄入' }]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('opA');
    expect(body[0].type).toBe('ingest');
    expect(body[0].date).toBe('2026-06-22T00:00:00Z');
    expect(body[0].affectedPages).toEqual([{ slug: 'a', action: 'update' }]);
  });

  it('subject 缺失 → 透传 resolve 的 error 响应', async () => {
    mockResolve.mockReturnValue({ subject: null, error: NextResponse.json({ error: 'subject required' }, { status: 400 }) });
    const res = await call();
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/app/api/history/__tests__/route.test.ts`
Expected: FAIL（找不到 `../route`）

- [ ] **Step 3: 实现列表路由**

新建 `src/app/api/history/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as operationsRepo from '@/server/db/repos/operations-repo';
import { getVaultLog } from '@/server/git/git-service';
import { buildHistoryEntries } from '@/server/wiki/history';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { subject, error } = resolveSubjectFromRequest(request, { required: true });
  if (error) return error;

  const rows = operationsRepo.listForSubject(subject.id);
  const commits = await getVaultLog();
  const commitBySha = new Map(commits.map((c) => [c.sha, c]));
  return NextResponse.json(buildHistoryEntries(rows, commitBySha));
}
```

- [ ] **Step 4: 运行确认通过（列表）**

Run: `npx vitest run src/app/api/history/__tests__/route.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 写失败测试（diff）**

新建 `src/app/api/history/[id]/diff/__tests__/route.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGetById = vi.fn();
const mockGetDiff = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/operations-repo', () => ({
  getById: (id: unknown) => mockGetById(id),
}));
vi.mock('@/server/git/git-service', () => ({
  getDiff: (a: unknown, b: unknown) => mockGetDiff(a, b),
}));

import { GET } from '../route';

function call(id: string) {
  const req = new NextRequest(`http://localhost/api/history/${id}/diff?subjectId=s1`);
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockGetById.mockReset();
  mockGetDiff.mockReset();
  mockGetDiff.mockResolvedValue('diff-text');
});

describe('GET /api/history/[id]/diff', () => {
  it('未知 op → 404', async () => {
    mockGetById.mockReturnValue(null);
    expect((await call('nope')).status).toBe(404);
  });

  it('跨 subject 的 op → 404', async () => {
    mockGetById.mockReturnValue({ id: 'opX', subjectId: 's2', preHead: 'pre', postHead: 'sha' });
    expect((await call('opX')).status).toBe(404);
    expect(mockGetDiff).not.toHaveBeenCalled();
  });

  it('合法 → 返回 diff 文本', async () => {
    mockGetById.mockReturnValue({ id: 'opA', subjectId: 's1', preHead: 'pre', postHead: 'sha' });
    const res = await call('opA');
    expect(res.status).toBe(200);
    expect((await res.json()).diff).toBe('diff-text');
    expect(mockGetDiff).toHaveBeenCalledWith('pre', 'sha');
  });
});
```

- [ ] **Step 6: 运行确认失败（diff）**

Run: `npx vitest run "src/app/api/history/[id]/diff/__tests__/route.test.ts"`
Expected: FAIL（找不到 `../route`）

- [ ] **Step 7: 实现 diff 路由**

新建 `src/app/api/history/[id]/diff/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as operationsRepo from '@/server/db/repos/operations-repo';
import { getDiff } from '@/server/git/git-service';

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
  const op = operationsRepo.getById(id);
  if (!op || op.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
  }
  if (!op.postHead) return NextResponse.json({ diff: '' });

  const diff = await getDiff(op.preHead, op.postHead);
  return NextResponse.json({ diff });
}
```

- [ ] **Step 8: 运行确认通过（diff）+ tsc + 提交**

Run: `npx vitest run "src/app/api/history/[id]/diff/__tests__/route.test.ts" src/app/api/history/__tests__/route.test.ts`
Expected: PASS（5 个用例合计）

```bash
npx tsc --noEmit
git add src/app/api/history/route.ts "src/app/api/history/[id]/diff/route.ts" src/app/api/history/__tests__/route.test.ts "src/app/api/history/[id]/diff/__tests__/route.test.ts"
git commit -m "feat: GET /api/history 列表 + GET /api/history/[id]/diff（subject 守卫）"
```

---

### Task 6: 写路由 —— `POST /api/history/[id]/revert`

**Files:**
- Create: `src/app/api/history/[id]/revert/route.ts`
- Test: `src/app/api/history/[id]/revert/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest`、`operationsRepo.{getById,markReverted}`、`getFileAtCommit`（git-service，已存在）、`buildRevertEntries`（Task 2）、`createChangeset`/`validateChangeset`/`applyChangeset`（wiki-transaction，已存在）、`vaultPath`（`@/server/config/env`）、`parseWikiPath`（`@/server/wiki/page-identity`）、`fs.existsSync`、`crypto.randomUUID`。
- 行为：未知/跨 subject → 404；已 `reverted` → 409；inverse 校验失败 → 422；成功 → 200 `{ revertedOperationId, newCommitSha, affectedSlugs }` 且 `markReverted` 被调用。

- [ ] **Step 1: 写失败测试**

新建 `src/app/api/history/[id]/revert/__tests__/route.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGetById = vi.fn();
const mockMarkReverted = vi.fn();
const mockGetFileAtCommit = vi.fn();
const mockBuildRevertEntries = vi.fn();
const mockCreateChangeset = vi.fn();
const mockValidate = vi.fn();
const mockApply = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/operations-repo', () => ({
  getById: (id: unknown) => mockGetById(id),
  markReverted: (id: unknown) => mockMarkReverted(id),
}));
vi.mock('@/server/git/git-service', () => ({
  getFileAtCommit: (p: unknown, sha: unknown) => mockGetFileAtCommit(p, sha),
}));
vi.mock('@/server/wiki/revert', () => ({
  buildRevertEntries: (...a: unknown[]) => mockBuildRevertEntries(...a),
}));
vi.mock('@/server/wiki/wiki-transaction', () => ({
  createChangeset: (...a: unknown[]) => mockCreateChangeset(...a),
  validateChangeset: (cs: unknown) => mockValidate(cs),
  applyChangeset: (cs: unknown) => mockApply(cs),
}));
vi.mock('@/server/config/env', () => ({ vaultPath: (p: string) => `/vault/${p}` }));
vi.mock('node:fs', () => ({ existsSync: (p: unknown) => mockExistsSync(p) }));

import { POST } from '../route';

function call(id: string, body: unknown = { subjectId: 's1' }) {
  const req = new NextRequest(`http://localhost/api/history/${id}/revert`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

const appliedOp = {
  id: 'opA', jobId: 'j', subjectId: 's1', preHead: 'pre', postHead: 'sha',
  changesetJson: JSON.stringify([{ action: 'create', path: 'wiki/general/a.md', content: '# A' }]),
  status: 'applied', jobType: null,
};

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockGetById.mockReset();
  mockMarkReverted.mockReset();
  mockGetFileAtCommit.mockReset();
  mockGetFileAtCommit.mockResolvedValue('# A old');
  mockBuildRevertEntries.mockReset();
  mockBuildRevertEntries.mockReturnValue([{ action: 'delete', path: 'wiki/general/a.md', content: null }]);
  mockCreateChangeset.mockReset();
  mockCreateChangeset.mockImplementation((id, subject, entries) => ({ id, subject, entries }));
  mockValidate.mockReset();
  mockValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
  mockApply.mockReset();
  mockApply.mockResolvedValue({ postHead: 'newsha' });
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(true);
});

describe('POST /api/history/[id]/revert', () => {
  it('未知 op → 404，不写入', async () => {
    mockGetById.mockReturnValue(null);
    expect((await call('nope')).status).toBe(404);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('跨 subject 的 op → 404', async () => {
    mockGetById.mockReturnValue({ ...appliedOp, subjectId: 's2' });
    expect((await call('opA')).status).toBe(404);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('已 reverted 的 op → 409', async () => {
    mockGetById.mockReturnValue({ ...appliedOp, status: 'reverted' });
    expect((await call('opA')).status).toBe(409);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('inverse 校验失败 → 422 带 errors，不 apply/markReverted', async () => {
    mockGetById.mockReturnValue(appliedOp);
    mockValidate.mockReturnValue({ valid: false, errors: ['坏链'], warnings: [] });
    const res = await call('opA');
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual(['坏链']);
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockMarkReverted).not.toHaveBeenCalled();
  });

  it('合法 → 200，apply + markReverted 被调用，返回 newCommitSha/affectedSlugs', async () => {
    mockGetById.mockReturnValue(appliedOp);
    const res = await call('opA');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revertedOperationId).toBe('opA');
    expect(body.newCommitSha).toBe('newsha');
    expect(body.affectedSlugs).toEqual(['a']);
    expect(mockMarkReverted).toHaveBeenCalledWith('opA');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run "src/app/api/history/[id]/revert/__tests__/route.test.ts"`
Expected: FAIL（找不到 `../route`）

- [ ] **Step 3: 实现 revert 路由**

新建 `src/app/api/history/[id]/revert/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as operationsRepo from '@/server/db/repos/operations-repo';
import { getFileAtCommit } from '@/server/git/git-service';
import { buildRevertEntries } from '@/server/wiki/revert';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '@/server/wiki/wiki-transaction';
import { vaultPath } from '@/server/config/env';
import { parseWikiPath } from '@/server/wiki/page-identity';
import type { ChangesetEntry } from '@/lib/contracts';

export const runtime = 'nodejs';

export async function POST(
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
  const op = operationsRepo.getById(id);
  if (!op || op.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
  }
  if (op.status === 'reverted') {
    return NextResponse.json({ error: 'Operation already reverted' }, { status: 409 });
  }

  let original: ChangesetEntry[] = [];
  try {
    const parsed = JSON.parse(op.changesetJson);
    if (Array.isArray(parsed)) original = parsed as ChangesetEntry[];
  } catch {
    original = [];
  }

  // 预读受影响 path 在 preHead 的内容（getFileAtCommit 是 async，先汇总成同步可查的 Map）
  const uniquePaths = Array.from(new Set(original.map((e) => e.path)));
  const preHeadContent = new Map<string, string | null>();
  for (const p of uniquePaths) {
    try {
      preHeadContent.set(p, await getFileAtCommit(p, op.preHead));
    } catch {
      preHeadContent.set(p, null); // preHead 不存在该文件 → 操作新建了它 → 回滚删除
    }
  }

  const entries = buildRevertEntries(
    original,
    (p) => preHeadContent.get(p) ?? null,
    (p) => existsSync(vaultPath(p)),
  );

  const changeset = createChangeset(crypto.randomUUID(), subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    return NextResponse.json(
      { error: 'Revert validation failed', errors: validation.errors },
      { status: 422 },
    );
  }

  const applied = await applyChangeset(changeset);
  operationsRepo.markReverted(op.id);

  const affectedSlugs = entries.map((e) => parseWikiPath(e.path)?.slug ?? e.path);
  return NextResponse.json({
    revertedOperationId: op.id,
    newCommitSha: applied.postHead,
    affectedSlugs,
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run "src/app/api/history/[id]/revert/__tests__/route.test.ts"`
Expected: PASS（5 个用例）

- [ ] **Step 5: tsc + 提交**

```bash
npx tsc --noEmit
git add "src/app/api/history/[id]/revert/route.ts" "src/app/api/history/[id]/revert/__tests__/route.test.ts"
git commit -m "feat: POST /api/history/[id]/revert（前向 Saga 还原 + 标记 reverted）"
```

---

### Task 7: 前端 —— History 页 + 列表/diff/回滚 + 侧边栏入口

> 无自动化单测（UI + 集成）；交付后由 Nick 在 `npm run dev:all` 眼测。组件代码完整给出；如 `Button` 的 `variant`/`size` 名或 `Tag` 的 `tone` 名与 `components/ui/{button,tag}.tsx` 实际不符，按实际命名校正（语义不变）。

**Files:**
- Create: `src/app/(app)/history/page.tsx`
- Create: `src/components/history/operation-list.tsx`
- Create: `src/components/history/operation-diff.tsx`
- Create: `src/components/history/revert-button.tsx`
- Modify: `src/components/layout/sidebar.tsx`（footer 区加 History 入口）

**Interfaces:**
- Consumes: `useApiFetch`、`useCurrentSubject`、`HistoryEntry`（contracts）、React Query、`Button`/`Tag` 原语、`GET /api/history`、`GET /api/history/[id]/diff`、`POST /api/history/[id]/revert`。

- [ ] **Step 1: 页面入口**

新建 `src/app/(app)/history/page.tsx`：

```tsx
import { OperationList } from '@/components/history/operation-list';

export default function HistoryPage() {
  return <OperationList />;
}
```

- [ ] **Step 2: 列表容器 + 行**

新建 `src/components/history/operation-list.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { History as HistoryIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Tag } from '@/components/ui/tag';
import type { HistoryEntry } from '@/lib/contracts';
import { OperationDiff } from './operation-diff';
import { RevertButton } from './revert-button';

const TYPE_LABELS: Record<string, string> = {
  ingest: '摄入',
  'save-to-wiki': '保存',
  merge: '合并',
  split: '拆分',
  edit: '编辑',
  delete: '删除',
};

function Row({ entry }: { entry: HistoryEntry }) {
  const [open, setOpen] = useState(false);
  const typeLabel = TYPE_LABELS[entry.type] ?? entry.type;
  const when = entry.date ? new Date(entry.date).toLocaleString() : '—';
  const shown = entry.affectedPages.slice(0, 5);
  const extra = entry.affectedPages.length - shown.length;

  return (
    <li className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-subtle"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Tag tone={entry.status === 'reverted' ? 'neutral' : 'accent'} size="sm">
            {typeLabel}
          </Tag>
          {entry.status === 'reverted' && (
            <span className="text-xs text-foreground-tertiary">已回滚</span>
          )}
          <span className="truncate text-sm text-foreground">
            {shown.map((p) => p.slug).join(', ') || '（无页面变更）'}
            {extra > 0 ? ` +${extra}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-foreground-tertiary">{when}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <OperationDiff operationId={entry.id} />
          <RevertButton entry={entry} />
        </div>
      )}
    </li>
  );
}

export function OperationList() {
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['history', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/history');
      if (!res.ok) return [] as HistoryEntry[];
      return (await res.json()) as HistoryEntry[];
    },
    enabled: !!subjectId,
    staleTime: 10_000,
  });

  return (
    <div className="mx-auto w-full max-w-content space-y-6 px-6 py-8">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
          <HistoryIcon className="h-5 w-5 text-foreground-tertiary" />
          History
        </h1>
        <p className="mt-1 text-sm text-foreground-secondary">
          本主题的每一次写操作。展开查看 diff 或回滚。
        </p>
      </header>

      {!subjectId || isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-md bg-subtle" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm italic text-foreground-tertiary">No operations yet.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: diff 染色组件**

新建 `src/components/history/operation-diff.tsx`：

```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { cn } from '@/lib/cn';

export function OperationDiff({ operationId }: { operationId: string }) {
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();

  const { data, isLoading } = useQuery({
    queryKey: ['history-diff', subjectId, operationId],
    queryFn: async () => {
      const res = await apiFetch(`/api/history/${operationId}/diff`);
      if (!res.ok) return { diff: '' };
      return (await res.json()) as { diff: string };
    },
    enabled: !!subjectId,
    staleTime: 60_000,
  });

  if (isLoading) return <div className="h-24 animate-pulse rounded bg-subtle" />;
  const diff = data?.diff ?? '';
  if (!diff.trim()) return <p className="text-xs italic text-foreground-tertiary">No diff.</p>;

  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs leading-relaxed">
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={cn(
            line.startsWith('+') && !line.startsWith('+++') && 'text-green-600 dark:text-green-400',
            line.startsWith('-') && !line.startsWith('---') && 'text-red-600 dark:text-red-400',
            line.startsWith('@@') && 'text-cyan-600 dark:text-cyan-400',
            (line.startsWith('diff ') ||
              line.startsWith('+++') ||
              line.startsWith('---') ||
              line.startsWith('index ')) &&
              'font-semibold text-foreground-tertiary',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}
```

- [ ] **Step 4: 回滚按钮 + 确认弹窗**

新建 `src/components/history/revert-button.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import type { HistoryEntry } from '@/lib/contracts';

export function RevertButton({ entry }: { entry: HistoryEntry }) {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { id: subjectId } = useCurrentSubject();
  const [confirming, setConfirming] = useState(false);

  const revert = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/history/${entry.id}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? 'Revert failed');
      }
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['history'] });
      await queryClient.invalidateQueries({ queryKey: ['pages'] });
      router.refresh();
      setConfirming(false);
    },
  });

  if (entry.status === 'reverted') {
    return <span className="text-xs text-foreground-tertiary">该操作已回滚</span>;
  }

  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        <Undo2 className="h-3.5 w-3.5" />
        回滚
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-subtle p-3 text-xs">
      <p className="text-foreground-secondary">
        将把这些页恢复到该操作之前的内容（作为一次新提交）。该操作之后对这些页的修改会被覆盖。
      </p>
      {revert.isError && (
        <p className="text-red-600 dark:text-red-400">{(revert.error as Error).message}</p>
      )}
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={revert.isPending}
          onClick={() => revert.mutate()}
        >
          {revert.isPending ? '回滚中…' : '确认回滚'}
        </Button>
        <Button variant="ghost" size="sm" disabled={revert.isPending} onClick={() => setConfirming(false)}>
          取消
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 侧边栏入口**

修改 `src/components/layout/sidebar.tsx`：

1. 顶部 lucide 图标 import 加入 `History`（与现有 `Activity` / `Hash` 同一处 import）。例如把 `import { Activity, Hash, ... } from 'lucide-react';` 补上 `History`。
2. 在 footer 区 `/tags` 的 `<Link>`（约 267–279 行）之后，紧接插入 History 入口：

```tsx
        <Link
          href="/history"
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-2 h-8 px-2 rounded-md text-sm transition-colors focus-ring',
            pathname.startsWith('/history')
              ? 'bg-subtle text-foreground font-medium'
              : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
          )}
        >
          <History className="h-3.5 w-3.5 text-foreground-tertiary" />
          History
        </Link>
```

- [ ] **Step 6: tsc + 全量测试 + 提交**

```bash
npx tsc --noEmit
npx vitest run
git add "src/app/(app)/history/page.tsx" src/components/history/ src/components/layout/sidebar.tsx
git commit -m "feat: History 时间线页 + 染色 diff + 回滚按钮 + 侧边栏入口（⑥ 前端）"
```

- [ ] **Step 7: 手工眼测（Nick）**

`npm run dev:all` → 侧边栏点 History → 列表按时间倒序、类型徽标正确、展开见染色 diff → 对一次编辑操作点「回滚」→ 确认弹窗 → 确认后该操作标「已回滚」、对应页内容恢复、再次出现一条新的 `编辑`/`保存` 操作（即 revert 提交本身）。

---

## 自审清单（写计划后自查，已完成）

- **Spec 覆盖**：列表（Task 5）/ diff（Task 5）/ 回滚（Task 2+6）/ 取数 repo（Task 3）/ 合成（Task 4）/ git 时间（Task 1）/ 前端+侧边栏（Task 7）/ contracts 类型（Task 4）—— spec 各节均有对应任务。
- **占位扫描**：无 TBD/TODO；每个代码步骤含完整代码与确切命令/预期。
- **类型一致性**：`OperationRow`（Task 3 定义，Task 4/5/6 消费字段名一致：id/jobId/subjectId/preHead/postHead/changesetJson/status/jobType）；`VaultCommit`（Task 1 定义，Task 4/5 消费）；`HistoryEntry`（Task 4 定义，Task 5/7 消费）；`buildRevertEntries` 签名（Task 2 定义，Task 6 调用三参一致）；`changeset_json` 全程按 `ChangesetEntry[]` 解析。

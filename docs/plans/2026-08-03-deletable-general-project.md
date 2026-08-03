# 实现计划：general 可删除 + 零 project 自动生成 general

对应设计稿：`docs/specs/2026-08-03-deletable-general-project.md`
日期：2026-08-03

---

## 任务拆分

每个任务都可独立测试与评审，完成一个提交一次。顺序遵循「先补不变量兜底，再拆守卫」——反过来会出现「general 已可删、但删完是零 project」的中间态。

---

### T1 — 仓储层：新增「保证至少一个 project」的不变量入口

**涉及文件**
- `src/server/db/repos/subjects-repo.ts`
- `src/server/db/repos/__tests__/subjects-default-fallback.test.ts`（新建）

**做什么**
- 新增 `ensureDefaultSubject(): Subject` —— `BEGIN IMMEDIATE` 事务内 `SELECT count(*) FROM subjects`，为 0 时按 spec 约束 3 建一行（`slug='general'` / `name='General'` / `description=''` / `augmentationLevel='standard'`），返回新建行；非 0 时返回既有的 general，general 不存在则返回 `listSubjects()[0]`（按 name 排序的第一个）。
- 事务用 `immediate()`，与 `beginDeleteMaintenance` / `deleteWithContents` 同口径 —— 两个进程（Next.js + worker）同时发现零 project 时不得双建（`slug` UNIQUE 会拒第二个，但要的是幂等返回而不是抛错）。

**先写的失败测试**（真实 SQLite，复用 `subjects-cascade-delete.test.ts` 的 tmpdir + `DATABASE_PATH` 套路）
1. 空库（手动 `DELETE FROM subjects`）调用 → 返回 slug 为 `general` 的行，`listSubjects()` 长度为 1；
2. 已有 general → 返回同一行，不新建（id 不变、总数不变）；
3. 有一个非 general project、无 general → 返回那个 project，**不建 general**；
4. 幂等：连续调两次，总数仍为 1，两次返回同一 id。

**验证命令**
`npx vitest run src/server/db/repos/__tests__/subjects-default-fallback.test.ts`

---

### T2 — 启动期判据：从「没有 general 就建」改为「零 project 才建」

**涉及文件**
- `src/server/db/client.ts`（`ensureSubjectsAndGeneral`，约 133–147 行）
- `src/server/db/__tests__/default-subject-bootstrap.test.ts`（新建）

**做什么**
- 建表 / ALTER 补列部分不动。
- 原来的 `SELECT id FROM subjects WHERE slug='general'`（有就返回、没有就插）改为：
  1. 先按 slug 查 general，命中直接返回其 id（存量库的热路径，零行为变化）；
  2. 未命中时再 `SELECT id FROM subjects LIMIT 1`（按 `rowid`），**有任何 project 就返回它的 id**（legacy 迁移的 backfill 需要一个 subject id，返回哪个都合法，因为 legacy 库必然是零 project 的空表，走不到这一支）；
  3. 只有一行都没有时才插 general。
- 函数名保留 `ensureSubjectsAndGeneral`，但注释改写清楚新语义（它现在保证的是「至少有一个 subject」，不是「general 存在」）。**不改成调 T1 的 `ensureDefaultSubject`** —— `subjects-repo` import `client`，反向调用会成环，且这里在建表期、drizzle 实例还没准备好。

**先写的失败测试**
1. 空库首次 `getDb()` → 存在 slug 为 `general` 的行；
2. 库里已有一个非 general project 且**无** general → `getDb()` 后仍无 general（现状会补出来 → 这条先红）；
3. 存量库有 general → id 不变（回归保护）。

**验证命令**
`npx vitest run src/server/db/__tests__/default-subject-bootstrap.test.ts`

---

### T3 — 拆掉服务端两处 general 禁删守卫

**涉及文件**
- `src/server/db/repos/subjects-repo.ts`（`beginDeleteMaintenance:214`、`deleteWithContents:272`）
- `src/server/db/repos/__tests__/subjects-cascade-delete.test.ts`（改既有用例）

**做什么**
- 删掉两处 `if (subject.slug === 'general') throw new SubjectError('protected', ...)`。
- `SubjectError` 的 `'protected'` code **保留**（联合类型成员留着，前端与既有 409 映射不动），只是不再有生产方 —— 若后续没有任何用途再单独清理，本次不做（避免把类型改动混进行为变更）。
- 更新 `deleteWithContents` 的 JSDoc（第 253 行「general→protected」那句）与 `src/server/db/CLAUDE.md` 里同口径的描述。

**测试改动**
- 把既有 `it('refuses to delete the general subject')` 改写为 `it('deletes the general subject like any other')`：断言 `deleteWithContents(general.id)` 不抛、general 行消失、其种下的关联数据全清（复用 `seedSubjectData` 与既有全表断言列表）。
- 既有 `it('purges every subject-scoped table + the subject row, leaving general/other intact')` 的「general 不受影响」断言保留（删的是别的 project，general 当然还在）。

**验证命令**
`npx vitest run src/server/db/repos/__tests__/subjects-cascade-delete.test.ts`

---

### T4 — DELETE 路由：删完为零时原子补 general 并在响应体返回

**涉及文件**
- `src/app/api/subjects/[id]/route.ts`（`DELETE`）
- `src/app/api/subjects/[id]/__tests__/delete-route.test.ts`（新建）

**做什么**
- `deleteWithContents` 成功之后、`commitVaultChanges` 之前（仍持 vault 锁）调 `subjectsRepo.ensureDefaultSubject()`；仅当它**真的新建了行**时把它放进响应体。
  - 判定「是否新建」：比对返回值 id 是否等于刚删的 id 不可靠（不同 id），改为让 `ensureDefaultSubject` 返回 `{ subject, created: boolean }`，T1 的测试同步覆盖该字段。
- 响应体从 `{ ok: true, subjectId: id }` 扩为 `{ ok: true, subjectId: id, replacement?: Subject }`。字段可选 —— 删非最后一个时不带，前端据此决定要不要强制切换。
- git commit 的 message 与 stage 路径不变（新 general 没有 vault 目录，无内容可提交）。

**先写的失败测试**（mock `subjectsRepo` / vault 锁 / git，与 `src/app/api/reset/__tests__` 同风格；若真实 SQLite 更省事则复用 tmpdir 套路）
1. 库里两个 project，删其中一个 → 200，响应体**不含** `replacement`；
2. 库里只剩一个 project（general 或任意 slug），删它 → 200，响应体 `replacement.slug === 'general'`，且 `replacement.id !== 被删的 id`；
3. 删除被守卫拒绝（active-jobs / has-inbound-refs）时 → 409，**不**创建任何 project（不变量补齐只挂在成功路径上）。

**验证命令**
`npx vitest run src/app/api/subjects/[id]/__tests__/delete-route.test.ts`

---

### T5 — subject 解析与 SSR：general 缺失时兜底到第一个 project

**涉及文件**
- `src/server/middleware/subject.ts`（`resolveGeneralOrFail`，96–116 行）
- `src/app/(app)/page.tsx`（`resolveActiveSubject`，29–35 行）
- `src/app/(app)/wiki/[...slug]/page.tsx`（同名函数，约 30–34 行）
- `src/server/middleware/__tests__/subject-fallback.test.ts`（新建）

**做什么**
- `resolveGeneralOrFail` 改名为 `resolveFallbackOrFail`：general → `listSubjects()[0]` → 都没有时才 500。500 文案改为「No project exists」（原文案「Run database migration」在新语义下是误导）。
  - **不在这里调 `ensureDefaultSubject`**：读路径不该有副作用；能走到「零 project」只能是数据库被外部清空，那是异常而非常态，且启动期（T2）与删除路径（T4）已经各自兜住。
- 两个 SSR 页的 `getBySlugOrThrow(GENERAL_SUBJECT_SLUG)` 改为 `getBySlug(GENERAL_SUBJECT_SLUG) ?? listSubjects()[0]`；仍为 undefined 时保持抛错（页面 error boundary 兜）。两处逻辑一致，抽到 `subjectsRepo.getFallbackSubject(): Subject | null` 避免第三份复刻。

**先写的失败测试**
1. 库中只有一个非 general project，请求无 cookie / 无 query → 解析到该 project（现状 500 → 先红）；
2. cookie 指向已删除的 slug + 无 general → 解析到剩下那个 project；
3. 零 project → 500，且 body.error 提到 no project；
4. general 存在 → 仍优先 general（回归保护）。

**验证命令**
`npx vitest run src/server/middleware/__tests__/subject-fallback.test.ts`

---

### T6 — 全局 reset：开头先确保 general 行存在

**涉及文件**
- `src/app/api/reset/route.ts`（约 240–295 行，`beginReset` 之前）
- `src/app/api/reset/__tests__/route.test.ts`（补一个用例）

**做什么**
- 在进入 reset 事务之前调一次 `subjectsRepo.ensureDefaultSubject()`。其余逻辑（`DELETE FROM subjects WHERE slug != 'general'`、`generalMarker` 查询、`stageVaultPaths` 的 marker/epoch、两个 stub 页重建、git commit）**一行不改**。

**先写的失败测试**
- 手动删掉 general 行（留一个别的 project）后调全局 reset → 200，reset 后库里存在 general 行且 `wiki/general/{index,log}.md` 被重建（现状在 `generalMarker.id` 上崩 → 先红）。

**验证命令**
`npx vitest run src/app/api/reset/__tests__/route.test.ts`

---

### T7 — 前端：去掉两处禁删守卫，删除后切到接任 project

**涉及文件**
- `src/components/subjects/subject-dialog.tsx`（`canDelete:312`、`deleteMutation:289`、禁删文案分支 419–425）
- `src/components/subjects/subjects-api.ts`（`deleteSubject` 返回值）
- `src/lib/i18n/messages/{en,zh-CN}.ts`（删 `subjects.dialog.generalProtected` / `activeProtected` 两个 key）

**做什么**
- `deleteSubject` 返回类型从 `Promise<void>` 改为 `Promise<{ subjectId: string; replacement?: SubjectListEntry }>`（`replacement` 补 `pageCount: 0` 便于乐观写缓存）。
- `canDelete` 常量整体删除 —— 危险区无条件渲染删除按钮，连同 `else` 分支的两条禁删文案与两个 i18n key 一起删掉。`isActive` 变量若无其他消费方一并删除。
- `deleteMutation.onSuccess` 改为：
  1. 若有 `replacement`，先 `queryClient.setQueryData(['subjects'], [replacement])` 乐观写入（与 `CreateSubjectBody` 同样的理由 —— 后台 refetch 未回来前 `SubjectsBootstrap` 会把切换目标当悬空选择重置掉）；
  2. `invalidateQueries(['subjects'])` + `onClose()`；
  3. 若删的是当前 active project，用 `useSwitchSubject()` 切到 `replacement`（或缓存里剩下的第一项）并 `navigateTo: '/'`；不是 active 则维持现状不导航。

**验证**
- 该文件目前无单测，行为靠 T8 的真实验收覆盖；本任务只保证 `npm run lint` 与 `npx tsc --noEmit`（如项目有该脚本，否则 `npm run build` 的类型检查）通过。
- 不新增组件测试：`subject-dialog` 是 mutation + 弹窗编排，没有值得单独测的纯逻辑（判断依据：`canDelete` 被删除后这里已无分支表达式）。

---

### T8 — 真实验收 + 文档同步

**涉及文件**
- `AGENTS.md`（架构决策表「Subject 隔离」行里的「`general`/active/被跨主题引用者禁删」）
- `src/server/db/CLAUDE.md`（`subjects-repo` 小节的 `deleteWithContents` 守卫说明 + Changelog）
- `src/server/CLAUDE.md`（worker 启动「确保 general subject 存在」→ 改为「确保至少一个 subject 存在」）
- `src/components/CLAUDE.md`（Changelog 的 2026-06-29 行不改历史，新增一行）
- `src/app/CLAUDE.md`（若其中有 general 必存的描述）

**真实验收步骤**（必须有本轮跑出的输出，不接受「应该可以」）
1. `npx vitest run` 全绿；`npm run lint` 通过；
2. `npm run dev:all` 起真实应用，在真实 vault 上：
   - 建一个测试 project → 切到它 → 打开 general 的设置弹窗，确认危险区有删除按钮 → 删掉 general → 确认列表只剩测试 project、且 `vault/wiki/general` 目录已随 git commit 移除；
   - 重启 `dev:all` → 确认 general **没有**被复活；
   - 删掉测试 project（它是 active）→ 确认响应带 `replacement`、UI 自动切到新 general 并落到首页、列表只有 general 且 pageCount 0；
   - 用 `sqlite3 data/wiki.db 'select id,slug from subjects'` 核对新 general 的 id 与被删的不同。
3. 把上面的命令、输出、以及 `git log --stat` 落进本文件的「验收记录」小节。

---

## 提交节奏

| 提交 | 内容 |
|---|---|
| `docs:` | 本 plan + spec（成对） |
| `feat:` ×1 | T1 |
| `fix:`/`feat:` ×1 | T2 |
| `feat:` ×1 | T3 |
| `feat:` ×1 | T4 |
| `fix:` ×1 | T5 |
| `fix:` ×1 | T6 |
| `feat:` ×1 | T7 |
| `docs:` | T8 文档同步 + 验收记录 |

完成后按项目约定 `--no-ff` 合回 main（merge message `merge: 合并 feat/deletable-general-project：<摘要>`），删分支与 worktree。

---

## 验收记录

日期：2026-08-03，分支 `feat/deletable-general-project`。

### 实现与 plan 的偏差（一处）

T1 只设计了一个 `ensureDefaultSubject()`，T6 实做时发现**它满足不了 reset**：reset 需要的是「**slug 为 general 的行**存在」（它保留 general 行、重建 stub 页、拿它的 id 当 vault staging marker），而 `ensureDefaultSubject` 的语义是「至少有一个 project」——库里还有 `physics` 时它返回 `physics` 且不建 general，`generalMarker.id` 照样空指针。T6 的测试正是先以这个原因红掉的。

改法：把插入抽成 `insertGeneralSubject()`，对外分成语义明确的两个入口——`ensureDefaultSubject()`（零 project 才建，删除路径与启动期用）与 `ensureGeneralSubject()`（即使有其他 project 也补 general，**仅** reset 用）。两者的分工由 `subjects-default-fallback.test.ts` 的第 4 个用例锁定。

### 自动化验证

```
$ npx vitest run
 Test Files  337 passed (337)
      Tests  3004 passed (3004)
   Duration  14.62s

$ npm run lint          # 仅既有 no-unused-vars warning，0 error
$ npx tsc --noEmit      # 仅 1 条既有报错（src/server/services/__tests__/reenrich-service.test.ts:140），
                        # 已用 git stash 在基线上复现确认与本次改动无关
```

### 真实应用验收

`next dev -p 3010`，`VAULT_PATH`/`DATABASE_PATH` 指向全新临时 vault（**未动 Nick 的真实 vault**——本需求是破坏性删除）。**worker 未启动**：worktree 里没有 `llm-config.json`（含 API key，复制被权限策略拦下）。本次验收零 LLM、零 job，而启动期 seeding 走的是 `getDb()`，Next.js 进程同样执行，故不影响结论；另单独直跑了一次 worker 的启动路径（见第 3 步）。

浏览器操作经 Playwright 驱动真实 UI（不是直接打 API）。

1. **启动 seed**：空库起应用 → `/subjects` 只有 `General`，侧栏 0 页。
2. **删 general（当前 active 是 Physics）**：先建 Physics，再往 vault 塞真实文件（`wiki/{general,physics}/note.md`、`raw/{general,physics}/a.txt`）并 git commit。打开 General 设置 → 危险区渲染的是**「删除主题」按钮**（旧行为是「不能删除 general 主题」文案）→ 两步确认。结果：
   ```
   $ sqlite3 wiki.db 'select id,slug,name from subjects order by slug;'
   52b50d5e-76ae-417f-bc19-23e6c0349321|physics|Physics
   $ find vault -type f            # wiki/general 与 raw/general 都已消失
   raw/physics/a.txt
   wiki/physics/note.md
   ```
   git commit 未落：`git add` 的 pathspec 里有从未存在过的 `.llm-wiki/sources/general`，`fatal: pathspec ... did not match any files` 被路由既有的 `// git failure is non-fatal` 吞掉。**这是既有行为，删任何 project 都一样**（真实 vault 里该目录随 ingest 建出，故实际不触发），本次不改。第 4 步补齐该目录后 git 路径走通。
3. **重启不复活 general**（本需求最容易做错的一条）：
   ```
   $ node --import tsx -e "getDb(); console.log(listSubjects().map(s=>s.slug))"
   subjects after startup: ["physics"]
   ```
   随后杀掉并重启真实 `next dev`，`/subjects` 仍只有 Physics。
4. **删最后一个 project（Physics，且它是 active）**：先补 `.llm-wiki/sources/physics/src1.json` 并 commit。危险区同样有删除按钮（旧行为是「请先切换到其他主题再删除」）→ 两步确认。结果：UI 自动跳到 `/`，顶栏主题切换器显示 **General**，侧栏 0 页。
   ```
   $ sqlite3 wiki.db 'select id,slug,name,description,augmentation_level,maintenance_state from subjects;'
   a5038e98-a2d1-4a4f-a6ed-01469654fecc|general|General||standard|active
   # 旧 general id = b85f44e1-…、旧 physics id = 52b50d5e-… → 新 general 是新建的行，不是没删掉
   $ find vault -type f            # 空
   $ git -C vault log --oneline | head -1
   206fca1 [subject:physics] Delete subject and all contents
   $ git -C vault show --stat --oneline HEAD
    .llm-wiki/sources/physics/src1.json | 1 -
    raw/physics/a.txt                   | 1 -
    wiki/physics/note.md                | 5 -----
   $ git -C vault status --porcelain     # 空（工作区干净）
   ```

对照成功标准 1–6 全部命中（第 5 条中「general 不存在时 SSR/API 正常」由第 3 步重启后 `/subjects` 与首页正常渲染、侧栏与统计都取到 `physics` 佐证；reset 的 500 由 T6 单测覆盖）。

### 已知遗留（不在本次范围）

- 删**当前 active** project 时，一个已在途的 `GET /api/pages?subjectId=<旧 id>` 会拿到一次 404（浏览器控制台可见）。切换完成后所有查询都用新 subject，页面渲染正常。这是「删除自己正站在上面的目标」的固有竞态，与 general 无关；要消掉得在删除前后主动移除旧 subject 的 query 缓存，超出本次范围。
- 上述 `commitVaultChanges` 对不存在目录的 pathspec 失败（既有行为，且被设计为非致命）。

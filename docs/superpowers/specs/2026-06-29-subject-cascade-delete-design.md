# Subject 级联删除设计

> 日期：2026-06-29
> 状态：已批准（待实现）
> 关联：`src/components/subjects/subject-dialog.tsx`、`src/app/api/subjects/[id]/route.ts`、`src/server/db/repos/subjects-repo.ts`、`src/app/api/reset/route.ts`（清理逻辑先例）

## 一、目标

让 subject 支持"一键删除"：删除 subject 的同时，级联清理与之关联的全部数据——
vault 中的 wiki 页面、原始源、sidecar，以及 SQLite 里所有 subject-scoped 行。

替换现状："删除非空 subject 直接返回 409，不做 cascade"（`deleteIfEmpty`）。

## 二、关键决策（已与用户确认）

| 决策点 | 选择 |
|--------|------|
| 二次确认摩擦 | **两步「再点一次确认」+ 页数警告**（复用现有 `confirmArmed` 模式） |
| 删除 active（当前正在使用）的 subject | **保持禁止**（客户端拦截，必须先切到别的 subject） |
| 其他 subject 的 `[[本subject:页面]]` 入站引用 | **有入站引用则阻止删除（409）**，不自动改写 |
| 保护 `general` | **是**，禁止删除（worker 启动会重建，是兜底主题） |
| 执行方式 | **同步 DELETE 路由 + 单事务清理**（沿用 `/api/reset?subjectId` 先例，非异步 job） |

## 三、数据模型背景

`subjects` 的外键级联行为分三类（见 `src/server/db/client.ts`）：

- **ON DELETE CASCADE**（删 subject 行自动清）：`page_aliases`、`wiki_links.subject_id`、`page_sources`、`conversations`→`messages`、`page_embeddings`、`page_maturity`
- **ON DELETE RESTRICT**（有行则阻止删 subject）：`pages`、`sources`、`wiki_links.target_subject_id`
- **ON DELETE SET NULL**：`jobs`、`operations`
- **无 FK**（须手动清）：`page_renditions`、`profile_signals`（`subject_id` 可空列）、`pages_fts`（FTS5 虚拟表）、`ingest_checkpoints`（按 `job_id`）

`wiki_links.target_subject_id` 的 RESTRICT 天然对应"入站跨主题引用阻止删除"：
- `subject_id = X` 行 = 本 subject 的出站链接
- `target_subject_id = X AND subject_id ≠ X` 行 = **其他** subject 指向本 subject 的入站链接 → 即阻止删除的判据

`/api/reset?subjectId` 已实现 ~80% 的同步清理（page_sources / pages_fts / wiki_links 双向 / page_aliases / pages / sources / ingest_checkpoints + 删 vault 子目录 + git commit），但它**重建** subject（写回 index.md/log.md）、**不删** subject 行，也未覆盖 embeddings/maturity/renditions/conversations/profile_signals/operations/jobs。本特性是其超集。

## 四、设计

### 4.1 数据清理：`subjectsRepo.deleteWithContents(id)`

在单个 `getRawDb().transaction()` 内，**按子→父顺序**显式 DELETE（不依赖 cascade 顺序，与 reset 的显式风格一致）：

```
1.  messages WHERE conversation_id IN (SELECT id FROM conversations WHERE subject_id = X)
2.  conversations         WHERE subject_id = X
3.  page_renditions       WHERE subject_id = X        -- 无 FK，必须显式
4.  page_maturity         WHERE subject_id = X
5.  page_embeddings       WHERE subject_id = X
6.  page_sources          WHERE subject_id = X
7.  pages_fts             WHERE subject_id = X
8.  wiki_links            WHERE subject_id = X OR target_subject_id = X
9.  page_aliases          WHERE subject_id = X
10. pages                 WHERE subject_id = X
11. sources               WHERE subject_id = X
12. profile_signals       WHERE subject_id = X        -- 无 FK，可空列
13. ingest_checkpoints    WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = X)
14. job_events            WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = X)
15. operations            WHERE subject_id = X
16. jobs                  WHERE subject_id = X
17. subjects              WHERE id = X
```

> 第 8 步显式删双向 wiki_links 是为绕开「同一行同时被 subject_id(CASCADE) 与 target_subject_id(RESTRICT) 引用」的自指冲突——这正是 reset 的既有做法。执行到此步时入站引用已被 4.2 守卫排除，剩下的 `target_subject_id = X` 行都满足 `subject_id = X`。

DB-only，无副作用，可单元测试。

### 4.2 删除前置守卫（命中即拒，不进事务）

路由层按序检查：

1. **not-found**：subject 不存在 → 404
2. **protected**：`subject.slug === 'general'` → 409 `{ code: 'protected' }`，message `The general subject can't be deleted.`
3. **has-inbound-refs**：`subjectsRepo.listInboundReferences(id)` 查 `wiki_links WHERE target_subject_id = X AND subject_id ≠ X`，按 referencing subject 的 `id` 去重返回（含其 slug）；非空 → 409 `{ code: 'has-inbound-refs' }`，message 列出引用方 subject slug（最多展示 5 个，超出以 `…` 省略），如 `This subject is referenced by other subjects (ml, notes). Remove those cross-subject links first.`
4. **active**：保持**客户端**拦截（删除按钮在 `isActive` 时不渲染）；服务端**不**强校验 active

> `deleteIfEmpty`（及其 `not-empty` 守卫）经核查仅被本 DELETE 路由调用、无测试引用，故**直接删除**，由 `deleteWithContents` 取代。

### 4.3 API 路由：`DELETE /api/subjects/[id]`

```
requireAuth → requireCsrf
→ subject = getById(id)            // 404
→ general 守卫                      // 409 protected
→ listInboundReferences 守卫        // 409 has-inbound-refs
→ deleteWithContents(id)           // 单事务（已含 page_renditions 清理，故不再单独调 deleteRenditionsBySubject）
→ fs.rmSync: wiki/<slug>, raw/<slug>, .llm-wiki/sources/<slug>（existsSync 守卫）
→ commitVaultChanges('[subject:<slug>] Delete subject and all contents')  // try/catch 非致命
→ 200 { ok: true, subjectId }
```

不调用 `rebuildPageIndex()`：删除自洽，且已确认无入站引用，无需重建全局索引。

`SubjectError` code union 扩展：`'invalid-slug' | 'slug-conflict' | 'not-found' | 'protected' | 'has-inbound-refs'`（移除 `'not-empty'`）。路由 catch 中映射：`not-found`→404，`protected`/`has-inbound-refs`/`slug-conflict`→409，其余→400。

### 4.4 UI：`SubjectDialog` 危险区（`EditSubjectBody`）

- `canDelete` 由 `pageCount === 0 && !isActive` 改为 `!isActive && subject.slug !== 'general'`
- 二次确认沿用现有 `confirmArmed` 两步态：
  - 未 armed 按钮文案：`Delete subject`
  - armed 按钮文案：`Click again to confirm`
  - armed 时按钮上方补一行**页数警告**：`This permanently deletes "<name>" and its <N> page(s) and all sources. This can't be undone.`（`N = subject.pageCount`）
- 阻止态说明文案：
  - active（沿用）：`This subject is currently active. Switch to another subject before deleting.`
  - general（新增）：`The general subject can't be deleted.`
- 入站引用阻止：反应式——第二次确认触发 API，服务端 409 时 `deleteMutation.onError` 既有逻辑显示 `err.message` 并 disarm（无需预取）
- `onSuccess`：`invalidateQueries(['subjects'])` + `onClose()`（active 已禁删，无需切换 subject 逻辑）

## 五、测试

- `subjects-repo.test.ts`：
  - `deleteWithContents`：建临时 subject + 跨各表插关联行 → 调用后断言所有表对应行归零、subject 行消失、`general` 不受影响
  - `listInboundReferences`：构造跨主题入站链接 → 命中；仅出站/无链接 → 空
- 路由层（参考 `patch-augmentation.test.ts` 风格）：
  - 删 general → 409 `protected`
  - 有入站引用 → 409 `has-inbound-refs`
  - 正常非空 subject → 200，且 vault 子目录被删

## 六、已知限制

1. 删除 subject 时若有**在途 job**，其 jobs 行被清掉可能令 worker 抛一次无害错误（subject 已不存在）。可接受，不做额外阻止。
2. 其他 subject 指向本 subject 的引用由"阻止删除"兜住，**不做自动改写/剥离**；用户须先手动移除那些跨主题链接。

## 七、不做（YAGNI）

- 不引入异步 `delete-subject` job / SSE 进度。
- 不在 subjects 列表 GET 预取入站引用计数（阻止态走 409 反应式呈现即可）。
- 不实现"删除前导出/软删除/回收站"。

# 孤儿 Source 体检与处置（orphan-source）设计

日期：2026-07-07
状态：已确认

## 问题

`POST /api/ingest` 在入队 job **之前**就同步落库 source（`saveRawSource` 一次写三处：`vault/raw/<subject>/<filename>` 原始文件、`vault/.llm-wiki/sources/<subject>/<id>.json` sidecar、`sources` 表行）。ingest job 失败后这三处残留物零清理，且现有体检的 `stale-source` 检查是从 page 侧出发的，只覆盖"已被页面引用"的 source——「没有任何 `page_sources` 关联的 source」目前无查询、无 finding 类型、无处置动作，用户完全不可见。

## 目标

1. 体检（lint 确定性检查）识别孤儿 source，进 findings 快照，Health 页展示。
2. Health 页逐条提供两个手动处置动作：重新触发 ingest / 删除 source。
3. 不自动化：不进 Fix issues，不加 sweep 自动清理。

## 判定口径（已确认）

「孤儿 source」= 零 `page_sources` 关联，**且**按其关联的 ingest job 状态分类：

| job 状态 | 处理 |
|---|---|
| `pending` / `running` | 跳过（在途，正常状态，不报） |
| `failed` | 报 finding，携带 `failedJobId`（可 checkpoint 续传重试） |
| 查无 job（enqueue 失败或 job 行已清理） | 报 finding，`failedJobId: null` |
| `completed` 但零关联 | 报 finding（ingest 成功但溯源丢失，属异常） |

## 设计

### 1. 检测（server）

- **`src/server/db/repos/sources-repo.ts`** 新增 `listUnreferencedSources(subjectId)`：`sources LEFT JOIN page_sources` 取零关联行（`page_sources.sourceId IS NULL`）。
- **`src/server/db/repos/jobs-repo.ts`** 新增 `findLatestIngestJobBySourceId(subjectId, sourceId)`：`type='ingest'` 且 `paramsJson LIKE '%"sourceId":"<id>"%'` 粗筛，再 JSON 解析精确匹配 `params.sourceId`，按创建时间取最新一条。
- **`src/server/services/lint-deterministic.ts`** 新增 `checkOrphanSources(subject)`，并入 `runDeterministicChecksForSubject`：对每个零关联 source 按上表分类产出 finding。

### 2. 契约扩展（`src/lib/contracts.ts`）

- `LintFinding.type` 联合新增 `'orphan-source'`，severity 固定 `warning`。
- `LintFinding` 新增可选字段：`sourceId?: string`、`sourceFilename?: string`、`failedJobId?: string | null`。
- `pageSlug` 对此类型置空字符串（无对应页面）；Health 行渲染用 `sourceFilename` 替代页面深链。
- **`src/server/services/fix-deterministic.ts`**：`orphan-source` 归入 ignored 桶（Fix issues 不处理）。

### 3. 处置端点（新路由，均 `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest`）

**`POST /api/sources/[id]/reingest`**（前端统一入口，无需区分有无 failed job）

1. 校验 source 存在且属于当前 subject，否则 404。
2. 校验仍零 `page_sources` 关联，否则 409（`already-referenced`）。
3. 若存在同源 `pending`/`running` ingest job → 409（`in-flight`）。
4. 有 failed job → `queue.requeue(jobId)`（等价现有 `/api/jobs/[id]/retry`，checkpoint 续传）；查无 job → 用现有 params 形状 `{ sourceId, filename, subjectId }` 新建 ingest job。
5. 202 + `{ jobId }`。

**`DELETE /api/sources/[id]`**

1. 同上校验存在 + 归属 + 零关联守卫（有关联 409）。
2. 若存在同源 `pending`/`running` ingest job → 409（`in-flight`，对称于 reingest 端点：删除在途任务的 raw 文件会致 worker 读盘失败，甚至在 Saga 完成后插入指向已删 source 的悬挂 `page_sources` 行）。
3. 获取 vault 写锁 → 删 raw 文件与 sidecar（best-effort，文件缺失不报错）→ 删 `sources` 表行 → git commit（message 含 `[subject:<slug>]`）→ 释放锁。
4. 不动关联的 failed job 行（留着无害；reingest 端点靠"source 存在"校验兜底）。
5. 200 + `{ deleted: true }`。

### 4. Health UI

- **`src/components/health/finding-row.tsx`**：`orphan-source` 类型渲染两个行内按钮：
  - **Retry ingest** → `POST /api/sources/[id]/reingest`，成功后走现有 JobsPanel SSE 追踪；完成后自动重跑 lint（与现有 Fix 闭环一致）。
  - **Delete source** → 两步确认（首次点击变 "Confirm delete"，同 SubjectDialog 模式），成功后该行本地移除。
- 类型过滤器（`typeFilter`）自动覆盖新类型，无需额外改动。

## 测试

- `checkOrphanSources` 四分支单测（在途跳过 / failed 报 / 无 job 报 / completed 零关联报）。
- `listUnreferencedSources` / `findLatestIngestJobBySourceId` repo 单测。
- reingest / delete 路由守卫单测（404、subject 越权、`already-referenced`、`in-flight` 各 409 分支、删除的文件 best-effort 分支）。

## 明确不做

- 不自动清理（无 worker sweep）。
- 不并入 Fix issues 自动修复。
- 不撤销/清理 failed job 行。
- 不做 Health 页实时补算（方案 B）；可见性依赖 Run lint，与其他确定性检查一致。

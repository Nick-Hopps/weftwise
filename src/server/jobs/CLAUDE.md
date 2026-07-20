[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **jobs**

# `src/server/jobs/` — 异步任务队列

## 模块职责

1. **队列**：基于 SQLite `jobs` 表的持久化任务队列。
2. **Worker**：单进程轮询、并发调度（`runningJobs` Map + `decideClaim` 三态决策，ingest 之间可并发、上限 `app_settings.ingestConcurrency`，非 ingest 独占）、带租约 + 心跳 + 自动重试。
3. **事件流**：通过 `events.emit` 把任务状态写入 `job_events` 表并推送到 SSE 订阅者。

## 入口与启动

- **Worker 进程**：`src/server/worker-entry.ts` 调 `startWorker(pollMs)`。
- **Next.js 侧**：Route Handler 只用 `queue.enqueue(...)`；绝不在这里跑 handler。

## 对外接口

### `queue.ts`

```ts
enqueue(type, params?, subjectId?): Job  // pending 状态入库（subjectId 写入 jobs.subject_id）
claim(type?): Job | null              // 原子"pending → running" + 租约
complete(id, result, expectedAttempt): boolean
fail(id, error, expectedAttempt): boolean
get(id): Job | null
list({ status?, type?, subjectId? }): Job[]
listRecent(filter, limit): Job[]          // 有界近期状态恢复
listLatestCompletedLint(subjectId): Job | null // 按 completedAt/id 单行读取
getOrCreateJobAtomic(input)               // IMMEDIATE 事务内过滤候选 + 精确幂等 matcher
reingestSourceAtomic(input)               // 同源 ingest 原子复用/requeue/create
requeue(id, expectedAttempt?): boolean // worker 传 fencing token；人工 retry 走管理型重排
reclaimExpired(): number              // 回收租约过期的 running 任务
updateHeartbeat(id, expectedAttempt): boolean
```

### `worker.ts`

```ts
registerHandler(type, handler: JobHandler)    // 在 worker-entry 启动前被 service 模块调用
startWorker(pollMs=2000): () => void          // 返回 stop()
stopWorker()
```

- **并发调度**：`runningJobs` Map 跟踪当前在跑任务（id→type）；每 tick 用纯函数 `decideClaim(runningTypes, ingestLimit)` 三态决策（可 claim ingest / 可 claim 非 ingest / 都不行）——非 ingest 类型独占（跑着任何非 ingest 任务时不再 claim）、ingest 之间允许并发但受 `app_settings.ingestConcurrency`（默认 2，范围 1-4，每 tick 实时读）上限约束；vault 写入安全靠 `vault-mutex`（进程内队列 + 跨进程文件锁）兜底，而非串行调度。
- **租约 fencing**：claim 原子自增的 `attempt_count` 是本次执行 token；每 30s heartbeat 及 complete/fail/requeue 都必须同时匹配 `running + attempt_count`，旧 worker 即使迟到也不能续租或覆盖新 attempt。handler 完成、失败或 requeue 后均在 `finally` 清理定时器。
- **重试**：`MAX_RETRIES=2`，基础延迟 5s，仅对可识别的临时错误（timeout / econnreset / 429 / 502 / 503 / 524 / terminated / other side closed / failed to process successful response / fetch failed / aborted / rate limit，关键字同时搜 `error.message` 和 `error.cause`）；AI SDK 的 `AI_RetryError` 按 `.reason` 精确判定（`maxRetriesExceeded`→retry，`errorNotRetryable`→fail，不猜关键字）；调 `queue.requeue(jobId, attemptCount)` 保持 job ID，只有当前 attempt 可重排，且仅在 requeue 成功、状态已为 pending 后发布 `job:retrying`。
- **终态事件契约**：service 业务事件 → 带 attempt fencing 的状态迁移 → 对应 `job:*` 状态事件 → provenance 对账。complete/fail/requeue/requestCancel 的 CAS 未命中时旧 Worker 静默退出，不发布与 jobs 表冲突的状态事件；重复取消已取消任务返回 `already-terminal`。
- **Research 对账**：job 真正完成或最终失败后调用 `reconcileResearchProvenanceForJob(jobId)`；自动 retry 中间态不对账。worker 启动和维护 tick 再扫描未完成 run，补偿 cancel route、进程崩溃和终态 hook 失败；该扫描先于 operation GC，确保 operation IDs 仍可物化。

### `events.ts`

```ts
emit(jobId, type, message, data?): void
// 1) 写入 job_events 表（持久化给 SSE 续播用）
// 2) 推送给内存中的活跃 SSE 订阅者
```

## 数据模型（`jobs` 表）

| 字段 | 说明 |
|------|------|
| `id` | UUID |
| `type` | `'ingest' \| 'lint' \| 'save-to-wiki' \| 'curate' \| 'embed-index' \| 're-enrich' \| 'fix' \| 'research' \| 'research-import' \| 'image-insert'`（来自 `lib/contracts.Job`） |
| `status` | `'pending' \| 'running' \| 'completed' \| 'failed'` |
| `params_json` / `result_json` | 任意 JSON 入参与结果 |
| `lease_expires_at` | 租约过期时间（`claim` 时写） |
| `heartbeat_at` | 上次心跳 |
| `attempt_count` | 成功领取次数（`claim` 原子自增；`requeue` 本身不增，下一次 claim 再增） |

`job_events`：`{ id, job_id, type, message, data_json, created_at }`，持久化读取按 SQLite `rowid`（真实 INSERT 顺序）；SSE 客户端用 `Last-Event-Id` = 最后收到的 `id` 续播，服务端先解析对应 rowid，再读取其后的事件。同毫秒事件不依赖随机 UUID 排序。

Phase 3C 的 Ask AI 工作流命令不直接暴露 queue：`workflow.status` 通过 services 层只返回 active Subject 脱敏摘要；start/cancel 先进入 PendingAction，批准后才在 SQLite 事务中把 job 状态与 action applied 一起提交。取消继续复用 `requestCancel`、`job:cancelled` 与 Research provenance 对账。

## 关键依赖与配置

- `WORKER_POLL_INTERVAL_MS`（默认 2000）
- 租约时长、心跳间隔在 `worker.ts` 常量：`HEARTBEAT_INTERVAL_MS = 30_000`
- 不需要 Redis —— SQLite WAL 足以支撑单机单 worker

## 扩展指南

- **新增任务类型**：
  1. 在 `src/lib/contracts.ts::Job.type` 联合类型里加新字面量；
  2. 新建 `src/server/services/<name>-service.ts`，在顶部 `registerHandler('<name>', handler)`；
  3. 在 `worker-entry.ts` import 这个 service 模块（触发 side-effect 注册）；
  4. 在对应 Route Handler 里 `queue.enqueue('<name>', {...})`。

- **自定义重试策略**：修改 `worker.ts::isRetryableError` 或给特定任务类型加白名单/黑名单。

## 测试与质量

已覆盖：

- `__tests__/maintenance-tick.test.ts`：`shouldSweep` 节律闸门边界。
- `job_events` 保留清扫、同毫秒 INSERT 顺序与 `afterId` 续播，以及 jobs 表 CRUD/查询见 `db/repos/__tests__/jobs-repo.test.ts`（queue/worker 是对 jobs-repo 的薄封装）。
- `__tests__/worker.test.ts`：`isRetryableError` 分类，以及 30 秒首跳/连续续租、成功/失败/retry 定时器释放、心跳异常隔离、状态迁移 fencing 与终态事件闸门。
- `__tests__/worker-terminal-consistency.test.ts`：真实 SQLite + trigger 锁定 Saga 业务事件 → failed 状态 → `job:failed` 的顺序，并验证失败结果与租约清理。
- `services/__tests__/research-provenance-reconciler.test.ts`：终态 hook、维护扫描、delivery/verification 聚合与 operation lineage；`jobs/[id]` cancel/retry 路由测试覆盖 coordinator 立即对账及 Research child 禁止独立复活。
- `lib/__tests__/error-format.test.ts` + `db/repos/__tests__/jobs-repo-fail.test.ts`：`describeErrorMessage` 补全 `AI_RetryError` 因 lastError message 为空而丢失的真实原因（见下方 2026-07-09 变更）。

- `db/repos/__tests__/jobs-repo.test.ts`：双进程 WAL claim 原子性、`lease_expires_at <= now` 的 claim/reclaim 一致边界、requeue/attempt_count 语义与旧 attempt fencing。

## 常见问题 (FAQ)

- **Worker 挂了任务怎么办？**
  租约在 `lease_expires_at <= now` 时失效。worker 启动会先调 `reclaimExpired()`；运行中的 worker 也可由 `claimNextJob()` 直接重新领取到期任务。
- **前端 SSE 断连怎么续播？**
  EventSource 自动携带 `Last-Event-Id`；服务端按此过滤 `job_events`，只推送更晚的事件。
- **一个任务要运行 10 分钟，会超时吗？**
  Worker 里会持续心跳续租；客户端 SSE 是长连接，只要 HTTP 不中断就行（Next.js dev 默认无硬超时，生产注意反代配置）。

## 相关文件清单

```
src/server/jobs/
├── queue.ts      # 对 jobs-repo 的薄封装
├── worker.ts     # 轮询 + 租约 + 重试 + 并发调度（runningJobs + decideClaim）
└── events.ts     # job_events 写入 + SSE 分发
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-07-20 | `failJob` 对 `url-auth-required` 只持久化安全的 code/status/authOrigin，供无 checkpoint 的认证失败 Ingest 在刷新后恢复；Cookie/Authorization 不复制到 result/event/job params |
| 2026-07-17 | 新增独占型 `image-insert` job：PendingAction 批准事务原子入队，worker 轮询取消并注册专用 handler；前端按真实类型追踪而非伪装成 ingest |
| 2026-07-14 | Saga/Worker 终态一致性：状态迁移成功后才发布 completed/failed/retrying/cancelled，CAS/fencing 未命中静默退出；重复取消幂等；job_events 按 rowid 插入顺序读取与续播，并以真实 SQLite trigger 锁定 Saga 失败顺序 |
| 2026-07-14 | Worker/DB 不变量测试收尾：所有 runJob 终态清 timer；claim/reclaim 统一 `<= now` 到期语义，`attempt_count` 作为 heartbeat/complete/fail/requeue fencing token；双进程 WAL 竞争与旧 attempt 隔离已有真实 repo 测试 |
| 2026-07-14 | Workflow 控制 Phase 3C：Ask AI status 只读脱敏；re-enrich/research start 与 cancel 先审批，批准后 job/action 原子收口，取消沿用既有终态、事件和 provenance 语义 |
| 2026-07-14 | Phase 2C 新增 `research-import` coordinator job；worker 终态 hook、启动与维护扫描执行幂等 Research provenance 对账，且早于 operation GC；自动 retry 中间态不提前终结 delivery，携带 provenance 的 child Ingest 禁止通用手动 retry，coordinator cancel 后 route 立即对账 |
| 2026-07-13 | queue 暴露最新 lint 单行读取与两类原子 get-or-create；repo 候选 SQL 避免扫描 subject 全历史，同源 ingest 走 JSON 表达式索引 |
| 2026-04-22 | 初始化 |
| 2026-06-24 | 新增 `job_events` 保留清扫（worker 维护 tick 调 `queue.pruneEvents` → `jobs-repo.pruneJobEvents`，独立于成熟度维护开关，启动清一次积压）|
| 2026-07-06 | Ingest 多任务支持：worker 由单任务串行改并发调度——新增 `runningJobs` Map + 纯函数 `decideClaim(runningTypes, ingestLimit)`（ingest 之间并发、上限 `app_settings.ingestConcurrency` 默认 2、非 ingest 独占）；vault 写入安全改靠 `vault-mutex` 兜底。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-06-ingest-multi-task* |
| 2026-07-09 | 修复瞬时中转层错误被误判为不可重试：日志分析发现 `bad response status code 524` / `Failed to process successful response`(cause:terminated) / `Cannot connect to API: other side closed` 等真实瞬时故障，都不命中 `isRetryableError` 旧关键字列表，直接一步到位判 fail，零重试。`isRetryableError` 补关键字（terminated / other side closed / failed to process successful response / 524）+ 同时搜 `error.cause`；新增 `error.name==='AI_RetryError'` 分支，按 `.reason`（`maxRetriesExceeded`/`errorNotRetryable`）精确判定而非猜关键字。另修复 `AI_RetryError` 最后一次尝试 message 为空时（`Failed after 3 attempts. Last error: ` 后面留白）真实原因被吞的问题：新增 `lib/error-format.ts::describeErrorMessage`（补 `lastError` 的 message/cause），`worker.ts` catch 块与 `jobs-repo.ts::failJob`（result_json 实际落库处）均改调此函数。|

---

_生成时间：2026-04-22 00:25:29_

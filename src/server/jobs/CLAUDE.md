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
complete(id, result)
fail(id, error)
get(id): Job | null
list({ status?, type?, subjectId? }): Job[]
listRecent(filter, limit): Job[]          // 有界近期状态恢复
listLatestCompletedLint(subjectId): Job | null // 按 completedAt/id 单行读取
getOrCreateJobAtomic(input)               // IMMEDIATE 事务内过滤候选 + 精确幂等 matcher
reingestSourceAtomic(input)               // 同源 ingest 原子复用/requeue/create
requeue(id)                           // retry 专用：保留 job ID
reclaimExpired(): number              // 回收租约过期的 running 任务
```

### `worker.ts`

```ts
registerHandler(type, handler: JobHandler)    // 在 worker-entry 启动前被 service 模块调用
startWorker(pollMs=2000): () => void          // 返回 stop()
stopWorker()
```

- **并发调度**：`runningJobs` Map 跟踪当前在跑任务（id→type）；每 tick 用纯函数 `decideClaim(runningTypes, ingestLimit)` 三态决策（可 claim ingest / 可 claim 非 ingest / 都不行）——非 ingest 类型独占（跑着任何非 ingest 任务时不再 claim）、ingest 之间允许并发但受 `app_settings.ingestConcurrency`（默认 2，范围 1-4，每 tick 实时读）上限约束；vault 写入安全靠 `vault-mutex`（进程内队列 + 跨进程文件锁）兜底，而非串行调度。
- **心跳**：每 30s 调 `queue.updateHeartbeat` 续租。
- **重试**：`MAX_RETRIES=2`，基础延迟 5s，仅对可识别的临时错误（timeout / econnreset / 429 / 502 / 503 / 524 / terminated / other side closed / failed to process successful response / fetch failed / aborted / rate limit，关键字同时搜 `error.message` 和 `error.cause`）；AI SDK 的 `AI_RetryError` 按 `.reason` 精确判定（`maxRetriesExceeded`→retry，`errorNotRetryable`→fail，不猜关键字）；调 `queue.requeue(jobId)` 保持 job ID，前端 SSE 不会丢踪。

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
| `type` | `'ingest' \| 'lint' \| 'save-to-wiki' \| 'curate' \| 'embed-index' \| 're-enrich' \| 'fix' \| 'research'`（来自 `lib/contracts.Job`） |
| `status` | `'pending' \| 'running' \| 'completed' \| 'failed'` |
| `params_json` / `result_json` | 任意 JSON 入参与结果 |
| `lease_expires_at` | 租约过期时间（`claim` 时写） |
| `heartbeat_at` | 上次心跳 |
| `attempt_count` | 当前重试次数（`requeue` 自增） |

`job_events`：`{ id, job_id, type, message, data_json, created_at }`，SSE 客户端用 `Last-Event-Id` = 最后收到的 `id` 续播。

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
- `job_events` 保留清扫（`pruneJobEvents`）与 jobs 表 CRUD/查询见 `db/repos/__tests__/jobs-repo.test.ts`（queue/worker 是对 jobs-repo 的薄封装）。
- `__tests__/worker.test.ts::decideJobFailureAction`：`isRetryableError` 分类（含 `AI_RetryError.reason` 精确判定、cause 里才有真实原因的网络错误）。
- `lib/__tests__/error-format.test.ts` + `db/repos/__tests__/jobs-repo-fail.test.ts`：`describeErrorMessage` 补全 `AI_RetryError` 因 lastError message 为空而丢失的真实原因（见下方 2026-07-09 变更）。

仍待补充：

- `claimNextJob` 并发原子性（用 `busy_timeout` + `BEGIN IMMEDIATE`）。
- `reclaimExpired` 的边界：刚好等于过期时间戳是否回收。
- `requeue` 对 `attempt_count` 的正确自增。
- `worker.ts`：心跳续租。

## 常见问题 (FAQ)

- **Worker 挂了任务怎么办？**
  租约过期后，下次 worker 启动（或仍在跑的 worker）调 `reclaimExpired()`，把那些 running 但租约过期的任务重置为 pending。
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
| 2026-07-13 | queue 暴露最新 lint 单行读取与两类原子 get-or-create；repo 候选 SQL 避免扫描 subject 全历史，同源 ingest 走 JSON 表达式索引 |
| 2026-04-22 | 初始化 |
| 2026-06-24 | 新增 `job_events` 保留清扫（worker 维护 tick 调 `queue.pruneEvents` → `jobs-repo.pruneJobEvents`，独立于成熟度维护开关，启动清一次积压）|
| 2026-07-06 | Ingest 多任务支持：worker 由单任务串行改并发调度——新增 `runningJobs` Map + 纯函数 `decideClaim(runningTypes, ingestLimit)`（ingest 之间并发、上限 `app_settings.ingestConcurrency` 默认 2、非 ingest 独占）；vault 写入安全改靠 `vault-mutex` 兜底。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-06-ingest-multi-task* |
| 2026-07-09 | 修复瞬时中转层错误被误判为不可重试：日志分析发现 `bad response status code 524` / `Failed to process successful response`(cause:terminated) / `Cannot connect to API: other side closed` 等真实瞬时故障，都不命中 `isRetryableError` 旧关键字列表，直接一步到位判 fail，零重试。`isRetryableError` 补关键字（terminated / other side closed / failed to process successful response / 524）+ 同时搜 `error.cause`；新增 `error.name==='AI_RetryError'` 分支，按 `.reason`（`maxRetriesExceeded`/`errorNotRetryable`）精确判定而非猜关键字。另修复 `AI_RetryError` 最后一次尝试 message 为空时（`Failed after 3 attempts. Last error: ` 后面留白）真实原因被吞的问题：新增 `lib/error-format.ts::describeErrorMessage`（补 `lastError` 的 message/cause），`worker.ts` catch 块与 `jobs-repo.ts::failJob`（result_json 实际落库处）均改调此函数。|

---

_生成时间：2026-04-22 00:25:29_

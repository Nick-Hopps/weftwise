[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **jobs**

# `src/server/jobs/` — 异步任务队列

## 模块职责

1. **队列**：基于 SQLite `jobs` 表的持久化任务队列。
2. **Worker**：单进程轮询、单任务串行、带租约 + 心跳 + 自动重试。
3. **事件流**：通过 `events.emit` 把任务状态写入 `job_events` 表并推送到 SSE 订阅者。

## 入口与启动

- **Worker 进程**：`src/server/worker-entry.ts` 调 `startWorker(pollMs)`。
- **Next.js 侧**：Route Handler 只用 `queue.enqueue(...)`；绝不在这里跑 handler。

## 对外接口

### `queue.ts`

```ts
enqueue(type, params?): Job           // pending 状态入库
claim(type?): Job | null              // 原子"pending → running" + 租约
complete(id, result)
fail(id, error)
get(id): Job | null
list({ status?, type? }): Job[]
requeue(id)                           // retry 专用：保留 job ID
reclaimExpired(): number              // 回收租约过期的 running 任务
```

### `worker.ts`

```ts
registerHandler(type, handler: JobHandler)    // 在 worker-entry 启动前被 service 模块调用
startWorker(pollMs=2000): () => void          // 返回 stop()
stopWorker()
```

- **串行**：`isProcessing` 布尔 flag 确保一次只处理一个任务（LLM 任务分钟级 + 并行 git commit 会炸）。
- **心跳**：每 30s 调 `queue.updateHeartbeat` 续租。
- **重试**：`MAX_RETRIES=2`，基础延迟 5s，仅对可识别的临时错误（timeout / econnreset / 429 / 502 / 503 / fetch failed / aborted / rate limit）；调 `queue.requeue(jobId)` 保持 job ID，前端 SSE 不会丢踪。

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
| `type` | `'ingest' \| 'lint' \| 'save-to-wiki'`（来自 `lib/contracts.Job`） |
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

无测试。建议：

- `claimNextJob` 并发原子性（用 `busy_timeout` + `BEGIN IMMEDIATE`）。
- `reclaimExpired` 的边界：刚好等于过期时间戳是否回收。
- `requeue` 对 `attempt_count` 的正确自增。

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
├── worker.ts     # 轮询 + 租约 + 重试 + 串行锁
└── events.ts     # job_events 写入 + SSE 分发
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |

---

_生成时间：2026-04-22 00:25:29_

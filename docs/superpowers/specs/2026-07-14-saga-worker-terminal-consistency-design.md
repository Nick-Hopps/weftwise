# Saga / Worker 终态一致性设计

日期：2026-07-14  
状态：已完成

## 一、目标

完成 Services 测试清单的最后一个缺口：当持有 Saga 的 service handler 失败时，业务事件、Worker 状态迁移和终态事件必须形成唯一、可续播、可验证的顺序，任何旧 attempt 或并发终态都不能发布与数据库状态不一致的事件。

## 二、当前风险

1. `job_events` 以 `(created_at, id)` 排序和续播；同一毫秒内多个事件的 UUID 随机，读取顺序可能与插入顺序不同，`Last-Event-Id` 也可能漏掉同毫秒的后续事件。
2. 自动 retry 当前先发 `job:retrying`，延迟结束后才尝试 `running → pending`；attempt fencing 失败时会留下虚假的 retrying 事件。
3. `AgentCancelled` 分支忽略 `requestCancel()` 的结果；若任务已由其他竞争路径完成，仍可能对 completed job 发布 `job:cancelled`。
4. 最终失败虽已先执行 `queue.fail` 再 emit，但尚无真实 SQLite 集成测试证明 Saga 业务事件 → failed 状态 → `job:failed` 的完整顺序。

## 三、终态契约

### 3.1 权威顺序

```text
service 业务事件（0..N）
  → 带 attempt fencing 的状态迁移成功
  → 对应 job:* 状态事件
  → 终态 provenance 对账（仅 completed/failed/cancelled）
```

- `job:completed` 只能在 `queue.complete(...) === true` 后发出；
- `job:failed` 只能在 `queue.fail(...) === true` 后发出；
- `job:retrying` 只能在 `queue.requeue(...) === true`、状态已为 pending 后发出；
- `job:cancelled` 只能在 `queue.requestCancel(...) === 'cancelled'`、状态已为 failed 后发出；
- fencing/CAS 未命中时，旧 Worker 静默退出，不发布任何状态事件或触发终态对账。

### 3.2 事件读取顺序

`job_events` 的权威顺序使用 SQLite `rowid`（实际 INSERT 顺序），不再用随机 UUID 作为同毫秒排序键。`Last-Event-Id` 先解析对应 rowid，再读取更大的 rowid，保证同毫秒事件不乱序、不遗漏。

事件的公开 `id`、`createdAt` 与响应结构保持不变；不做数据库 schema 迁移。

### 3.3 失败策略

事件写入失败不反转已经提交的 job 状态：jobs 表仍是终态权威源，SSE 会根据 jobs 状态产生 `final` 事件。此次只消除“状态迁移未成功却发布状态事件”和“已持久化事件读取乱序”两类不一致。

## 四、范围

- 修改 `jobs-repo.getJobEvents` 的插入顺序读取和 cursor 语义；
- 修改 Worker retry/cancel 状态事件的发布时机；
- 补充 jobs repo、Worker 单元测试和真实 SQLite Worker/Saga 失败集成测试；
- 更新 Jobs、DB、Services 和根测试基线文档；
- 不修改 Job status 枚举、数据库 schema、LLM task 或 `llm-config.example.json`。

## 五、验收

1. 同毫秒事件按 INSERT 顺序读取，`afterId` 不漏后续事件；
2. Saga handler 业务事件后抛错，最终数据库状态为 failed，最后且唯一的状态事件为 `job:failed`；
3. failed 状态在 `job:failed` INSERT 前已经可见；
4. stale attempt 的 fail/requeue 不发虚假事件；
5. 已终态任务不发 `job:cancelled`；
6. 全量测试、TypeScript、ESLint 与生产构建通过。

## 六、实施结果

- `job_events` 已改为按 SQLite rowid 读取与续播；
- retry/cancel 已在状态迁移成功后才发布状态事件；
- 重复取消已取消任务已收口为 `already-terminal`；
- 真实 SQLite trigger 集成测试已验证 Saga 业务事件 → failed 状态 → `job:failed`；
- 未新增 LLM task、schema 或配置，`llm-config.example.json` 保持不变。

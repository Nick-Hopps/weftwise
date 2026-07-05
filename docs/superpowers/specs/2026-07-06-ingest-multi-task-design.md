# Ingest 多任务支持 — 设计文档

- 日期：2026-07-06
- 状态：已确认（Nick 批准）
- 范围：批量提交（前端）+ worker 并发执行（仅 ingest）+ 多任务进度聚合面板

## 背景与目标

当前 ingest 存在三层"单任务"限制：

1. **提交层**：文件/文本模式一次只能提交一个源（URL 模式已支持批量）。
2. **执行层**：worker 用 `isProcessing` 布尔严格串行，队列中多个 ingest job 只能一个跑完再跑下一个。
3. **展示层**：`GlobalJobTracker` 只追踪一个 job（`jobs[0]`），多任务时其余不可见。

目标：三层全部打通——多文件一次提交、多个 ingest 并行执行、所有活跃任务统一可见。

串行的历史理由是"并行 git commit 会损坏 vault"，但 2026-07-06 已落地 `vault-mutex`（进程内互斥队列 + 跨进程文件锁），Saga 写入已具备并发安全基础。

## 决策摘要

| 决策点 | 选择 |
|--------|------|
| 范围 | 批量提交 + worker 并发 + 进度面板，三层全做 |
| 并发策略 | **仅 ingest 之间可并发**；非 ingest 任务与一切互斥（独占执行） |
| 并发上限 | 全局设置 `app_settings.ingestConcurrency`（默认 2，范围 1–4），worker 每轮 tick 实时读取 |
| 批量提交 | 前端循环调用现有单文件 `POST /api/ingest`，API 零改动 |
| 进度 UI | 右下角聚合面板（列出所有 running + pending job），替换单条 ProgressToast |

## 1. 批量提交（纯前端）

- `ingest-workbench` 文件模式改为 `<input multiple>` + 拖拽多文件。
- 前端逐个调用现有 `POST /api/ingest`（multipart 单文件），每文件独立 job；归集结果为 `{ filename, jobId?, sourceId?, error? }[]`。
- 提交后展示逐条结果面板，复用 URL 模式已有的逐条结果样式；单文件失败标红、不阻塞其余。
- Text 模式、URL 模式行为不变；API / 路由零改动。
- 结果归集逻辑抽为纯函数便于单测。

## 2. Worker 并发执行（仅 ingest）

### 调度规则（`src/server/jobs/worker.ts`）

- `isProcessing: boolean` 替换为 `runningJobs: Map<jobId, type>`。
- 每轮 tick 的 claim 决策：
  - 完全空闲 → 可 claim **任意类型**（claim 到非 ingest 则该 job 独占直到结束）；
  - 当前跑的全是 ingest 且数量 < `ingestConcurrency` → 只允许再 claim 一个 **ingest**（`claim({ onlyTypes: ['ingest'] })`）；
  - 其余情况（有非 ingest 在跑，或 ingest 已满额）→ 本轮不 claim。
- 决策逻辑抽成纯函数（形如 `decideClaim(runningTypes: string[], limit: number): 'any' | 'ingest-only' | 'none'`），便于单测。
- 心跳、SSE emit、重试、取消均已是 per-job 闭包，天然兼容并发，无需改。
- 优雅关停：等待 `runningJobs` 清空（现有逻辑按 flag 判断处改为按 Map size）。

### 队列层（`queue.ts` / `db/repos/jobs-repo.ts`）

- `claim()` 增加可选类型过滤：`claim(opts?: { onlyTypes?: string[] })`；SQL 加 `type IN (...)` 条件，原子性保持（`busy_timeout` + 事务语义不变）。
- 现有调用方不传参数 → 行为不变。

### 并发上限设置

- `app_settings` 新增键 `ingestConcurrency`（int，默认 2，clamp 1–4）。
- 贯通：`lib/contracts.ts` settings schema → `settings-repo` 读写 → `GET/PUT /api/settings` → 设置面板 Agents 分区加一行 `NumberSettingRow`（"Ingest concurrency"）。
- worker 每轮 tick 经 `settings-repo` 实时读取，修改无需重启；设为 1 = 行为完全等同现状。

### 写入安全与既有机制交互

- 并发 ingest 的 Saga 写入（fs + SQLite + git commit）靠 `vault-mutex` 串行化，commit 排队执行，vault 不会损坏。
- checkpoint（断点续传）、job_events、租约心跳均按 jobId 隔离，无共享可变状态。
- ingest 完成后自动入队的 `curate` 与 `embed-index` 均为非 ingest 类型 → 按调度规则自动等待所有 ingest 结束后独占执行（符合预期，curate 看到的是全部 ingest 落盘后的状态）。

## 3. 多任务进度聚合面板（前端）

- `GlobalJobTracker` 从单 `activeJobId` 改为维护**活跃 job 列表**：
  - 轮询 `/api/jobs?status=running` 与 `/api/jobs?status=pending` 合并（保持 5s 间隔）；
  - `wiki:job-started` 自定义事件即时补入（含 retry 场景的 reconnect 语义，保留现有 reconnectKey 机制、按 jobId 维度）。
- 新组件 `shared/jobs-panel.tsx` 替换单条 `ProgressToast` 的挂载位置：
  - 右下角面板，每行 = 任务类型图标 + 文件名/摘要（来自 job params）+ 状态 + 最新事件一行文本；
  - 每个 **running** job 各自持有一条 `useJobStream` SSE 订阅；**pending** 行只显示 "Queued"，不建 SSE；
  - 单任务时视觉退化为与现有 toast 相近的紧凑单行；
  - 行内「详情/错误」入口复用现有 `JobDetailDialog`（透传该行的 events/status，不新建第二条 SSE）；
  - completed 行保留数秒后自动移除；failed 行驻留直到用户关闭或重试。
- query invalidation 保持现有语义：任一 job 转为 completed 即 invalidate `['pages']` / `['page-detail']`。
- `ProgressToast` 组件保留（其展示逻辑被 panel 行复用或改造），不影响其他调用点。

## 4. 测试

- `db/repos/__tests__/jobs-repo`：`claim` 类型过滤（onlyTypes 命中/不命中/不传兼容）。
- `jobs/__tests__/`：`decideClaim` 纯函数全分支（空闲/ingest 未满/ingest 满额/非 ingest 独占）。
- 前端纯函数：批量提交结果归集；panel 行摘要派生（如从 params 提取 filename）。
- 手动验证：多文件上传 → 并发 2 跑 ingest → 面板多行进度 → 全部完成后 curate 独占执行。

## 5. 已知限制（接受）

- **并发 ingest 写同一页**：两个源同时更新同一 slug 时，后提交者基于的 `existingPages` 快照可能略旧（planner 决策时未包含前一个 job 刚写入的内容）。Saga 靠锁串行落盘不会损坏数据，语义与"排队跑两次 ingest"差异很小，接受为已知限制。
- 并发度上限 4 为保守值：本机 LLM 供应商限流与 SQLite 单写者特性下，更高并发收益递减。

# Re-enrich 快速失败可见性设计

## 背景

Ask AI 批准 re-enrich 后，客户端先收到后台任务 ID，并在全局 Tasks 面板显示 `Queued`。当前 queued 行不建立 SSE；若 worker 在下一次 5 秒 active jobs 轮询前失败，该任务既不在 `pending`，也不在 `running`，轮询合并会直接移除该行，用户看不到失败原因。

本次现场中的直接失败原因是运行时 `ingest-enricher` 仍为 v4，而当前模板与 re-enrich 契约要求 v5。Worker 为保护用户自定义 skill，只播种缺失文件、不覆盖已有文件，因此内置模板升级后会留下旧副本，直到人工删除并重启。

## 目标

- queued 任务快速完成或失败时，Tasks 面板能够恢复终态并保留详情入口。
- 不为所有 queued 任务提前建立 SSE，继续控制浏览器连接数。
- 未修改的历史内置 skill 可在 worker 启动时安全升级到当前模板。
- 用户修改过的 skill 永不被自动覆盖。

## 约束

- Tasks 面板仍以 `/api/jobs?status=pending|running` 为 active jobs 权威来源。
- 任务终态仍由既有 SSE `final` 事件确认，不在客户端猜测成功或失败。
- 内置 skill 自动升级只能命中完整文件 SHA-256 白名单，不能仅按版本号覆盖。
- 不改变 re-enrich 的 Saga、审批、队列或 LLM 流水线。

## 方案比较

### 方案 A：所有 queued 行立即订阅 SSE

实现最简单，也能直接收到快速终态；但批量 ingest 或维护任务会同时占用大量浏览器 SSE 连接，破坏当前“running 才订阅”的连接控制。

### 方案 B：active 列表缺失时直接查询单任务

可读取终态，但需要为每个消失行额外发起 REST 请求，并在 Tasks 状态中复制一套终态和错误字段；终态展示会与既有 SSE 逻辑形成两份实现。

### 方案 C：缺失 queued 行转入 SSE 终态恢复（推荐）

queued 行保持零连接；当 active 轮询首次发现它已不在 pending/running 时，将该行切换为可订阅状态，由既有 SSE 回放持久化事件并发送权威 `final`。这只为发生状态跃迁的任务建立连接，并复用现有错误详情逻辑。

## Skill 升级策略

在 builtin manifest 中记录允许升级的历史原版 SHA-256。Worker 构建 registry 时：

1. 对每个有升级规则的内置 skill 读取 vault 副本。
2. 当前 hash 命中历史原版白名单时，以 `examples/skills` 当前模板原子替换。
3. 当前 hash 不命中时视为用户改版，保持原文件不变。
4. 缺失文件继续走既有播种逻辑。

该策略只自动迁移能够证明“未被用户修改”的旧内置文件，安全边界与 retired skill 的 hash 判定一致。

## Tasks 状态恢复

轮询合并 active jobs 时保留两类未列出的旧行：

- 已经 running 的行继续保留，等待其 SSE 终态。
- 原 queued 行切换为 running/streamable，仅用于启动 SSE 终态回放。

已 dismiss 的任务不恢复；仍在 active 列表中的任务以服务端 queue status 覆盖本地状态。

## 成功标准

- 精确匹配历史 v4 模板的 `ingest-enricher` 自动升级为当前 v5。
- 用户修改过的旧 skill 保持逐字不变。
- 快速失败的 queued 任务不再消失，而是显示 Failed 并可查看错误。
- 正常 queued、running、completed、failed 汇总行为保持不变。
- registry、任务面板状态、lint 与生产构建通过。

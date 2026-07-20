# Spec：采集任务取消后的检查点竞态修复

日期：2026-07-21
状态：已定稿

## 背景与问题

用户结束 failed Ingest 时，`requestCancel()` 会在事务内标记 `cancel_requested=1` 并删除
`ingest_checkpoints`。但仍在执行的 worker 可能已经越过取消检查，在事务提交后继续调用
`putCheckpoint()`，把检查点重新写回。

Ingest 工作台刷新时会恢复所有仍有 checkpoint 的 failed job，因此这类已取消任务会再次显示为
失败。当前数据库中的 3 个异常任务均符合该时序：取消完成时间早于随后写回的 `plan` checkpoint。

## 目的

- 已取消 job 从数据库提交取消状态后，任何迟到的 checkpoint 写入都必须被原子拒绝。
- 历史数据库中已存在的“cancelled job + checkpoint”不得再被视为可续传任务。
- 普通 failed job 继续保留取消前已有的 checkpoint，维持现有断点续传语义。
- 不改变 jobs status、SSE 协议或 worker 并发模型。

## 方案取舍

### 方案 A：checkpoint 仓储层原子门禁（推荐）

`putCheckpoint()` 使用单条条件写入，只在目标 job 不处于 `cancel_requested=1` 时 upsert；
`getProgress()` 对 cancelled job 返回 `null`，兼容历史遗留脏数据。

优点：在所有 checkpoint 类型共用的最终写边界消除竞态；无需依赖 worker 在每个 await 后都检查
取消；读取防御可立即修复既有数据的恢复行为。缺点：保留少量历史孤立行，后续可由维护机制清理。

### 方案 B：每个 agent 阶段写入前检查取消

优点：流程语义直观。缺点：检查与写入之间仍有 TOCTOU，且容易漏掉新增 checkpoint 类型，不采用。

### 方案 C：为数据库增加 trigger

优点：约束更强。缺点：需要 trigger 迁移与版本治理；当前运行时只有一个 checkpoint 写入口，超过
本次修复所需，不采用。

## 成功标准

- running Ingest 被取消后，迟到的 `putCheckpoint()` 不产生记录。
- cancelled job 即使数据库里遗留 checkpoint，`getProgress()` 仍返回 `null`。
- 未取消的 failed job 仍能读取已有 checkpoint 进度并用于续传。
- 当前 3 个已取消任务不再进入 Ingest 工作台恢复集合。
- 定向测试、全量测试、TypeScript 与 lint 通过。

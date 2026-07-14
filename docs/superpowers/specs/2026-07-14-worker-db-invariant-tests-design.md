# Worker 与数据库不变量测试收尾设计

日期：2026-07-14  
状态：已完成

## 一、背景

工具与工作流治理 Phase 0–3 已完成。仓库测试策略仍明确列出四类底层可靠性缺口：worker 心跳续租、jobs claim 原子性、pages 复合主键和手动维护的 FTS 一致性。本阶段只补齐这些不变量及其暴露的最小实现缺陷，不新增产品能力、LLM task 或工具。

`wiki.reenrich` 弃用 alias 仍处于总 spec 规定的一个版本观察期，本阶段不删除。

## 二、范围

### 2.1 Worker 心跳

- 任务领取后，30 秒前不续租，恰好 30 秒执行第一次心跳；
- 长任务持续按 30 秒续租；
- completed、failed、cancelled 与 retry/requeue 路径离开 `runJob` 后必须清除心跳定时器；
- `updateHeartbeat` 只允许更新 `status='running'` 的任务，旧 worker 不得给终态或已重排任务续租；
- 心跳异常继续被吞掉，由租约过期机制接管，不覆盖 handler 结果。

### 2.2 Job 租约与领取

- `claimNextJob` 的单条 `UPDATE ... RETURNING` 必须让同一 pending job 只能被领取一次；
- type filter 不能领取其他类型；
- `attempt_count` 只在成功 claim 时加一，requeue 本身不加，下一次 claim 再加；
- worker 把 claim 返回的 `attempt_count` 作为 fencing token；heartbeat/complete/fail/requeue 只有在 `status='running' AND attempt_count=token` 时才能落库，旧 attempt 不得覆盖新领取者；
- `lease_expires_at <= now` 视为已经过期，claim 与 reclaim 使用相同边界；
- 未过期 running job 不得被重复领取或回收。

### 2.3 Pages 复合身份

- `(subject_id, slug)` 是复合主键：跨 Subject 同 slug 合法，同 Subject 重复非法；
- `path` 全局唯一；
- `upsertPage` 只能更新精确复合身份，不污染另一 Subject 同名页；
- `deletePage` 只删除精确复合身份及其本 Subject FTS/出链。

### 2.4 FTS 手动一致性

项目没有 pages/FTS trigger，一致性完全依赖 `updateFtsEntry` 与 `deleteFtsEntry`。测试必须覆盖：

- update 先替换旧 FTS 行，不产生重复；
- 相同 slug 在不同 Subject 中互不覆盖；
- search 返回新 title/summary/body，旧内容不再命中；
- delete 与 `deletePage` 只清理目标复合身份的 FTS 行。

## 三、实现约束

- 先写红测，再做最小实现修复；
- 时间边界通过 fake timers 固定，不依赖真实等待；
- 数据库约束使用真实临时 SQLite/WAL，不用 mock；
- 不引入 trigger，不把 FTS 一致性职责移出既有 repo/indexer；
- 不修改 `llm-config.example.json`。

## 四、验收

1. worker 心跳定时、清理、异常吞并和 running-only 更新均有测试；
2. claim/reclaim/requeue/attempt 边界有真实数据库测试；
3. pages 复合主键、path unique、跨 Subject 隔离有真实数据库测试；
4. FTS update/delete/search 的复合身份一致性有真实数据库测试；
5. 仓库文档移除对应“仍待补充”项；
6. 定向测试、全量 Vitest、TypeScript、ESLint、production build 通过；
7. `llm-config.example.json` 无差异。

## 五、验收结果

- 核心定向测试：3 个文件、60 个用例通过；相关 jobs 回归集：4 个文件、65 个用例通过；
- 全量测试：239 个文件、2103 个用例通过；
- `npx tsc --noEmit`、`npm run lint`、`npm run build` 通过；
- `llm-config.example.json` 无差异；
- 修复项仅为租约 `<= now` 边界，以及基于 `attempt_count` fencing token 的 heartbeat/complete/fail/requeue 条件更新。

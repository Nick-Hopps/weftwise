# Wiki 工作流控制工具 Phase 3C 设计

日期：2026-07-14
状态：已完成

## 一、来源与目标

本设计承接 `2026-07-10-wiki-tooling-and-workflow-governance-design.md` 的 Phase 3 第 3 项，把已有 job queue、re-enrich、research、任务状态与取消能力收敛为 Ask AI 可治理的工作流命令：

```text
workflow.status
  → active Subject 内只读任务状态

workflow.reenrich.start / workflow.research.start / workflow.cancel
  → PendingAction 预览
  → 独立批准 API
  → 原子启动或取消任务
```

核心边界是：模型可以查看任务并提出启动/取消，但不能直接创建或终止 job；工具调用成功、聊天回复或 actionId 都不等于批准。

## 二、范围

### 2.1 本期实现

1. `workflow.status`：读取 active Subject 内一个 job 的安全状态摘要；
2. `workflow.reenrich.start`：为单页 re-enrich 创建 PendingAction；
3. `workflow.research.start`：为自由主题 Research 创建 PendingAction；
4. `workflow.cancel`：为 active Subject 内非终态 job 创建取消 PendingAction；
5. 启动/取消批准复用现有 jobs queue、cancel event 与 Research provenance 对账；
6. 启动 job 与 action applied 在同一 SQLite 事务内提交，避免崩溃后重复入队；
7. `wiki.reenrich` 保留一个版本作为弃用别名，但改为相同的 PendingAction 提案语义并记录 deprecation 日志；
8. 扩展 pending_actions operation CHECK，保留历史数据并接受三个 workflow operation。

### 2.2 非目标

- 不新增任意 job type 或通用 `workflow.start({ type, params })`；
- 不让模型读取 job 的原始 `paramsJson`、`resultJson`、错误堆栈或跨 Subject 状态；
- 不绕过 Research 自身的候选审批与导入 provenance；Research start 只启动“发现”阶段；
- 不为 ingest、fix、curate、lint 新增 start 工具；
- 不实现 `wiki.move`；
- 不新增 LLM task，不修改 `llm-config.example.json`。

## 三、工具契约

### 3.1 `workflow.status`

输入：`{ jobId: string }`。

输出：

```ts
{
  found: boolean;
  job: null | {
    jobId: string;
    type: Job['type'];
    status: Job['status'];
    cancelled: boolean;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    attemptCount: number;
  };
}
```

只允许 `job.subjectId === activeSubject.id`。未知、全局 job 与跨 Subject job 统一返回 `found:false`，不泄露其存在性；输出不包含原始参数、结果与内部错误。

### 3.2 `workflow.reenrich.start`

输入：`{ slug: string }`，输出 `PendingActionView`。工具只生成 operation=`workflow-reenrich-start` 的 workflow preview：校验页面存在且不是 meta 页，但批准前不入队。

批准时重新校验目标，并原子创建 `re-enrich` job 与标记 action applied。批准返回的 `jobId` 可继续交给 `workflow.status`。

### 3.3 `workflow.research.start`

输入：`{ topic: string }`，topic trim 后必须非空且限制长度；输出 `PendingActionView`。工具只生成 operation=`workflow-research-start` 的 workflow preview。

预览与批准都检查 Web Search 已配置。批准只创建 subject-scoped `research` job，沿用 `{ topic, subjectId }` 参数；Research 完成后仍停在候选审批，不自动导入来源或写 Wiki。

### 3.4 `workflow.cancel`

输入：`{ jobId: string }`，输出 `PendingActionView`。只接受 active Subject 内 `pending/running` job；未知、跨 Subject、全局或终态 job 均不可规划。

批准时重新读取 job 并调用既有原子 `requestCancel`，写 `job:cancelled` 事件，再 best-effort 执行 `reconcileResearchProvenanceForJob`。action 保存目标 `jobId`，取消与 action applied 同一 SQLite 事务收口；事件/对账失败不反转已经成功的取消。

## 四、治理与兼容

1. `workflow.status` 为 `sideEffect:'none'`，进入 `query:read` 与 `query:propose`；
2. 三个 start/cancel 工具实际只提出 PendingAction，因此 ToolDef 标记 `sideEffect:'propose'`，只进入 `query:propose`；
3. Query profile 仍不包含任何 `enqueue/destructive` 直接执行工具；
4. `wiki.reenrich` 作为兼容 alias 同样是 `propose`，调用新 re-enrich preview callback，并通过服务端日志记录弃用；
5. prompt 明确要求状态先查 jobId，启动/取消只调用一次提案工具，并说明审批按钮是唯一授权入口；
6. 意图分类把明确的“开始 Research / 重新丰富 / 取消任务”识别为 propose，教程、能力询问和否定句仍保持 read。

## 五、审批、一致性与恢复

1. payload 参与 canonical hash，并包含 `effectiveAt`；
2. 批准前重新规划，目标页、Web Search 配置、job subject 与终态均重新校验；
3. workflow preview 继续保存创建时 HEAD 作为审计快照；HEAD 变化时刷新 preview 并要求再次批准；
4. start 在 SQLite IMMEDIATE transaction 中完成 job insert + action applied，任一步失败整体回滚；
5. cancel 在 SQLite transaction 中完成 job cancel + action applied，随后发事件与 provenance 对账；
6. 原子事务提交前崩溃时不产生 job/取消，action 保持 `executing` 并由 maintenance 超时失败；提交后 action 已是 `applied`，不存在需要猜测的孤儿 job，也不会重复创建任务；
7. 重复批准沿用 PendingAction 单次消费语义。

## 六、UI 与审计

- PendingAction 卡片把 workflow 提案显示为“Proposed workflow action”，执行中状态显示“Executing workflow action”；
- start 成功显示 `jobId`，cancel 成功保留目标 `jobId`；
- tool activity 只显示 slug、topic 或 jobId；不输出 job payload/result；
- registry 与模块文档同步 builtin 数量和新工具边界。

## 七、测试与验收

1. registry 注册 27 个 builtin；新四工具只属于 Query profile；
2. `workflow.status` 对 active Subject 返回安全摘要，对跨 Subject/全局/未知 job 隐藏；
3. re-enrich/research/cancel 工具只生成 PendingAction，零 job/cancel 副作用；
4. start 批准原子入队，失败回滚，不产生重复 job；
5. cancel 批准只作用于 active Subject 非终态 job，并发/重复批准不重复消费；
6. Research start 在 Web Search 未配置时拒绝；
7. 旧 `wiki.reenrich` 返回相同审批语义并记录弃用；
8. pending_actions 启动迁移和 Drizzle 迁移保留旧行并接受新 operation；
9. PendingAction UI、Query prompt、意图分类和 tool activity 覆盖新命令；
10. 定向测试、全量测试、类型检查、lint、build 通过；
11. `git diff -- llm-config.example.json` 为空。

## 八、后续阶段

- Phase 3D：`wiki.move` 独立设计与实现；
- Phase 3C alias 观察期结束后删除 `wiki.reenrich`。

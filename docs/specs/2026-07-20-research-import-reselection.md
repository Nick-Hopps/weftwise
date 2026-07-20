# Research 导入失败后重新选择候选设计

## 背景

Research 在用户批准搜索候选后，会冻结候选决策并创建 `research-import` 协调任务。当前导入失败的 run 只支持重置原失败 delivery 后重试，无法回到候选选择阶段。与此同时，Health 投影把导入阶段失败的 finding 当作已处理结果隐藏，用户关闭失败弹窗后也无法从原待研究项恢复。

## 目标

- 导入阶段失败、尚未进入验证的 Research run 可以重新选择同一候选快照中的搜索结果。
- 重新选择不重新执行搜索，不接受客户端 URL，只使用服务端持久化候选 ID。
- 失败审批与 delivery lineage 不被覆盖或丢弃，保留可审计快照。
- 重新选择、审批归档、候选解冻和 run 状态迁移在同一 SQLite `IMMEDIATE` transaction 内完成。
- 导入失败不再从 Health 当前 findings 中消失；显式忽略、空结果和验证终态仍沿用既有投影语义。
- 既有“重试失败导入”继续保留，用户可在重试原候选和重新选择之间决定。

## 非目标

- 不重新执行 Tavily 搜索或 LLM triage。
- 不允许在已进入 verification 或已有 finding 验证结果后重新选择。
- 不为已完成或部分成功的 Research run 增加撤销能力。
- 不改变普通 Ingest 或 Research child Ingest 的原地重试语义。

## 现状与根因

1. `approveResearchRunAtomic()` 将所有候选从 `pending` 冻结为 `approved/rejected`，并由 `research_approvals_run_unique` 保证每个 run 只有一个活跃审批。
2. failed run 的现有恢复原语只把 failed delivery 重置为 `pending`，选择集合不变。
3. `readHandledOutcome()` 将 `failed` Research run 视为已完成处置，导致 baseline finding 被移入近期结果并从当前列表隐藏。
4. Health 刷新只从 active job 或 `awaiting-approval` plan 恢复候选弹窗；失败 run 关闭后没有恢复入口。

## 方案比较

### 方案 A：创建新的 Research run

复制候选快照并创建新 run，再把原 finding 关联到新 job。

- 优点：新旧 run 完全隔离，历史天然不可变。
- 缺点：需要制造新的 Research job 身份，重写 remediation 去重与 run/job 映射；相同搜索结果被重复持久化。

### 方案 B：把一个 run 改造成多活跃审批读模型

移除 run 唯一审批约束，在 `research_runs` 增加 current approval 指针，所有读取与对账都按该指针过滤。

- 优点：历史完全结构化，长期扩展性最好。
- 缺点：迁移和读写面很大；当前产品只需要串行重新选择，不需要并发或任意审批历史浏览。

### 方案 C：归档失败审批后复用现有审批状态机（推荐）

新增 `research_approval_attempts` 归档表。在重新选择事务中先保存审批与 deliveries 的不可变 JSON 快照，再解冻候选、删除当前审批及其 delivery、将 run CAS 回 `awaiting-approval`。之后继续调用既有批准 API 创建新的活跃审批。

- 优点：保留失败 lineage；继续维持一个 run 仅一个活跃审批；审批、协调和对账主路径几乎不变。
- 缺点：历史尝试以归档快照保存，当前 UI 不提供结构化历史浏览。

选择方案 C。它满足审计与恢复要求，并把变化限制在失败恢复边界，符合 YAGNI。

## 数据模型

新增 `research_approval_attempts`：

- `id`：归档记录 ID。
- `run_id`：所属 Research run，随 run 级联删除。
- `approval_id`：原审批 ID，同一 run 内唯一。
- `approval_json`：原 `research_approvals` 完整快照。
- `deliveries_json`：按 candidate 排序的原 delivery 完整快照。
- `archived_at`：归档时间。

表只追加，不参与活跃 run hydration。现有 `research_approvals` 和 `research_candidate_ingests` 继续表示唯一活跃审批尝试。

## 状态迁移

`failed -> awaiting-approval` 仅在以下条件全部成立时允许：

- `expectedVersion` 与当前 run version 一致。
- run 尚未关联 verification lint。
- 所有 finding 的 `verification_status` 仍为 `pending`。
- 存在活跃审批，且至少一个 delivery 为 `failed`。
- 所有 delivery 都已处于 `completed/failed` 终态，避免仍在运行的旧任务与新选择并发。

事务步骤：

1. 回读并校验 run、审批、候选和 deliveries。
2. 追加审批与 delivery 归档快照。
3. 将所有候选恢复为 `pending`，清空 `approval_id/decided_at`。
4. 删除活跃审批，利用外键级联删除旧 delivery。
5. CAS 更新 run 为 `awaiting-approval`，version + 1，清空完成时间和错误。
6. 回读新的 `ResearchRunView`；所有候选再次可选择，approval/delivery 为空。

## API 与 UI

新增 `POST /api/research-runs/[id]/reselect`：

```json
{
  "subjectId": "subject-id",
  "expectedVersion": 3
}
```

路由沿用 auth、CSRF、required subject 与 Research 稳定错误映射。成功返回 `202 { run }`。

失败弹窗同时提供：

- `重试失败的导入`：沿用原选择重试。
- `重新选择候选项`：归档旧尝试并回到可勾选状态。
- `关闭`：只关闭弹窗，不改变 run。

Health 投影仅在 Research 真正完成验证、显式忽略或空结果时隐藏 finding。导入前失败且 verification 仍为 pending 时保持 finding 可见，并显示失败状态。

## 成功标准

- failed run 点击重新选择后，同一 run ID 变为 `awaiting-approval`、version 增加、候选恢复可选。
- 重新批准不同 candidate ID 后会创建新的审批和 coordinator。
- 旧审批与 delivery 仍可从归档表完整读取。
- 陈旧版本、跨 subject、验证后失败、仍有非终态 delivery 均 fail closed。
- 关闭失败弹窗并刷新 Health 后，原 finding 仍存在。
- 原重试路径与普通首次批准行为测试保持通过。


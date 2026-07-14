# Wiki History 工具与回滚审批 Phase 3B 设计

日期：2026-07-14  
状态：已完成

## 一、来源与目标

本设计承接 `2026-07-10-wiki-tooling-and-workflow-governance-design.md` 的 Phase 3 第 2 项，把现有 History API、operations 仓储、git diff 与回滚 Saga 复用为 Ask AI 工具：

```text
history.list / history.diff
  → 只读核对 operation
  → history.revert
  → PendingAction 预览
  → 独立批准 API
  → 前向 Saga 生成新的回滚提交
```

核心边界是：模型可以读取历史并提出回滚，但不能直接执行回滚；聊天回复、工具调用成功或 actionId 均不等于批准。

## 二、范围

### 2.1 本期实现

1. `history.list`：列出 active Subject 的 operation，可按页面 slug 过滤并限制条数；
2. `history.diff`：读取 active Subject 内指定 operation 的 git diff；
3. `history.revert`：为指定 operation 创建 PendingAction，不直接写 vault；
4. 抽取 History 共享服务，供工具和既有 `/api/history/*` 路由复用；
5. 回滚计划记录当前 HEAD、逆向 changeset、确定性 diff 与受影响页；
6. 批准时重新规划并执行 stale HEAD 防护；
7. 回滚完成后原 operation 标记为 `reverted`，新 Saga operation 与 PendingAction 可恢复对账；
8. 扩展 pending_actions operation CHECK 的启动迁移，保留历史行并接受 `history-revert`。

### 2.2 非目标

- 不直接暴露任意 git SHA、git reset、checkout 或通用文件恢复；
- 不允许跨 Subject 查询或回滚 operation；
- 不改变 History 页面现有的人工确认交互；
- 不实现 workflow start/status/cancel 或 `wiki.move`；
- 不新增 LLM task，不修改 `llm-config.example.json`。

## 三、工具契约

### 3.1 `history.list`

输入：`{ slug?: string; limit?: number }`，`limit` 默认 20、最大 50。输出 `{ entries: HistoryEntry[] }`。列表按 operations 最新优先；`slug` 只匹配 `affectedPages.slug`，系统不会把查询扩大到其他 Subject。

### 3.2 `history.diff`

输入：`{ operationId: string }`。输出 operation 的 id、状态、受影响页和统一 diff。未知、跨 Subject、无提交或非终态 operation 统一按不可见处理，不泄露其他 Subject 的历史。

### 3.3 `history.revert`

输入：`{ operationId: string }`。输出 `PendingActionView`。工具为 `sideEffect:'propose'`，只进入 `query:propose`；它必须：

- 只接受 active Subject 中 `status='applied'` 的 operation；
- 从原 operation 的 `preHead` 读取旧快照；
- 从当前 HEAD 读取当前快照；
- 用既有 `buildRevertEntries` 生成前向 inverse changeset；
- 用统一 diff 展示“当前内容 → 回滚后内容”；
- 创建 action 后零 vault/operations/job 写入。

## 四、审批、并发与恢复

1. PendingAction payload 只保存 `operationId + effectiveAt`，并参与 canonical hash；
2. 批准前重新规划；若 HEAD 与预览不同，刷新 preview 并要求再次批准；
3. 真正 apply 时在 vault mutex 内再次用 `expectedPreHead` 比较，消除规划与持锁之间的竞态；
4. 第一个成功回滚会把原 operation 标为 `reverted`；并发第二次批准在重规划或 stale 分支失败；
5. 新回滚本身仍是普通 Saga operation，崩溃恢复沿用 changeset 标记；
6. PendingAction 保持 `executing` 时，维护流程根据新 operation 的 applied 状态重试“标记原 operation + embedding 入队 + action applied”的 SQLite 原子最终化。

## 五、既有 API 兼容

- `GET /api/history` 与 `GET /api/history/[id]/diff` 改为调用共享 History 服务，响应保持兼容；
- `POST /api/history/[id]/revert` 继续保留认证、CSRF 与页面内二次确认，内部复用同一回滚 plan/apply；
- API 与工具都以 server-side Subject guard 为准，不接受客户端自行声明的 operation 归属。

## 六、测试与验收

1. registry 注册 23 个 builtin；三个 History 工具只进入 Query profile；
2. list 的 subject、slug、limit 与稳定排序正确；
3. diff 拒绝未知、跨 Subject 与无提交 operation；
4. revert preview 零写入，payload hash 与 DB CHECK 支持新 operation；
5. 批准 fresh preview 才 apply，stale preview 刷新后必须再次批准；
6. 并发/重复回滚不可重复消费；
7. 最终化失败保持 executing，并可由维护流程重试；
8. 既有 History API 行为保持兼容；
9. 定向测试、全量测试、类型检查、lint、build 通过；
10. `llm-config.example.json` 与本阶段基线无差异。

## 七、后续阶段

- Phase 3C：workflow start/status/cancel；
- Phase 3D：`wiki.move` 独立设计与实现。

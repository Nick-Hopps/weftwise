# Health 逐条处置互不阻塞：门控粒度从 action 类型下沉到处置目标

日期：2026-07-30
状态：设计定稿（盘问结论已沉淀进「目的 / 约束 / 成功标准」三节）

---

## 一、问题现状

`2026-07-27-research-batch-per-topic-jobs` 引入了 `remediationButtonDisabled`，让**工具栏上的**「整理 / 修复 / 研究」三个批量按钮互不阻塞。它的注释把理由写得很清楚：

> 三个动作**互不阻塞**：worker 对非 ingest job 串行独占执行（`decideClaim`），vault 写入另有 vault-mutex 保护，所以点了就入队是安全的，禁用只会让用户白等。

但这个理由同样适用于「同一类型、不同 finding」，而那一半没改。**逐条 finding 行的按钮至今仍是按 action 类型全局禁用的。**

### 症状

Health 列表里有 3 条 orphan，点第一条的 Tidy → 另外两条的 Tidy **和**工具栏的「整理」一起变灰，直到那个 curate job 走到终态（实测一次 curate 约 1–5 分钟）。Fix / Research 同理。

### 机制

`finding-row.tsx:252` 的禁用条件：

```ts
disabled={
  deleting
  || (item.type !== 'review-source' && busyActions?.has(item.type))
}
```

`busyActions` 是 `health-view.tsx:1614` 传下来的 `effectiveBusyActions` —— 一个**按 action 类型**的全局集合，每一行拿到的是同一份引用。所以只要 `busyActions` 里有 `'curate'`，全部行的 Tidy 一起禁用。

三个来源都往这个全局集合里置位（`health-view.tsx:225-239`）：

| 来源 | 置位条件 |
|---|---|
| `busyActions` state（`acquireAction` 写） | 本次点击 |
| `blockingRecoverableActions(recoverableJobs)` | 任何 running/pending 的 fix/curate/research job（`recoverableFromActiveJob` 里 `blocksAction: true` 是硬编码常量） |
| `persistedBusyActions(data)` | 快照里**任一** finding 的 plan 是 `queued` |

### 服务端不需要这个限制

- `remediation-service.ts:171` 用 `normalizeRemediationContext({ lintJobId, findingIds, action })` 算幂等键，`findDuplicateRemediationJob` 按 `contextKey` 精确匹配。不同 finding → 不同 context → **各自建独立 job**，不会互相吞掉。
- `worker.ts:207` `decideClaim`：只要有非 ingest job 在跑就返回 `'none'`，第二个 curate job 老实排队，不会并发。
- vault 写入另有 `vault-mutex`（进程内队列 + 跨进程文件锁）兜底。

没有任何「一个 subject 同时只能有一个 curate」的服务端约束。禁用纯粹是客户端的过度保护。

### 根因：客户端三个追踪结构全按 action 类型开槽

```ts
createActionGate()      → Map<action, origin>                    // 一个类型一把锁
actingFindingByAction   → Partial<Record<action, string>>         // 一个类型只记得住一个 finding
actionJobMetaRef        → Partial<Record<action, ActionJobMeta>>  // 一个类型一个 jobId
```

`actingFindingByAction` 是关键：它的**类型本身**就规定了「同一时刻一个 action 只能有一个进行中的 finding」。7-27 给 research 开的 `researchQueueRef` 例外解决的是「**一次点击**拆成 N 个 job」，不是「**N 次点击**各自的 job」，帮不上这里。

另外 `readStrictRemediationContext`（`remediation-ui.ts:306`）已经在校验 `context.findingIds` 了，但**校验完就丢**，只返回 `{ action, lintJobId }` —— 客户端因此不知道每个在途 job 覆盖了哪些 finding。

---

## 二、目的

1. **逐条处置互不阻塞** —— 点了一条 finding 的 Tidy，其余 finding 的 Tidy 仍可点，服务端按队列串行执行。
2. **「防重复提交」按正确粒度实施** —— 禁用的依据是「这条 finding 已被某个在途 job 覆盖」，不是「这个 action 类型有人在用」。
3. **不引入新的 SSE 连接数** —— 观察 N 个在途 job 沿用已验证过的单流逐个观察模式。

---

## 三、约束（盘问结论）

### C1 门控粒度：行内按 finding 独立，工具栏批量保留每类型一把锁

**Nick 的决策**（在「全部按目标独立、批量也可并发多批」与「只解除终态残留误禁用」之间选定中间档）。

- **行内按钮**：各自门控，互不阻塞；每行有自己的 jobId 与 Stop。
- **工具栏批量按钮**：仍是每类型一把锁 —— 仅当**它自己发起的那一批**在途时禁用，不再被行内点击禁用，也不再禁用行内。

理由：批量按钮一次提交整个可见列表，允许并发多批会立刻产生「同一 finding 同时进了两批」的归属问题，而 Stop 的取消范围也随之变模糊。批量入口只有一个、一次一批，语义清晰且已够用。

### C2 SSE：沿用 `researchQueueRef` 模式，每类型单条流逐个观察

`health-view` 现有 **5 个固定的 `useJobStream`**（lint / curate / fix / re-ingest / research），hooks 数量不能随在途 job 数变化。两个可选方向里选定单流逐个观察：

- worker 对非 ingest job 串行独占，**同一时刻只有一个 job 真在 running**，其余都是 pending。为 pending job 各建一条 SSE 是空跑连接。
- 行内 `running` 态来自该流；行内 `queued` 态来自已有的 active-jobs 轮询（5s，`health-view.tsx:205`）—— 这条数据通路本来就在，`persistedBusyActions` 用的就是它。
- 7-27 已为 research 验证过这个模式，**包括它的坑**：`useJobStream` 在 jobId 变化时不重置 status，切换观察目标前必须先 `reset()`，否则残留终态会让下一个 job 瞬间被误判为已完成。新的 fix/curate 队列必须照抄这条纪律。

代价如实记录：队列中间某个 job 的**进度事件**在轮到它之前不会被观察到，行内只能显示 `queued`。这与用户看到的事实一致（它确实还没开始跑），不构成信息损失。

### C3 重叠判定：按「finding 是否已被在途 job 覆盖」禁用

**Nick 的决策**（对比「只看本行自己点过没有」）。

从每个在途同类 job 的 `remediationContext.findingIds` 算出「已被覆盖的 finding 集合」，行内按钮只在**自己那一条**落在该集合里时禁用。

- 点了工具栏「整理 (3)」→ 那 3 行的 Tidy 自然禁用，第 4 行不受影响。
- 落选方案会让已被批量覆盖的行仍可再点一次：服务端 context 不同会真建第二个 job，同一页被整理两次 —— 不出错，但白烧一次 LLM。

实现上需要让 `readStrictRemediationContext` 把已经校验过的 `findingIds` 返回出来（当前是校验完丢弃）。

### C4 零回归硬要求

- **All Subjects 只读边界不动**：`onAction` 在 `allSubjects` 时仍为 `undefined`，不挂任何执行回调。
- **hydration 安全门不动**：`activeJobsHydrationBusyActions` 在首次成功读到 active jobs 前禁用全部四类入口 —— 这是防「刷新后重复提交」的，与本次要解除的阻塞无关，保持整类禁用。
- **`orphan-source` 的 Delete Source 不动**：它有自己的 `deleting` / armed 二次确认通路，独立于通用 action。
- **`review-source` 不动**：纯导航，从来不参与门控。

---

## 四、成功标准

1. 3 条同类型 finding，逐条点击各自的处置按钮 → 建出 3 个独立 job，`jobs` 表可见，worker 串行跑完，**点击过程中没有任何按钮因为别人在跑而变灰**。
2. 工具栏「整理 (N)」在途时，被它覆盖的那 N 行禁用，第 N+1 行仍可点。
3. 行内 Stop 只取消自己那一条的 job；工具栏 Stop 只取消自己那一批。
4. 队列里前一个 job 终态后，下一个的 running 态能被观察到（`reset()` 纪律生效，不出现「整队瞬间判完」）。
5. 刷新页面后，全部在途 job 都能恢复到对应行，不丢不重。
6. 切换 subject / scope 时，旧的队列与 in-flight 记录同步作废（沿用 `origin` 代次隔离）。
7. `npm run lint` 与 `npx vitest run src/components/health` 全绿；新增纯函数有单测锁定「同类型不同 finding 互不禁用」。

---

## 五、改动面

| 文件 | 改动 |
|---|---|
| `remediation-ui.ts` | `readStrictRemediationContext` 返回 `findingIds`；新增纯函数 `coveredFindingIds(activeJobs, action)` 与 `rowActionDisabled({ findingId, action, coveredIds, hydrationBusy })`；`createActionGate` 的键从 `action` 改为 `action + target`（target = findingId 或批量哨兵） |
| `finding-row.tsx` | `busyActions: ReadonlySet<action>` 换成按本行算好的禁用集；新增行内 Stop（复用 `requestHealthJobCancel`） |
| `health-view.tsx` | `actingFindingByAction` / `actionJobMetaRef` 改为按 `action + target` 键；curate/fix 各引入一个 `queueRef`（照抄 research 的 `reset()` 纪律）；工具栏按钮只看自己那一批 |
| `remediation-ui.test.ts` | 新增/调整用例：同类型不同 finding 互不禁用、被批量覆盖的行禁用、hydration 门仍整类禁用 |
| `src/components/CLAUDE.md` | 同步 health 段落 |

**服务端零改动** —— 它本来就支持。

---

## 六、明确不做（YAGNI）

- **不给在途 remediation job 加数量上限**。`MAX_RESEARCH_BATCH_JOBS = 10` 存在的理由是「一次点击可能创建 100 个 job」；行内是一次点击一个 job，受人手点击速率天然限流。真出现「点了二十条把 worker 堵住几小时」，那是用户的明确意图，不该由 UI 代为否决。
- **不为每个在途 job 建独立 SSE**（C2 已否）。
- **不改工具栏批量按钮的并发语义**（C1 已定）。
- **不动 `isUntouchedSkip` 与快照投影**。那是 7-28 的正确设计，与本次无关。

# Tidy 修 orphan 的信息断层与「假已处理」闭环

日期：2026-07-28
状态：设计定稿（盘问结论已沉淀进「目的 / 约束 / 成功标准」三节）

---

## 一、问题现状

`world-history` 的 `mongol-empire` 页面上，`orphan` finding（无入链）**每次点 Tidy 后消失、重新 lint 后原样回来**，稳定复发。

### 复现证据（真实 DB）

`data/wiki.db` 里三次针对同一个 finding ID 的 Curate 任务，结果逐字节相同：

| curate job | created_at | result |
|---|---|---|
| `d2e39885` | 2026-07-28T08:10:52Z | `writes:0, touchedSlugs:[], perFindingOutcomes:{6f79135a…:"skipped"}` |
| `918eb06b` | 2026-07-28T08:12:48Z | 同上 |
| `e97dbcfd` | 2026-07-28T11:59:03Z | 同上 |

`job_events` 显示 agent 只调了 `wiki_read`×2 + `wiki_inspect`×2 就收工，**一次写都没有尝试**。

### 根因一：worklist 解析出来了，但没进 prompt

`curate-service.ts:192` 调 `resolveCurateWorklist` 拿到 orphan finding 列表，但该值只流向 `completeCurate` 做结果归因 —— `buildCurateAgenticUserPrompt(metas, promptCtx, { auto })`（`curate-prompt.ts:29`）的入参里**没有 worklist**。模型收到的只有页面 meta 清单 + 一句 "perform conservative structural maintenance"，而 system prompt 里写着 `When in doubt, do NOTHING`。

模型不知道 `mongol-empire` 是孤页，更不知道本次任务目标是给它补一条入链。**它什么都不做是对指令的正确执行** —— 错的是它在信息真空里执行。

### 根因二：这个 orphan 在 auto 模式下物理上无解

即使模型知道了目标，当前 scope 内也没有可行路径：

- `expandScopeWithNeighbors`（`curate-plan.ts:13`）过滤 meta 页，allowedSet = `{mongol-empire, global-history-from-states-to-modernity}`（与事件里的 `count: 2` 一致）。
- 唯一能修 orphan 的工具是 `wiki_link_ensure`，它要求源页正文里**已存在唯一自然锚点**（`wiki-link-ensure.ts:29-31` 明确禁止新建 `Related` 段落、禁止猜测锚点文本）。
- 而 `global-history-from-states-to-modernity.md` 里 **「蒙古」出现 0 次**，没有任何可挂的锚点。
- auto profile 不含 `wiki.create`（`profiles.ts:104`），造 hub 页这条路也封着。

orphan 判定本身没错：`lint-deterministic.ts:25` 给 `getAllLinks` 传了 `metaKeys`，`index`/`log` 的出链不计入入链，而 `index.md` 正是当前唯一链到该页的地方。

### 根因三：`skipped` 与 `fixed` 一样被隐藏，制造「已处理」假象

`remediation-status.ts:79-89`：只要 `readHandledOutcome` 返回非 null（含 `skipped`），finding 就 `continue` 掉、不进 `visibleFindings`。于是时间线变成：

1. Tidy 完成（`completedAt` 晚于 baseline lint 的 `ranAt`）→ `completedAfterSnapshot` 为真 → finding 被隐藏 → **看起来修好了**。
2. 手动 Run check（discovery）→ 新 lint 的 `ranAt` 晚于该 Curate 的 `completedAt` → `completedAfterSnapshot` 为假 → finding 回到列表，`applyCurrentJob` 给它 `status:'skipped'`。

这个「消失 → 重新 lint → 原样出现」的翻转就是 Nick 观察到的现象。`skipped` 的语义是**未触达**，问题必然仍在，隐藏它等于谎报。

---

## 二、目的

1. **Tidy 必须知道自己在修什么** —— 消除 worklist 解析出来却不进 prompt 的信息断层。
2. **「没修成」必须在列表上可见** —— `skipped` 不再伪装成已处理，用户不必靠重跑 lint 才发现问题还在。
3. **消除翻转闭环** —— 同一个 finding 在 Tidy 前后、re-lint 前后的可见性与状态保持一致。

---

## 三、约束（盘问结论）

### C1 worklist 注入 user prompt，system prompt 一字不改

`CURATE_AGENTIC_SYSTEM_PROMPT` 是策展宪法，对 auto/manual × 有无 remediationContext 四种组合都生效；`When in doubt, do NOTHING` 这条保守纪律本身正确，不该为单个 finding 类型放松。

「本次任务是修这几条 orphan」属于**语境**而非纪律，放 user prompt。无 worklist 时（manual Tidy、ingest 后的自动 Curate）prompt **逐字节不变** —— 零回归是硬要求。

### C2 只注入 finding 事实，不注入 finding ID，不下达「必须写入」的命令

注入 `pageSlug` + `description` + `suggestedFix`，并明说「若邻域内找不到自然锚点，就不要写 —— 报告为什么找不到」。

**理由**：
- agent 仍须自我门控。根因二那种情况下，**正确答案就是不写** —— 逼它写只会诱导它伪造锚点或新建 `Related` 段落，而后者被 `wiki_link_ensure` 硬拒，白烧 token。
- 不注入 finding ID：模型没有任何正当理由消费它，注入只会增加它写进正文的风险。归因始终由服务端 `postcondition.scope.touchedSlugs` 完成，不依赖模型自报。

### C3 只让 `skipped` 回归可见列表，`fixed` / `failed` 保持隐藏

**理由**：三档语义不同，2026-07-15 那次「统一隐藏」的决策对其中两档成立、对第三档不成立。

| outcome | 含义 | 隐藏是否诚实 |
|---|---|---|
| `fixed` | 已触达且 postcondition 干净 | 诚实 |
| `failed` | 已触达，postcondition 判残留 | 诚实（真实结果进近期摘要） |
| `skipped` | **未触达** —— 问题必然仍在 | **不诚实** |

改动收敛到唯一制造假象的那一档，不整体推翻既有契约。

信息不丢失，只是换位置：`skipped` 从「近期摘要的一个计数」变成「列表里带 `skipped` 徽章的一行」，后者才是可操作的呈现。

### C4 前端零改动

`finding-row.tsx:62` 已有 `skipped` 徽章与 `health.remediation.skipped` 文案，`remediation-ui.ts:400-432` 已统计该状态。`applyCurrentJob` 本来就会给它算出 `status:'skipped'`（re-lint 之后的现状即如此）。所以本次只改服务端投影，UI 自动正确。

### C5 不给 auto 模式开 `wiki.create`，也不在 router 层预判「无锚点 → skipped」

**理由**：
- 开 `create` 等于让无人监督的后台任务能凭判断造 hub 页，越权面远大于收益。
- 预判需要 `routeFinding` 知道邻域正文里有没有锚点，而它是**不读 DB 的纯函数**（`remediation-router.ts`，新增 finding type 靠穷尽 switch 的 `assertNever` 兜底）。为此让它长出 IO，破坏的契约比解决的问题大。

C1+C3 落地后，用户看到的是「Tidy 试过、未触达」这个真话，可以自己去 `global-history-from-states-to-modernity` 加一句话带上链接 —— 这就是正确的人机分工：确定性护栏不允许模型凭空造锚点，那么造锚点这件事本就该由人来做。

---

## 四、成功标准

1. **prompt 层**：`buildCurateAgenticUserPrompt` 带 worklist 时输出含孤页 slug 与「找不到锚点就不要写」的纪律；**不带 worklist 时输出与改动前逐字节相同**。
2. **投影层**：`buildHealthSnapshot` 对 `skipped` 保留在 `findings` 且 `remediations[id].status === 'skipped'`；`fixed` / `failed` 仍隐藏且仍进 `recentOutcomes`；可见的 finding 不重复出现在 `recentOutcomes`。
3. **真实数据回归**：用 `data/wiki.db` 里那三个真实 Curate job + 最新 lint 快照喂 `buildHealthSnapshot`，断言该 orphan 在「Tidy 刚完成」的时序下**依然可见**且状态为 `skipped`（当前实现在此时序下会隐藏它）。零 LLM、确定性可复跑。
4. **全量测试**：`npm test` 全绿。

---

## 五、不做（YAGNI）

- **不给 auto 模式开 `wiki.create`**（C5）。
- **不在 router 层做「无锚点」预判**（C5）。
- **不改 orphan 的判定口径** —— `index` 出链不计入入链是有意设计（否则 index 会让全库零孤页，该规则直接失效）。
- **不让 `failed` 回归列表** —— 它已触达且真实结果进了近期摘要，与本 bug 无关；一并改动会把 2026-07-15 的决策整体推翻，超出需求。
- **不给 `mongol-empire` 手工补链** —— 那是内容决策，属于 Nick；本次只保证系统说真话。

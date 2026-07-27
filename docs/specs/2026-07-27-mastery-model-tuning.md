# Spec：掌握度模型调优与复习闭环

日期：2026-07-27
状态：已定稿
上游：
[docs/specs/2026-07-26-mastery-evidence-model.md](./2026-07-26-mastery-evidence-model.md)（spec ①）、
[docs/specs/2026-07-26-known-concept-map-surfaces.md](./2026-07-26-known-concept-map-surfaces.md)（spec ②）

> 本 spec 不引入新的证据来源，也不改动四态语义。它做四件事：
> **修**两处正确性/健壮性缺陷、**接**上 `dueAt` 的第一个消费者、**补**调参所需的观测面、
> **沉淀**两条一直只存在于讨论里的语义决策。

---

## 一、背景

`876205a7`（证据流掌握度模型 + 已知概念地图两个消费面）合入后，对照实现复核发现四类问题。
它们的共同点是：**都不会让任何测试变红**，只会在真实使用一段时间后以「数据不对劲」的形式浮出来。

### 缺陷 1：连击按 UTC 日折叠，与时区错位

决策 4 第 2 条要求「同一天内的多条正证据只算 1」，防的是反复点判分把连击刷到 5、
换来 120 天的 `mastered`。实现用 `new Date(iso).toISOString().slice(0, 10)` 取日期键
（`mastery.ts:66`）——那是 **UTC 日**。

vault 主人在 UTC+8。**北京时间早上 7:30–8:30 的一次学习会话跨过 UTC 午夜**：
同一坐答对两道题，一条落在 UTC 的昨天、一条落在今天，连击算 2，有效期从 +4 天跳到 +10 天。
这与「同一分钟点五下不构成五次复习」是同一个失真，只是换了个入口进来。

对称的反向失真同样存在：每天固定晚上 9 点（UTC 13 点）复习，本该连续计数，
但只要某天推迟到次日凌晨 1 点（UTC 17 点），仍算两个不同 UTC 日——这次是「该算 1 却算了 2」
的反面：**跨越两个自然日的两次真复习被折叠成 1**（例如 23:50 与次日 00:10 只算 1 天，
虽然中间只隔 20 分钟，这次折叠是对的；但 UTC 日边界落在北京时间早上 8 点，
让「昨晚 + 今早」这种最常见的复习节律被拆成两次）。

**根因是「日历日」这个单位本身**：它需要一个时区，而服务端不知道读者在哪个时区，
证据行里也没存。任何选定的时区都会在某个作息模式下出错。

### 缺陷 2：`POST /api/evidence` 入参无大小上限

`api/evidence/route.ts:15` 的 zod schema 里 `slug` / `anchor` 只有 `min(1)`，
`detail` 是 `z.unknown()` 且被原样 `JSON.stringify` 落进 `detail_json`。
App Router 的 route handler 没有默认 body 上限，一条请求可以往 append-only 的证据表里
写任意大的行。

今天是单机单用户，风险有限；但 `page_evidence` 恰恰是**永不删除**的表，
一次失控写入是永久的。且 `resolveUserId` 的注释已写明「未来多租户时由 auth 层解析真实
userId，调用点无需改动」——那时这个洞就是对外的。

### 缺陷 3：读完埋点的「到底」判定有粘性误报

`calculateReadingProgress` 在 `scrollHeight <= clientHeight`（内容不足一屏、根本不能滚动）
时返回 **100**（`reading-progress.tsx:11`）。而 `use-page-read-beacon.ts:123` 在 effect 首帧
就判一次，`reachedBottom` 一旦为 true 便**永不撤销**（这是刻意的：读完往回翻不该撤销）。

于是：图片 / mermaid / KaTeX 尚未布局完成时进入页面 → 首帧内容不足一屏 → 判定「到底」
→ 内容加载完页面变得很长 → 用户只看了开头，30 秒后照样发出一条 `page-read`。

`page-read` 是 exposure/weak，单条影响很小；但它是**唯一区分「接触过」与「没碰过」的证据**，
系统性误报会让 `exposed` 段虚胖，进而让重塑 prompt 对一堆没读过的概念说「一句话回顾即可」。

### 缺陷 4：`listStyleEvidence` 的查询形状没有索引支撑

`evidence-repo.ts:120` 的查询是 `WHERE user_id = ? AND kind IN (...) AND created_at > ?`，
而现有两个索引是 `(user_id, subject_id, slug, created_at)` 与 `(user_id, subject_id, created_at)`
——都以 `subject_id` 作第二列，这个查询**跨 subject**，只能吃到 `user_id` 前缀。

单用户下 `user_id` 前缀几乎不筛掉任何行，等于全表扫。且它挂在
`POST /api/evidence` 的同步路径上（style-bearing 证据每次写入都跑一遍 reducer）。
项目有 `indexes.test.ts` 用 `EXPLAIN QUERY PLAN` 锁热路径的惯例，这一条漏了。

### 缺口 5：`dueAt` 算了但没有任何消费者

决策 4 的两级语义里，`dueAt`（该复习了）与 `expiresAt`（失效）是两个不同的量。
实现照此产出，但 `deriveMastery` **只把 `expiresAt` 放进 verdict**，
`dueAt` 在 `mastery.ts:147` 被就地解构丢弃，注释写着「留给未来的复习提醒，不参与四态」。

而决策 4 自己写明了这套设计的软肋：

> 到期该复习 ≠ 到期就当作不会了。若直接拿间隔当有效期，答对一次只维持 1 天，
> **而系统里没有任何机制提示用户回去重答**。

双倍有效期是对「没有复习提醒」的**补偿**，不是替代。补偿只能推迟问题：
`mastered` 的最长有效期是 120 天，没有任何回访机制的话，一个月后 `mastered` 仍会大面积
静默回落 `exposed`，spec ① 成功标准里「一周后 `mastered` 非空」大概率先过、随后失效。

### 缺口 6：验收标准与待调旋钮都没有观测面

spec ① 留下三个明说「接入真实数据后再调」的常量（`READ_DWELL_MS=30s`、
`NEGATIVE_WINDOW_DAYS=14`、规则 3 的 strength 门槛），以及一条「若一周后 `struggling`
计数为 0 就放松判据」的遗留观察。今天要回答这些问题只能手写 SQL——
`seed-mastery-evidence.ts` 是**造**数据的，不是**看**数据的。

没有观测面，这些常量的调整会退化为凭感觉。

---

## 二、目的

1. 让连击计数与读者所在时区解耦，消除「同一次学习被计成两次复习」。
2. 给 append-only 的证据表装上写入侧的大小闸门。
3. 消除 `page-read` 的系统性误报，让 `exposed` 真的意味着「接触过」。
4. 给 `dueAt` 接上第一个消费者，让 `mastered` 不再只能静默过期。
5. 提供一个可重复运行的观测面，让 spec ① 遗留的调参有数据依据。

## 三、非目标

- **不改四态语义、不改优先级表、不改 strength 权重表**：本 spec 只修实现与语义的偏差，
  不重开决策 2/3 的论证。
- **不引入 BKT / FSRS 之类的概率记忆模型**：spec ① 决策 2 已明确「不落标量分数」，
  理由（稀疏证据下的假精度）依然成立。
- **不做复习任务调度 / 通知 / 邮件**：复习面是一个**被动清单**，用户来看才看得到，
  不主动打扰。
- **不做证据表 GC**：只沉淀决策，不实现（详见决策 6）。
- **不动 Graph 图层的视觉编码**：`due` 不进 stylesheet（理由见决策 4）。

## 四、约束与成功标准

**约束**

- **零证据零回归依然成立**：本 spec 的所有改动在证据为空时必须与今天行为一致——
  复习面空态不渲染、`dueAt` 恒为 null、prompt 不变。
- **`deriveMastery` 保持纯函数、零 IO**：新增的 `dueAt` 与到期判定都在同一层。
- **不改变既有 verdict 的 `state` / `confidence` 取值**：连击算法的改动只影响
  `expiresAt`（以及新增的 `dueAt`），不得让任何页面的四态判定翻转口径。
  唯一允许的变化是「同一坐的多条正证据不再被算成多次复习」——那正是要修的缺陷。
- **观测脚本只读**：不得写库、不得触发 LLM。
- 复习面取数失败按空处理，绝不阻断 Dashboard 渲染。

**成功标准**

- 构造「北京时间 07:30 与 08:30 各答对一题」的证据，连击算 **1** 而非 2；
  构造「相隔 3 天各答对一题」，连击算 2。两者都有回归断言。
- 超长 `slug` / `anchor` 被 400 拒绝且不落行；超大 `detail` 被截断但**证据本身照常落库**。
- 构造「首帧不可滚动 → 随后内容变长变得可滚动」的序列，`page-read` **不**发出；
  真·短页（始终不可滚动）仍在 30 秒后发出。
- `EXPLAIN QUERY PLAN` 断言 `listStyleEvidence` 的查询走索引、不 `SCAN page_evidence`。
- 种入一批到期证据后，Dashboard 出现「该复习了」区块并列出正确的页；
  证据为空时该区块整体不渲染。
- `npm run mastery:report` 在真实库上打印四态分布 + 判定路径归因，不写任何数据。

---

## 五、关键决策

### 决策 1：连击用**滚动最小间隔**替代日历日折叠

放弃「日历日」这个单位，改为：正证据按时间正序扫描，第一条计数；
此后**只有距上一条被计数的正证据 ≥ `STREAK_MIN_GAP_HOURS` 才计数**。

```
STREAK_MIN_GAP_HOURS = 16
```

为什么是 16 小时：

| 场景 | 真实间隔 | 日历日折叠 | 滚动 16h | 期望 |
|---|---|---|---|---|
| 同一坐连点五下 | 分钟级 | 1 ✅ | 1 ✅ | 1 |
| 早 7:30 + 早 8:30（UTC 跨日） | 1h | **2 ❌** | 1 ✅ | 1 |
| 昨晚 21:00 + 今早 09:00 | 12h | 2 ❌ | 1 ✅ | 1（同一轮学习的两头） |
| 每天固定 21:00 复习 | 24h | 2 ✅ | 2 ✅ | 2 |
| 今天 23:50 + 明天 00:10 | 20min | 1 ✅ | 1 ✅ | 1 |
| 隔 3 天再来一次 | 72h | 2 ✅ | 2 ✅ | 2 |

16h 落在「同一天内的两次」（≤ 12h）与「每日节律」（≥ 24h）之间，
并给每日复习留 8 小时的作息浮动余量。它**不需要知道读者的时区**——
这是相对日历日的根本优势，也是选它的首要理由。

阈值定为常量、不做设置项（与 `READ_DWELL_MS` 同规格），接入真实数据后按分布再调。

> **`lastPositiveAt` 仍取最后一条正证据，不取最后一条被计数的。**
> 它的语义是「最近一次表现出掌握」，用于起算有效期；把它挪到被计数那条上，
> 会让同一坐的第二次答对反而缩短有效期，是反直觉的。

### 决策 2：入参上限分两层——身份字段拒绝，审计字段截断

| 字段 | 处理 | 理由 |
|---|---|---|
| `slug` | zod `max(512)` → **400** | 它参与页面身份。超长 slug 本来也过不了 `getPageBySlug`，早拒早明确 |
| `anchor` | zod `max(256)` → **400** | 同上，它是 quizId / section 标题，正常值远小于此 |
| `detail` | 序列化后 > 4KB → **截断为一条说明性占位，证据照常落库** | 它只用于事后审计、不参与任何查询或派生。为一条审计字段丢掉整条证据，与 best-effort 语义矛盾 |

**`detail` 的截断必须落在 `evidence-repo.appendEvidence`，不能只在路由做。**
因为服务端还有三个生产方（`/api/query` 的 `selection-ask` 摘录、`citation-hit`、
`/api/lens` 的 `reshape-request`）直接调 repo，绕过路由。闸门装在唯一的写入口才有意义。

截断后写入的是 `{ truncated: true, bytes: <原长度> }`，而不是被砍半的 JSON——
半截 JSON 既不可解析也不可解释，不如诚实地记录「这里原本有多大」。

### 决策 3：「到底」判定区分**滚到底**与**不足一屏**

`reachedBottom` 的粘性是对的（读完往回翻不该撤销），错的是把「内容不足一屏」也塞进了
同一个粘性变量。两者语义不同：

- **滚到底**：用户产生过滚动并抵达底部 → 这是一个**已发生的事实**，粘性正确。
- **不足一屏**：整页一眼看完 → 这是一个**当下的属性**，内容变长它就不再成立，
  必须每次重算。

拆成两个字段：

```ts
interface ReadBeaconState {
  visibleMs: number;
  /** 粘性：可滚动容器里滚到过底部。已发生的事实，不撤销。 */
  scrolledToBottom: boolean;
  /** 非粘性：当前内容不足一屏。属性，每次 tick 重算。 */
  fitsInViewport: boolean;
}

shouldFire = (scrolledToBottom || fitsInViewport) && visibleMs >= READ_DWELL_MS
```

调用方据此要多传一个「容器当前是否可滚动」的事实，因此 `advanceReadBeacon` 的 tick 入参
从 `{ progress }` 改为 `{ progress, scrollable }`——由 hook 从
`scrollHeight > clientHeight` 得到，纯函数不碰 DOM。

同时 **timer tick 里也要重算 progress**，不能只累加 `visibleMs`：
内容变长这件事可能在用户完全没滚动的情况下发生（图片异步布局），
只监听 `scroll` 事件是感知不到的。

矩阵（都满足停留 ≥30s）：

| 序列 | 结果 |
|---|---|
| 始终不足一屏 | 发出 ✅（真·短页确实读完了） |
| 首帧不足一屏 → 变长变可滚动 → 用户没滚 | **不发** ✅（本 spec 要修的那条） |
| 首帧不足一屏 → 变长 → 用户滚到底 | 发出 ✅ |
| 一直可滚动，滚到底后往回翻 | 发出 ✅（粘性保住） |
| 一直可滚动，从没滚到底 | 不发 ✅ |

### 决策 4：复习面是 Dashboard 上的被动清单，不进 Graph 图层

`dueAt` 的消费者有三个候选位置，选 Dashboard：

| 位置 | 否决 / 采用理由 |
|---|---|
| Graph 掌握度图层加 `due` 视觉 | **否决。** 图层是**主动审计动作**（spec ② F1b：「用完即走」），而复习提醒需要**被动送达**——用户不会为了看有没有该复习的东西去开全屏图。且 spec ② F5 已用满填充 ramp + danger 描边两个通道，第三个通道（虚线）是 F4 边界导航后置时预留的，占掉它就要重排色彩方案 |
| 阅读页状态行 | **否决。** 只有已经打开那一页才看得到，而复习面要解决的恰恰是「想不起来该回哪一页」 |
| **Dashboard 区块** | **采用。** 它是每次打开 app 的落点，是唯一能让「该复习了」被动进入视野的位置；且已有「最近页面」这类同构区块，视觉与信息层级现成 |

**判据**：`state === 'mastered' && dueAt !== null && dueAt <= now`。
注意 `mastered` 本身已经排除了过期的（过期即回落 `exposed`），
所以这个清单天然是 `dueAt <= now < expiresAt` 的窗口，语义正是「该复习、但还没失效」。

**刻意不含已过期回落 `exposed` 的页。** 它们已经不算掌握了，复习清单的语义是
「维持你已有的掌握」，把失效的混进来会让清单随时间单调膨胀成一个永远清不完的待办——
那会让人直接忽略它，连带毁掉这个面的可信度。想找回失效的概念，走 Graph 审计面。

排序按 `dueAt` 升序（最该复习的在前），上限 20 条，超出只提示剩余计数。

### 决策 5：`dueAt` 进 `MasteryVerdictLite`，与 `expiresAt` 并列

复习面需要全量扫 subject 才能找出到期项，走的是 `/api/mastery` 的批量分支——
那条分支返回 `MasteryVerdictLite`（刻意不含 `recent`）。因此 `dueAt` 必须进 Lite。

它是一个 ISO 字符串，与已在 Lite 里的 `expiresAt` 同规格、同生命周期（都只在 `mastered`
时非空），加它不会让响应体随使用量膨胀——这正是当初把 `recent` 排除在 Lite 之外的判据。

复习清单**不新增路由**，在 `/api/mastery` 上加 `?due=1` 分支：
它和批量分支共用同一次 `listForSubject` + `deriveMastery`，只是多一步过滤、排序、
join 页面标题。单独开一个 `/api/mastery/due` 会让两条路径各自演化，而它们的取数逻辑
必须保持一致（同口径排除 meta 页）。

### 决策 6：证据表保留策略只**沉淀决策**，不实现

`page_evidence` 是 append-only 且无 GC。项目里已有两个先例（`llm_usage` 90 天、
`operations` 每 subject 500 条），所以「要不要给证据也加一个」是个会被反复问起的问题。
现在回答它，但不实现：

- **不实现的理由**：单用户一年的证据量级远小于 `job_events`，YAGNI。
- **将来真要做时的正确形状**（写进 `db/CLAUDE.md`，避免届时拍脑袋）：
  只折叠 12 个月以上的 **exposure 与 weak negative** 行（`page-read` / `citation-hit` /
  `reshape-request`），**正证据与 strong negative 永久保留**。
  因为连击派生要扫完整的正证据历史，删正证据会让老页面的 `consecutivePositives`
  凭空缩水、有效期集体跳水；而 exposure 行只影响规则 4/5 的落点，折叠成一条计数即可。

### 决策 7：观测脚本报告**判定路径**，不只报告四态分布

只打四态计数回答不了 spec ① 遗留的那三个问题。真正需要知道的是**每个判定是怎么来的**，
所以把归因逻辑抽成纯函数 `explainMastery(evidence, now)`，返回命中的规则序号与关键计数：

| 报告项 | 回答的问题 |
|---|---|
| 四态分布 + 各态 top 页面 | spec ① 成功标准第 1 条 |
| 因 strength 门槛被压在 `exposed` 的页数 | 规则 3 的门槛是不是太严（`mastered` 恒空的第一嫌疑） |
| `mastered` 里 low / high 置信度各占多少 | 低置信度会被 E2 降级进第二段，占比过高说明注入几乎没生效 |
| `struggling` 的 kind 分布 | 是不是全被 `selection-ask` 主导（`quiz-wrong` 才是有客观参照的那个） |
| 只有弱负证据的页数 | 遗留观察「若 `struggling` 恒 0，改为累计 ≥3 条弱负证据判 `struggling`」的直接依据 |
| 已过期回落 `exposed` 的页数 vs 当前到期未过期数 | 复习闭环有没有真的在被使用 |
| 证据 kind 总分布 | 哪些采集点是死的（spec ① 缺口 2 的复发检测） |

`explainMastery` 与 `deriveMastery` **共用同一段判定逻辑**，不得各写一遍——
两份判定必然漂移，报告就会开始撒谎。实现上让 `deriveMastery` 成为 `explainMastery`
的薄封装（丢掉解释字段），而不是反过来。

---

## 六、组件与接口

### 改动 `src/server/profile/mastery.ts`

```ts
/** 决策 1：连击的最小间隔（小时）。取代原先按 UTC 日折叠的实现。 */
export const STREAK_MIN_GAP_HOURS = 16;

export interface MasteryVerdict extends MasteryVerdictLite {
  recent: EvidenceRow[];
}
// MasteryVerdictLite 新增：dueAt: string | null（仅 mastered 时非空）

/** 决策 7：带判定归因的完整派生。`deriveMastery` 是它丢掉解释字段的薄封装。 */
export function explainMastery(evidence: EvidenceRow[], now: Date): MasteryExplanation;

export interface MasteryExplanation {
  verdict: MasteryVerdict;
  /** 命中的优先级规则序号（1–5），对应决策 3 的表。 */
  rule: 1 | 2 | 3 | 4 | 5;
  consecutivePositives: number;
  strongPositives: number;
  weakPositives: number;
  recentStrongNegatives: number;
  /** 有正证据、但被规则 3 的 strength 门槛挡下（落 exposed）。 */
  blockedByStrengthGate: boolean;
  /** 有正证据、但已过期（落 exposed）。 */
  expiredPositives: boolean;
}

/** 决策 4 的判据。`mastered` 已排除过期项，故等价于 dueAt <= now < expiresAt。 */
export function isDueForReview(v: MasteryVerdictLite, now: Date): boolean;
```

### 改动 `src/server/db/repos/evidence-repo.ts`

- `appendEvidence` 对 `detail` 序列化后超 `MAX_DETAIL_BYTES`（4096）时替换为
  `{ truncated: true, bytes }`（决策 2），并 `console.warn`。

### 改动 `src/server/db/client.ts`

- `ensureIndexes` 新增 `page_evidence_style_idx ON page_evidence(user_id, kind, created_at)`。

> 放 `ensureIndexes` 而非 `ensureTables`：该函数的注释已写明「索引必须在这里重建，
> 否则会随表重建被丢弃」，且 `CREATE INDEX IF NOT EXISTS` 幂等，既有安装启动即补。

### 改动 `src/app/api/mastery/route.ts`

| 参数 | 行为 |
|---|---|
| 无 | 全量 `slug → MasteryVerdictLite`（现状，`dueAt` 随 Lite 一并出现） |
| `?slug=` | 单页完整 verdict 含 `recent`（现状） |
| `?due=1` | **新增**：`{ entries: MasteryDueEntry[], total }`，按 `dueAt` 升序，上限 20 |

```ts
export interface MasteryDueEntry {
  slug: string;
  title: string;
  dueAt: string;
  expiresAt: string;
  confidence: MasteryConfidence;
}
```

三条分支共用同一段 meta 页排除与 `deriveMastery` 调用。

### 改动 `src/components/wiki/use-page-read-beacon.ts`

- `ReadBeaconState` 拆 `scrolledToBottom` / `fitsInViewport`（决策 3）
- `advanceReadBeacon` 的 tick 入参加 `scrollable`
- timer tick 里一并重算 progress，不只累加 `visibleMs`

### 新增 `src/components/dashboard/due-for-review.tsx`

Dashboard 的客户端区块：React Query `['mastery-due', subjectId]` 拉 `?due=1`，
渲染标题 + 相对到期时间 + 链到 `/wiki/<slug>?s=`；空/失败**整体不渲染**
（不占位、不显示错误——它是锦上添花的提醒，不该给首页添噪）。

### 新增 `scripts/mastery-report.ts` + `npm run mastery:report`

只读；可选 `--subject=<slug>`，缺省遍历全部 subject。

---

## 七、数据流

### 7.1 复习清单（新增）

```
Dashboard 挂载
  → GET /api/mastery?s=<subject>&due=1
       → evidenceRepo.listForSubject          一次索引扫描 + 内存分组（同批量分支）
       → 逐 slug deriveMastery(rows, now)      纯函数
       → filter(isDueForReview) → sort(dueAt) → join 标题 → 截断 20
  → 空清单 → 区块整体不渲染（零证据零回归）
```

### 7.2 观测报告（新增，离线）

```
npm run mastery:report [--subject=<slug>]
  → 逐 subject listForSubject
  → 逐 slug explainMastery(rows, now)          与线上判定同一段逻辑
  → 按 rule / state / kind 聚合 → stdout 表格
```

---

## 八、错误处理与降级

| 场景 | 行为 |
|---|---|
| `?due=1` 取数失败 | 客户端区块不渲染，Dashboard 其余部分不受影响 |
| `detail` 超限 | 截断落库 + `console.warn`；**证据本身不丢** |
| `slug` / `anchor` 超限 | 400，不落行（与既有「不存在的 slug → 404 不落行」同规格） |
| 证据里有未来时间戳（时钟回拨） | 连击扫描按已排序序列处理，间隔为负时**不计数**（等价于「与上一条同时」），与 `deriveMastery` 既有的「未来时间戳按已发生处理」取向一致 |
| 复习清单里的页已被删 | `join` 标题时跳过（`deriveMastery` 不感知页面存在性，与既有口径一致） |
| 观测脚本遇到空库 | 打印空分布，退出码 0 |

---

## 九、测试策略

1. **连击滚动间隔（决策 1，回归重点）**：同一坐多条 → 1；**UTC 跨日但间隔 1h → 1**
   （这条直接锁死本 spec 要修的缺陷）；间隔 24h → 2；间隔恰好
   `STREAK_MIN_GAP_HOURS` → 2，差一分钟 → 1；strong 负证据仍清零、弱负证据仍不清零
   （既有语义不得回归）。
2. **`dueAt`**：仅 `mastered` 时非空；`dueAt < expiresAt` 恒成立；
   逐档对应 `masteryWindowDays`。
3. **`isDueForReview`**：未到期 false、恰好到期 true、`exposed`/`struggling`/`unknown`
   一律 false（**过期回落的不进清单**——决策 4 的清单语义）。
4. **`explainMastery` 与 `deriveMastery` 一致**：对同一组输入，
   `explainMastery(...).verdict` 与 `deriveMastery(...)` 深相等（防两份判定漂移）；
   五条规则各自的 `rule` 序号断言；`blockedByStrengthGate` 只在规则 3 被门槛挡下时为 true。
5. **入参上限**：超长 slug/anchor → 400 且**表里无新行**；超大 detail → 201 且
   `detail_json` 是 `{truncated:true,bytes}`；正常 detail 原样落库。
   截断在 repo 层，故服务端生产方（`recordEvidence`）同样受保护——单独断言一次。
6. **read beacon 矩阵（决策 3）**：第五节那张五行表逐行断言；
   `advanceReadBeacon` 仍是纯函数（不改传入状态）。
7. **索引**：`EXPLAIN QUERY PLAN` 断言 `listStyleEvidence` 的查询形状走索引、
   不 `SCAN page_evidence`（进 `indexes.test.ts`，与既有热路径同处）。
8. **`?due=1` 路由**：按 `dueAt` 升序；排除 meta 页（与另两条分支同口径）；
   上限截断且 `total` 反映真实总数；空库返回空数组不报错；已删页跳过。
9. **零回归**：`deriveMastery` 既有全部用例不变绿→红（连击改动只应影响「同一坐」那一条
   的语义，其断言值本就是 1）。

---

## 十、影响文件清单

| 文件 | 改动 |
|---|---|
| `src/server/profile/mastery.ts` | 连击换滚动间隔；新增 `explainMastery` / `isDueForReview` / `STREAK_MIN_GAP_HOURS`；verdict 加 `dueAt`；补「过期不降档」语义注释 |
| `src/lib/contracts.ts` | `MasteryVerdictLite` 加 `dueAt`；新增 `MasteryDueEntry` / `MasteryDueResult` |
| `src/server/db/repos/evidence-repo.ts` | `appendEvidence` 截断超大 `detail` |
| `src/server/db/client.ts` | `ensureIndexes` 加 `page_evidence_style_idx` |
| `src/app/api/evidence/route.ts` | zod 加 `slug` / `anchor` 上限 |
| `src/app/api/mastery/route.ts` | 新增 `?due=1` 分支 |
| `src/components/wiki/use-page-read-beacon.ts` | 到底判定拆两个字段；tick 重算 progress |
| `src/components/dashboard/due-for-review.tsx` | **新增** 复习清单区块 |
| `src/app/(app)/page.tsx` | 挂载复习区块 |
| `src/lib/i18n/messages/{zh-CN,en}.ts` | 复习区块文案 |
| `scripts/mastery-report.ts` | **新增** 观测脚本 |
| `package.json` | `mastery:report` script |
| `src/server/db/__tests__/indexes.test.ts` | 补 `listStyleEvidence` EQP 断言 |
| 各 `__tests__/` | 见测试策略 |
| `src/server/db/CLAUDE.md` | 新索引 + 决策 6 的保留策略 |
| `src/server/CLAUDE.md` / `src/app/CLAUDE.md` / `src/components/CLAUDE.md` / `src/lib/CLAUDE.md` | changelog |

---

## 十一、已定决策

| # | 议题 | 取值 | 依据 |
|---|---|---|---|
| 1 | 连击折叠单位 | **滚动 16h 间隔** | 日历日需要时区，而服务端不知道读者时区、证据行也没存；任何选定时区都会在某种作息下出错 |
| 2 | 超大入参 | 身份字段 400 / 审计字段截断 | 为一条只用于事后审计的字段丢掉整条证据，与 best-effort 语义矛盾 |
| 3 | 复习面位置 | **Dashboard 被动清单** | 图层是主动审计动作（用完即走），承载不了被动提醒；阅读页状态行只有打开那页才看得到 |
| 4 | 复习清单是否含已失效项 | **不含** | 清单语义是「维持已有掌握」；含失效项会单调膨胀成清不完的待办，连带毁掉可信度 |
| 5 | 证据表 GC | **只沉淀决策，不实现** | YAGNI；但先写明正确形状（只折叠 exposure/weak negative，正证据永久保留），避免届时拍脑袋删正证据导致连击集体跳水 |

### 遗留待观察（不阻塞实现）

- `STREAK_MIN_GAP_HOURS = 16`：接入后按 `mastery:report` 的连击分布调整。
- 复习清单上限 20 条：若长期贴顶，说明复习跟不上产生速度，届时该考虑的是降低
  `mastered` 的达成门槛还是加提醒，而不是简单加大上限。
- spec ① 的三个旋钮（30s 停留 / 14 天负窗口 / strength 门槛）：本 spec 只提供观测，
  不动取值。

# Spec：证据流与逐页掌握度模型

日期：2026-07-26
状态：已定稿（四项待评审决策已于 2026-07-26 定案，见第十四节）

> 本 spec 是「已知概念地图」两份设计中的第 ①份，负责**产生并解释**掌握度事实。
> 第 ②份（`已知地图的两个消费面`：重塑 prompt 注入 + Graph 掌握度图层）依赖本份产出的
> `deriveMastery()` 契约，另行成文。

---

## 一、背景与问题

Cognitive Lens（`docs/superpowers/specs/2026-06-26-cognitive-lens-design.md`）的目标是
「让输出跟随主人的认知水平上升」。当前实现距这个目标有两层缺口：

### 缺口 1：画像不是认知模型，是风格偏好

`user_profiles` 存的是 4 个三档旋钮（readingLevel / verbosity / exampleDensity /
formality）+ 一段自述文本。这描述的是**怎么讲**，不是**他懂什么**。
「这个概念他在 `[[X]]` 里已经吃透、引用即可」这类事实在 schema 里没有存放位置。

原设计的决策 6 把「从 vault / `page_maturity` 派生已内化地图」列为 Phase 2，至今未实现。

**且 `page_maturity` 不能用作掌握度代理**：`passes` 的增量来自新增 callout 数与正文增长
（`maintenance-policy.ts::deriveMaturityUpdate`），`graduated` 的含义是「内容不再长了」。
它是**内容侧成熟度**，与读者是否理解正交——一页可以 passes=5 已毕业而用户从没打开过。

### 缺口 2：唯一的学习输入是两个几乎没人点的拇指

- 信号枚举声明 5 种（`api/profile/signals/route.ts:11`），实际只有 `too_hard` / `too_easy`
  会产生。`simplify_click` / `deepen_click` 的入口（原设计路线 B 段级重塑）从未实现；
  `view_original` 无埋点。
- 零行为信号：服务端没有任何页面访问记录，无停留、无重读、无提问归因。
- `LensFeedback` 在 `wiki-reading-view.tsx:184` **无条件渲染**——用户看的可能是 canonical
  原文，此时点「太难」评价的是原文，却被写进重塑画像。信号也不记录当时看的是哪个版本，
  事后无法区分「原文太难 / 重塑没生效 / 重塑生成得差」。
- `recentSignals(userId, 8)` 按 id 裸取最近 8 条，**无时间窗**；信号从不标记消费。
  于是阈值只对第 1 步生效——第 3 次同向点击时窗口净值仍 ≥2，会再降一档，形成单向棘轮；
  三个月前的点击与今天等权。

### 已在库里、但没有第二个消费者的信号

| 信号 | 位置 | 当前消费者 |
|---|---|---|
| 选区追问 `UserMessageReference{pageSlug, section, excerpt}` | `messages.citations_json`（role=user） | 仅聊天历史渲染 |
| Ask AI 回答引用命中 | `citation-extract.ts::extractCitationsFromAnswer` | 仅回答下方引用列表 |
| Reshape 请求 | `POST /api/lens/[...slug]` | 仅写 `page_renditions` |
| `[!quiz]` 自测题 | enricher 已按 `augmentation_level` 生成 | 仅静态样式（`page-renderer.tsx:45`） |

其中 quiz 是整个系统里**唯一的主动测量入口**，内容生产链路已完整，但前端只有边框颜色和
图标（`callout-icon.tsx:16`）——不能作答、不判分、不记录。

---

## 二、目的

1. 建立 `(user, subject, slug)` 粒度的**掌握度事实**，可被重塑 prompt 与 Graph 图层消费。
2. 掌握度必须**可解释**：任何结论都能回溯到具体证据条目与时间，而不是一个不透明分数。
3. 采集成本尽量落在既有交互上：优先接通已经在发生但没被记录的行为，其次才加新交互。
4. 顺带修复既有反馈闭环的归因与衰减缺陷，让 `style_prefs` 的学习不再基于脏信号。

---

## 三、非目标

- **重塑 prompt 注入与 Graph 图层**：属 spec ②，本份只定义 `deriveMastery()` 的输出契约。
- **概念实体抽取**：不建独立概念词表，概念的单位就是 page（详见决策 1）。
- **多租户**：沿用 `LOCAL_USER_ID` 单例，表结构 user-keyed，未来接 auth 无需迁移。
- **掌握度的物化缓存**：读时派生，不建缓存表（详见方案取舍）。
- **既有页面批量 re-enrich 回填 quiz 答案**：re-enrich 的 supplement 阶段会同时改动正文，
  代价与副作用都超出本需求。存量页退化为自评形态（详见决策 5）。

---

## 四、约束与成功标准

**约束**

- 零证据时全链路行为必须与今天**完全一致**（冷启动无回归）：重塑 prompt 不变、图层不着色。
- 证据采集不得阻断主流程：写入失败只 `console.error`，不影响阅读、问答或重塑。
- 不新增 LLM 调用。四态派生是确定性纯函数。
- 掌握度**默认保守**：无证据即「不懂」。误判「已掌握」会让重塑版跳过解释、页面直接读不懂，
  这是本功能唯一真正危险的失败模式。
- 页面生命周期必须闭合：删页、move/rename、删 subject 都要正确处理证据，
  **不得出现同 slug 重建后复活旧掌握度**（`page_rendition_assets` 已踩过同一个坑，
  见 db/CLAUDE.md 2026-07-17 条目）。
- 替换既有 `profile_signals` 按「并存加新 → 原子切换 → 删旧」推进，每步系统可运行。

**成功标准**

- 在一个真实 subject 上使用一周后，能产出非空的四态分布；人工复核 `struggling` 项，
  确实对应用户卡过的页面。
- 任一非 `unknown` 判定都能在 UI 上展开看到支撑它的原始证据条目与时间戳。
- 删页 / 改名 / 删 subject 后，`page_evidence` 无残留、无错误关联；重建同名 slug 从零开始。
- `signal-reducer` 的棘轮与无衰减行为消失：同向连点不再每次降档，历史信号按时间衰减。

---

## 五、方案取舍

### 核心问题：掌握度怎么存

#### 方案 A：物化 `page_mastery` 表，证据到来时增量更新状态

优点：读一次即得，图层全量查询最快。

缺点：
- 派生规则每次迭代都要全量重算（而规则一定会迭代——这是本设计里最不确定的部分）。
- 时间衰减需要定时任务，或读时仍要补算，物化的收益被抵消。
- 丢掉原始证据就无法回答「为什么系统认为我懂这个」，与约束 2 直接冲突。

不采用。

#### 方案 B：只存 append-only 证据流，掌握度读时纯函数派生（**推荐**）

`page_evidence` 是唯一真实源；`deriveMastery(evidence, now)` 是无 IO 纯函数。

优点：
- 规则可自由迭代，无数据迁移。
- 衰减天然按 `now` 计算，不需要任何调度。
- **证据即解释**：审计面直接展示原始行，与 Health / Research 的 evidence-driven 风格一致。
- 纯函数可完整单测，这是本设计里唯一有真实逻辑复杂度的地方。

缺点：每次读要聚合。量级评估：单 subject 证据行数 ≈ 页数 × 每页数条，图层全量也只是一次
按 `(user_id, subject_id)` 的索引扫描 + 内存分组。远小于现有 `getAllLinks` 的量级。

采用。

#### 方案 C：证据流 + 物化视图

方案 B 的读路径若真成为瓶颈再加。现在做是 YAGNI——且在没有真实使用数据前，
物化的键该怎么设计本身就是猜测。不采用。

### 次要问题：`profile_signals` 与 `page_evidence` 的关系

`too_hard` 同时是两件事：「讲法太难」（风格信号）与「这一页没懂」（掌握证据）。
双写两张表 = 两份真实源，必然漂移。

采用**统一到 `page_evidence`**，`profile_signals` 退役。所有既有信号都发生在某一页上，
evidence 的字段是 signals 的超集（多 `slug` 必填 / `polarity` / `anchor` / `detail`）。
按项目约定分三步：并存双写 → reducer 切读 evidence → 删旧表与 repo。

---

## 六、关键决策

### 决策 1：概念的单位就是 page，不引入新词表

诱惑是用 LLM 抽概念实体建独立词表。不做——新词表必须解决归一、去重、跨 subject 同名、
页面重命名同步四个问题，而这四个问题项目已经在页面身份上解决过一遍
（`(subject_id, slug)` 复合 PK + `page_aliases` + `resolveWikiLinkTarget` 单一真实源）。
再造一套只会产生第二份会漂移的身份。

且 ingest planner 本就按「一页一个概念」切分，`[[wikilink]]` 就是概念依赖边——
**概念图已经物化了**，就是 `pages` + `wiki_links`。

### 决策 2：四态 + 三档置信度，不存标量分数

```
unknown     无证据（默认，且长期必然是绝大多数）
exposed     接触过但未验证
mastered    有未过期的正向验证
struggling  有近期负证据 —— 「试过并卡住了」，不是「更不懂」
```

两条硬规则：

1. **负证据压过正证据。** 有近期 `struggling` 就不进 `mastered`，哪怕 quiz 答对过。
   保守方向永远是「多讲一点」。
2. **`mastered` 会过期。** 记忆会衰减，一个不带有效期的 `mastered` 是错的。

置信度必须能表达 `none`（不知道），下游不得把 `none` 当作任何一端。

不落 0–100 分数：掌握度是从稀疏证据派生的估计，印一个「72」是假精度，
会让用户以为系统有它并不具备的确定性。

### 决策 3：判定用显式优先级，不用加权求和

加权求和的权重是拍脑袋的，且结果不可解释。改为自上而下先命中先返回：

| 序 | 条件 | 结果 |
|---|---|---|
| 1 | 无任何证据 | `unknown` / `none` |
| 2 | 衰减窗口内存在**强负证据**（`quiz-wrong` / `selection-ask`） | `struggling` / 强证据≥2 则 `high`，否则 `low` |
| 3 | 存在**未过期的正证据** | `mastered` / 来源含 quiz 则 `high`，否则 `low` |
| 4 | 存在 exposure 证据，或存在已过期的正证据 | `exposed` / `low` |
| 5 | 只有弱负证据（`citation-hit` / `reshape-request`） | `exposed` / `low` |

第 5 条是刻意的：弱负证据信噪比不足以判 `struggling`，但足以证明「他接触过这一页」。

### 决策 4：`mastered` 有效期复用间隔重复阶梯

`SPACING_LADDER = [1, 3, 7, 21, 60]`（`maintenance-policy.ts:18`）这套装置库里已经有了，
只是**接错了对象**——它在给「内容」排增益计划。同一套节律指向 `(user, page)` 就是
一个现成的记忆模型：

```
masteredUntil = lastPositiveAt + SPACING_LADDER[min(consecutivePositives - 1, 4)] 天
```

连续答对越多，有效期越长；过期回落 `exposed`（而非 `unknown`——他确实接触过）。

一次负证据清零 `consecutivePositives`。

> 实现上抽 `masteryWindowDays(consecutivePositives)` 到 `profile/mastery.ts`，
> 与 `maintenance-policy` 共用常量但**不共用函数**——两者的语义在未来可能分化，
> 现在耦合会让任一侧的调整误伤另一侧。

### 决策 5：enricher 升 v7 产出答案，前端兼容有 / 无答案两种形态

核实 `examples/skills/ingest-enricher.md:50`：现有 quiz callout 是
「a question that makes the reader retrieve/apply what the prose taught (optionally a hint)」
——**只有问题和提示，没有标准答案**，「先答 → 揭晓 → 判分」在存量内容上走不通。

本 spec 同期把 `ingest-enricher` 升到 **v7**，让新产出的 quiz callout 携带答案：

| 内容形态 | 交互 | 证据可信度 |
|---|---|---|
| 有答案（v7 产出：新 ingest / 用户主动 re-enrich） | 看答案 → 揭晓 → 我答对了 / 我答错了 | 有客观参照 |
| 无答案（存量页） | 直接自评二选一 | 自陈 |

三处必改，漏任一处都会让既有 vault 启动即 fail-fast：

1. `ingest-service.ts:200` 版本门 `'ingest-enricher': 6 → 7`
2. `reenrich-service.ts:147` 版本门 `'ingest-enricher': 6 → 7`
3. `skills/builtin-manifest.ts::BUILTIN_UPGRADE_HASHES['ingest-enricher']`
   **追加当前 v6 原版的完整 SHA-256**

第 3 条最易漏：该白名单是自动升级的**唯一依据**——`registry.ts::upgradeBuiltinSkillFiles`
只原子替换 hash 精确匹配历史原版的 vault 副本，用户改过的 skill 始终保留。不追加 v6 hash，
所有未改过 skill 的既有 vault 都会卡在 v6 撞版本门。

**证据 strength 的不对称**（决策 2「保守优先」的直接推论）：

| 场景 | kind | strength | 理由 |
|---|---|---|---|
| 揭晓答案后判对 | `quiz-correct` | strong | 有客观参照 |
| 揭晓答案后判错 | `quiz-wrong` | strong | 有客观参照 |
| 无答案自评「我答对了」 | `quiz-correct` | **weak** | 自我拔高偏差；且误判 `mastered` 代价最大 |
| 无答案自评「我答错了」 | `quiz-wrong` | **strong** | 主动承认答错，无拔高动机 |

这个不对称是刻意的：同一个交互，正向降权、负向不降权。

**不落 `quiz-revealed`**：揭晓答案却不判分（好奇点开、看完就走）要做 unload 兜底 +
与判分去重 + 竞态处理，复杂度不值当。揭晓不判分就什么都不记。

### 决策 6：答案用 `---` 分隔，不用 HTML

`markdown-client.ts:344` 设了 `allowDangerousHtml: false`——**raw HTML 不渲染**，
`<details>` 方案直接出局。

改用 blockquote 内的 thematic break 分隔（已验证 remark 在 blockquote 内把 `---`
解析为 `thematicBreak` 子节点）：

```markdown
> [!quiz] ❓ 自测
> 为什么反向传播需要保存前向过程的中间激活值？
>
> ---
>
> 因为链式法则求梯度时要用到每层的输入。丢弃后只能重算，属于时间换空间。
```

选它的理由是**语言无关**：不依赖「答案：」/「Answer:」这类自然语言标记，
不会随 `wikiLanguage` 漂移。

渲染层在现有 callout 重标插件（`markdown-client.ts:231`）里对 `quiz` 类型检测
`thematicBreak`：有则按**第一个** `thematicBreak` 切为问题段与答案段，答案段包进默认隐藏的
容器；无则按旧形态处理。

canonical 正文里答案是明文（编辑器、git、FTS 里都可见），只有阅读渲染折叠——这是对的，
答案属于页面内容，不是 UI 状态。

### 决策 7：quiz 身份 = **问题段**内容 hash，客户端同步计算

需要一个跨会话稳定、内容变即变的 quiz 标识。位置索引脆弱（插入一段就全错位），
内容 hash 语义正确（题目改了就是新题，旧证据自然失效）。

hash 的输入只取**问题段**（决策 6 切分后的前半），不含答案。理由：证据是关于「这道题」的，
enricher 重跑时润色答案措辞不应该让「他答对过」这件事失效。切分本来就要做，取前半是免费的。

在 `markdown-client.ts` 的 rehype 插件里为 `quiz` 类型写入 `data-quiz-id`。该插件运行在
客户端，`crypto.subtle` 是异步的不适用，改用同步非加密 hash（FNV-1a）——这只是本地标识，
不是安全边界。

### 决策 8：证据必须随页面生命周期闭合

这是上游讨论未覆盖、但实现必踩的三处：

| 事件 | 处理 | 挂载点 |
|---|---|---|
| 删页 | 删除该页全部证据 | `page-write.ts::deletePageInSubject` |
| move / rename slug | 证据迁移到新 slug | `wiki/page-identity-migration.ts`（已在迁移其他 slug 派生数据） |
| 删 subject / reset | 级联清理 | `subject_id` FK CASCADE + `subjects-repo::deleteWithContents` 清单 |

`page_evidence` **挂 `subject_id` FK CASCADE**——与 `page_renditions`（故意不挂、靠 repo
显式清理）不同。理由：证据是 user-owned 事实而非可丢弃缓存，用数据库约束保证比靠 repo
记得清更可靠；且这正是「重建同名 subject 复活旧数据」那个坑的根因。

---

## 七、数据模型

### 新表 `page_evidence`

```ts
page_evidence {
  id          INTEGER PRIMARY KEY AUTOINCREMENT
  user_id     TEXT NOT NULL              // 今天恒为 'local'
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE
  slug        TEXT NOT NULL
  kind        TEXT NOT NULL              // 见下表
  polarity    TEXT NOT NULL              // 'positive' | 'negative' | 'exposure'
  strength    TEXT NOT NULL              // 'strong' | 'weak'
  anchor      TEXT                       // quizId / section 标题 / null
  detail_json TEXT                       // 类型相关载荷（追问摘录等），可空
  created_at  TEXT NOT NULL
}

INDEX page_evidence_page_idx  ON (user_id, subject_id, slug, created_at)
INDEX page_evidence_scope_idx ON (user_id, subject_id, created_at)
```

`polarity` / `strength` 由 `kind` 确定性派生并冗余落列——让「新增 kind」不必回填历史行，
也让 repo 层聚合查询不依赖应用层映射表。

### 证据类型

| kind | polarity | strength | 来源 | anchor |
|---|---|---|---|---|
| `quiz-correct` | positive | strong / **weak** | D1 揭晓后判分 / 无答案自评 | quizId |
| `quiz-wrong` | negative | strong | D1 判分或自评（两者同权，见决策 5） | quizId |
| `selection-ask` | negative | strong | D2 选区追问 | section |
| `self-report-hard` | negative | strong | 原 `too_hard` | — |
| `self-report-easy` | positive | weak | 原 `too_easy` | — |
| `citation-hit` | negative | weak | D3 回答引用命中 | — |
| `reshape-request` | negative | weak | D4 重塑请求 | — |
| `page-read` | exposure | weak | D5 读完 | — |
| `own-source` | exposure | weak | D6 自己 ingest 的源产出的页 | — |

`self-report-easy` 定为 weak positive：说「太浅」不等于掌握，只是不觉得难。

### `user_profiles` 的 subject 化（分期后置，见分期一节）

```
主键 user_id → (user_id, subject_id)
getProfileOrDefault(userId, subjectId)  缺失返回 DEFAULT_STYLE_PREFS
```

不引入 sentinel 行表示「全局默认」——缺失即默认，无合并逻辑，与 `pages` 的
`(subject_id, slug)` 同构。

---

## 八、组件与接口

### 纯函数 `src/server/profile/mastery.ts`（新，无 IO）

```ts
export type MasteryState = 'unknown' | 'exposed' | 'mastered' | 'struggling';
export type MasteryConfidence = 'none' | 'low' | 'high';

export interface EvidenceRow {
  kind: EvidenceKind;
  polarity: 'positive' | 'negative' | 'exposure';
  strength: 'strong' | 'weak';
  anchor: string | null;
  createdAt: string;
}

export interface MasteryVerdict {
  state: MasteryState;
  confidence: MasteryConfidence;
  evidenceCount: number;
  lastEvidenceAt: string | null;
  /** 供审计面展示，按时间倒序有界截断 */
  recent: EvidenceRow[];
}

export function deriveMastery(evidence: EvidenceRow[], now: Date): MasteryVerdict;
export function masteryWindowDays(consecutivePositives: number): number;
export const NEGATIVE_WINDOW_DAYS: number;   // 强负证据的有效窗口
export const MAX_RECENT_EVIDENCE: number;    // recent 截断上限
```

`deriveMastery` 是本 spec 的**对外契约**——spec ② 的 prompt 注入与 Graph 图层都只消费它。

### 纯函数 `src/lib/stable-hash.ts`（新）

`fnv1a(text: string): string` —— 客户端同步 hash，供 quiz 身份使用。

### repo `src/server/db/repos/evidence-repo.ts`（新）

```ts
appendEvidence(row): void
listForPage(userId, subjectId, slug): EvidenceRow[]
listForSubject(userId, subjectId): Map<slug, EvidenceRow[]>   // 图层全量，一次查询分组
deleteByPage(subjectId, slug): void                            // 删页
movePage(subjectId, fromSlug, toSlug): void                    // rename
```

### `signal-reducer` 改造

- 输入从 `ProfileSignal[]` 改为 `EvidenceRow[]`，只筛 style-bearing 的 kind。
- 加时间窗与衰减：按 `createdAt` 折算权重，超窗证据不参与。
- 加消费边界：记录 `style_prefs` 上次调整的时间戳，只统计其后的证据——消除棘轮。
- 解耦三个维度：`readingLevel` / `verbosity` / `exampleDensity` 各自独立阈值，
  不再一次信号同时推动三个。

### API

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/evidence` | POST | 追加一条证据；`requireAuth` + `requireCsrf` + `resolveSubjectFromRequest` |
| `/api/mastery` | GET | 无 `slug` 返回当前 subject 全量 `slug → MasteryVerdict`；带 `slug` 返回单页含 `recent` |
| `/api/profile/signals` | POST | 并存期双写，切换后删除 |

### 前端

- `src/components/wiki/quiz-affordance.tsx`（新）：quiz callout 底部的自评行。
- `markdown-client.ts`：rehype 插件为 quiz 写 `data-quiz-id`；`div` 组件覆盖在
  `data-callout === 'quiz'` 时挂载 `<QuizAffordance>`。
- `lens-feedback.tsx`：改为只在查看重塑版时渲染（修 A1），发送时带 `viewedSource`。
- 阅读完成埋点（D5）：复用现有 `reading-progress.tsx` 的滚动进度，
  到底且停留超阈值发一条 `page-read`，同页去重。

---

## 九、数据流

### 9.1 证据产生

```
用户在 quiz 上点「我答错了」
  → POST /api/evidence { slug, kind:'quiz-wrong', anchor: quizId }
       → requireAuth + requireCsrf + resolveSubjectFromRequest(required)
       → evidenceRepo.appendEvidence（polarity/strength 由 kind 派生）
  → 失败只 console.error，UI 不阻断
```

选区追问（D2）与引用命中（D3）挂在**服务端已有的落库点**上，不新增客户端请求：
`/api/query` 持久化 user message 时，对每条 `messageReferences` 追加一条
`selection-ask`；流末 `extractCitationsFromAnswer` 的结果追加 `citation-hit`。
两处都 best-effort。

### 9.2 掌握度读取

```
GET /api/mastery?s=<subject>
  → evidenceRepo.listForSubject(userId, subjectId)   // 一次索引扫描 + 分组
  → 逐 slug deriveMastery(rows, now)                  // 纯函数
  → { masteryBySlug: Record<slug, MasteryVerdict> }
```

无缓存、无失效。冷启动返回空对象，下游按「未列出即 unknown」处理。

### 9.3 风格学习（改造后）

```
证据落库
  → 取 style-bearing 且在时间窗内、且晚于上次调整的证据
  → 逐维度独立阈值判定
  → 命中则 upsertProfile + version++ → 重塑版标记 stale
```

---

## 十、错误处理与降级

| 场景 | 行为 |
|---|---|
| 证据写入失败 | `console.error`，主流程不受影响（沿用 `recordCoverageGap` 的 best-effort 语义） |
| `/api/mastery` 失败 | 下游按全 `unknown` 处理——即今天的行为，零回归 |
| 证据指向已删页 | 决策 8 保证不会残留；万一出现，`deriveMastery` 不感知页面存在性，由调用方 join 页面时自然丢弃 |
| quiz 问题变更 | `data-quiz-id` 随之变化，旧证据不再匹配新题——这是正确语义，不做迁移。仅答案改写不影响 id（决策 7） |
| 页面 quiz 从有答案变回无答案 | 前端按当前渲染结果决定形态；已落证据的 strength 不追溯修改 |
| 时钟回拨 | `deriveMastery` 对未来时间戳的证据按「已发生」处理，不特殊化 |

---

## 十一、测试策略

1. **`deriveMastery`（核心）**：五条优先级各自命中；负证据压正证据；`mastered` 过期回落
   `exposed` 而非 `unknown`；连续答对延长有效期；一次负证据清零连击；空输入返回
   `unknown/none`；`recent` 截断稳定。
2. **`masteryWindowDays`**：阶梯边界与上限钳制。
3. **`fnv1a`**：同输入同输出；不同输入不同输出（抽样）；跨 Node/浏览器一致。
4. **quiz 切分**：有 `---` 正确切分；无 `---` 走旧形态；多个 `---` 只按第一个切；
   答案改写不改变 `data-quiz-id`，问题改写则改变（决策 7）。
5. **`ingest-enricher` v7**：版本号断言；skill roundtrip 覆盖带答案的 quiz 契约；
   `BUILTIN_UPGRADE_HASHES` 含 v6 原版 hash（防漏第 3 步导致既有 vault fail-fast）。
6. **`evidence-repo`**：append / 按页查 / 按 subject 分组 / `deleteByPage` / `movePage`；
   真实 SQLite 覆盖 subject FK CASCADE。
7. **生命周期集成**：删页后证据清空 → 重建同名 slug 得到 `unknown`；move 后证据跟随；
   `deleteWithContents` 与 `/api/reset` 级联覆盖。
8. **`signal-reducer` 回归**：同向连点不再每次降档（棘轮消失）；超窗证据不参与；
   三维度独立不再联动。
9. **并存期一致性**：双写阶段 `profile_signals` 与 `page_evidence` 的 style-bearing
   子集等价。

---

## 十二、影响文件清单

| 文件 | 改动 |
|---|---|
| `src/server/db/schema.ts` | **新** `page_evidence` 表 |
| `src/server/db/client.ts::ensureTables` | 补 `CREATE TABLE IF NOT EXISTS` + 两个索引 |
| `drizzle/0013_*.sql` | 结构性迁移 |
| `src/server/db/repos/evidence-repo.ts` | **新** |
| `src/server/profile/mastery.ts` | **新** 四态派生纯函数 + 常量 |
| `src/server/profile/signal-reducer.ts` | 改：输入换 EvidenceRow、加时间窗/消费边界、三维解耦 |
| `src/server/services/apply-signal.ts` | 改：并存双写 → 切换到 evidence |
| `src/lib/stable-hash.ts` | **新** FNV-1a |
| `src/lib/contracts.ts` | 加 `MasteryState` / `MasteryVerdict` / `EvidenceKind` DTO |
| `src/app/api/evidence/route.ts` | **新** POST |
| `src/app/api/mastery/route.ts` | **新** GET（全量 / 单页） |
| `src/app/api/query/route.ts` | 落库处追加 `selection-ask` / `citation-hit`（best-effort） |
| `src/app/api/lens/[...slug]/route.ts` | POST 处追加 `reshape-request` |
| `src/server/services/page-write.ts` | 删页时 `deleteByPage` |
| `src/server/wiki/page-identity-migration.ts` | move 时 `movePage` |
| `src/server/db/repos/subjects-repo.ts` | `deleteWithContents` 清单补该表 |
| `src/app/api/reset/route.ts` | 清理清单补该表 |
| `examples/skills/ingest-enricher.md` | v6 → **v7**：quiz callout 用 `---` 分隔携带答案 |
| `src/server/agents/skills/builtin-manifest.ts` | `BUILTIN_UPGRADE_HASHES` 追加 v6 原版 SHA-256（**漏则既有 vault 全部 fail-fast**） |
| `src/server/services/ingest-service.ts` | 版本门 `'ingest-enricher': 6 → 7` |
| `src/server/services/reenrich-service.ts` | 版本门 `'ingest-enricher': 6 → 7` |
| `src/server/agents/skills/__tests__/ingest-enricher.load.test.ts` | 版本断言 + 答案段契约 |
| `src/lib/markdown-client.ts` | quiz 按首个 `thematicBreak` 切分问答段、答案段默认隐藏、写 `data-quiz-id`；div 覆盖挂 QuizAffordance |
| `src/components/wiki/quiz-affordance.tsx` | **新**（有答案 / 无答案两种形态） |
| `src/components/wiki/lens-feedback.tsx` | 改：仅重塑版渲染、带 `viewedSource` |
| `src/components/wiki/reading-progress.tsx` | 读完埋点（同页去重） |
| `src/lib/i18n/messages/{zh-CN,en}.ts` | quiz 自评与证据面板文案 |
| 各 `__tests__/` | 见测试策略 |
| `src/server/db/CLAUDE.md` / `src/server/CLAUDE.md` / `src/app/CLAUDE.md` | changelog + 模块文档 |

---

## 十三、分期

**MVP（本 spec 的实现计划覆盖）**

0. `ingest-enricher` v7 + 两处版本门 + hash 白名单（**先行**：先让新 ingest 开始产出带答案的
   quiz，后续前端落地时才有真实内容可测；且它与其余任务无耦合，可独立验证）
1. `page_evidence` 表 + repo + 生命周期闭合（决策 8）
2. `deriveMastery` 纯函数 + `masteryWindowDays`（可先于采集写完并测透）
3. D1 quiz 通电（第一批正证据，兼容有 / 无答案两种形态）
4. D2 选区追问 + D3 引用命中 + D4 重塑请求（服务端已有落库点，改动薄）
5. D5 读完埋点（区分接触与掌握的必需品）
6. `GET /api/mastery`（供 spec ② 消费）
7. A 组修复 + `profile_signals` 三步退役

**后置（本 spec 设计但不在首个实现计划内）**

- **B 组 画像 subject-scoped**。诚实说明理由：一旦 C+D 落地、spec ② 的地图接入重塑，
  「他懂什么」将由地图逐页精确回答，`readingLevel` 这个三档粗粒度维度的边际价值会显著
  缩水。先把地图跑起来，再判断 subject-scoped 画像是否还值得那次主键迁移。
  设计已在第七节写明，随时可启动。
- D6 `own-source` 曝光传播（依赖 source → page 的产出关系查询，改动面独立）。
- D7 归因消歧（区分「我不懂」与「这页写得烂」）——需要先有一批真实证据才能设计判据。

---

## 十四、已定决策（2026-07-26）

| # | 议题 | 取值 | 依据 |
|---|---|---|---|
| 1 | B 组（画像 subject-scoped） | **后置** | 等 spec ② 的地图接入重塑后，再判断 `readingLevel` 这个三档粗粒度维度是否还值得一次主键迁移。设计已完整写在第七节，随时可启动 |
| 2 | enricher 产出 quiz 答案 | **同期升 v7** | 把自评升级为有客观参照的判分。不做全库回填，存量页退化为自评（决策 5、6） |
| 3 | `page-read` 判定 | **滚动到底 + 停留 ≥30s** | 两个条件都要满足才算接触，避免把扫一眼当读过。阈值写死常量，不做设置项 |
| 4 | 弱负证据计入 `struggling` | **不计入**，只作 `exposed` | 信噪比不足：问到某页可能是查资料，重塑可能只是想换讲法（决策 3 第 5 条） |

### 遗留待观察（不阻塞实现）

- 决策 3 的 30s 阈值：接入后按真实数据调整。
- 决策 4 的放松条件：若一周真实使用后 `struggling` 计数为 0，改为「累计 ≥3 条弱负证据
  判 `struggling`」——这是本设计里第一个该放松的旋钮。
- 决策 2 的下一步：若判分数据表明自评形态明显失真，再评估存量页批量回填。

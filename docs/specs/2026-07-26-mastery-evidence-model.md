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

- 在一个真实 subject 上使用一周后，能产出非空的四态分布，**且 `mastered` 非空**
  （决策 4 的有效期若定得过短，这一条会直接失败——它是那条公式的验收闸门）。
- 人工复核 `struggling` 项，确实对应用户卡过的页面。
- 任一非 `unknown` 判定都能在 UI 上展开看到支撑它的原始证据条目与时间戳。
- 删页 / 改名 / 删 subject 后，`page_evidence` 无残留、无错误关联；重建同名 slug 从零开始。
- `signal-reducer` 的棘轮与无衰减行为消失：同向连点不再每次降档，历史信号按时间衰减。

**关于「重塑是否变得更好」——不设客观标准**

这套系统的前提就是**因人而异**：不存在一个跨读者成立的「更好」，判据只能是 vault 主人的
主观感受，且 N=1、无法 A/B。本 spec 不伪造可测量指标。

但它有一个必须落实的推论——**正确性不可测量时，可逆性必须是一等公民**。
这不是安慰性表述，而是三条硬性设计约束：

1. 「看原文」永远即时可切（canonical 本地即得，已是现状，不得退化）。
2. 每个由地图导致的「跳过解释」都必须有当场翻案的入口（spec ② 的 E3）。
3. 翻案必须立刻生效——负证据压过正证据（决策 3 第 2 条），下一次重塑即改变。

判断权归人，系统只负责**让错误的代价足够低、纠正足够快**。

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
| 2 | 衰减窗口内存在**强负证据**（`quiz-wrong` / `selection-ask` / `self-report-hard` / `concept-unknown`） | `struggling` / 强证据≥2 则 `high`，否则 `low` |
| 3 | 存在未过期的正证据，**且（含 ≥1 条 strong 或 ≥2 条 weak）** | `mastered` / 含 strong 则 `high`，纯 weak 则 `low` |
| 4 | 存在 exposure 证据、已过期的正证据、**或不足以支撑规则 3 的孤立 weak 正证据** | `exposed` / `low` |
| 5 | 只有弱负证据（`citation-hit` / `reshape-request`） | `exposed` / `low` |

**规则 3 的 strength 门槛是必须的**，否则一条 `self-report-easy`（读者点一下「太浅」）
就能把整页判成 `mastered`，重塑从此跳过解释它——正是决策 2 要防的那个最危险失败。
`quiz-correct`(weak)（无答案自评答对）同理：自我拔高偏差下的单条自陈不足以支撑「不必再讲」。
两条 weak 正证据（例如同页两道题都自评答对）才够到 `low` 置信度的 `mastered`。

第 5 条是刻意的：弱负证据信噪比不足以判 `struggling`，但足以证明「他接触过这一页」。

### 决策 4：`mastered` 有效期 = 复习到期 **再逾期一档**才降级

`SPACING_LADDER = [1, 3, 7, 21, 60]`（`maintenance-policy.ts:18`）这套装置库里已经有了，
只是**接错了对象**——它在给「内容」排增益计划。同一套节律指向 `(user, page)` 就是一个现成
的记忆模型。

**但阶梯本身不是有效期。** 阶梯说的是「什么时候该复习」，不是「知识什么时候失效」——
到期该复习 ≠ 到期就当作不会了。若直接拿间隔当有效期，答对一次只维持 **1 天**，
而系统里没有任何机制提示用户回去重答，`mastered` 会几乎恒为空、E 的注入等于没做。

正确的两级语义：

```
i        = min(consecutivePositives - 1, LADDER.length - 1)
dueAt    = lastPositiveAt + LADDER[i]                          // 该复习了
expiresAt= dueAt + LADDER[min(i + 1, LADDER.length - 1)]       // 逾期超过下一档才降级
```

| 连续正证据 | 该复习 | 失效 |
|---|---|---|
| 1 | +1 天 | +4 天 |
| 2 | +3 天 | +10 天 |
| 3 | +7 天 | +28 天 |
| 4 | +21 天 | +81 天 |
| ≥5 | +60 天 | +120 天 |

过期回落 `exposed`（而非 `unknown`——他确实接触过）。

**`consecutivePositives` 的三条精确定义**（每条都对应一个会让公式失真的具体失败）：

1. **页级，不是题级。** 同一页上任意正证据（不同的 quiz、`self-report-easy`）都累加。
   题级连击要求用户回去重答同一道题——没有任何机制促成，实际不可达；页级下一页 3 道 quiz
   各答对一次即到 `+28 天`，这才现实。
2. **按「天」去重，不按行计数。** 同一天内的多条正证据只算 1。否则读者反复点判分按钮
   （或误触）就能把连击刷到 5，换来 120 天的 `mastered`——而间隔重复的语义本来就是
   「隔一段时间再答对一次」，同一分钟点五下不构成五次复习。
   证据表仍然 append-only 全量保留（审计需要），只是**派生时按天折叠**。
3. **只有 strong 负证据清零连击。** 若不限定强弱，`citation-hit`（问了个问题、回答引用了
   这一页，完全正常的事）会把攒了几周的掌握连击打回零。弱负证据只影响规则 5 的落点，
   不参与连击计算。

> 实现上抽 `masteryWindowDays(consecutivePositives)` 到 `profile/mastery.ts`，
> 与 `maintenance-policy` 共用常量但**不共用函数**——两者的语义已经分化
> （一个是复习排期，一个是有效期），耦合会让任一侧的调整误伤另一侧。

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

### 决策 6：答案用 `---` 分隔，切分逻辑收进 `createRemarkQuiz()` 插件

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

切分**不塞进**既有的 callout 重标插件，而是独立成 `createRemarkQuiz()`，与
`createRemarkCallouts` / `createRemarkSelectionBlocks` 同构：

1. 在 `createRemarkCallouts` **之后**运行，扫 `data.hProperties['data-callout'] === 'quiz'`
   的节点（复用它已经打好的标记，不重复解析 `[!type]`）
2. 按**第一个** `thematicBreak` 把 children 切为问题段 / 答案段；无 `thematicBreak`
   则原样放行（存量页形态）
3. 答案段包进 `hName:'div'` + `data-quiz-answer` 的容器
4. 问题段文本经 `fnv1a` 得 `data-quiz-id`，写到 callout 节点的 `hProperties`

**插件顺序约束**：必须排在 `createRemarkSelectionBlocks()` **之后**。选区块依赖解析期的
`node.position` 计算 offset，而 quiz 会插入没有 position 的包装节点。它只重构 blockquote
**内部**、不影响顶层块 offset，但排最后是零成本的保险。

canonical 正文里答案是明文（编辑器、git、FTS 里都可见），只有渲染时折叠——这是对的，
答案属于页面内容，不是 UI 状态。

### 决策 7：quiz 身份 = **问题段**内容 hash，客户端同步计算

需要一个跨会话稳定、内容变即变的 quiz 标识。位置索引脆弱（插入一段就全错位），
内容 hash 语义正确（题目改了就是新题，旧证据自然失效）。

hash 的输入只取**问题段**（决策 6 切分后的前半），不含答案。理由：证据是关于「这道题」的，
enricher 重跑时润色答案措辞不应该让「他答对过」这件事失效。切分本来就要做，取前半是免费的。

hash 由 `createRemarkQuiz()`（决策 6）计算。该插件运行在客户端，`crypto.subtle` 是异步的
不适用，改用同步非加密 hash（FNV-1a）——这只是本地标识，不是安全边界。

### 决策 8：证据必须随页面生命周期闭合

这是上游讨论未覆盖、但实现必踩的三处：

| 事件 | 处理 | 挂载点 |
|---|---|---|
| 删页 | 删除该页全部证据 | `page-write.ts::deletePageInSubject` |
| move / rename slug | 证据迁移到新 slug | `page-identity-migration.ts::migratePageIdentityCaches` |
| 删 subject / reset | 级联清理 | `subject_id` FK CASCADE + `subjects-repo::deleteWithContents` 清单 |

`migratePageIdentityCaches` 已经在迁移 `page_sources` / `page_embeddings` /
`page_maturity` / `page_renditions` / `page_rendition_assets` / **`profile_signals`**
六项 slug-keyed 派生数据，`page_evidence` 按同一 `INSERT…SELECT + DELETE` 模式加入即可。

> **退役 `profile_signals` 时必须同步删掉该文件里的 `profile_signals.slug` 迁移块**
> （`page-identity-migration.ts:85`），否则表已 DROP 而迁移仍在 UPDATE，
> move 页面会直接 SQL 报错。

### 决策 9：正文交互块走统一接缝，不在 callout 渲染器里特判

`renderMarkdown()` 目前有 **6 个消费方**：

| 消费方 | 有页面身份？ | 该有 quiz 判分按钮？ |
|---|---|---|
| `page-renderer.tsx`（Wiki 阅读页） | 是 | **是** |
| `message-list.tsx`（Chat 消息） | 否 | 否 |
| `editor-preview.tsx`（编辑器预览） | 是，但语境是编辑 | 否 |
| `source-viewer.tsx`（Source 查看器） | 否 | 否 |
| `url-source-preview.tsx`（URL 阅读模式） | 否 | 否 |
| `wiki-reading-view.tsx:371`（Sources 分栏） | 否 | 否 |

若直接在既有 `div` 覆盖里「见到 `data-callout==='quiz'` 就挂按钮」，按钮会出现在全部六处，
而其中四处**根本没有页面身份**——证据要么发不出去，要么归错页。这是必须在设计期消除的缺陷，
不是实现细节。

quiz 是正文里**第一个**交互块，但不会是最后一个：spec ② 的 E4（重塑版里被跳过解释的
`[[X]]` 挂「这个我其实不懂」）就是第二个。所以把接缝一次性建好，形状沿用文件里已有的
按需插件模式（`headingAnchors` / `selectionBlocks` 就是同一套）：

```ts
renderMarkdown(content, titleSlugMap, {
  // …既有 headingAnchors / selectionBlocks
  interactive?: { pageSlug: string; subjectSlug: string },
})
```

- **不传 `interactive`**（上表五处）：quiz 照样切分、答案照样折叠，但只有一个纯本地的
  展开开关——零网络、零证据。
- **传 `interactive`**（只有 Wiki 阅读页）：`<QuizBlock>` 在揭晓后额外渲染判分按钮，
  用上下文里的 `pageSlug` / `subjectSlug` 发证据。

> **`interactive` 必须是 `PageRenderer` 的显式 prop，由 `wiki-reading-view` 传入；
> `PageRenderer` 不得用自己的 `slug` / `subjectSlug` 属性就地构造。**
> 因为 `editor-preview.tsx` 就是 `<PageRenderer content slug titleSlugMap />`——
> 只要 PageRenderer 自行构造，编辑器预览立刻获得判分按钮，与上表第三行直接矛盾。

**一般原则：能力由最外层知道语境的调用方显式授予，不能由中间层或展示层推断。**

本 spec 里有两个实例，两处都不是实现细节而是设计约束：

| 组件 | 它有什么 | 为什么不能让它自己决定 |
|---|---|---|
| `PageRenderer` | `slug` / `subjectSlug` | 不知道自己是被阅读页还是编辑器预览渲染 |
| `ReadingProgress` | `containerRef` | 纯展示组件（只渲染一根进度条），本来就没有页面身份；为了埋点给它加 `slug` 会把展示层变成有 IO 的组件 |

所以 D5 的读完埋点不改 `ReadingProgress`，而是新增 `use-page-read-beacon` hook 由
`wiki-reading-view` 挂载，复用它已导出的纯函数 `calculateReadingProgress` 做到底判定。

**答案折叠在六处都生效**：「不剧透」是内容呈现决定，不是某个页面的 UI 状态。
只有**发证据**这一能力是阅读页独占的。

按 YAGNI 只做到这一步：**不建插件注册表、不做能力协商**。一个上下文参数 + 每种交互块一个
remark 插件，N=2 时这是刚好的抽象量；真到第四五种再谈注册表。

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

**`detail_json` 承载 A2 要求的归因字段**：`viewedSource`（`canonical` / `reshape`）、
`profileVersion`、以及重塑相关证据的 rendition 标识。它们不单独立列——只用于事后审计与
排查，不参与任何查询或派生，塞进 JSON 是正确的粒度。

### 证据类型

| kind | polarity | strength | 生产方 | 来源 | anchor |
|---|---|---|---|---|---|
| `quiz-correct` | positive | strong / **weak** | 本 spec D1 | 揭晓后判分 / 无答案自评 | quizId |
| `quiz-wrong` | negative | strong | 本 spec D1 | 判分或自评（两者同权，见决策 5） | quizId |
| `selection-ask` | negative | strong | 本 spec D2 | 选区追问 | section |
| `self-report-hard` | negative | strong | 本 spec A 组 | 原 `too_hard`（**整页讲法太难**） | — |
| `self-report-easy` | positive | weak | 本 spec A 组 | 原 `too_easy`（**整页讲法太浅**） | — |
| `citation-hit` | negative | weak | 本 spec D3 | 回答引用命中 | — |
| `reshape-request` | negative | weak | 本 spec D4 | 重塑请求 | — |
| `page-read` | exposure | weak | 本 spec D5 | 读完 | — |
| `concept-unknown` | negative | strong | **spec ② E3** | 重塑版里的「这个我其实不懂」 | — |
| `own-source` | exposure | weak | **后置**（D6） | 自己 ingest 的源产出的页 | — |

「生产方」一列是刻意加的：`concept-unknown` 由 spec ② 写入、本 spec 只定义它的语义与权重，
`own-source` 则已后置——只看本 spec 的分期会找不到这两者的落地位置。
枚举本身是**单一真实源**，两份 spec 共用，不得各自扩充。

`self-report-easy` 定为 weak positive：说「太浅」不等于掌握，只是不觉得难。

**`concept-unknown` 必须与 `self-report-hard` 分开，不能复用后者**，尽管两者都是
strong negative。因为 `self-report-hard` 是 **style-bearing** 的（它就是原来的
`too_hard`，要喂给风格 reducer 调 `readingLevel`），而 E3 说的是
「**别的那一页**讲的那个概念我不懂」——跟当前页的讲法难度毫无关系。
复用会让每一次纠错都顺手把全库讲解深度往下推一格，正是决策 3 白名单要防的那类污染。

`concept-unknown` 只进掌握度派生，不进 reducer。

### `user_profiles` 加一列（A 组，非后置）

```
style_prefs_updated_at TEXT   -- 仅在旋钮真的变化时推进；reducer 的消费边界
```

与既有 `updated_at` 分开——后者任何画像写入都会变（改背景自述、onboarding 提交），
拿它当边界会误清信号窗口。

> **给既有表加列不能只靠 `ensureTables`。** `client.ts::ensureTables` 用的是
> `CREATE TABLE IF NOT EXISTS`——对已存在的表**什么都不做**，既有安装升级后拿不到新列，
> 读写立刻 SQL 报错。必须走项目已有的守卫式 ALTER 模式：
> `PRAGMA table_info(<table>)` 检测列缺失 → `ALTER TABLE … ADD COLUMN`。
> 仓库里有多处先例（`subjects.augmentation_level` / `jobs` 的补列循环 /
> `operations.subject_id` / `llm_usage`）。
>
> 本设计有**两处**加列，两处都在既有表上，都适用这条：
> `user_profiles.style_prefs_updated_at`（本 spec）与
> `page_renditions.known_concepts_json`（spec ② E4）。

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
  /** 仅 state==='mastered' 时非空；供审计面解释「何时会降级」（决策 4） */
  expiresAt: string | null;
  /** 供审计面展示，按时间倒序有界截断 */
  recent: EvidenceRow[];
}

export function deriveMastery(evidence: EvidenceRow[], now: Date): MasteryVerdict;
/** 决策 4 的两级语义，返回 { dueDays, expiryDays }。 */
export function masteryWindowDays(consecutivePositives: number): { dueDays: number; expiryDays: number };
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

> **style-bearing 只有 `self-report-hard` / `self-report-easy` 两种**（即原 `too_hard` /
> `too_easy`），必须在代码里以显式白名单表达，不能用 polarity 之类的属性顺带筛。
>
> 因为其余负证据说的都是**掌握度**而非**讲法**：`quiz-wrong`（这道题答错了）、
> `selection-ask`（这段没看懂）都不代表「整体讲得太难，请全局降档」。若它们混进 reducer，
> 读者每答错一道题就把全库 `readingLevel` 往下推一格——这恰恰是本 spec 缺口 1 要修的
> 「领域无关的全局降档」，会以更隐蔽的形式复发。
- 加时间窗与衰减：按 `createdAt` 折算权重，超窗证据不参与。
- 加消费边界：只统计**上次旋钮调整之后**的证据——消除棘轮。
- 解耦三个维度：`readingLevel` / `verbosity` / `exampleDensity` 各自独立阈值，
  不再一次信号同时推动三个。

> **消费边界要一列专用时间戳 `user_profiles.style_prefs_updated_at`，不能复用
> `updated_at`。** 后者在任何画像写入时都会变——用户改一句背景自述、或 onboarding
> 提交，都会把信号窗口整个清空，读者会觉得「我明明点过好几次太难，怎么一点反应都没有」。
> 只有旋钮真的动了才推进边界。

### API

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/evidence` | POST | 追加一条证据；`requireAuth` + `requireCsrf` + `resolveSubjectFromRequest`；**写前校验 `slug` 在该 subject 内存在**（`getPageBySlug`），不存在 404 |
| `/api/mastery` | GET | **无 `slug`**：全量 `slug → MasteryVerdictLite`（`state` / `confidence` / `evidenceCount` / `lastEvidenceAt` / `expiresAt`，**不含 `recent`**）；**带 `slug`**：单页完整 `MasteryVerdict` 含 `recent`。**与 `/api/graph` 同口径排除 meta 页**（`isMetaPage`） |

> 批量响应刻意不带 `recent`：图层只需要着色所需的 state/confidence，逐页塞进最多
> `MAX_RECENT_EVIDENCE` 条证据会让响应体随使用量线性膨胀，而其中 99% 永远不会被展开看。
> 证据明细在 tap 节点时按单页取——这也正是审计面的真实交互形状。
| `/api/profile/signals` | POST | 并存期双写，切换后删除 |

> `/api/evidence` 的存在性校验不是洁癖：没有它，前端一个陈旧的 slug（页面刚被删/改名，
> 客户端缓存未刷新）就会持续累积指向幽灵页的证据，而决策 8 的生命周期闭合**只清理已存在
> 过的页**，兜不住这种从未存在过的 slug。

### 前端

- `markdown-client.ts`：新增 `createRemarkQuiz()`（决策 6）+ `RenderOptions.interactive`
  （决策 9）；`div` 覆盖按 `data-quiz-id` 挂 `<QuizBlock>` 并透传 interactive 上下文。
- `src/components/wiki/quiz-block.tsx`（新）：问题 + 答案折叠开关 +（仅 interactive 时）
  判分按钮；兼容有 / 无答案两种形态。
- `page-renderer.tsx`：新增 `interactive?` **透传 prop**（自身不构造，见决策 9 的警示）。
- `wiki-reading-view.tsx`：**唯一**构造并传入 `interactive` 的调用方。
- `lens-feedback.tsx`：改为只在查看重塑版时渲染（修 A1），发送时带 `viewedSource`。
- 阅读完成埋点（D5）：**新增 `use-page-read-beacon.ts` hook，由 `wiki-reading-view` 挂载**。
  不改 `reading-progress.tsx`——它只有 `containerRef` / `useContainerScroll` 两个 prop，
  是纯展示组件（渲染一根进度条），没有也不该有 `slug` / `subjectSlug`。
  hook 复用 `calculateReadingProgress` 这个已导出的纯函数做到底判定，
  滚动到底 **且** 停留 ≥30s 时发一条 `page-read`，同页一次会话去重。

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
| 无 `interactive` 上下文（决策 9） | `<QuizBlock>` 不渲染判分按钮，也不持有发证据的能力——不是运行时判空，是根本拿不到 `pageSlug` |
| 时钟回拨 | `deriveMastery` 对未来时间戳的证据按「已发生」处理，不特殊化 |
| 纠错后点 Refresh 会顺带写一条 `reshape-request` | **已知且接受**：它是 weak negative，规则 5 只在「只有弱负证据」时生效，页面若已有更强证据则完全不影响判定；只会让 `evidenceCount` 略微虚高。不为它加特例 |

---

## 十一、测试策略

1. **`deriveMastery`（核心）**：五条优先级各自命中；负证据压正证据；`mastered` 过期回落
   `exposed` 而非 `unknown`；连续答对延长有效期；一次负证据清零连击；空输入返回
   `unknown/none`；`recent` 截断稳定；`expiresAt` 仅在 `mastered` 时非空。
2. **`masteryWindowDays`（决策 4，回归重点）**：`{dueDays, expiryDays}` 对 1–5+ 连击
   逐档断言（1→{1,4} / 2→{3,10} / 3→{7,28} / 4→{21,81} / ≥5→{60,120}）；
   **`expiryDays` 恒 > `dueDays`**（防再次退化成「到期即失效」）；上限钳制。
3. **连击三条定义（决策 4，回归重点）**：页级累加（同页不同 quiz，不要求同一道题）；
   **同一天多条正证据只算 1**（防反复点判分刷到 120 天）；
   **只有 strong 负证据清零**（`citation-hit` 这种弱负证据不得打断连击）。
4. **规则 3 的 strength 门槛**：单条 `self-report-easy` 或单条 weak `quiz-correct`
   **不足以判 `mastered`**，落 `exposed`；两条 weak 正证据才到 `mastered/low`；
   含 strong 则 `mastered/high`。
5. **`fnv1a`**：同输入同输出；不同输入不同输出（抽样）；跨 Node/浏览器一致。
6. **`createRemarkQuiz`**：有 `---` 正确切分；无 `---` 走旧形态；多个 `---` 只按第一个切；
   答案改写不改变 `data-quiz-id`，问题改写则改变（决策 7）；非 quiz callout 不受影响；
   排在 `selectionBlocks` 之后时顶层块 offset 不变（决策 6 的顺序约束）。
7. **交互接缝隔离（决策 9）**：不传 `interactive` 时渲染结果**不含任何判分按钮**——
   对 Chat / **编辑器预览（`EditorPreview` 经 `PageRenderer` 的那条路径）** /
   Source 查看器三条各断言一次；答案折叠在两种情况下都生效。
8. **`ingest-enricher` v7**：版本号断言；skill roundtrip 覆盖带答案的 quiz 契约；
   `BUILTIN_UPGRADE_HASHES` 含 v6 原版 hash（防漏第 3 步导致既有 vault fail-fast）。
9. **API 边界**：`POST /api/evidence` 对不存在 / 跨 subject 的 slug 返回 404 不落行；
   `GET /api/mastery` 排除 meta 页，口径与 `/api/graph` 一致。
10. **`evidence-repo`**：append / 按页查 / 按 subject 分组 / `deleteByPage` / `movePage`；
   真实 SQLite 覆盖 subject FK CASCADE。
11. **生命周期集成**：删页后证据清空 → 重建同名 slug 得到 `unknown`；move 后证据跟随；
    `deleteWithContents` 与 `/api/reset` 级联覆盖；**退役 signals 后 move 页面不报错**
    （防漏删迁移块，决策 8）。
12. **`signal-reducer` 回归**：同向连点不再每次降档（棘轮消失）；超窗证据不参与；
    三维度独立不再联动。
13. **并存期一致性**：双写阶段 `profile_signals` 与 `page_evidence` 的 style-bearing
    子集等价。

---

## 十二、影响文件清单

| 文件 | 改动 |
|---|---|
| `src/server/db/schema.ts` | **新** `page_evidence` 表 |
| `src/server/db/client.ts::ensureTables` | 补 `CREATE TABLE IF NOT EXISTS` + 两个索引 |
| `drizzle/00xx_*.sql` | 结构性迁移（编号由 `npm run db:generate` 自动分配；两份 spec 都不要写死，谁先落地谁占号） |
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
| `src/server/wiki/page-identity-migration.ts` | 加 `page_evidence` 迁移块；**退役 signals 时同步删 `profile_signals` 块**（决策 8） |
| `src/components/wiki/use-page-read-beacon.ts` | **新**：D5 埋点 hook，由 `wiki-reading-view` 挂载（`ReadingProgress` 是纯展示组件，没有也不该有页面身份，见决策 9） |
| `src/server/db/repos/subjects-repo.ts` | `deleteWithContents` 清单补该表 |
| `src/app/api/reset/route.ts` | 清理清单补该表 |
| `examples/skills/ingest-enricher.md` | v6 → **v7**：quiz callout 用 `---` 分隔携带答案 |
| `src/server/agents/skills/builtin-manifest.ts` | `BUILTIN_UPGRADE_HASHES` 追加 v6 原版 SHA-256（**漏则既有 vault 全部 fail-fast**） |
| `src/server/services/ingest-service.ts` | 版本门 `'ingest-enricher': 6 → 7` |
| `src/server/services/reenrich-service.ts` | 版本门 `'ingest-enricher': 6 → 7` |
| `src/server/agents/skills/__tests__/ingest-enricher.load.test.ts` | 版本断言 + 答案段契约 |
| `src/lib/markdown-client.ts` | **新** `createRemarkQuiz()`（排在 `selectionBlocks` 之后）；`RenderOptions` 加 `interactive?`；div 覆盖按 `data-quiz-id` 挂 `<QuizBlock>` 并透传 interactive 上下文 |
| `src/components/wiki/page-renderer.tsx` | 透传 `interactive={{ pageSlug, subjectSlug }}`（**唯一**传入方） |
| `src/components/wiki/quiz-block.tsx` | **新**：问题 + 答案折叠开关 + （仅 interactive 时）判分按钮；兼容有 / 无答案两种形态 |
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

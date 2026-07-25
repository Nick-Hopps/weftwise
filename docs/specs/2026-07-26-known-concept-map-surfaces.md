# Spec：已知概念地图的两个消费面

日期：2026-07-26
状态：待评审
上游：[docs/specs/2026-07-26-mastery-evidence-model.md](./2026-07-26-mastery-evidence-model.md)（spec ①）

> 本 spec 是「已知概念地图」两份设计中的第 ②份，负责**消费**掌握度事实：
> **E** 把地图注入读时重塑 prompt，**F** 把地图叠成 Wiki Graph 的一个图层。
> 事实的产生与解释在 spec ① 中定义，本份只消费其 `deriveMastery()` 契约。

---

## 一、与 spec ① 的依赖边界

本 spec 不新增任何证据来源，只消费四样东西：

| 依赖 | 来自 plan ① | 用途 |
|---|---|---|
| `page_evidence` 表 + `evidence-repo` | 任务 2、3 | 取原始证据 |
| `deriveMastery(evidence, now)` | 任务 5 | 四态 + 置信度派生 |
| `GET /api/mastery` | 任务 11 | F 的数据源 |
| `RenderOptions.interactive` 接缝 | 任务 7 | E4 纠错入口的挂载点 |

**没有这四样，本 spec 无法实现，也无法验证**——零证据时地图全 `unknown`，两个消费面都渲染
不出任何东西。若先行实现本 spec，需从 plan ① 抽出这条最小脊柱（详见第十二节）。

反向价值：本 spec 是 `deriveMastery()` 契约的**第一批真实消费者**。E 需要按状态分组的
slug 清单，F 需要全 subject 的 `slug → verdict` 映射外加逐条证据展示——两者都能在 ① 实现
之前暴露契约缺口。

---

## 二、背景与目的

spec ① 建立了 `(user, subject, slug)` 粒度的掌握度事实，但事实本身不改变任何用户可见行为。
两个消费面把它变现：

**E —— 读时重塑注入。** 当前 `buildReshapePageUserPrompt` 只喂「读者画像」（4 个风格旋钮
+ 一段自述）。模型不知道读者已经吃透了哪些概念，于是每一页都从零讲起。有了地图就能说：
「`[[gradient-descent]]` 他已经掌握，直接引用即可；`[[backprop]]` 他卡过，换个角度重点讲」。
**这是整个已知地图存在的理由**——它是唯一把「他懂什么」而非「他爱怎么读」喂给模型的通路。

**F —— Graph 掌握度图层。** 已知地图在数据结构上**就是** Wiki Graph：节点是 page（概念），
边是 wikilink（概念依赖）。另做一个列表视图是把同构的东西拆成两份。图层同时是三样东西：

1. **审计面**——这类功能错了是隐形的（用户只会觉得「重塑版怎么突然看不懂了」，不会归因到
   地图）。必须能看到系统认为你懂什么、依据是哪几条证据。
2. **纠错入口**——看到误判可以当场翻案。
3. **（后置）导航面**——见决策 F4。MVP 只做前两项。

---

## 三、非目标

- 不新增证据来源（全部在 spec ①）。
- 不改 canonical 正文：地图只影响读时重塑与图层着色，与 vault / Saga / git 无关。
- 不做跨 subject 的地图（同 slug 在不同 subject 语义不同，项目本身就这么隔离）。
- 不做全库掌握度预计算或缓存表（沿用 ① 的读时派生）。
- 不做从图上一键加入 research backlog（决策 F4 的下一步，独立成项）。

---

## 四、约束与成功标准

**约束**

- **零证据零回归**：地图全 `unknown` 时，重塑 prompt 与今天逐字节相同，图层默认不启用。
- **注入必须邻域 scoped，永不全库**。项目在 T2.1 吃过一次亏——index/log 生成因为把全 subject
  页清单塞进 prompt 而随页数单调膨胀直至超上下文窗口，最后整个改成确定性渲染。
- **误判「已掌握」是本功能唯一真正危险的失败**：重塑版会跳过解释，页面直接读不懂。
  默认保守（未列出即不懂）+ 逐条纠错 + 「看原文」永远即时可切。
- **图层不得重建 cytoscape 元素集**。`use-wiki-graph.ts` 的数据 effect 是 `[]` 一次性
  （文件里有注释说明原因）；重建会摧毁 cose 布局位置与力导向模拟。
- 图层不新增 LLM 调用。

**成功标准**

- 手工种入若干证据行后，重塑同一页两次（种证据前 / 后），产出可见地不同：已掌握概念从
  「展开解释」变为「直接引用」。
- 图层能一眼看出四态分布；点任一非 `unknown` 节点能看到支撑它的原始证据条目与时间。
- 关掉图层（结构模式）后，graph 行为与改动前完全一致。
- 重塑版里被判为已掌握的 `[[X]]` 都带纠错入口，**且刷新页面后仍在**（E4）；
  点击后状态行出现 `Update available`（E5），Refresh 后该概念重新展开。

> **「更好」不设客观标准。** 这套系统的前提就是因人而异——不存在跨读者成立的「更好」，
> 判据只能是 vault 主人的主观感受，N=1、无法 A/B。本 spec 不伪造指标。
>
> 其必然推论是 spec ① 已写明的**可逆性优先**，在本 spec 里对应三条硬约束：
> 「看原文」即时可切（不得退化）、每个被跳过的概念都有纠错入口（E2 的 `[[slug]]` 纪律 +
> E3）、纠错后立刻可见（E5 的 stale）。**判断权归人，系统只负责让错误代价足够低、
> 纠正足够快**——这三条任一缺失，本 spec 就不该上线。

---

## 五、关键决策 —— E（重塑注入）

### E1：邻域取自正文本身，不查 DB

重塑页 X 时，`extractWikiLinks(body)`（`wiki/wikilinks.ts` 单一真实源）直接从正文拿到
1 跳出链——**wikilink 就写在正文里，连图查询都不用**。再 `getPageBySlug` 补 title，
join 证据算四态。

邻域典型 <20 页，一次算几毫秒。这同时满足了「邻域 scoped 永不全库」的硬约束：注入量由
页面自身的引用数决定，与 vault 规模无关。

排除项：自身 slug、meta 页（`META_PAGE_SLUGS`）、跨 subject 目标（本 subject 之外不计）。

**仍需一个硬上界 `MAX_NEIGHBORHOOD = 40`**，按 wikilink 在正文中的**首次出现顺序**截断。
「与 vault 规模无关」不等于「有界」——一张综述性质的页面链出 150 个概念完全可能，
那就是 150 行注入。项目在 T2.1 正是因为「prompt 随规模单调膨胀」把 index/log 整个改成了
确定性渲染；这里必须先把闸门装上，而不是等它长出来。

首次出现顺序是刻意选的：它确定性、零成本，且正文里越早提到的概念通常越核心。
截断发生时在注入段末尾明说「还有 N 个相关概念未列出」——**不做静默截断**，
否则模型会把「未列出」误读成「读者不懂」，反而多讲一堆。

### E2：注入三段清单 + 「未列出即不懂」兜底

```
=== READER'S KNOWN CONCEPTS (this subject) ===
When you mention any concept listed below, write it as a [[slug]] wikilink
using EXACTLY the slug shown — that link is the reader's correction handle.

Already solid — reference as [[slug]], do NOT re-explain:
  [[gradient-descent]] Gradient Descent
Seen before — a one-line recap is enough:
  [[chain-rule]] The Chain Rule
Known trouble spot — explain carefully and try a different angle:
  [[backprop]] Backpropagation
Anything not listed here: assume unfamiliar and explain it normally.
```

**开头那句 wikilink 纪律不是可选的。** `RESHAPE_PAGE_SYSTEM_PROMPT` 通篇没提 wikilink，
而 2026-07-17 那次改动**明确把 reshape 从保真护栏里移除了**（见 `services/CLAUDE.md`），
模型可以自由增删链接。若不显式要求 `[[slug]]` 语法，模型很可能写成纯文本
「如你已知的梯度下降」——而 **E3 的纠错入口挂在 wikilink 上，没有 wikilink 就没有入口**，
唯一的翻案通道断掉。

这条纪律只约束「提到清单内概念时的写法」，不恢复任何保真护栏，也不限制模型增删其他链接。

映射：`mastered` → 第一段，`exposed` → 第二段，`struggling` → 第三段，
`unknown` → **不出现**。

最后一句是兜底护栏：未列出等同今天的行为，冷启动零回归。

`confidence === 'low'` 的 `mastered` **降级进第二段**（「一句话回顾」）而不是第一段。
理由同 ① 的保守原则：低置信度的「已掌握」不足以支撑「完全不讲」。

三段全空时**整段不注入**（不是注入一个空清单），保证零证据时 prompt 逐字节不变。

### E3：纠错入口挂在「被判为已掌握」的 wikilink 上

E2 的第一段是模型被明确告知「不必重讲」的概念。渲染重塑版时，对这些 slug 的 `[[X]]`
挂一个轻量纠错入口「这个我其实不懂」——点击写入一条 `concept-unknown` 负证据，
按 ① 的决策 3，负证据压过正证据，下一次重塑该概念立即重新展开。

**怎么知道哪些被跳过了？** 不问模型（不可靠且要改输出契约），而是用我们自己给出的清单：
凡进入第一段、且确实出现在重塑正文里的 slug，就是被跳过的候选。确定性、零额外调用。

挂载点复用 spec ① 决策 9 的接缝——这正是当时说「quiz 不会是最后一个交互块」的兑现：

```ts
interactive?: {
  pageSlug: string;
  subjectSlug: string;
  assumedKnown?: string[];   // ② 新增：被当作已掌握、因而未展开解释的 slug
}
```

`markdown-client.ts` 的 `a` 覆盖（现有 `WikiLinkAnchorRenderer`）在 slug ∈ `assumedKnown`
时额外渲染入口。**只在重塑视图传 `assumedKnown`**：canonical 没有「跳过解释」这回事，
传了就是误导。

> **匹配必须同时比对 subject，不能只比 slug。** 该覆盖同时处理
> `[[slug]]` 与 `[[other-subject:slug]]`（`data-wiki-subject` 属性区分），而
> `assumedKnown` 里只装当前 subject 的裸 slug。只比 slug 的话，重塑正文里一个指向**别的
> subject 同名页**的链接会挂上纠错入口——点下去写的是当前 subject 那一页的负证据，
> 归错了页。跨主题同名 slug 在本项目是合法且常见的（`pages` 复合主键就是为此）。

接缝沿用 spec ① 决策 9 的授权方向：`interactive` 由 `wiki-reading-view` 显式构造并传入，
`PageRenderer` 只透传、不就地构造——否则 `EditorPreview` 会连带获得纠错入口。

### E4：地图随重塑产物一起持久化

`assumedKnown` 在 **POST**（生成重塑）时算出，但 `use-lens.ts` 挂载时走的是 **GET**
（`loadSavedLens`）——而 `page_renditions` 现有列是
`subjectId/slug/canonicalHash/profileVersion/renderedMd/model/updatedAt`，没地方存。
不处理的话：生成当次有纠错入口，**刷新或重访就全没了**，而重访恰恰是最常见路径。

**不能在 GET 时重算**——证据可能已经变了，重算出的清单和当初真正告诉模型的那份对不上，
纠错入口会挂到模型其实展开讲过的概念上。

`page_renditions` 新增一列：

```
known_concepts_json TEXT   -- 生成该 rendition 时注入的 KnownConcepts 对象（可空=旧行/无地图）
```

一列同时解决两件事：

- **`assumedKnown`** 从它的 `mastered` 段派生，GET / POST 同源
- **stale 判定**（下一条）拿它与当前地图比对

### E5：rendition 的 stale 判定必须感知地图变化

现状：

```ts
stale: saved.canonicalHash !== current || saved.profileVersion !== current
```

掌握度变化**不会**改 `profileVersion`——那个只在 `style_prefs` 变时自增。于是答对一道
quiz、或点了「这个我其实不懂」之后，旧重塑版照旧显示、不提示 `Update available`，
E3 的纠错闭环在 UI 上无从触发（用户得自己想到去按 Refresh）。

GET 时补算当前 `KnownConcepts` 与 `known_concepts_json` 比对，不同即 stale。

**成本可接受**：`evidence-repo.listForSubject` 是**一次**索引扫描 + 内存分组，
之后逐 slug 跑纯函数。因此 `buildKnownConceptsForPage` 要接受一个可选的预取证据 map，
让 GET / POST 两条路径都只查一次；不要退化成邻域内逐页 `listForPage` 的 N 次查询。

`known_concepts_json` 为 null 的旧行（本功能上线前生成的 rendition）不参与地图比对，
只按既有两项判 stale——避免存量重塑版一上线全部变 stale。

> **加列必须同步改 move 迁移。** `page-identity-migration.ts:68` 迁移 `page_renditions`
> 用的是**显式列清单**的 `INSERT…SELECT`：
> ```sql
> INSERT OR REPLACE INTO page_renditions
>   (subject_id, slug, canonical_hash, profile_version, rendered_md, model, updated_at)
> SELECT subject_id, ?, canonical_hash, profile_version, rendered_md, model, updated_at ...
> ```
> 不把 `known_concepts_json` 加进去，**改名一次就把地图快照静默抹成 NULL**——
> 重塑版的纠错入口全部消失、stale 判定退回旧两项，而且不报任何错。
> 这是加列时最容易漏的一处：它不在 renditions repo 目录下。

---

## 六、关键决策 —— F（Graph 掌握度图层）

### F1：图层数据独立取，不塞进 `/api/graph`

对话中原本设想给 `/api/graph` 的每个 node 加 `mastery` 字段。读完 `use-wiki-graph.ts` 后
改为**前端在掌握度模式下额外 fetch `GET /api/mastery`**，理由三条：

1. `/api/graph` 是 mount 时一次性拉取；掌握度是可随时开关的图层，生命周期不同。
2. 掌握度会随证据变化，图结构不会——分开才能只刷新掌握度而不动布局。
3. 结构模式下不必白算一遍全 subject 的掌握度。

`/api/mastery` 已在 spec ① 定义（无 `slug` 时返回全量 `slug → MasteryVerdict`），本 spec
零新增后端路由。

### F1b：模式是全屏专属，mini-graph 恒为结构模式

`MiniGraphView` 有**两个挂载点**——Dashboard（`(app)/page.tsx:159`）与 Context 面板
（`context-panel-context-tab.tsx:151`），全屏浮层是从 mini-graph 进入的（同一 cy 实例迁移
宿主，不重建）。所以 `mode` 状态天然住在 `useWikiGraph` 里，会被 compact 视图共享。

**定为：`mode` 在退出全屏时重置回 `structure`。** 两条理由：

1. 切换入口只在全屏顶栏。若模式跨全屏持久化，compact 视图会停在掌握度着色上，
   而那里**没有任何切回去的 UI**——用户被困在一个自己看不懂的配色里。
2. Dashboard 的 mini-graph 是 200px 见方的概览卡片，四态 ramp 在那个尺寸下读不出信息，
   只会让首页看起来"坏了"。

掌握度是一次**主动的审计动作**，不是常驻视图状态——用完即走是对的。

### F2：模式切换只换 data + stylesheet，绝不重建元素

`use-wiki-graph.ts` 的数据 effect 明确是 `[]` 一次性（注释解释了为什么：避免 `currentSlug`
变化时重建模拟）。掌握度模式必须走文件底部那条既有的更新路径：

```ts
cy.batch(() => { /* node.data('mastery', …) */ });
cy.style(buildStylesheet(readGraphTheme(), mode));
```

一旦改元素集，cose 布局位置与力导向模拟全部丢失。

### F3：unknown 压暗，不过滤元素集

对话中原本设想「默认只渲染有证据子图 + 1 跳邻居，其余折叠成计数」。过滤元素集与 F2 直接
冲突，改为：**`unknown` 节点走低对比压暗**（复用现有 `.dimmed` 的 0.22 opacity 思路），
有证据的子图自然浮出来。

达到同样目的（unknown 不淹没画面）、零重建、零布局扰动，且用户仍能看到整张图的形状——
「我的已知区域在整体中占多大」本身就是有价值的信息，折叠掉反而丢了。

### F4（**后置，MVP 不做**）：边界导航

`mastered` 节点的邻居里那些还是 `unknown` 的，就是「下一步够得着的概念」——学习科学里的
最近发展区。它在列表视图里表达不出来（「离已知区域一跳」是拓扑属性），只有图上一眼可见，
且几乎零成本：`cy` 里已有全部节点与边，F1 又把 mastery 写进了 node data，
派生就是一遍遍历（`unknown` 且至少一个邻居 `mastered`），一个纯函数 + 一条 stylesheet
选择器。

**但 MVP 不做**，三条理由，重要性递增：

1. **冷启动是空的。** 边界依赖 `mastered` 非空，而按 spec ① 的设计 `mastered` 恰恰是最难
   到达的状态（要 quiz 判分或明确正向证据，还带过期）。现在做大概率一片空白。
2. **边的语义是「提到了」，不是「需要先学」。** `wiki_links` 不足以支撑「你已经懂了它的
   前置」这个声称——`[[backprop]]` 链到 `[[chain-rule]]` 可能是前置，也可能只是顺带一提。
   诚实的表述只能是「和你懂的东西相邻」。
3. **边界是 F 里唯一一个系统主动下断言的地方**，其余全是如实报告。四态着色说的是「我根据
   这几条证据认为你懂这个」，边界说的是「你应该学这个」——后者要花掉前者攒下的信任。
   先让用户看到地图是准的（点节点、证据条条对得上），再让系统开口建议；顺序反了，
   一次不靠谱的推荐会连带让人不信整张图。

**后加零返工**：它是 F 已有数据上的派生 class，没有架构锁定。等地图被验证准确后再加，
届时再接 research backlog / maintenance / `coverage-gap`。

### F5：色彩编码 —— ramp + outlier 分开

`unknown → exposed → mastered` 是**有序**的，用同一色相（warp 经线靛，项目的正常操作主色）
的明度阶梯。

`struggling` **不是这个梯子的一端**——它的语义是「试过并卡住了」，不是「更不懂」。
塞进 ramp 会误导。它走 **danger 描边**（categorical outlier），这也正合项目 2026-07-20
定下的色彩语义约定：danger 红独占「需要注意的问题」。

新增 3 个主题 token（亮暗各一套，与现有 7 个 `--color-graph-*` 并列）：

```
unknown                           复用现有 --color-graph-orphan 灰 → 不新增
--color-graph-mastery-exposed     warp 低明度
--color-graph-mastery-mastered    warp 高明度
--color-graph-mastery-struggling  danger（描边用）
```

> F4 后置带走了第四个 token（`--color-graph-mastery-frontier`，虚线描边）。
> 虚线是第三种编码通道，与填充 ramp 和 danger 描边都不冲突，后加不需要重排色彩方案。

**结构模式下的 `orphan` 填充色在掌握度模式让位**——孤儿是结构属性，归结构模式。
同理 `.focused` / `.neighbor` 的焦点层级在掌握度模式下降级为仅描边加粗，不抢填充色。

### F6：数字不印节点，改为图例分布 + 点击证据面板

节点 label 已是标题（`text-max-width: 180` + ellipsis），再叠数字会挤爆。

更根本的理由：spec ① 决策 2 明确**不存标量分数**——掌握度是从稀疏证据派生的带置信度估计。
在节点上印一个「72」是假精度，会让用户以为系统有它并不具备的确定性。

数字放两处：

- **顶栏 stats 位**（现在是 nodes / links / orphans）在掌握度模式换成四态分布计数
- **点击节点后的证据面板**：列出该页原始证据条目（kind + 时间 + anchor），
  以及派生出的 state / confidence。**`kind` 必须经 i18n 映射成人话**
  （「自测答对」而非 `quiz-correct`）——这是给 vault 主人看的解释面，不是日志；
  把原始枚举值直接上屏等于没解释，而「可解释」正是 spec ① 目的 2 的硬要求

图例（`fullscreen-graph.tsx` 现成的 `LegendRow`，现在三行）在掌握度模式换成五行。

### F7：掌握度模式下 tap = 选中看证据，不跳转

结构模式保持 `tap → router.push`。掌握度模式的主要意图是**审计**而非导航，改为
tap 选中并在面板显示证据，面板内提供「打开页面」链接。

模式不同交互不同是可接受的——模式是用户显式切换的，且面板内保留了导航出口。
触屏下这比 hover 方案可用。（列为待评审决策 2。）

> **tap handler 分支必须读 ref，不能读 state。** 现有 `cy.on('tap','node', …)` 注册在
> `use-wiki-graph.ts` 的 `[]` 一次性 effect 里，闭包会把挂载时的 `mode` 永久钉死——
> 用户切到掌握度模式后，tap 仍然跳转。该文件**已经因为同类问题留过注释**
> （数据 effect 的闭包会把 `currentSlug` 钉在挂载时刻，所以焦点高亮才被拆到独立 effect）。
> 同一个坑，第二次踩。`mode` 存 ref，handler 读 `modeRef.current`。

---

## 七、数据流

### 7.1 生成重塑（E，POST）

```
POST /api/lens/[...slug]
  → 既有：resolveSubject / 读 canonical body / getProfileOrDefault
  → evidenceRepo.listForSubject(userId, subjectId)         一次查询，供下一步复用
  → buildKnownConceptsForPage({ userId, subject, selfSlug, body, evidenceBySlug })
       → selectNeighborhood(body, { currentSubjectSlug, selfSlug, titleResolver })
       → getPageBySlug 补 title（缺页跳过）
       → 逐 slug deriveMastery → 四态分组，low-confidence mastered 降级进 exposed
  → reshapePageBody({ …, knownConcepts })
       → buildReshapePageUserPrompt 追加 KNOWN CONCEPTS 段（三段全空则整段不注入）
  → replaceRendition({ …, knownConceptsJson })              E4：随产物一起持久化
  → 响应 assumedKnown = 存储清单的 mastered 段 slug
```

### 7.2 读取已保存重塑（E，GET —— 最常见路径）

```
GET /api/lens/[...slug]
  → getLatestRendition → 无则回落 canonical（同今天）
  → assumedKnown 从 known_concepts_json 派生     ★ 不重算：必须是当初告诉模型的那份
  → 补算当前 KnownConcepts（复用同一次 listForSubject）
  → stale = canonicalHash 变 || profileVersion 变 || 地图变
            （known_concepts_json 为 null 的旧行不参与地图比对）
```

### 7.3 纠错回流（E3）

```
读者在重塑版里点某个 [[X]] 的「这个我其实不懂」
  → POST /api/evidence { slug: X, kind: 'concept-unknown' }    （spec ① 已有路由）
  → 该页地图随即变化 → 下次 GET 即 stale:true，状态行显示 Update available
  → 用户点 Refresh 重塑：X 进 struggling 段，重新展开解释
```

E5 的 stale 判定是这条闭环在 UI 上唯一的触发点——没有它，纠错点完了页面毫无反应。

### 7.3 图层（F）

```
用户在 graph 切到「掌握度」模式
  → GET /api/mastery?s=<subject>            （spec ① 已有路由）
  → cy.batch(): 逐 node 写 data('mastery'|'confidence')
  → cy.style(buildStylesheet(theme, 'mastery'))
  → 顶栏 stats 与图例切换为四态
  → tap 节点 → GET /api/mastery?s=&slug= → 证据面板
```

---

## 八、组件与接口

### 新增纯函数 `src/server/profile/concept-map.ts`

```ts
/**
 * 从正文抽本 subject 内的 1 跳 wikilink 目标（去重、排除自身与 meta 页）。
 * titleResolver 必传：正文里的 `[[某某标题]]` 若没有 resolver，`extractWikiLinks`
 * 只能回落 `normalizeSlug(title)`，未必等于真实 slug——邻域会静默漏掉概念且不报错。
 * 由 IO 层用 `pages-repo::getTitleToSlugMap(subjectId)` 供给。
 */
export function selectNeighborhood(
  body: string,
  opts: { currentSubjectSlug: string; selfSlug: string; titleResolver: TitleResolver },
): string[];

export interface KnownConcept { slug: string; title: string; state: MasteryState }
export interface KnownConcepts { mastered: KnownConcept[]; exposed: KnownConcept[]; struggling: KnownConcept[] }

/** 渲染 prompt 段；三段全空返回 null（调用方据此整段不注入）。 */
export function renderKnownConcepts(k: KnownConcepts): string | null;

/** 低置信度 mastered 降级进 exposed。 */
export function groupByMastery(entries: Array<{ slug; title; verdict: MasteryVerdict }>): KnownConcepts;
```

三个都是无 IO 纯函数，可完整单测。

### 新增 IO 层 `src/server/profile/concept-map-io.ts`

```ts
buildKnownConceptsForPage(opts: {
  userId; subject; selfSlug; body;
  /** 可选预取：GET/POST 共用一次 listForSubject，避免邻域内 N 次 listForPage（E5）。 */
  evidenceBySlug?: Map<string, EvidenceRow[]>;
}): KnownConcepts
```

组合三个纯函数 + `getTitleToSlugMap`（供 resolver）+ `getPageBySlug`（补 title，
页面已删则跳过）+ `evidenceRepo` + `deriveMastery`。

### 改动

| 位置 | 改动 |
|---|---|
| `db/schema.ts` + `db/client.ts` + `drizzle/00xx_*.sql` | `page_renditions` 加 `known_concepts_json TEXT`（可空，E4） |
| `db/repos/renditions-repo.ts` | `replaceRendition` / `getLatestRendition` 读写新列 |
| `wiki/page-identity-migration.ts` | `page_renditions` 的显式列清单加 `known_concepts_json`（**漏则改名静默丢地图快照**，见 E5） |
| `llm/prompts/reshape-prompt.ts` | `buildReshapePageUserPrompt` 增可选 `knownConcepts`；system prompt 补「按 KNOWN CONCEPTS 段调整展开深度」+ **`[[slug]]` 书写纪律** |
| `services/reshape-service.ts` | `reshapePageBody` 入参增 `knownConcepts?` 并透传 |
| `api/lens/[...slug]/route.ts` | POST 算地图并随 rendition 持久化；**GET 补算并与存储比对判 stale**（E5）；两条路径共用一次 `listForSubject` |
| `lib/contracts.ts` | `LensResult` 加 `assumedKnown?: string[]` |
| `hooks/use-lens.ts` | 透传 `assumedKnown` |
| `components/wiki/wiki-reading-view.tsx` | **唯一**构造 `interactive` 的调用方；仅 `usingReshaped` 时带 `assumedKnown` |
| `components/wiki/page-renderer.tsx` | `interactive?` 透传 prop，自身不构造（spec ① 决策 9） |
| `lib/markdown-client.ts` | `interactive` 加 `assumedKnown?`；`a` 覆盖据此挂纠错入口 |
| `components/wiki/wiki-link.tsx` | 新增纠错 affordance（沿用 quiz 的 best-effort 发送语义） |
| `components/graph/graph-stylesheet.ts` | `buildStylesheet(theme, mode)`；掌握度选择器族 |
| `components/graph/use-wiki-graph.ts` | 掌握度取数 + `cy.batch` 写 data + mode 状态 |
| `components/graph/fullscreen-graph.tsx` | 模式切换按钮、四态图例、分布 stats、证据面板 |
| `app/globals.css` | 4 个 `--color-graph-mastery-*` token（亮/暗） |
| `lib/theme/read-theme-vars.ts` | `ThemeSnapshot` 补 4 个字段 |

---

## 九、错误处理与降级

| 场景 | 行为 |
|---|---|
| `buildKnownConceptsForPage` 抛错 | 捕获，按「无地图」继续重塑——**不阻断**（重塑本身比地图重要） |
| 邻域内页面已删 | `getPageBySlug` 返回 null 时跳过该 slug，不进任何段 |
| 三段全空 | 整段不注入，prompt 与今天逐字节相同 |
| GET 时地图补算失败（E5） | 退回既有两项判 stale，不因此报错或隐藏已保存重塑版 |
| `known_concepts_json` 为 null（本功能上线前的旧 rendition） | 不参与地图比对、无 `assumedKnown`；避免存量重塑版一上线全部变 stale |
| 模型没按纪律写 `[[slug]]`（E2） | 该概念就没有纠错入口——**已知降级**。用户仍可用「看原文」兜底，且下次重塑有机会写对 |
| `GET /api/mastery` 失败 | 图层保持结构模式并提示一次，不影响既有 graph |
| 证据面板取数失败 | 面板显示错误行，图本身不受影响 |
| 纠错入口发送失败 | `console.error`，UI 保持乐观态（与 quiz 同语义） |

---

## 十、测试策略

1. **`selectNeighborhood`**：去重；排除自身与 meta 页；跨 subject 目标不计；
   无 wikilink 返回空；**`[[某某标题]]` 经 titleResolver 解析到真实 slug**，
   无 resolver 时的错误行为有回归断言（防再次退化）；
   **超过 `MAX_NEIGHBORHOOD` 时按首次出现顺序截断且不静默**。
2. **`groupByMastery`**：四态映射；`unknown` 不出现；**low-confidence `mastered` 降级进
   `exposed`**；空输入。
3. **`renderKnownConcepts`**：三段渲染；部分段为空时不渲染空标题；**三段全空返回 null**；
   **含 `[[slug]]` 书写纪律那句**（E2，缺了 E3 就没锚点）。
4. **prompt 快照**：有地图时含三段与兜底句；**无地图时与改动前逐字节相同**（零回归断言）。
5. **lens 路由**：`assumedKnown` 只含 mastered 段；`buildKnownConceptsForPage` 抛错时
   重塑仍成功。
6. **E4 持久化**：POST 落 `known_concepts_json`；**GET 从存储派生 `assumedKnown`
   而非重算**（构造「存储清单 ≠ 当前地图」的场景断言取的是存储那份）。
7. **E5 stale**：证据变化后 GET 返回 `stale:true`；`known_concepts_json` 为 null 的
   旧行不因地图比对变 stale；地图未变时不误报 stale。
8. **E3 挂载隔离**：canonical 视图不传 `assumedKnown` → 无纠错入口；重塑视图才有；
   不在 `assumedKnown` 里的 wikilink 无入口；`EditorPreview` 路径无入口；
   **`[[other-subject:同名slug]]` 不得命中**（跨主题同名合法且常见，只比 slug 会归错页）。
7. **`graph-stylesheet`**：`mode='structure'` 产出与改动前完全一致（零回归）；
   `mode='mastery'` 下 orphan 填充让位、focus 层级降级为描边、struggling 走 danger 描边；
   **node 没有 `mastery` data 时按 `unknown` 着色**（`/api/mastery` 只返回有证据的 slug，
   绝大多数节点根本没有这个字段）。
8. **图层不重建**：切换模式后 `cy` 实例同一、元素数不变、节点位置不变。
9. **模式归属（F1b）**：退出全屏后 `mode` 回到 `structure`；Dashboard 与 Context 面板的
   mini-graph 任何时候都不着掌握度色。
10. **move 不丢地图快照（E5）**：改名一页后，其 rendition 的 `known_concepts_json`
    仍在，`assumedKnown` 与 stale 判定行为不变。

---

## 十一、影响文件清单

见第八节表格。新增文件 3 个（`concept-map.ts` / `concept-map-io.ts` /
graph 证据面板组件），其余为改动。

---

## 十二、分期与实现顺序

**若在 spec ① 之前实现本 spec**，需先从 plan ① 抽出最小脊柱：

```
plan ① 任务 2（page_evidence 表）
plan ① 任务 3（evidence-repo）
plan ① 任务 5（deriveMastery 纯函数）
plan ① 任务 11 的 GET /api/mastery 部分
plan ① 任务 7（interactive 接缝）        ← 仅 E3 需要
        ↓
本 spec E（重塑注入）        本 spec F（图层）    ← 可并行
```

**验证靠手工种证据**：`page_evidence` 是纯 append-only 表、无 LLM 参与，可以直接
`INSERT` 若干行（覆盖四态）来驱动两个消费面。这让本 spec 在采集链路（quiz 通电、
选区追问接入、读完埋点）**完全没做**的情况下依然可以真实验证——也正是先做 ② 的价值：
先确认收益长什么样，再决定采集链路投入多少。

**E 与 F 建议顺序**：先 E。它是地图存在的理由，且能最快回答「注入之后重塑版真的变好了吗」
这个决定后续投入的问题；F 是审计与导航面，价值依赖 E 已经在跑。

---

## 十三、决策状态

**已定（2026-07-26）**

| 议题 | 取值 | 依据 |
|---|---|---|
| 边界导航是否进 MVP | **后置** | 冷启动空、边语义不足以支撑「前置」声称、且它是唯一主动下断言的地方——先让地图证明自己准，再让系统开口建议。后加零返工（决策 F4） |

**待评审**

1. **`exposed` 段的措辞强度**。当前定为「一句话回顾即可」。若实测发现模型对 `exposed`
   也大幅压缩解释、导致可读性下降，应改为更弱的表述（如「可以略快带过」）。
   这是本设计里最可能需要按实感调整的一处，建议接入后用同一页对照重塑两次再定。
2. **掌握度模式下 tap 的语义**（决策 F7）：改为「选中看证据」而非跳转。
   若觉得两种模式交互不一致的代价更大，退回「tap 仍跳转 + hover 看证据」，
   代价是触屏不可用。

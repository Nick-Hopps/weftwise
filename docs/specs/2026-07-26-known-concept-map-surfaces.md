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
3. **导航面**——见决策 F4，这是复用 graph 而非另建视图的最强理由。

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
- 重塑版里被判为已掌握的 `[[X]]` 都带纠错入口；点击后下一次重塑该概念重新展开。

---

## 五、关键决策 —— E（重塑注入）

### E1：邻域取自正文本身，不查 DB

重塑页 X 时，`extractWikiLinks(body)`（`wiki/wikilinks.ts` 单一真实源）直接从正文拿到
1 跳出链——**wikilink 就写在正文里，连图查询都不用**。再 `getPageBySlug` 补 title，
join 证据算四态。

邻域典型 <20 页，一次算几毫秒。这同时满足了「邻域 scoped 永不全库」的硬约束：注入量由
页面自身的引用数决定，与 vault 规模无关。

排除项：自身 slug、meta 页（`META_PAGE_SLUGS`）、跨 subject 目标（本 subject 之外不计）。

### E2：注入三段清单 + 「未列出即不懂」兜底

```
=== READER'S KNOWN CONCEPTS (this subject) ===
Already solid — reference by name, do NOT re-explain:
  [[gradient-descent]] Gradient Descent
Seen before — a one-line recap is enough:
  [[chain-rule]] The Chain Rule
Known trouble spot — explain carefully and try a different angle:
  [[backprop]] Backpropagation
Anything not listed here: assume unfamiliar and explain it normally.
```

映射：`mastered` → 第一段，`exposed` → 第二段，`struggling` → 第三段，
`unknown` → **不出现**。

最后一句是兜底护栏：未列出等同今天的行为，冷启动零回归。

`confidence === 'low'` 的 `mastered` **降级进第二段**（「一句话回顾」）而不是第一段。
理由同 ① 的保守原则：低置信度的「已掌握」不足以支撑「完全不讲」。

三段全空时**整段不注入**（不是注入一个空清单），保证零证据时 prompt 逐字节不变。

### E3：纠错入口挂在「被判为已掌握」的 wikilink 上

E2 的第一段是模型被明确告知「不必重讲」的概念。渲染重塑版时，对这些 slug 的 `[[X]]`
挂一个轻量纠错入口「这个我其实不懂」——点击写入一条 `self-report-hard` 负证据，
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

### F4：图上真正有价值的是**边界**，不是分布

`mastered` 节点的邻居里那些还是 `unknown` 的——那就是「你的下一步该学什么」，
而且是**有依据的**：你已经懂了它的前置。

这个在列表视图里根本表达不出来，只有在图上一眼可见。**这是复用 graph 而非另建审计视图的
最强理由**——它把地图从 debug 面变成了学习路径推荐面。

实现上是掌握度模式下的一个额外高亮 class（`.frontier`），确定性派生：
`unknown 且至少一个邻居是 mastered`。

接 research backlog / maintenance / `coverage-gap` 是自然的下一步，但需要新的写入路径，
本 spec 不做（非目标）。

### F5：色彩编码 —— ramp + outlier 分开

`unknown → exposed → mastered` 是**有序**的，用同一色相（warp 经线靛，项目的正常操作主色）
的明度阶梯。

`struggling` **不是这个梯子的一端**——它的语义是「试过并卡住了」，不是「更不懂」。
塞进 ramp 会误导。它走 **danger 描边**（categorical outlier），这也正合项目 2026-07-20
定下的色彩语义约定：danger 红独占「需要注意的问题」。

`.frontier` 用虚线描边（第三种编码通道，不与前两者冲突）。

新增 4 个主题 token（亮暗各一套，与现有 7 个 `--color-graph-*` 并列）：

```
--color-graph-mastery-unknown     现有 orphan 灰复用即可 → 不新增
--color-graph-mastery-exposed     warp 低明度
--color-graph-mastery-mastered    warp 高明度
--color-graph-mastery-struggling  danger（描边用）
--color-graph-mastery-frontier    warp（虚线描边用）
```

**结构模式下的 `orphan` 填充色在掌握度模式让位**——孤儿是结构属性，归结构模式。
同理 `.focused` / `.neighbor` 的焦点层级在掌握度模式下降级为仅描边加粗，不抢填充色。

### F6：数字不印节点，改为图例分布 + 点击证据面板

节点 label 已是标题（`text-max-width: 180` + ellipsis），再叠数字会挤爆。

更根本的理由：spec ① 决策 2 明确**不存标量分数**——掌握度是从稀疏证据派生的带置信度估计。
在节点上印一个「72」是假精度，会让用户以为系统有它并不具备的确定性。

数字放两处：

- **顶栏 stats 位**（现在是 nodes / links / orphans）在掌握度模式换成四态分布计数
- **点击节点后的证据面板**：列出该页原始证据条目（kind + 时间 + anchor），
  以及派生出的 state / confidence

图例（`fullscreen-graph.tsx` 现成的 `LegendRow`，现在三行）在掌握度模式换成五行。

### F7：掌握度模式下 tap = 选中看证据，不跳转

结构模式保持 `tap → router.push`。掌握度模式的主要意图是**审计**而非导航，改为
tap 选中并在面板显示证据，面板内提供「打开页面」链接。

模式不同交互不同是可接受的——模式是用户显式切换的，且面板内保留了导航出口。
触屏下这比 hover 方案可用。（列为待评审决策 2。）

---

## 七、数据流

### 7.1 重塑注入（E）

```
POST /api/lens/[...slug]
  → 既有：resolveSubject / 读 canonical body / getProfileOrDefault
  → 新增：buildKnownConceptsForPage({ userId, subject, body })
       → selectNeighborhood(body, subject.slug)        纯函数，extractWikiLinks
       → 批量 getPageBySlug 补 title（缺页跳过）
       → 批量 evidenceRepo.listForPage → deriveMastery  逐 slug
       → 按四态分组，low-confidence mastered 降级进 exposed 段
  → reshapePageBody({ …, knownConcepts })
       → buildReshapePageUserPrompt 追加 KNOWN CONCEPTS 段（三段全空则整段不注入）
  → 响应体新增 assumedKnown: string[]（= mastered 段的 slug，供 E3 渲染纠错入口）
```

### 7.2 纠错回流（E3）

```
读者在重塑版里点某个 [[X]] 的「这个我其实不懂」
  → POST /api/evidence { slug: X, kind: 'self-report-hard' }   （spec ① 已有路由）
  → 下次重塑：X 进 struggling 段，重新展开解释
```

### 7.3 图层（F）

```
用户在 graph 切到「掌握度」模式
  → GET /api/mastery?s=<subject>            （spec ① 已有路由）
  → cy.batch(): 逐 node 写 data('mastery'|'confidence')
                 确定性派生 .frontier class
  → cy.style(buildStylesheet(theme, 'mastery'))
  → 顶栏 stats 与图例切换为四态
  → tap 节点 → GET /api/mastery?s=&slug= → 证据面板
```

---

## 八、组件与接口

### 新增纯函数 `src/server/profile/concept-map.ts`

```ts
/** 从正文抽本 subject 内的 1 跳 wikilink 目标（去重、排除自身与 meta 页）。 */
export function selectNeighborhood(body: string, currentSubjectSlug: string, selfSlug: string): string[];

export interface KnownConcept { slug: string; title: string; state: MasteryState }
export interface KnownConcepts { mastered: KnownConcept[]; exposed: KnownConcept[]; struggling: KnownConcept[] }

/** 渲染 prompt 段；三段全空返回 null（调用方据此整段不注入）。 */
export function renderKnownConcepts(k: KnownConcepts): string | null;

/** 低置信度 mastered 降级进 exposed。 */
export function groupByMastery(entries: Array<{ slug; title; verdict: MasteryVerdict }>): KnownConcepts;
```

三个都是无 IO 纯函数，可完整单测。

### 新增 IO 层 `src/server/profile/concept-map-io.ts`

`buildKnownConceptsForPage({ userId, subject, selfSlug, body }): KnownConcepts`
—— 组合上面三者 + `getPageBySlug` + `evidenceRepo.listForPage` + `deriveMastery`。

### 改动

| 位置 | 改动 |
|---|---|
| `llm/prompts/reshape-prompt.ts` | `buildReshapePageUserPrompt` 增可选 `knownConcepts`；system prompt 补一句「按 KNOWN CONCEPTS 段调整展开深度」 |
| `services/reshape-service.ts` | `reshapePageBody` 入参增 `knownConcepts?` 并透传 |
| `api/lens/[...slug]/route.ts` | POST 前算 `knownConcepts`；响应加 `assumedKnown` |
| `lib/contracts.ts` | `LensResult` 加 `assumedKnown?: string[]` |
| `hooks/use-lens.ts` | 透传 `assumedKnown` |
| `components/wiki/wiki-reading-view.tsx` | 仅 `usingReshaped` 时把 `assumedKnown` 传进 `interactive` |
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
| `GET /api/mastery` 失败 | 图层保持结构模式并提示一次，不影响既有 graph |
| 证据面板取数失败 | 面板显示错误行，图本身不受影响 |
| 纠错入口发送失败 | `console.error`，UI 保持乐观态（与 quiz 同语义） |

---

## 十、测试策略

1. **`selectNeighborhood`**：去重；排除自身与 meta 页；跨 subject 目标不计；
   无 wikilink 返回空；别名/标题写法经 `extractWikiLinks` 正确归一。
2. **`groupByMastery`**：四态映射；`unknown` 不出现；**low-confidence `mastered` 降级进
   `exposed`**；空输入。
3. **`renderKnownConcepts`**：三段渲染；部分段为空时不渲染空标题；**三段全空返回 null**。
4. **prompt 快照**：有地图时含三段与兜底句；**无地图时与改动前逐字节相同**（零回归断言）。
5. **lens 路由**：`assumedKnown` 只含 mastered 段；`buildKnownConceptsForPage` 抛错时
   重塑仍成功。
6. **E3 挂载隔离**：canonical 视图不传 `assumedKnown` → 无纠错入口；重塑视图才有；
   不在 `assumedKnown` 里的 wikilink 无入口。
7. **`graph-stylesheet`**：`mode='structure'` 产出与改动前完全一致（零回归）；
   `mode='mastery'` 下 orphan 填充让位、struggling 走描边、frontier 虚线。
8. **frontier 派生**：`unknown` 且至少一个邻居 `mastered` 才命中；纯函数单测。
9. **图层不重建**：切换模式后 `cy` 实例同一、元素数不变、节点位置不变。

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

## 十三、待评审决策

1. **`exposed` 段的措辞强度**。当前定为「一句话回顾即可」。若实测发现模型对 `exposed`
   也大幅压缩解释、导致可读性下降，应改为更弱的表述（如「可以略快带过」）。
   这是本设计里最可能需要按实感调整的一处。
2. **掌握度模式下 tap 的语义**（决策 F7）：改为「选中看证据」而非跳转。
   若觉得两种模式交互不一致的代价更大，退回「tap 仍跳转 + hover 看证据」，
   代价是触屏不可用。
3. **`.frontier` 是否进 MVP**。它是 F 最有价值的部分（决策 F4），但也是唯一一个
   「系统主动建议你学什么」的地方——若认为过早，可只做四态着色，frontier 留待下一步。

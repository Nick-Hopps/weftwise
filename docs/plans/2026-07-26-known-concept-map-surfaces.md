# Plan：已知概念地图的两个消费面

日期：2026-07-26
设计稿：[docs/specs/2026-07-26-known-concept-map-surfaces.md](../specs/2026-07-26-known-concept-map-surfaces.md)（spec ②）
上游：[docs/plans/2026-07-26-mastery-evidence-model.md](./2026-07-26-mastery-evidence-model.md)（plan ①）

按 TDD 推进，每个任务独立可验证、独立提交。

---

## 前置：从 plan ① 抽取最小脊柱

本 plan 消费掌握度事实，不产生事实。开工前必须先按 **plan ① 的原任务**完成以下四项
（不在此重复展开，避免两份计划漂移）：

| plan ① 任务 | 内容 | 本 plan 何处依赖 |
|---|---|---|
| 任务 2 | `page_evidence` 表 | 任务 1 种子脚本 |
| 任务 3 | `evidence-repo` | 任务 3 取证据 |
| 任务 5 | `deriveMastery` 纯函数 | 任务 2、3 |
| 任务 11 的 `GET /api/mastery` 部分 | 图层数据源 | 任务 6 |

**不需要**的部分：plan ① 任务 1（enricher v7）、任务 4（生命周期闭合）、
任务 6–10（quiz 通电与采集埋点）、任务 12–13（A 组与 signals 退役）。
它们与本 plan 无耦合，可后续独立推进。

> **接缝归属**：`RenderOptions.interactive`（spec ① 决策 9）由**先落地的一方建**。
> 本 plan 的任务 4 需要它，故由本 plan 建；plan ① 任务 7 届时改为「复用已有接缝 +
> 挂 `<QuizBlock>`」，已在该任务下加注。

---

## 任务 1：证据种子脚本（后续所有验证的前提）

零证据时两个消费面什么都渲染不出来，必须先有可复现的测试数据。

- 新增 `scripts/seed-mastery-evidence.ts` + `package.json` script
  `db:seed-mastery-evidence`；参数为 subject slug。
- 从该 subject 取若干真实页，种入覆盖四态的证据：
  - `mastered` —— 2 条近期 `quiz-correct`(strong)
  - `exposed` —— 1 条 `page-read`
  - `struggling` —— 1 条近期 `selection-ask`
  - `unknown` —— 不种（保持无行）
  - 另种 1 页「过期的 mastered」（`quiz-correct` 但时间戳超出 `masteryWindowDays`），
    用于验证回落 `exposed` 而非 `unknown`
- 脚本跑完**自己调 `deriveMastery` 打印各页判定**，成为自验证输出。
- 验证：`npm run db:seed-mastery-evidence -- general`，确认打印出五种情况且与预期一致。

## 任务 2：`concept-map.ts` 三个纯函数（E 核心）

先把用例写成失败测试，再实现。

- 新增 `src/server/profile/concept-map.ts`：
  `selectNeighborhood(body, { currentSubjectSlug, selfSlug, titleResolver })`、
  `groupByMastery(entries)`、`renderKnownConcepts(k)`。
- 新增 `src/server/profile/__tests__/concept-map.test.ts`：
  - `selectNeighborhood`：去重；排除自身 slug 与 `META_PAGE_SLUGS`；跨 subject 目标不计；
    无 wikilink 返回空；**`[[某某标题]]` 经 `titleResolver` 解析到真实 slug**
    （无 resolver 时 `extractWikiLinks` 只能回落 `normalizeSlug(title)`，邻域会静默漏概念
    且不报错——加一条回归断言锁死 resolver 必传）
  - `groupByMastery`：四态映射；`unknown` 不出现；**`confidence==='low'` 的 `mastered`
    降级进 `exposed` 段**；空输入返回三段全空
  - `renderKnownConcepts`：三段渲染含兜底句；某段为空时不渲染该段标题；
    **三段全空返回 `null`**；**必含 `[[slug]]` 书写纪律那句**（缺了 E3 就没锚点可挂）
- 验证：`npx vitest run src/server/profile/__tests__/concept-map.test.ts`

## 任务 3：地图注入重塑 prompt

- 新增 `src/server/profile/concept-map-io.ts`：`buildKnownConceptsForPage`
  （组合任务 2 三函数 + `getTitleToSlugMap` 供 resolver + `getPageBySlug` 补 title
  + `deriveMastery`；页面已删则跳过该 slug）。
  **接受可选 `evidenceBySlug` 预取**——调用方用一次 `listForSubject` 供给，
  不要退化成邻域内 N 次 `listForPage`。
- `src/server/llm/prompts/reshape-prompt.ts`：`buildReshapePageUserPrompt` 增可选
  `knownConcepts`；`RESHAPE_PAGE_SYSTEM_PROMPT` 补「按 KNOWN CONCEPTS 段调整展开深度」。
- `src/server/services/reshape-service.ts`：`reshapePageBody` 入参增 `knownConcepts?` 并透传。
- `src/app/api/lens/[...slug]/route.ts`：POST 前算地图（**try/catch 包裹，抛错按无地图
  继续**），响应加 `assumedKnown`。
- 测试重点：
  - prompt 快照：有地图时含三段、兜底句与 `[[slug]]` 纪律句
  - **零回归**：无地图时 `buildReshapePageUserPrompt` 输出与改动前**逐字节相同**
  - `buildKnownConceptsForPage` 抛错时重塑仍成功
  - `assumedKnown` 只含 `mastered` 段
- 验证：`npx vitest run src/server/llm/prompts/__tests__/reshape-prompt.test.ts src/server/services/__tests__/reshape-service.test.ts src/app/api/lens/`
- 人工验证：任务 1 种子跑完后，对同一页在**种证据前 / 后**各重塑一次，
  肉眼确认已掌握概念从「展开解释」变为「直接引用」。这是 E 是否真的有效的唯一判据。

## 任务 3b：`known_concepts_json` 持久化与 stale 判定（E4 + E5）

没有这一步，纠错入口在刷新后全部消失，且纠错完页面毫无反应——E 的闭环断在这里。

- `src/server/db/schema.ts` + `client.ts::ensureTables` + `drizzle/00xx_*.sql`：
  `page_renditions` 加 `known_concepts_json TEXT`（可空）。
- `src/server/db/repos/renditions-repo.ts`：`replaceRendition` / `getLatestRendition`
  读写新列。
- `src/app/api/lens/[...slug]/route.ts`：
  - POST：把注入的 `KnownConcepts` 一并落库
  - GET：`assumedKnown` **从存储列派生，不重算**（必须是当初告诉模型的那份）；
    另补算当前地图与之比对，纳入 `stale`
  - 两条路径共用一次 `evidenceRepo.listForSubject`
- 测试：
  - POST 落列；GET 在「存储清单 ≠ 当前地图」时仍返回**存储**那份 `assumedKnown`
  - 证据变化后 GET `stale:true`；地图未变时不误报
  - `known_concepts_json` 为 null 的旧行不因地图比对变 stale（存量不炸）
  - GET 地图补算抛错时退回既有两项判 stale，不隐藏已保存重塑版
- 验证：`npx vitest run src/app/api/lens/ src/server/db/repos/__tests__/renditions-repo.test.ts`

## 任务 4：`interactive` 接缝 + E3 纠错入口

- `src/lib/markdown-client.ts`：`RenderOptions` 加
  `interactive?: { pageSlug; subjectSlug; assumedKnown?: string[] }`（本 plan 建接缝）；
  `a` 覆盖（`WikiLinkAnchorRenderer`）在 slug ∈ `assumedKnown` 时透传标记。
- `src/components/wiki/page-renderer.tsx`：`interactive?` 只做**透传 prop**，
  **不得用自身的 `slug`/`subjectSlug` 就地构造**——`editor-preview.tsx` 就是
  `<PageRenderer content slug titleSlugMap />`，一旦就地构造，编辑器预览立刻获得纠错入口。
  能力由最外层知道语境的调用方显式授予。
- `src/components/wiki/wiki-link.tsx`：新增「这个我其实不懂」入口，
  点击 `POST /api/evidence { kind:'self-report-hard' }`；失败 `console.error`，
  UI 保持乐观态。
- `src/lib/contracts.ts` `LensResult` 加 `assumedKnown?: string[]`；
  `src/hooks/use-lens.ts` 透传；
  `src/components/wiki/wiki-reading-view.tsx` **仅 `usingReshaped` 时**传入
  （canonical 没有「跳过解释」这回事）。
- 测试：canonical 视图无纠错入口；重塑视图才有；不在 `assumedKnown` 里的 wikilink 无入口；
  不传 `interactive` 的五个消费方一律无入口——**`EditorPreview` 那条经 `PageRenderer`
  的路径单独断言一次**（它是唯一会被「就地构造」误伤的消费方）。
- 验证：`npx vitest run src/lib/__tests__/ src/components/wiki/__tests__/`

## 任务 5：graph 主题 token + `buildStylesheet(theme, mode)`

- `src/app/globals.css`：新增 3 个 token（亮/暗各一套）
  `--color-graph-mastery-{exposed,mastered,struggling}`；`unknown` 复用现有
  `--color-graph-orphan`。
- `src/lib/theme/read-theme-vars.ts`：`ThemeSnapshot` 补 3 个字段。
- `src/components/graph/graph-stylesheet.ts`：`buildStylesheet(theme, mode)`；
  `mode==='mastery'` 时——按 `data(mastery)` 填充 ramp、`struggling` 走 danger 描边、
  `unknown` 压暗（复用 `.dimmed` 的 0.22 思路）、**`orphan` 填充与 `.focused` 填充让位**
  （focus 层级降级为仅描边加粗）。
- 测试（`graph-layout.test.ts` 同目录新增）：**`mode='structure'` 产出与改动前完全一致**
  （零回归断言，逐条比对选择器与样式）；`mode='mastery'` 下上述四条各断言一次。
- 验证：`npx vitest run src/components/graph/__tests__/`

## 任务 6：掌握度取数 + 模式切换（绝不重建元素）

- `src/components/graph/use-wiki-graph.ts`：新增 `mode` 状态与 `setMode`；
  切到 `mastery` 时 fetch `GET /api/mastery`，随后
  `cy.batch(() => node.data('mastery'/'confidence'))` + `cy.style(buildStylesheet(theme, mode))`。
  **必须走文件底部既有的更新路径**——数据 effect 是 `[]` 一次性（文件内有注释说明），
  改元素集会摧毁 cose 布局与力导向模拟。
- 取数失败：保持结构模式并提示一次，不影响既有 graph。
- 测试：切换模式后 `cy` 实例同一、元素数不变、节点坐标不变；取数失败时 mode 回落 structure。
- 验证：`npx vitest run src/components/graph/__tests__/`
- 人工验证：全屏图切模式，确认布局不跳、四态着色正确。

## 任务 7：模式切换入口 + 四态图例 + 分布 stats + 证据面板

- `src/components/graph/fullscreen-graph.tsx`：
  - 顶栏加模式切换（结构 / 掌握度）
  - 顶栏 stats 在掌握度模式换成四态分布计数（替代 nodes/links/orphans）
  - 图例（现成 `LegendRow`，三行）换成四行
  - 新增证据面板：掌握度模式下 tap 节点 → 选中并显示该页
    `state / confidence / 原始证据条目（kind + 时间 + anchor）`，面板内提供「打开页面」
- **tap 语义**：结构模式保持 `router.push` 不变；掌握度模式改为选中看证据
  （spec ② 待评审 2，先按此实现，评审后可回退）。
- `src/lib/i18n/messages/{zh-CN,en}.ts`：新增文案。
- 验证：`npm run dev:all` 后人工走查——种子数据下四态分布计数与图上着色一致；
  点各态节点证据条目正确；切回结构模式后行为与改动前一致。

## 任务 8：文档同步

- `src/server/CLAUDE.md`：`profile/concept-map*` 两个新模块。
- `src/app/CLAUDE.md`：`/api/lens` 响应新增 `assumedKnown` + changelog。
- `src/lib/CLAUDE.md`：`markdown-client` 的 `interactive` 接缝（与 plan ① 协调措辞）。
- `src/components/CLAUDE.md`：graph 双模式、证据面板、`wiki-link` 纠错入口。
- 根 `AGENTS.md` changelog。
- 验证：`npm run lint && npx tsc --noEmit && npm test`

---

## 收口检查

1. `npm test` 全绿，`npm run lint` 与 `npx tsc --noEmit` 无错。
2. **零证据零回归**：清空 `page_evidence` 后——重塑 prompt 与改动前逐字节相同
   （任务 3 的快照断言覆盖）；graph 默认结构模式，行为与改动前一致。
3. **E 真的有效**：同一页在种证据前 / 后各重塑一次，产出可见地不同。
   若看不出差别，说明注入措辞太弱——回到 spec ② 待评审 1 调整 `exposed` 段强度。
   （「更好」不设客观判据，见 spec ② 成功标准；此处只验「地图确实改变了产出」。）
4. **纠错闭环完整走通**：重塑版点某个已掌握概念的「这个我其实不懂」 →
   **刷新页面纠错入口仍在**（E4）→ 状态行出现 `Update available`（E5）→
   Refresh 后该概念从「直接引用」变回「重点展开」。四步缺一即闭环断裂。
5. **`mastered` 非空**：种子数据里连击 1 次的页在 4 天内仍应判 `mastered`
   （决策 4 的两级有效期；若这条失败，说明公式又退化成了「到期即失效」）。
6. **图层不破坏布局**：结构 ↔ 掌握度反复切换，节点位置不漂移。
7. **接缝隔离**：Chat 与编辑器预览里的 wikilink 无纠错入口。

---

## 与 plan ① 的后续衔接

本 plan 完成后，plan ① 的剩余任务价值排序会更清楚：

- **plan ① 任务 1 + 6–10（enricher v7 + quiz 通电 + 采集埋点）** 成为最高优先——
  本 plan 跑在种子数据上，只有真实采集接通后地图才会自己长出来。
- **plan ① 任务 4（生命周期闭合）** 在真实证据产生前必须补上，否则删页/改名会留下脏数据。
- **plan ① 任务 12–13（A 组 + signals 退役）** 与本 plan 完全解耦，可任意时点推进。

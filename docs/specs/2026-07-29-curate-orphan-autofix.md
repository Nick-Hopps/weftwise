# Tidy 自主修掉孤页：候选源页检索、补句写入与按事实归因

日期：2026-07-29
状态：设计定稿（盘问结论已沉淀进「目的 / 约束 / 成功标准」三节）

---

## 一、问题现状

`2026-07-28-curate-orphan-loop` 只做到「系统说真话」：Tidy 会报告「检查了哪几页、为什么找不到锚点」，孤页带 `skipped` 徽章留在 Health 列表里，**仍需用户自己去源页写一句话带上链接**。

这违背 Health 的存在前提 —— 它是替用户解决问题的，不是给用户派活的。彻底修掉需要三处改动，其中第三处是上一轮遗漏的真实缺陷。

### 阻塞一：候选源页集合对孤页定义上无用

`curate-service.ts:201` 用 `expandScopeWithNeighbors(seed, links, …)` 算 allowedSet = seed + **一跳图邻居**。

而孤页的定义就是**没有入链**，所以它的「邻居」只剩它自己链出去的那几页 —— 一个与「谁应该链到它」几乎无关的集合。`mongol-empire` 的 allowedSet 因此只有 `{mongol-empire, global-history-from-states-to-modernity}`，后者恰好一次都没提「蒙古」。

「哪一页最该链到这个孤页」本质是**语义相似度**问题，不是图邻接问题。`curate-tools.ts:56` 早就接了 `hybridRankSlugs`（FTS + 向量 RRF），但检索结果会被 guard 的 allowedSet 过滤掉，等于白接。

### 阻塞二：唯一的补链工具要求锚点「已存在」

`wiki_link_ensure` 硬性要求源页正文里已有唯一自然锚点（`wiki-link-ensure.ts:29-31`，明确禁止新建 `Related` 段落、禁止猜测锚点）。这条护栏对「把已有的提及变成链接」是对的，但对「源页压根没提过目标」的情形，它把唯一出路也堵死了 —— 而这正是孤页的典型形态。

auto profile 也没有 `wiki.create`（`profiles.ts:104`），造 hub 页那条路同样封着。

### 阻塞三（上一轮遗漏的真实缺陷）：归因口径与孤页的修复方式互斥

`curate-service.ts:165`：

```ts
} else if (!touchedSlugs.has(finding.pageSlug)) {
  outcomes[finding.id] = 'skipped';
```

`finding.pageSlug` 是**孤页自己**（`mongol-empire`），而修孤页写的是**源页**（`global-history-…`）。孤页永远不会出现在 `touchedSlugs` 里，所以**补链成功也会被记成 `skipped`**。

叠加上一轮 `isUntouchedSkip` 的改动，后果是：Tidy 真把问题修好了，Health 却永远显示它没修 —— 复发闭环换了个形态继续存在。

---

## 二、目的

1. **Tidy 能自主修掉孤页** —— 不再把「去写一句话」这件事退回给用户。
2. **候选源页按语义选，不按图邻接选** —— 让早已接好的混合检索真正参与决策。
3. **归因按事实判，不按写了哪一页判** —— 孤页是否修好，只由「现在是否有非 meta 入链」决定。

---

## 三、约束（盘问结论）

### C1 写入机制：给 `curate:auto` 开 `wiki.patch` + `FIDELITY_PROFILES.fix` 护栏

**Nick 的决策**（在「新增确定性窄写工具 `wiki.crossref.add`」与「复用 `wiki.patch` + 忠实度护栏」之间选定后者）。

我提出的顾虑，如实记录在此：`FIDELITY_PROFILES.fix` 只检查「正文不缩水 80%、原有 wikilink 不丢、frontmatter 不变」，**挡不住**模型顺手改写别处、一次插入多段、或新建 `Related` 段落。而 Curate auto 是无人复核的后台任务。

Nick 已确认该取舍，按此实现。为把风险压到该方案能达到的下限，实现侧仍做两件不扩张范围的事：

- **护栏真的挂上**：`wiki.patch` 在 fix/query 两条既有路径上**都没有**忠实度护栏（`page-write.ts::patchPageInSubject` 与 `fix-tools.ts:101` 都是裸调 `executePagePatch`，理由是 old/new 精确唯一替换风险面小）。Curate auto 无人复核，因此这里补上 —— 读取当前正文 → `applyPatchEdits` 算出候选正文 → `checkRewriteFidelity(…, FIDELITY_PROFILES.fix)` → 过了才落 Saga。
- **prompt 明确纪律**：软约束补硬护栏够不到的部分（只插一句、只在与目标真实相关的位置、不建 `Related` 段落）。承认这是 prompt 纪律而非物理限制。

### C2 候选源页：orphan worklist 非空时用混合检索扩 allowedSet

对 worklist 里的每个孤页，用「标题 + summary」做 `hybridRankSlugs`，取前 `ORPHAN_SOURCE_CANDIDATES = 5` 个非 meta、非自身的页并入 allowedSet。

**理由**：这是阻塞一的直接解法，且复用既有检索栈零新增依赖。上界 5 而非全库 —— 写 scope 每扩一页就多一份护栏面，5 个候选足够在任何规模的 subject 里找到一个合理落点；检索为空（单页 subject）时不扩张，孤页如实报 `skipped`（一个只有一页的 subject 确实无法产生入链，这是诚实的终态而非失败）。

**scope 扩张只发生在带 orphan worklist 的 Curate**。manual Tidy 与 ingest 后的自动 Curate 的 allowedSet 逐元素不变 —— 零回归是硬要求。

### C3 归因：孤页按「当前是否有非 meta 入链」判定，与 touchedSlugs 解耦

新增单页判定，与 `lint-deterministic::checkOrphanPages` **共用同一口径**（跨主题入链算、meta 页出链不算），避免两份判定漂移（AGENTS.md 的既有要求，`isSourceStale` / `checkStaleSourcesForPage` 是同一范式）。

判定顺序保持保守：`allFailed` / 未归因 residual / 命中 residual → `failed`（不变）；否则**查该孤页现在有没有非 meta 入链** → 有则 `fixed`，无则 `skipped`。

**理由**：`touchedSlugs` 对「写 A 页修 B 页的问题」这类 finding 天生错位。orphan 是九类 finding 里唯一这样的，所以只改 orphan 的判据，其他类型继续走 touchedSlugs。而且这个判据比 touchedSlugs **更强** —— 它验的是问题本身没了，不是「有人动过那一页」。

### C4 不动 `wiki_link_ensure` 的锚点护栏

有自然锚点时仍走 `link.ensure`（更精确、改动面更小）；只有确认无锚点才允许 `wiki.patch` 补一句。prompt 里把这个优先级写清楚。

**理由**：`link.ensure` 的「锚点必须已存在」对它自己的用途是正确护栏，放松它会同时污染 Fix 的 broken-link/missing-crossref 路径 —— 那两条不需要这个能力。

### C5 不改 orphan 的判定口径

`index` 出链不计入入链保持不变（否则 index 会让全库零孤页，该规则直接失效）。补链必须落在真实内容页上。

---

## 四、成功标准

1. **纯函数层**：`pageHasInboundLinks`（或等价单页判定）有单测，与 `checkOrphanPages` 口径一致 —— meta 出链不算、跨主题入链算、`tags` 含 `meta` 的页不算入链源。
2. **scope 层**：带 orphan worklist 时 allowedSet 含检索候选；**不带 worklist 时 allowedSet 逐元素不变**（零回归硬要求）。
3. **护栏层**：`wiki.patch` 经 curate guard —— 越 allowedSet 拒绝、meta 页拒绝、超 update cap 拒绝、忠实度不过拒绝且不计数。
4. **归因层**：孤页在「源页被写、孤页未被 touch」时判 `fixed`（当前实现判 `skipped`，这是缺陷本身）；补链失败仍判 `skipped`；residual 命中仍判 `failed`。
5. **端到端**：`mongol-empire` 真实跑一次 Tidy，vault 里 `global-history-from-states-to-modernity.md` 出现一条指向它的 wikilink，Health 上该 orphan 变为 `fixed` 并从列表消失；随后手动 Run check **不再重新发现它**。这是本 spec 的唯一终局判据 —— 前四条全绿但这条不绿，等于没修。
6. **全量测试**：`npm test` 全绿。

---

## 五、不做（YAGNI）

- **不新增 `wiki.crossref.add` 窄写工具**（C1，Nick 决策）。
- **不给 auto 开 `wiki.create`** —— 造 hub 页在 2 页的 subject 里本身就会变成新孤页。
- **不放松 `wiki_link_ensure` 的锚点要求**（C4）。
- **不改 orphan 判定口径**（C5）。
- **不给 Fix 的 broken-link/missing-crossref 开 patch 补句** —— 那两类 finding 的源页必然已提到目标（否则不会被判为缺链），锚点本来就存在。

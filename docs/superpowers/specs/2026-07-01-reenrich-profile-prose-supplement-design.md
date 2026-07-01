# 设计：re-enrich 画像驱动的正文补全（reenrich-supplement）

> 日期：2026-07-01
> 状态：设计已定稿，待实现
> 范围：仅 re-enrich 路径（不动 ingest 流水线）

## 一、背景与问题

当前 `re-enrich`（`reenrich-service.ts`）复用 ingest 增益流水线的后半段，只跑两步：

```
现有正文(draft) → ingest-enricher（叠 callout，逐字复刻正文） → verify（联网/自检）
```

`ingest-enricher` 的第一硬规则是「逐字复刻 draftContent，只能在已有块之间插入 callout」，`verify` 只对**存疑断言**做外科式修正。因此现状下 **re-enrich 无法真正补全正文本身的解释缺口**——只能贴学习脚手架 callout。

期望能力：re-enrich 应能对正文做**片段级**修改——先读用户认知画像，判断某个概念/描述读者大概率不清楚，就在正确位置补充讲解。

## 二、核心架构决策

### 决策 1：补充内容的性质 —— canonical 层做「普遍有益的知识补全」，读时层做「读者专属讲法」（分层）

这是与已有 **Cognitive Lens** 的边界划分。Cognitive Lens 的立身之本是「canonical 零侵入——按读者画像的重塑只发生在读取时，是可丢弃的读侧缓存」。本特性让 re-enrich（一条经 Saga + git 写 canonical 的写路径）改正文，两者必须分层，不得职责重叠：

- **canonical（re-enrich supplement）**：填补对**任何读者都普遍有用**的解释缺口。画像在这里只是**探针**——用来定位「大多数读者会卡住的地方」，但写进去的补充内容本身是中性、普遍适用的 canonical 知识。
- **读时（Cognitive Lens）**：读者专属的讲法适配（换措辞、换难度）保持不变，仍是可丢弃的读侧缓存。

**这条边界是本设计的宪法**：supplement skill 绝不能写「只对当前读者才成立」的口吻内容——那是 Lens 的活。

### 决策 2：修改语义 —— 插入 + 局部改写（不重排/不删章节）

允许两类正文操作：

1. **插入**：在难点处插入新的解释片段（一句到一段）。
2. **局部改写**：对表达不清的单句/短语就地改写澄清。

**禁止**：重排章节、删章节、整段重写、改标题层级、改 frontmatter。

因允许局部改写，逐字保留的硬护栏不适用 → 走软性护栏组合（见决策 4）。

### 决策 3：生效范围 —— 仅 re-enrich

不碰 ingest 流水线（ingest 的 writer 已写完整讲解文、enricher 只叠 callout，保持现状）。爆炸半径最小。

### 决策 4：忠实度护栏 floor = 0.95（严），成熟度信号并入正文增长

- 护栏严格（补全应净增长）；
- 成熟度收敛信号从「仅 callout 增量」扩展为「callout 增量 + 正文增量」合并信号（否则「多补正文、少加 callout」的 re-enrich 会被误判无进展而过早毕业）。

## 三、架构与数据流

re-enrich 流水线从 2 步扩为 3 步，新增 `supplement` 作为**首阶段**：

```
现有正文(canonical) + 画像(UserProfileDTO)
        │
        ▼ ① supplement   [新 step kind]  画像探针 → 在正文缺口处 插入/局部改写
        ▼ ② enricher     [不变]          在补全后的正文上叠 callout（逐字复刻新基线）
        ▼ ③ verify       [不变]          联网/自检，顺带核查新补的正文断言
        ▼ commitPending（frontmatter / index / log 不变）
```

`reenrichSteps()`：

```ts
[
  { kind: 'supplement', skillId: 'reenrich-supplement', fromOutput: 'plan.pages',
    injectPriorPageAs: 'draftContent', checkpointAs: 'supplement-page' },
  { kind: 'fanout', skillId: 'ingest-enricher', fromOutput: 'plan.pages',
    injectPriorPageAs: 'draftContent', checkpointAs: 'enricher-page' },
  { kind: 'verify', fromOutput: 'plan.pages', injectPriorPageAs: 'content',
    checkpointAs: 'verifier-page' },
]
```

**复用红利**：新补的正文自然流经既有 verify 阶段做事实核查（verify v2 已能核查正文断言），不用另造核查逻辑。supplement 阶段输出成为 enricher 的 `draftContent`（orchestrator 的 `injectPriorPageAs` 已支持跨阶段链式注入），enricher 只是把「新基线」当 draft 逐字复刻并叠 callout，无需感知它被补过。

## 四、组件设计

### 4.1 orchestrator 改动（极小）

`orchestrator.ts` 中：

- `PipelineStep` union 增加一枝：
  `{ kind: 'supplement'; skillId: string; fromOutput: string; checkpointAs?: 'supplement-page'; injectPriorPageAs?: string }`
- `checkpointAs` union 增加 `'supplement-page'`。
- 现有 `step.kind === 'fanout' || step.kind === 'verify'` 分支扩为 `... || step.kind === 'supplement'`（三者共用 overlay 快照隔离 / `WriterConflictError` 检测 / `putEntries` 合并骨架）。
- skill 解析：`step.kind === 'fanout' || step.kind === 'supplement'` 时 `resolveSkill(step.skillId)`（verify 不需要）。
- 每项计算三分派：`verify → runPageVerification`、`supplement → runPageSupplement`、`fanout → runSkill`。
- checkpoint 读写辅助（`readStageCheckpoint`/`writeStageCheckpoint`）增加 `'supplement-page'` 枝；checkpoint repo 增加 `getSupplementPage`/`putSupplementPage`。

**enricher / verify / ingest / map 分支全不改。**

### 4.2 新增 `agents/runtime/supplement-page.ts`（镜像 `verify-page.ts`）

`runPageSupplement(ctx, item, opts)` 每页逻辑：

1. 组装输入：`draftContent`（现有正文=基线）、`title`/`summary`、`profileHint`（见 4.4）、`languageDirective`、`augmentationDirective`。
2. `generateStructuredOutput`/`generateObject`（skill=`reenrich-supplement`）→ 候选 `content`。
3. 过忠实度护栏（决策 4，全确定性）。
4. 护栏失败 → **重写一次**（把违规项作为反馈拼回 prompt）→ 二次仍失败 → **回落原文 passthrough**（emit `reenrich:supplement-fallback` warn，不阻断后续 enricher/verify）。
5. 返回 `{ output: { action:'update', path, content } }`，交由共用骨架 `putEntries` 合并进 `ctx.pending`。

### 4.3 新增 skill `agents/skills/reenrich-supplement.md`（结构化输出，无 tools，v1）

- **outputSchema**：`{ action: 'create'|'update', path, content }`。
- **输入**：`draftContent`（基线正文）、`title`、`summary`、`profileHint`、`languageDirective`、`augmentationDirective`。
- **Rules（钉死决策 1 / 决策 2 边界）**：
  1. 只做两类动作——难点处**插入**新解释片段；对不清的**单句/短语局部改写**。禁止重排/删章节/整段重写/改标题层级。
  2. 补充内容必须是**对任何读者都普遍有用的中性讲解**。画像只是探针（告知「读者大概率不懂 X」），写出来的补充是写给所有人的 canonical 知识——不写只对该读者才成立的口吻（读者专属讲法归 Lens）。
  3. **不改 frontmatter**、不删现有事实、保留所有现有 `[[wikilink]]`、不臆造新 wikilink 目标。
  4. 遵 `languageDirective`（不翻译 slug/frontmatter key/wikilink target/代码）；遵 `augmentationDirective` 密度（light 少补 / standard / deep 多补）。
  5. 无 callout（callout 是下游 enricher 的活）。

### 4.4 画像注入（`reenrich-service.ts`）

- worker 侧经 `profiles-repo` 读 `resolveUserId()`（单租户占位）的 `UserProfileDTO`。
- **有画像** → 拼 `profileHint`：`backgroundSummary` + `stylePrefs`（`readingLevel`/`verbosity`/`exampleDensity`）作为探针提示注入 prompt（形如「读者背景：…；阅读水平：…。据此判断哪些概念读者大概率需要铺垫，但补充写成中性讲解」）。
- **无画像**（未 onboard）→ `profileHint` 回落「中性中级读者」假设，仍补明显的普遍缺口。re-enrich 不因缺画像而失能。

### 4.5 忠实度护栏（4 项，全确定性）

| 护栏 | 判定 | 来源 |
|------|------|------|
| 不缩水 | `!bodyShrankTooMuch(orig, cand, floor=0.95)` | 复用 `fix-deterministic.ts` |
| 不臆造链接 | `checkLinkSubset(orig, cand).ok`（新 wikilink 目标须是原文目标子集） | 复用 `profile/fidelity.ts` |
| 结构不减 | 原文所有标题行（`#`~`######`）在补全后全部仍在 | 新纯函数（supplement-page 或 fidelity 内） |
| frontmatter 不变 | parse 两侧比对 frontmatter 相等 | 复用 `wiki/markdown` parse |

护栏是「插入+局部改写」在缺硬逐字护栏时的软替代——比 re-enrich 现状（无任何正文护栏）严格得多。

### 4.6 成熟度信号联动（`reenrich-service.ts` + `maintenance-policy.ts`）

`deriveMaturityUpdate` 的 `newIncrement` 改为合并信号：

```
newIncrement = max(0, calloutΔ) + calloutEquivalentOf(正文字符净增)
```

其中「正文净增折算为等效 callout 数」的换算函数与阈值放 `maintenance-policy.ts`（纯函数，便于单测）。`countCallouts` 与 `nextMaturity` 逻辑不变。

## 五、降级矩阵

| 情形 | 行为 |
|------|------|
| `reenrich-supplement` skill 未播种/版本不足 | fail-fast（`MIN_SKILL_VERSIONS` 加 `reenrich-supplement:1`，提示删 `data/vault/.llm-wiki/skills/reenrich-supplement.md` 重播种） |
| 护栏两次失败 | 该页 passthrough 原文 → 继续 enricher/verify（re-enrich 退化回「只叠 callout」，与现状等价） |
| 无画像 | 中性中级读者假设，照常补 |
| `augmentationLevel=off` | re-enrich 本就强制 `standard`，supplement 照 standard 密度跑 |
| 断点续传命中 supplement-page 检查点 | 跳过 LLM，直接用缓存正文进 enricher |

## 六、已知限制

- **单租户画像**：用的是 `resolveUserId()` 单租户占位画像。未来多租户需把 `userId` 串进 re-enrich job params（本次不做）。
- **软护栏非逐字**：允许局部改写 → 无法逐字保证原文不被改动，只能保证「不大幅缩水 + 结构不减 + 不臆造链接 + frontmatter 不变」。事实层由下游 verify 兜底。
- **⑥ 回滚不撤源**：沿用既有语义，不在本设计范围。

## 七、测试策略

- **护栏纯函数**：不缩水（0.95 边界正反例）/ 链接子集（臆造链接被拒）/ 结构不减（删标题被拒）/ frontmatter 不变（改 frontmatter 被拒）各正反例。
- **`runPageSupplement`**：guard-pass 直落 / guard-fail→retry→pass / guard-fail→retry-fail→passthrough 三路径（mock LLM）。
- **成熟度合并信号**：纯正文增长（无 callout）也能推进成熟度、不被判无进展。
- **skill load 测试**：仿 `ingest-enricher.load.test.ts`，验证 `reenrich-supplement.md` 可加载且 version≥1、schema 合法。
- **orchestrator**：supplement step 分派、checkpoint 续传命中跳过 LLM。

## 八、改动清单

| 文件 | 改动 |
|------|------|
| `src/server/agents/runtime/orchestrator.ts` | +`supplement` step kind 分派 + `supplement-page` checkpoint 枝 |
| `src/server/agents/runtime/supplement-page.ts` | 🆕 `runPageSupplement`（skill 调用 + 护栏 + retry + passthrough） |
| `src/server/agents/runtime/checkpoint.ts` | +`getSupplementPage`/`putSupplementPage` |
| `src/server/agents/skills/reenrich-supplement.md` | 🆕 supplement skill（v1） |
| `src/server/services/reenrich-service.ts` | reenrichSteps 加 supplement 步；读画像拼 profileHint；成熟度合并信号；`MIN_SKILL_VERSIONS` 加 `reenrich-supplement:1` |
| `src/server/services/maintenance-policy.ts` | 正文增量折算为等效 callout 的纯函数 + 阈值 |
| `src/server/profile/fidelity.ts`（或 supplement-page 内） | 结构不减护栏纯函数 |
| 各 `__tests__/` | 护栏 / runPageSupplement / 成熟度 / skill load / orchestrator 测试 |

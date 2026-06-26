# Ingest 讲解深度增强（P1：讲解者重写）— 设计 Spec

> 日期：2026-06-26
> 状态：设计已确认，待写实现计划
> 关联愿景：项目目标含"整理、总结、归纳、**补充、泛化**"，但现有 ingest 流水线在架构上偏向"忠实于来源"，导致页面"讲不透彻"。本 spec 是分期改造的 **P1**。

---

## 一、问题与诊断

用户反馈：大模型输出内容太少，不足以把一个知识讲透彻。

诊断结论——**深度天花板是设计使然，不是 token 限制**。三道闸门把页面压薄：

| 闸门 | 位置 | 作用 |
|------|------|------|
| 忠实约束 | `examples/skills/ingest-writer.md` Rule 4/8 | "Do not invent facts not present in the chunks" + "plain encyclopedic prose only" → writer 只能复述 chunk 内已有内容；源材料简略则页面简略 |
| 增益只许加 callout | `examples/skills/ingest-enricher.md` | 增益层 "EVERYTHING you author MUST live inside a callout"，不得扩写正文；level 只调 callout 密度 |
| verifier 反向裁剪 | `src/server/agents/runtime/verify-page.ts` | 联网核查把低置信 callout 删掉/改保守，进一步缩水 AI 补充 |

`DEFAULT_MAX_TOKENS = 8192`（`src/server/llm/task-router.ts`）很宽裕，chunk 切分也不是主因。**真正的深度天花板 = 源材料本身 + 一薄层被核查过的 callout。**

要"讲透彻"，必须让 AI 在某种程度上越过"只忠实于来源"这条线（这正是愿景里的"补充/泛化"）。问题只是越多少、怎么越得让"书里的"和"AI 加的"仍可信。

---

## 二、已确认的两个方向性决策

1. **深度来源 = 两者都要**：既放宽忠实约束让 AI 用自有知识讲解，又（后续）联网把来源喂厚。分期上。
2. **分层方式 = 正文可融合·靠核查保质**：允许 AI 把讲解织进正文，写成一篇真正连贯的百科/教科书式文章；牺牲逐句可追源，信任靠 **verifier 核查 + 章节级来源标注**。

> 这两个决策推翻了现有"忠实 prose vs AI callout 视觉可分"的信任模型，是本次改造的根本前提。

---

## 三、分期排期（本 spec 只覆盖 P1）

| 期 | 内容 | 状态 |
|----|------|------|
| **P1** | 方案 A：讲解者重写 + maxTokens↑ + verifier 范围扩到正文 | **本 spec** |
| P2 | 方案 C：完整性批判（completeness critic）深化循环 | 后续 spec |
| P3 | 联网富化前置：writer 前插 Tavily 阶段把来源喂厚（复用 ⑨ web-search） | 后续 spec |
| 备选 | 方案 B：大纲→分节 fanout→拼装，仅当 P1+P2 后仍偏薄时再上 | 不主动做 |

P1 先做的理由：改动最小、最快见效、复用全部现有流水线，且能让用户**亲眼判断"融合正文"的质量是否可接受**，再决定是否投入更重的机器。

---

## 四、P1 范围

**只改生成契约 + token 预算 + 核查范围，不动流水线拓扑、不加新阶段、不引外部依赖。**

现有六阶段保持不变：

```
planner → (chunk-summarizer) → writer → enricher → verifier(triage→apply) → indexer
```

逐页 checkpoint 续传、Saga 单 commit、subject 贯通——全部不变。

---

## 五、三个 skill 的契约改动

种子文件在 `examples/skills/*.md`（运行期播种到 `data/vault/.llm-wiki/skills/`）。

### 5.1 `ingest-writer.md`（v5 → v6）：复述者 → 讲解者

**删除/反转**：
- Rule 4「Do not invent facts not present in the chunks」
- Rule 8「Write plain encyclopedic prose only … Do NOT add … intuition asides, worked examples」

**新 Role / Rules（要点）**：
- 你是一位**讲解者**。用 `relevantChunks` 作为**事实骨架**，并**调用你自己的知识**，写一篇自洽、由浅入深、能让读者**内化**该主题的文章。
- 鼓励覆盖的讲解维度（按主题取用，不是逐项填表）：**定义 → 动机/为什么这样 → 前置/背景 → 机制/原理 → 类比与直觉 → 由浅入深的例子 → 与相邻概念的对比 → 常见误区 → 应用/意义**。这些**全部织进正文 prose**。
- AI 补充的内容必须**正确、扣题**；不确定的不要硬写（verifier 会核查正文断言）。
- 仍然**严禁翻译** slug、`[[wikilink]]` 目标、frontmatter key、code block。
- 仍然**遵守 `languageDirective`**。
- **保留增量合并（update）规则**：命中 `existingPageContent` 时并入而非重写，保留既有事实/章节/wikilinks。
- 输出 schema 不变：`{ action, path, content }`。

**新增输入字段**：`expositionDirective`（见 §7 深度旋钮），指示讲解深度。

### 5.2 `ingest-enricher.md`（v2 → v3）：收窄为"学习脚手架"

intuition / example 已下沉进正文，enricher 不再与正文重复，**只保留真正适合独立区块的学习动作**：

- 保留的 callout 类型：`[!quiz]` 自测、`[!pitfall]` 常见误区、`[!diagram]` mermaid 图示、`[!background]` 前置/关联 `[[wikilink]]`。
- **移除** `[!intuition]`、`[!example]` 两类（它们现在属于 writer 正文）。
- "两层规则"放宽：不再要求"正文逐字复刻 + 只在块间插 callout"——因为正文本身已含 AI 推演。改为：**不得改动 writer 正文的事实与结构，只在合适位置追加上述四类 callout**。
- 仍遵守 `augmentationDirective`（密度旋钮）与 `languageDirective`。
- 输出 schema 不变。

> 注：若实现时发现 writer + enricher 两趟对薄文档冗余，可在 plan 阶段评估是否合并为一趟；P1 默认**保留两阶段**以最小化拓扑改动。

### 5.3 verifier（`ingest-verifier-triage.md` / `ingest-verifier-apply.md` / `verify-page.ts`）：范围扩到正文

**triage**：
- 输入从"只看 callout"扩到**整页（正文 prose + callout）**。
- 任务：挑出**最值得核查的 top-N 事实断言**（含正文里 AI 推演出的断言），给出核查 query。
- **top-N 封顶**（建议默认 N=3，与现有 query 上限对齐）以控制联网成本与时延。

**apply**：
- 在证据**冲突**时**保守改写对应断言**（无论它在正文还是 callout）；其余部分**忠实逐字复刻**。
- 不新增 callout（沿用现策略）。

**降级矩阵**保持现状：未配置联网 / triage 空 / 零证据 → 回落既有自检或 passthrough。

> `verify-page.ts` 的编排（triage → 编排层 Tavily 搜索 → apply）结构不变，只是 triage 的输入载荷与 prompt 覆盖范围从 callout 扩到整页。

---

## 六、Token 预算

### 6.1 阶段 maxTokens（无需改代码）

`ingest:writer` / `ingest:enricher` 的 `maxTokens` 经 `llm-config.json::tasks` 按阶段路由即可调，**不动代码**：

- 在 `llm-config.example.json` 把 `ingest:writer`（以及视情况 `ingest:enricher`）的 `maxTokens` 从默认 8192 提到 **16384**。
- 同步更新 `src/server/llm/CLAUDE.md` 与根 `CLAUDE.md` 的示例说明。

### 6.2 Job 级预算（需关注，可能改默认值）

单页变长 → 整 job 输出 token 增加。需保证：
- `getAgentMaxTokensPerJob()`（job 级预算上限）留足头寸；
- `src/server/services/ingest-prep.ts` 的预检（按 chunk 估算成本）不会因放大后的输出而误放行后运行期爆 `maxTokensPerJob`。

**动作**：评估并按需上调 agent job 预算默认值（现值见 `src/server/agents/` 设置）；在实现计划里量化"放大系数"（如假设每页输出 ×1.8）并据此调整 `ingest-prep` 的估算与预算闸门。

---

## 七、深度旋钮：复用 `subjects.augmentation_level`，重定义语义

per-subject 旋钮现在**同时驱动 writer 讲解深度与 enricher callout 密度**：

| level | 新语义 |
|-------|--------|
| `off` | **退回旧忠实模式**：writer 只渲染来源（旧 v5 行为）、跳过 enricher。保留"我就要原味"的逃生口。 |
| `light` | 适度讲解，关键处加直觉/一例；callout 稀疏。 |
| `standard` | 完整讲解文章 + 均衡 callout（默认）。 |
| `deep` | 充分铺陈、多例多对比 + 慷慨脚手架。 |

实现：
- 新增 `renderExpositionDirective(level)`（`src/server/llm/prompts/prompt-context.ts`），对称于现有 `renderAugmentationDirective`，注入 writer user prompt 作为 `expositionDirective`。
- `off` 走双叉：service 层（`ingest-service.ts` / `reenrich-service.ts`）在 `off` 时**注入"仅忠实渲染"的 writer 指令并跳过 enricher**（enricher 跳过逻辑现已存在）。
- carry 字段：`ingest-service.ts::carryKeys` 增加 `expositionDirective`，orchestrator 注入 writer step。

---

## 八、兼容性与回滚

- skill 改的是 `examples/skills/*.md` 种子；**rollout 需手动删** `data/vault/.llm-wiki/skills/ingest-{writer,enricher,verifier-triage,verifier-apply}.md` 后重播种（沿用 ⑤ 既有约定）。在 changelog/文档注明。
- `off` 模式 = 旧 v5 行为，**零回归风险**（提供回退路径）。
- 整次 ingest 仍是一个 git commit，可经 ⑥ 历史回滚。
- 版本号递增（writer v6 / enricher v3）便于排查"播种了哪版"。

---

## 九、验收标准

1. **深度对比**：取一份已知偏薄的输入，`augmentationLevel=standard` 下对比改造前后同一页：
   - 正文显著变长，且**出现 定义/动机/类比/例子/对比/误区 等多个讲解维度**（人工核验）；
   - `[[wikilink]]`、slug、frontmatter key、code 仍未被翻译/破坏；
   - update 路径下既有事实/章节未被丢弃。
2. **核查不破坏正文**：抽查 verifier 改写后的 N 个正文事实断言，确认有据、未引入错误。
3. **off 回归**：`augmentationLevel=off` 输出与旧 v5 逐字/结构一致（保护逃生口）。
4. **预算不爆**：书本级文档在放大输出后仍通过 `ingest-prep` 预检且运行期不撞 `maxTokensPerJob`。
5. **单测**：`prompt-context` 新增 `renderExpositionDirective` 用例；`ingest-service` carry/`off` 分叉用例；skill 契约变更不破坏现有 ingest 流水线测试。

---

## 十、明确不做（YAGNI）

- 方案 B（大纲→分节 fanout→拼装）。
- 方案 C（完整性批判深化循环）——P2。
- 联网富化前置——P3。
- 双视图 / 阅读页"原味↔增强"切换。
- 逐句来源追溯（已主动放弃，换 verifier + 章节级标注）。

---

## 十一、受影响文件清单（实现计划细化）

| 文件 | 改动 |
|------|------|
| `examples/skills/ingest-writer.md` | v5→v6：讲解者契约 + `expositionDirective` 输入 |
| `examples/skills/ingest-enricher.md` | v2→v3：收窄为 quiz/pitfall/diagram/background 四类脚手架 |
| `examples/skills/ingest-verifier-triage.md` | 输入扩到整页，挑 top-N 正文+callout 断言 |
| `examples/skills/ingest-verifier-apply.md` | 保守改写正文或 callout 断言 |
| `src/server/llm/prompts/prompt-context.ts` | 新增 `renderExpositionDirective(level)` |
| `src/server/llm/prompts/ingest-prompt.ts`（或 writer user prompt 构造处） | 注入 `expositionDirective` |
| `src/server/services/ingest-service.ts` | carryKeys + `expositionDirective` 计算 + `off` 仅忠实分叉 |
| `src/server/services/reenrich-service.ts` | 对齐 `expositionDirective` 注入 |
| `src/server/agents/runtime/orchestrator.ts` | 把 `expositionDirective` 注入 writer step（对齐现有 `augmentationDirective`）|
| `src/server/agents/runtime/verify-page.ts` | triage 载荷/范围扩到整页（编排结构不变）|
| `src/server/services/ingest-prep.ts` + agent job 预算默认值 | 放大系数下的预检与预算调整 |
| `llm-config.example.json` | `ingest:writer`/`ingest:enricher` maxTokens 16384 示例 |
| 根 `CLAUDE.md` / `src/server/llm/CLAUDE.md` | changelog + 示例 + rollout 重播种说明 |

> 实现时以代码为准复核每个 user prompt 的实际构造位置（`ingest-prompt.ts` 与 agent skill 注入两条路径），spec 列出的路径供定位。

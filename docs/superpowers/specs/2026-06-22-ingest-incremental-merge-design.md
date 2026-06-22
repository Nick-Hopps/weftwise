# Ingest 增量合并进已有页（Incremental Merge）设计

> 日期：2026-06-22
> 状态：已确认，待写实现计划
> 关联：特性序列第 ⑤ 项「增量合并进已有页面」

---

## 一、背景与动机

摄入关于**已有主题**的新材料时，期望 merge 进现有页而非另开近似重复页。现状勘察结论：

- planner 已注入全量 `existingPages`（`{slug, title, summary}`，无正文）并被指示「prefer updating」；但 planner 输出 schema **无 `action` 字段**，update 与否由 writer 靠「slug 是否在 existingPages 中」隐式判断（writer Rule 2）。
- **即使判成 `update`，writer 也不读现有正文**，而是基于新材料 `relevantChunks` 整页重写**覆盖**（已有知识丢失）。`buildFanoutInput`（orchestrator.ts:211）给 writer 喂 `existingPages`（仅 slug/title/summary）+ 本页 plan 条目 + `relevantChunks`，**不含现有页正文**。
- 落地层 `applyChangeset` 对 create/update 等价（均 `writeFileSync` 覆盖），无冲突保护。

净结果：摄入关于已有页 X 的新材料 → 取决于 LLM 是否恰好复用 X 的 slug：复用了就覆盖 X（丢旧内容）、没复用就新建近似重复页。**真正的「增量合并」今天不成立。**

skill 源在 `examples/skills/*.md`（git 跟踪），运行时读 `data/vault/.llm-wiki/skills/*.md`（gitignore，`seedSkillFiles` 启动播种、**不覆盖已有**）。

---

## 二、范围（v1）

> **改造 ingest 多 agent 流水线：writer 在更新已有页时，由 orchestrator 确定性注入该页现有正文，writer 把新材料并入现有正文（保留已有知识、不覆盖）；planner 强化「已有主题复用其 slug」以稳定落到 update。**

### 已定决策

1. **形态 = 改造 ingest 自动合并**（非独立「加入此页」定向流；后者不做）。
2. **注入机制 = orchestrator 确定性注入**：writer 阶段若本页 slug 命中 `existingPages` → orchestrator 读现有正文注入 `existingPageContent`（不依赖 LLM 记得调 `vault.read`，避免漏读直接覆盖）。
3. **rollout = 文档手动重播种（b1）**：改 `examples/skills/` 后，已有 vault 的旧 skill 副本不会被 seed 覆盖；升级需手动删除 `data/vault/.llm-wiki/skills/ingest-{writer,planner}.md` 让 worker 重新播种。不改 `seedSkillFiles`（保留用户自定义安全）。
4. **匹配靠 LLM**：planner 复用已有页 slug（强化指令）；语义/模糊匹配（embedding）= ⑧，本期不做；残留近似重复可接受。
5. **合并策略 = 保全式整合**：update 时保留现有事实/章节、整合并去重新材料、保留现有 `[[wikilink]]`，不丢弃、不从零重写。

### 明确不做（YAGNI）

- 独立「加入此页」定向 UI/接口（B 方案）。
- 语义/embedding 匹配（⑧）。
- `seedSkillFiles` 版本感知自动覆盖（b2）。
- planner 输出 schema 加 `action` 字段——**不需要**：update 检测由 orchestrator 按 `existingPages` 成员判定（确定性），不依赖 planner 显式 action。
- `validateChangeset` 的 create-已存在-slug 冲突防护（本期不加）。

---

## 三、架构与数据流

```
ingest-service.ts: runPipeline steps（改动：writer fanout step 加 injectExistingPageForUpdate: true）
        │
  orchestrator.ts: fanout 'ingest-writer' × N pages
        │  每页 input = buildFanoutInput(carry, item, ctx, step)   ← 改为 async
        │     base = { subjectSlug, existingPages, plan, languageDirective, ...item, relevantChunks }
        │     若 step.injectExistingPageForUpdate 且 item.slug ∈ carry.existingPages（按 slug 判定 = 更新）:
        │        page = await ctx.overlay.readPage(subjectSlug, item.slug)   // 现有正文（writer 阶段尚无 content overlay diff → 即真实 vault 当前内容）
        │        if (page?.markdown) base.existingPageContent = page.markdown
        │  → runAgentLoop({ skill: ingest-writer, input: await buildFanoutInput(...) })
        │
  ingest-writer skill（改动）:
        action=update（slug 已存在）且收到 existingPageContent 时 →
          把 relevantChunks 的新材料【并入】existingPageContent（保留现有、整合去重），而非整页重写
        action=create 时 → 行为不变（基于 relevantChunks 新建）
        │
  （enricher / verifier / finalize 不变；commitPending 对 update 已保留 created 时间戳）
```

关键点：

- **update 判定 = 确定性**（`existingPages` 成员），不靠 LLM 的 action 字段；planner 的职责仅是「为已有主题复用正确 slug」。
- writer 阶段是首个内容阶段，overlay 尚无内容 diff，`overlay.readPage` 返回真实 vault 当前页内容——正是要并入的现有正文。
- `existingPageContent` 仅对 update 注入；create 页不注入，writer 行为不变。
- 其余流水线（enricher 叠加 callout、verifier 自检、indexer、commitPending 保留 created）均不变。

---

## 四、改动契约

### orchestrator.ts

```ts
// PipelineStep fanout 变体新增可选字段：
| { kind: 'fanout'; skillId: string; fromOutput: string;
    checkpointAs?: 'writer-page' | 'enricher-page' | 'verifier-page';
    injectPriorPageAs?: string;
    injectExistingPageForUpdate?: boolean }   // ← 新增

// buildFanoutInput 改为 async，新增注入分支；唯一调用点（fanout 循环内）改为 await。
async function buildFanoutInput(
  carry: unknown, item: unknown, ctx: AgentContext,
  step: { injectPriorPageAs?: string; injectExistingPageForUpdate?: boolean },
): Promise<unknown>
```

注入逻辑（在现有 `injectPriorPageAs` 分支之后）：

```ts
if (step.injectExistingPageForUpdate && typeof item.slug === 'string') {
  const existing = Array.isArray(carry.existingPages) ? carry.existingPages : [];
  const isUpdate = existing.some(
    (p) => isPlainObject(p) && (p as { slug?: unknown }).slug === item.slug,
  );
  if (isUpdate) {
    const page = await ctx.overlay.readPage(String(carry.subjectSlug), item.slug);
    if (page?.markdown) base.existingPageContent = page.markdown;
  }
}
```

### ingest-service.ts

writer fanout step 加 `injectExistingPageForUpdate: true`（其余 step 不动）。

### examples/skills/ingest-writer.md（version 4 → 5）

- Inputs 增：`existingPageContent` —— 仅当本页是**更新已有页**时出现；该页当前完整 markdown（frontmatter + body）。
- 新增 Rule（合并）：当 `existingPageContent` 存在时，把 `relevantChunks` 的新材料**并入**现有正文——保留现有事实与章节、整合并去重新信息、保留现有 `[[wikilinks]]`，**不丢弃现有内容、不从零重写**。`content` 输出为并入后的完整文件。

### examples/skills/ingest-planner.md

- 强化指令：若新材料的主题在 `existingPages` 中已有页（按 title/summary 判断），**必须复用该页的精确 slug**（落到 update 而非新建近似重复页）；确为新主题才用新 slug。

---

## 五、新增 / 改动文件

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/server/agents/runtime/orchestrator.ts` | 改动 | `PipelineStep` fanout 加 `injectExistingPageForUpdate?`；`buildFanoutInput` 改 async + 注入现有正文；调用点 await — **TDD 目标** |
| `src/server/agents/runtime/__tests__/orchestrator.test.ts` | 改动 | 加注入逻辑用例（命中 existingPages 注入 / 未命中不注入 / 无 flag 不注入） |
| `src/server/services/ingest-service.ts` | 改动 | writer fanout step 加 `injectExistingPageForUpdate: true` |
| `examples/skills/ingest-writer.md` | 改动 | Inputs + 合并 Rule + version 5 |
| `examples/skills/ingest-planner.md` | 改动 | 强化「已有主题复用 slug」指令 |

> 不改 DB schema、不改 Saga、不改 `seedSkillFiles`、不改 enricher/verifier/indexer/commitPending。

---

## 六、测试（node-only，无 RTL）

1. **orchestrator `buildFanoutInput` 注入逻辑**（扩 `orchestrator.test.ts`，走 `runPipeline` fanout + fake writer skill 捕获输入，模式同既有「writer 共享前缀」用例）：
   - writer step 带 `injectExistingPageForUpdate:true` 且 `item.slug ∈ existingPages` 且 `ctx.overlay.readPage` 返回 `{markdown:'EXISTING'}` → writer 收到的输入含 `existingPageContent === 'EXISTING'`；
   - slug ∉ existingPages → 不注入 `existingPageContent`，且不调 `readPage`（或调用结果不写入）；
   - step 无 `injectExistingPageForUpdate` → 行为同今天，不注入；
   - `overlay.readPage` 返回 null（页不存在）→ 不写 `existingPageContent`（防御）。
2. skill prompt（writer 合并 / planner 复用 slug）：LLM 行为，**不做单测**；tsc + dev 眼测。

---

## 七、边界与已知取舍

- **rollout**：改 `examples/skills/` 后，已有 vault 不自动更新。dev/部署需删 `data/vault/.llm-wiki/skills/ingest-{writer,planner}.md`（或全删该目录）再重启 worker 重新播种。**这是 dev 眼测的前置步骤**。
- **匹配**：planner 复用 slug 靠 LLM 判断；若漏判（新 slug）仍会建近似重复页——语义匹配 = ⑧，本期接受残留。
- **合并质量**：writer 把新材料并入现有正文是 LLM 行为，质量靠 prompt + dev 验收；不做强校验。
- **created 时间戳**：update 页的 `created` 由 `commitPending::stampSystemFrontmatter`（existingCreated）保留——现有行为，不变。
- writer 阶段 overlay 无内容 diff，`readPage` 即真实 vault 当前内容；若同一 ingest 计划里两个 plan 条目指向同一已有 slug（异常），后者仍读真实旧内容——属 planner 计划异常，不在本期处理。

---

## 八、不变量与依赖

- 不改 DB schema / Saga / `seedSkillFiles` / enricher / verifier / indexer / commitPending。
- 复用 `ctx.overlay.readPage`（overlay 读隔离）、现有 `buildFanoutInput` 结构与 `existingPages` carry；不复刻。
- writer 仍为结构化输出无写盘工具，只暂存 `ctx.pending`；commit 仍由 service 层 `finalizeIngest → commitPending` 收口（Saga 契约不变）。
- skill 改动只动 `examples/skills/`（git 源）；`data/vault/.llm-wiki/skills/` 为 gitignore 的运行时副本，不提交。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，非门禁。
- commit message 中文一句话；禁止任何 AI 署名 trailer / 脚注。

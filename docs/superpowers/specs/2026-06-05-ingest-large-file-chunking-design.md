# Ingest 大文件分片读取设计

> 日期：2026-06-05
> 状态：已确认，待写实现计划
> 范围：仅 `ingest` 任务流水线（不动 query / lint）

---

## 一、背景与问题

当前 `ingest` 对大文件是**截断**而非分片。`ingest-service.ts::loadSingleSource` 在解析后执行：

```ts
const SOURCE_TEXT_LIMIT = 30_000;
fullText: parsed.cleanText.slice(0, SOURCE_TEXT_LIMIT),   // 超出部分静默丢弃
```

由此暴露两个独立问题：

- **(A) 完整性**：超过 30k 字符的内容被静默丢弃，长 PDF / 文档后半部分根本不进入知识库，且无任何告警。
- **(B) token 成本**：即便在 30k 以内，`orchestrator.ts::buildFanoutInput` 把完整 `sources` 原样复制给**每一个** writer，全文被重复内联发送 N+1 次，成本随页面数线性膨胀。

本设计目标（四项全要）：完整性（别再丢内容）、支持超大文件（书本级）、降低 token 成本、提升规划质量（避免长文截断导致的片面规划）。

文件量级预期为**混合**：既有中等（几万~十几万字），也偶有超大（整本书）。因此架构必须**优雅降级**——小文件走简单路径，大文件自动触发 map-reduce。

---

## 二、现状数据流（事实基础）

1. `loadSingleSource` 解析文件 → `cleanText.slice(0, 30_000)` → 单个 `{ filename, contentSummary:'', fullText }`。
2. pipeline 初始输入 `{ sources:[source], subjectSlug, existingPages:[] }`。
3. **planner** 收到 `sources`（全文内联）→ 产出 `plan.pages[]`。
4. **fanout**（`orchestrator.ts`）按 `plan.pages` 并发跑 writer；`buildFanoutInput` 把完整 `sources` 复制给每个 writer。
5. **reviewer** 汇总 `writerOutputs` → 调 `commit_changeset` 写入（Saga）。

约束：写入边界仅 reviewer 可 `commit_changeset`；`agentMaxParallelSubAgents` 控制 fanout 并发；`BudgetTracker` 统一预算（超限抛不可重试的 `BudgetExceededError`）；overlay-vault 做读写隔离。

---

## 三、方案选型

**采用方案：自适应流水线 + 确定性块路由。**

- 切块（split）与读取（read）彻底分离：切块为解析期确定性纯函数（零 token），读取改为 orchestrator 按 planner 标注确定性注入。
- 块路由采用 **planner 标注 chunkIds + orchestrator 注入**（而非 writer 自行调工具按需拉取）：步数少、可预测、成本可控。
- **因此 v1 不新增任何 agent 工具**（无需 `source.read` / `source.outline`）——纯数据流改造。

被否决的备选：

- *统一 map-reduce*（不分支）：小文件也白跑摘要，浪费 token/延迟，违背「小文件简单路径」。
- *仅放大窗口 + 结构化切块*（无 map-reduce）：planner 仍无法纵览整本书，达不到「超大文件」目标，只是把 30k 挪到更高硬上限。

---

## 四、详细设计

### A. 解析期确定性切块

新增 `src/server/sources/source-chunker.ts`（纯函数）：

```ts
interface SourceChunk {
  id: string;          // 'c0' / 'c1' ...，源内顺序稳定
  heading: string;     // 所属最近标题（无则 ''）
  charStart: number;
  charEnd: number;
  text: string;
}

function chunkText(cleanText: string, opts?: {
  target?: number;   // 默认 CHUNK_TARGET = 6000
  overlap?: number;  // 默认 CHUNK_OVERLAP = 400
}): SourceChunk[];
```

切分规则：

1. **结构优先**：先按 Markdown 标题（`#`/`##`/…）切段。
2. **尺寸约束**：对超过 `CHUNK_TARGET` 的段按字符数硬切；相邻块带 `CHUNK_OVERLAP` 重叠，避免跨块语义断裂。
3. **Unicode 安全**：硬切点不得切坏多字节字符 / 代理对。
4. **移除 `SOURCE_TEXT_LIMIT = 30_000` 截断**（本次核心目的）。

持久化：chunk 数组写入既有的 `vault/.llm-wiki/sources/<id>.json`（权威源，SQLite 仍是缓存）。chunk 由 cleanText 确定性派生；源内容变化即新 sourceId（现有 hash 去重保证），故 chunkId 在同一源版本内天然稳定。

### B. 自适应流水线

**核心约束：源全文绝不进入 `carry`。** orchestrator 的 sequence 步会把整个 `carry` 序列化进下游 agent 的 prompt；若全文进 carry，大文件下 planner 仍会收到全文，token 目标落空。因此全文只存放在 `ctx.chunkStore`（见 C 段），`carry` 里只流转轻量 `chunkRefs`（带 `content` 字段：小路径=全文、大路径=摘要）。

`ingest-service.ts` 在装配 `steps` 前计算 `totalChars = Σ chunk.text.length`，**仅一个分支**：

```
totalChars ≤ PLAN_INLINE_THRESHOLD (默认 100_000 字符)
  小/中路径：无 map 步；ingest-service 直接把 chunkRefs[].content = text
            （全文仅此一次进入 planner 输入，可接受）

totalChars > PLAN_INLINE_THRESHOLD
  大/超大路径：插入 map 步 —— fanout 逐块跑 ingest-chunk-summarizer
            （文本从 ctx.chunkStore 注入给每个 summarizer）
            → 把 chunkRefs[].content = summary（全文不进 carry）

两条路径之后统一（planner 只见 chunkRefs[].content）：
  sequence: ingest-planner   → plan.pages[]，每页带 sourceRefs:[{sourceId,chunkIds}]
  fanout:   ingest-writer × N → orchestrator 按 sourceRefs.chunkIds 从 ctx.chunkStore
                                注入 relevantChunks（仅相关块全文）
  sequence: ingest-reviewer  → commit_changeset（Saga，不变）
```

要点：

1. **planner 输入形状统一**为 `chunkRefs:[{ key, sourceId, id, heading, content }]`；`content` 在小路径是全文、大路径是摘要——planner 无需区分。
2. **planner 输出契约统一**：无论哪条路径都为每页标注 `sourceRefs`，writer 注入逻辑只有一套。
3. **writer 不收 `chunkRefs` 也不收整包源**，只收按 chunkId 从 `ctx.chunkStore` 解析出的 `relevantChunks`，token 成本从「全文 × N 页」降到「相关块之和」。
4. map 步与 writer 步复用同一个「按 chunkId 从 chunkStore 注入全文」的 helper；并发走 `runWithSemaphore` + `agentMaxParallelSubAgents`，预算走现有 `BudgetTracker`。

### C. chunkStore、skill / schema / prompt 改动

**关键简化**：既然选了「planner 标注 + orchestrator 确定性注入」，v1 **不新增任何 agent 工具**（`source.read` 之类不需要）——纯数据流改造。

**0. `ctx.chunkStore`（全文唯一存放处）**

`AgentContext` 新增字段：

```ts
chunkStore: Map<string, { sourceId: string; id: string; heading: string; text: string }>
// key = `${sourceId}:${id}`
```

由 `ingest-service` 在切块后构建。**全文只存这里，绝不进入 carry / prompt**。map 步给 summarizer 注入文本、writer 步注入 relevantChunks，都从这里按 chunkId 取。

**1. planner 输入**（carry 里只有轻量 chunkRefs）：

```jsonc
chunkRefs: [{ key: "src1:c0", sourceId: "src1", id: "c0", heading: "...", content: "..." }]
// content：小路径=全文，大路径=摘要（由 map 步回填）
sources: [{ sourceId, filename }]        // 仅元数据
subjectSlug, existingPages
```

**2. planner 输出 schema**（`ingest-planner.md`）每页新增必填 `sourceRefs`：

```jsonc
pages: [{ slug, title, summary, tags, rationale,
  sourceRefs: [{ sourceId, chunkIds: ["c0","c3"] }] }]
```

prompt 增规则：「每个 chunkRef 的 `content` 是该块的正文或摘要；为每个页面标注取材自哪些 chunkId；标题/摘要/rationale 可按 wikiLanguage 翻译，**chunkId / slug / wikilinks / frontmatter keys 不可改写**」。

**3. 新增 skill `ingest-chunk-summarizer.md`**（map 步）：

- 输入：单个 `{ sourceId, id, heading, text }`（text 由 orchestrator 从 chunkStore 注入）。
- 输出 schema：`{ "summary": string }`（≤ 2–3 句，保留关键实体/术语，遵循全局 wikiLanguage）。
- 工具：无（纯摘要，不读 vault）。
- 随 `examples/skills/` 播种到 `vault/.llm-wiki/skills/`（已存在不覆盖）。

**4. writer 输入改造**（`buildFanoutInput`）：

- 不再透传 `chunkRefs` / 源；按该页 `sourceRefs.chunkIds` 从 `ctx.chunkStore` 解析出 `relevantChunks: [{ id, heading, text }]`（始终全文）注入。
- `ingest-writer.md` 的 Inputs 段：`sources` → `relevantChunks`。

### D. orchestrator step kind

当前 `fanout` 写死了 writer 合并逻辑（`seenSlugs` / `putEntries` 到 overlay）。新增**纯收集型** step kind：

```ts
| { kind: 'map'; skillId: string; fromOutput: string; intoOutput: string }
```

- 按 `fromOutput` 数组（`chunkRefs`）fanout；为每个 item 从 `ctx.chunkStore` 注入 `text` 后跑 summarizer；把输出 `summary` 写回该 item 的 `content` 字段；收进 `carry[intoOutput]`（即写回 `chunkRefs`），**无 overlay 副作用**。
- writer 那步保持现有 `fanout` 合并语义不变；与 map 共用「按 chunkId 从 chunkStore 注入全文」helper。

---

## 五、配置

v1 先用模块常量，后续按需提升到 `app_settings`（沿用 settings-repo 单一真实源约定）：

| 常量 | 默认 | 位置 |
|------|------|------|
| `CHUNK_TARGET` | 6000 字符 | `source-chunker.ts` |
| `CHUNK_OVERLAP` | 400 字符 | `source-chunker.ts` |
| `PLAN_INLINE_THRESHOLD` | 100_000 字符 | `ingest-service.ts` |

---

## 六、边界与失败处理

- 空/纯空白源 → 0 chunk → planner 收到空 chunks，不产页（不报错）。
- 无标题源 → 纯按 `CHUNK_TARGET` 切。
- 超长无标题段 → 硬切 + overlap。
- `chunkIds` 引用不存在的块 → 注入时跳过并 `emit('ingest:warn', ...)`，**不静默**。
- 解析后 `emit('ingest:chunking', { chunkCount })` 让成本可见；map 步真超预算由现有 `BudgetExceededError` 兜底（失败而非截断）。
- 溯源 `page_sources` 维持 sourceId 级（块级溯源留作后续）。

---

## 七、测试策略（vitest，沿用现有 `__tests__/` 布局）

- `source-chunker`：标题切分 / 尺寸切分 / overlap / 无标题 / 空源 / Unicode 边界不切坏字符。
- orchestrator `map` step：结果收进 `carry[intoOutput]`、**不触碰 overlay**。
- `buildFanoutInput`：`chunkIds → relevantChunks` 正确解析；缺失块跳过 + emit warn。
- `ingest-service` 路径选择：按 `PLAN_INLINE_THRESHOLD` 走 inline vs map。
- planner / writer schema round-trip（`sourceRefs` 在场）。

---

## 八、非目标（Out of Scope）

- query / lint 任务的分片（本次只动 ingest）。
- 块级溯源（page_sources 仍按 sourceId）。
- writer 自行调工具按需拉块（已选确定性注入路线）。
- 把 chunk/threshold 常量提升为 `app_settings` 设置项 + UI（留作后续）。
- 多轮递归摘要（summary-of-summaries）；当前单层 map 足以让 planner 纵览，超大文件由 BudgetTracker 兜底。

---

## 九、涉及文件

| 文件 | 改动 |
|------|------|
| `src/server/sources/source-chunker.ts` | 新增：确定性切块纯函数 |
| `src/server/sources/source-store.ts` | chunk 数组持久化到 source JSON |
| `src/server/services/ingest-service.ts` | 移除截断；算 totalChars；构建 `ctx.chunkStore` + `chunkRefs`；装配自适应 steps |
| `src/server/agents/types.ts` | `AgentContext` 新增 `chunkStore` 字段 |
| `src/server/agents/runtime/orchestrator.ts` | 新增 `map` step kind；map/writer 共用 chunkStore 注入 helper；改 `buildFanoutInput` 注入 relevantChunks |
| `examples/skills/ingest-planner.md` | 输入改 chunk 列表；输出加 `sourceRefs` |
| `examples/skills/ingest-writer.md` | 输入 `sources` → `relevantChunks` |
| `examples/skills/ingest-chunk-summarizer.md` | 新增 skill |
| 对应 `__tests__/` | 按第七节补测试 |

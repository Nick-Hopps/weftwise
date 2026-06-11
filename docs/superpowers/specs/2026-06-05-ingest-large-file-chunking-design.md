# Ingest 大文件分片读取设计

> 日期：2026-06-05（06-08 修订①：切分策略深化——结构感知递归切分 + 预清洗 + token 计长 + 上下文摘要；修订②：补预算交互——maxSteps 改单实例作用域 + token 预检 fail-fast + reviewer 剪枝 + existingPages 实读 + outline 兜底）
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

### A. 解析期：预清洗 + 结构感知切块

> **设计依据**：原始文档不一定是 markdown（pdf/txt/docx 等），各 parser 产出的 `cleanText` 结构差异巨大。业界（2024–2026）共识是「**结构感知的递归切分 + 必要时加上下文前缀**」，而非依赖 embedding 的 semantic chunking（无向量库时无消费方）。详见文末研究引用。

切块作用在**解析后的 `cleanText`** 上。各来源形态：

| 来源 | `cleanText` 形态 | 有 `#` 标题 |
|------|------------------|:---:|
| md/mdx（gray-matter） | 原样 markdown 正文 | ✅ |
| html（turndown） | 转出的 markdown | ✅ |
| pdf（pdf-parse） | 扁平噪声文本：假换行 / 连字符断词 / 重复页眉脚 | ❌ |
| txt / 其它 | 原始纯文本 | ❌ |

因此分两个纯函数模块（均零 token）：`source-cleaner.ts`（预清洗）→ `source-chunker.ts`（切块）。

#### A.1 预清洗 `source-cleaner.ts`

pdf-parse 的输出会破坏「按 `\n\n` 切段落」的前提（按视觉宽度的假换行、行尾连字符断词、逐页重复的页眉页脚），必须先按来源归一化：

| 来源 | 预清洗 |
|------|--------|
| md / html | 仅基础空白归一化（已结构化） |
| txt | NFKC + 空白归一化 |
| **pdf** | **完整清洗链**（下） |

PDF 完整清洗链（按序）：

1. **NFKC 归一化**（`String.normalize('NFKC')`，统一全角/半角、形近字符、组合字符）。
2. **剥软连字符** U+00AD。
3. **去连字符断词**：行尾 `字母-\n字母` → 合并整词。
4. **合并软换行**：行尾非句末标点（`。！？.!?:；`）且下一行非空 → 折叠为空格；句末标点或连续空行 → 保留为段落边界。
5. **剥重复页眉页脚**：统计跨页高频重复短行（含纯页码 `^\d+$`）→ 删除。
6. **空白归一化**：多空格→单空格、3+ 连续换行→`\n\n`、trim。
7. **去控制字符 / 残留制表符**（pdf-parse 的列分隔符）。

> Node 生态无开箱库，为自写正则启发式（业界标准做法）。md/html 来源经 gray-matter / turndown 已基本干净，不跑此链。

#### A.2 切块 `source-chunker.ts`

```ts
interface SourceChunk {
  id: string;          // 'c0' / 'c1' ...，源内顺序稳定
  heading: string;     // 最近 markdown 标题，无则 ''（best-effort）
  text: string;
  tokenCount: number;  // 近似 token（gpt-tokenizer / cl100k）
}

type SourceKind = 'markdown' | 'plain';   // md/html→markdown；pdf/txt→plain

function chunkText(cleanText: string, kind: SourceKind, opts?: {
  target?: number;   // 默认 CHUNK_TARGET = 1000 token
  overlap?: number;  // 默认 CHUNK_OVERLAP = 120 token
}): SourceChunk[];
```

核心是**结构感知的递归切分器**（recursive splitter）：按来源选分隔符阶梯，按 **token**（非字符）计长，逐级回退。

1. **按来源分流分隔符阶梯**：
   - `markdown`（md/html）：`["\n## ", "\n### ", … , "```", "\n---\n", "\n\n", "\n", <句界>, " ", ""]`——从 H2 起切（保留 H1 主体完整），代码块 / 分割线整体优先。
   - `plain`（pdf/txt）：`["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", "；", "，", " ", ""]`——**补中英句末标点**，修复 LangChain 默认阶梯 `["\n\n","\n"," ",""]` 既无句界、`" "` 对中文又形同虚设的两个坑。
2. **递归**：用当前最高层分隔符切；累积到 `CHUNK_TARGET`(token) 收口；单片仍超限则降一级；最后字符级硬切（Unicode 安全，不切坏代理对）。
3. **overlap**：相邻块带 `CHUNK_OVERLAP`(token) 重叠。
4. **heading**：捕获最近 markdown 标题作 best-effort 元数据（pdf/txt 多为空，可接受）。
5. **token 计长理由**：喂 LLM 且中英混合，1 个中文字 ≈ 2–3 token，按字符会让中文块「虚胖」、上下文预算失控。用 `gpt-tokenizer`(cl100k) 近似，跨供应商当作上限度量足够。
6. **移除 `SOURCE_TEXT_LIMIT = 30_000` 截断**（本次核心目的）。

持久化：chunk 数组写入既有的 `vault/.llm-wiki/sources/<id>.json`（权威源，SQLite 仍是缓存）。chunk 由 cleanText 确定性派生；源内容变化即新 sourceId（现有 hash 去重保证），故 chunkId 在同一源版本内天然稳定。

### B. 自适应流水线

**核心约束：源全文绝不进入 `carry`。** orchestrator 的 sequence 步会把整个 `carry` 序列化进下游 agent 的 prompt；若全文进 carry，大文件下 planner 仍会收到全文，token 目标落空。因此全文只存放在 `ctx.chunkStore`（见 C 段），`carry` 里只流转轻量 `chunkRefs`（带 `content` 字段：小路径=全文、大路径=摘要）。

`ingest-service.ts` 在装配 `steps` 前计算 `totalTokens = Σ chunk.tokenCount`（用 token 而非字符——中文按字符会严重低估），**仅一个分支**：

```
totalTokens ≤ PLAN_INLINE_THRESHOLD (默认 25_000 token)
  小/中路径：无 map 步；ingest-service 直接把 chunkRefs[].content = text
            （全文仅此一次进入 planner 输入，可接受）

totalTokens > PLAN_INLINE_THRESHOLD
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
4. map 步与 writer 步复用同一个「按 chunkId 从 chunkStore 注入全文」的 helper；并发走 `runWithSemaphore` + `agentMaxParallelSubAgents`；预算交互见 E 段。
5. **reviewer 步前剪枝 carry**：进入 reviewer 前从 carry 剔除 `chunkRefs`（保留 `plan` + `writerOutputs` + 源元数据）。否则大文件下 reviewer 会同时收到全部块摘要和全部页面正文，token 再次膨胀且可能超单次上下文。

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

`existingPages` **不再硬编码 `[]`**（现状 `ingest-service.ts` 一直传空数组，导致 planner skill 规则 2「优先更新已有页面」形同虚设）：改为从 `pagesRepo` 读取该 subject 全部页面的 `{ slug, title, summary }` 传入——这是业务核心「增量构建」的前提，本次顺手修复。

**2. planner 输出 schema**（`ingest-planner.md`）每页新增必填 `sourceRefs`：

```jsonc
pages: [{ slug, title, summary, tags, rationale,
  sourceRefs: [{ sourceId, chunkIds: ["c0","c3"] }] }]
```

prompt 增规则：「每个 chunkRef 的 `content` 是该块的正文或摘要；为每个页面标注取材自哪些 chunkId；标题/摘要/rationale 可按 wikiLanguage 翻译，**chunkId / slug / wikilinks / frontmatter keys 不可改写**」。

**3. 新增 skill `ingest-chunk-summarizer.md`**（map 步，含轻量上下文前缀）：

- 输入：单个 `{ sourceId, id, heading, text, outline }`——`outline` 是**全文标题大纲**（轻量，由 `ingest-service` 一次性构建并注入每个 summarizer）。
- 输出 schema：`{ "summary": string }`：**结合 outline 用 ≤ 2–3 句说明「这段在全文中的定位与作用」**（Anthropic Contextual Retrieval 的轻量版），而非孤立概括——让下游 planner/writer 不再面对失去跨块指代的碎片，直接服务「完整性 + 规划质量」目标。保留关键实体/术语，遵循全局 wikiLanguage。
- **只注入「全文大纲 + 本块文本」，不注入全文**——避免超大文件下每块都带全文、违背 token 目标。
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

- 按 `fromOutput` 数组（`chunkRefs`）fanout；为每个 item 从 `ctx.chunkStore` 注入 `text`、并附上共享的全文 `outline`，跑 summarizer；把输出 `summary` 写回该 item 的 `content` 字段；收进 `carry[intoOutput]`（即写回 `chunkRefs`），**无 overlay 副作用**。
- writer 那步保持现有 `fanout` 合并语义不变；与 map 共用「按 chunkId 从 chunkStore 注入全文」helper。
- `outline` 由 `ingest-service` 在切块后构建并放入 `carry` 供 map 步引用。大纲条目 = `chunk.heading`，**heading 为空时（`plain` 源，如 PDF 书）回退为该块首行截断（约 60 字符）**——否则最需要上下文前缀的书本级 PDF 恰恰拿不到 outline，摘要会退化回孤立概括。pseudo-outline 是 best-effort，质量不及真标题，属已知限制。

### E. 预算交互（书本级可达性的前提）

不改预算语义的话，大路径在默认设置下**必然失败**，「支持超大文件」目标不可达。两处必须改：

**E.1 `agentMaxSteps` 作用域：job 总和 → 单 agent 实例**

现状：`agent-loop.ts` 每个 agent 运行 `chargeStep()` 一次，`BudgetTracker` 全 job 共享，超 `agentMaxSteps=25` 即抛错。后果：刚过阈值的文件就有 25+ 个 chunk，**仅 map 步就耗尽全部步数**，planner/writer/reviewer 一步跑不了；书本级的 writer fanout（几十页）同样撞墙。

修正：step 防护的本意是「防单个 agent 失控循环」，而 map/fanout 的实例数量由 chunk 数 / 页面数**确定性决定**，不是模型自主行为，不应受步数防护栏约束。因此：

- `agentMaxSteps` 语义改为**单个 agent 实例内的最大 tool-call 轮次**（每个 `runAgentLoop` 自带独立 step 计数器，默认 25 不变，绝大多数实例 1–3 轮远低于上限）。
- **job 级总量防线由 `agentMaxTokensPerJob` 独自承担**（token 是真实成本，步数不是）。
- `BudgetTracker` 拆分：token 计数保持 job 级共享；step 计数移到 per-run。设置项 key 与默认值不变，仅作用域变化（需更新 `agents/CLAUDE.md` 的语义描述）。

**E.2 token 预算预检（fail-fast，不烧钱后爆）**

map 步要通读全文一遍（输入 ≈ totalTokens），书本级（300–500k token）必然突破默认 `agentMaxTokensPerJob=500_000`。与其烧掉几十万 token 后中途 `BudgetExceededError` 回滚，不如在**任何 LLM 调用前**预检：

```
estimatedCost ≈ totalTokens × 1.2          // map 输入 + outline/摘要开销
              + chunkCount × SUMMARY_OUT    // 摘要输出，~80 token/块
              + PIPELINE_RESERVE            // planner/writers/reviewer 预留，~60k
若 estimatedCost > agentMaxTokensPerJob：
  job 直接 fail，error 明确给出「预计 ~X token，当前预算 Y，
  请在设置中调大 agentMaxTokensPerJob 至 ≥ Z」——不进入流水线。
```

预估是粗粒度上界（宁可保守），随 `ingest:chunking` 事件一并 emit（`{ chunkCount, totalTokens, estimatedCost }`），成本在动手前可见。

**推荐配置参考**（写入设置页 help 文案）：默认 500k 预算可稳妥处理 ≈ 200k token（约 30–40 万中文字）以内的文件；整本书（300k+ token）建议临时调到 1–1.5M。

---

## 五、配置

v1 先用模块常量，后续按需提升到 `app_settings`（沿用 settings-repo 单一真实源约定）。**全部按 token 计**（不按字符——中文 token 密度约英文 4 倍，字符阈值会失控）：

| 常量 | 默认 | 位置 |
|------|------|------|
| `CHUNK_TARGET` | 1000 token | `source-chunker.ts` |
| `CHUNK_OVERLAP` | 120 token（~12%） | `source-chunker.ts` |
| `PLAN_INLINE_THRESHOLD` | 25_000 token | `ingest-service.ts` |

**新依赖**：`gpt-tokenizer`（纯 TS、零依赖、cl100k/o200k 编码）用作近似 token 计数器。跨供应商（含 Anthropic）tokenizer 略有差异，但作为「切分上限 / 路径阈值」的近似度量足够，不必逐供应商精确对齐。

---

## 六、边界与失败处理

- 空/纯空白源 → 0 chunk → planner 收到空 chunks，不产页（不报错）。
- `plain` 源（pdf/txt）无标题 → 阶梯自然跳过标题层，落到段落/句界/字符级，不报错。
- 超长无分隔符段（无标题、无段落、无句界）→ 逐级回退到字符级硬切 + overlap（Unicode 安全）。
- 预清洗误伤：去连字符/合并软换行是启发式，可能偶有误合并；属可接受损耗，记录在 spec，不做语言级判定。
- `chunkIds` 引用不存在的块 → 注入时跳过并 `emit('ingest:warn', ...)`，**不静默**。
- 解析后 `emit('ingest:chunking', { chunkCount, totalTokens, estimatedCost })` 让成本可见；**预检超预算 → 流水线启动前 fail-fast**（见 E.2，错误信息含建议预算值）；预检通过但实际超支（预估偏差）仍由 `BudgetExceededError` 兜底（失败而非截断）。
- 溯源 `page_sources` 维持 sourceId 级（块级溯源留作后续）。

---

## 七、测试策略（vitest，沿用现有 `__tests__/` 布局）

- `source-cleaner`：PDF 清洗链各步——NFKC / 剥软连字符 / 去连字符断词 / 合并软换行（句末标点保留段落边界）/ 剥重复页眉页脚；md/html/txt 不过度清洗。
- `source-chunker`：
  - `markdown` 阶梯按标题切、代码块整体保留；`plain` 阶梯按段落/句界切。
  - 按 **token** 计长（非字符）；CJK 文本按 `。！？` 切而非空格；中英混合两套句界都生效。
  - overlap / 超长无分隔符硬切 / 空源 / Unicode 边界不切坏代理对。
- orchestrator `map` step：结果收进 `carry[intoOutput]`、注入 text + outline、**不触碰 overlay**。
- **预算交互**：step 计数 per-run 隔离（N 个 map/fanout 实例不互相耗步数）；token 仍 job 级累加；单实例超 `agentMaxSteps` 仍抛错。
- **token 预检**：estimatedCost > 预算 → 流水线启动前失败、错误含建议值；预算充足 → 正常进入。
- **reviewer 剪枝**：进入 reviewer 的 carry 不含 `chunkRefs`，仍含 `plan` / `writerOutputs`。
- `buildFanoutInput`：`chunkIds → relevantChunks` 正确解析；缺失块跳过 + emit warn。
- `ingest-service` 路径选择：按 `PLAN_INLINE_THRESHOLD`(token) 走 inline vs map；`existingPages` 从 `pagesRepo` 实际读取。
- outline 构建：heading 存在用 heading；`plain` 源回退块首行截断。
- planner / writer schema round-trip（`sourceRefs` 在场）。

---

## 八、非目标（Out of Scope）

- query / lint 任务的分片（本次只动 ingest）。
- 块级溯源（page_sources 仍按 sourceId）。
- writer 自行调工具按需拉块（已选确定性注入路线）。
- 把 chunk/threshold 常量提升为 `app_settings` 设置项 + UI（留作后续）。
- 多轮递归摘要（summary-of-summaries）；当前单层 map 足以让 planner 纵览，超大文件由 BudgetTracker 兜底。
- **docx 正式解析**（`mammoth` → 带标题层级的 HTML/Markdown）。当前 docx 二进制走错分支产乱码；本次不修。chunker 本身格式无关，未来接入 docx parser 后自动受益（其产物归为 `markdown` kind）。
- **embedding 驱动的 semantic / late chunking**：无向量库时无消费方，明确放弃（见研究结论）。
- 复杂/扫描 PDF 的高质量解析——见下「后续质量档位」。

---

## 九、涉及文件

| 文件 | 改动 |
|------|------|
| `src/server/sources/source-cleaner.ts` | 新增：按来源预清洗纯函数（PDF 清洗链） |
| `src/server/sources/source-chunker.ts` | 新增：结构感知递归切分器（分流阶梯 + token 计长 + CJK 句界） |
| `src/server/sources/source-store.ts` | chunk 数组持久化到 source JSON |
| `src/server/services/ingest-service.ts` | 移除截断；预清洗→切块；算 totalTokens + 预算预检（E.2）；构建 `ctx.chunkStore` + `chunkRefs` + `outline`；`existingPages` 实读 `pagesRepo`；装配自适应 steps |
| `src/server/agents/types.ts` | `AgentContext` 新增 `chunkStore` 字段；`BudgetTracker` 接口拆分 step/token 作用域 |
| `src/server/agents/runtime/budget.ts` | step 计数移至 per-run，token 保持 job 级（E.1） |
| `src/server/agents/runtime/agent-loop.ts` | 使用 per-run step 计数器 |
| `src/server/agents/runtime/orchestrator.ts` | 新增 `map` step kind；map/writer 共用 chunkStore 注入 helper；改 `buildFanoutInput` 注入 relevantChunks；reviewer 步前剪枝 `chunkRefs` |
| `examples/skills/ingest-planner.md` | 输入改 chunkRefs；输出加 `sourceRefs` |
| `examples/skills/ingest-writer.md` | 输入 `sources` → `relevantChunks` |
| `examples/skills/ingest-chunk-summarizer.md` | 新增 skill（含 outline 上下文前缀） |
| `package.json` | 新依赖 `gpt-tokenizer` |
| `src/server/agents/CLAUDE.md` | `agentMaxSteps` 语义描述更新（job 级 → 单实例级） |
| 对应 `__tests__/` | 按第七节补测试 |

---

## 十、后续质量档位（不在 v1，记录升级路径）

切块质量的上限取决于「能否拿到带结构的中间表示」。当前 v1 用 pdf-parse + 自写预清洗已能稳健覆盖大多数 PDF/TXT；对**复杂版式 / 扫描件**，未来可分档升级（按运维成本递增）：

1. **云 layout API（TS 原生可直连，零本地运维）**：Azure Document Intelligence layout（`outputContentFormat=markdown`，约 $1.25/100 页）或 Mistral OCR（约 $1–2/1k 页）把 PDF → Markdown，再走本设计的 `markdown` 阶梯。代价：数据出境 + 按页计费。
2. **Docling Serve 边车（开源质量天花板）**：IBM Docling（61k★）输出带类型的 element 树 + token-aware `HybridChunker`（只需 tokenizer、不需 embedding），切分理念与本设计最契合；但核心是 Python，需运行一个 REST 边车进程。

接入方式都是「在 parser 层产出更高质量的 markdown / 结构」，**对 chunker 与流水线无侵入**——故可作为纯增量演进。

---

## 十一、研究引用（2024–2026）

- **切分策略基准**：[Chroma《Evaluating Chunking Strategies for Retrieval》(2024-07)](https://www.trychroma.com/research/evaluating-chunking)（调好参数的 recursive splitter 出奇地强）；[NAACL 2025《Is Semantic Chunking Worth the Computational Cost?》](https://aclanthology.org/2025.findings-naacl.114/)（固定块常追平/超过语义块）；[Firecrawl《Best Chunking Strategies 2026》](https://www.firecrawl.dev/blog/best-chunking-strategies-rag)。
- **递归切分器权威值**：[LangChain RecursiveCharacterTextSplitter](https://docs.langchain.com/oss/python/integrations/splitters/recursive_text_splitter)；[langchainjs text_splitter.ts（markdown 阶梯）](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-textsplitters/src/text_splitter.ts)。
- **CJK 切分**：[CJK in GenAI pipelines (tonybaloney, 2024-03)](https://tonybaloney.github.io/posts/cjk-chinese-japanese-korean-llm-ai-best-practices.html)；[LangChain issue #18770](https://github.com/langchain-ai/langchain/issues/18770)。
- **token 计数**：[gpt-tokenizer (npm)](https://www.npmjs.com/package/gpt-tokenizer)。
- **PDF 文本噪声**：[pdf-parse options（lineThreshold）](https://github.com/mehmet-kozan/pdf-parse/blob/main/docs/options.md)；[PDF de-hyphenation 论文 (Freiburg, 2019)](https://ad-publications.cs.uni-freiburg.de/theses/Bachelor_Mari_Hernaes_2019.pdf)。
- **上下文前缀**：[Anthropic《Contextual Retrieval》(2024-09)](https://www.anthropic.com/news/contextual-retrieval)。
- **结构感知解析（后续档位）**：[Docling](https://github.com/docling-project/docling) + [Chunking 概念](https://docling-project.github.io/docling/concepts/chunking/)；[Azure DI Layout (markdown)](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0)；[Mistral OCR](https://mistral.ai/news/mistral-ocr/)；[mammoth (docx)](https://www.npmjs.com/package/mammoth)。

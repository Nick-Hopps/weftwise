# Ingest 增益流水线设计（从"忠实压缩"到"学习化增益"）

> 日期：2026-06-20
> 状态：设计（待评审 → 进入实现计划）
> 范围：仅 `ingest` 任务流水线（不动 query / lint）；含配套前端渲染改造

---

## 一、背景与问题（诊断）

项目愿景是"在原文基础上做**必要的补充**（概念补充、额外解释、图表说明、例题对照、QA），让资料更易被理解和吸收"。但当前生成的 wiki 文档质量很差——**只是对原文的高度总结**。

这不是 bug，而是当前流水线的设计目标的必然结果：**它是一条忠实压缩流水线**，目标是"高保真地把源材料重新打包"。根因六处叠加：

1. **writer 被明令禁止增益**。`vault/.llm-wiki/skills/ingest-writer.md` 规则 4：*"Base the body on `relevantChunks`. **Do not invent facts not present in the chunks.**"* 这一句把"补充"判死。更甚：writer 在结构上**只能看到 planner 分配给它的几个 chunk**（`orchestrator.ts::resolveRelevantChunks`），连原文其余部分都看不到。
2. **角色设定是"百科编辑"而非"讲师"**。prompt 强调 *encyclopedic, neutral prose*。
3. **schema 贫瘠**。writer 输出 `{action, path, content}`，frontmatter 仅 `title/summary/tags`，没有承载直觉/例题/自测/前置的结构。
4. **planner 思维是"chunk→page 重打包"**（`sourceRefs`），而非"学习者需要哪些脚手架"。
5. **大文件先被 chunk-summarizer 压一遍**，writer 拿到"摘要的摘要"。
6. **reviewer 只把关保真**（断链、矛盾、跑题），无"够不够好懂"的职责，反向加固忠实度。

### 真实产物印证

`data/vault/wiki/general/eigenvalues-and-eigenvectors.md`（《线性代数应该这样学》第 5 章）基本是一份**定理点名册**——"定理 5.7、定理 5.11、推论 5.12、定理 5.18……"逐条罗列陈述，几乎无直觉、动机、几何图像、例题。最讽刺的是结尾写 *"本章末配有大量习题……详见原书习题 5A–5E"*——**系统因不能越界，干脆把例题甩回原书**。对学习者而言，价值仅略高于原书的定理索引。

### 核心张力：增益 ≠ 幻觉

"不准编造"本身是对的——它是**幻觉护栏**。但增益（补直觉、例题、前置概念、Q&A）**本质就是加入源材料里没有的内容**。当前系统把"有益阐释"与"凭空捏造"混为一谈，一刀切都禁了。**本设计的核心，是把这两者拆开**：允许正确的阐释性扩写，同时仍挡住"被当作源材料事实的捏造"。

---

## 二、目标与非目标

**目标**

- 生成的页面在保留原文严谨内容（忠实层）之外，叠加**学习导向的增益层**：直觉/动机、例题、自测 Q&A、前置背景、图示、常见误区。
- 增益内容**正确性可控**：模型自由扩写后经验证；存疑断言触发 web 检索核查；低置信项打标或删除。
- 忠实层与增益层**物理可分、溯源可辨**：读者一眼能区分"书上的"与"AI 补的"。
- 不破坏既有 Saga 写入边界、subject 隔离、断点续传、预算护栏。

**非目标（本轮不做）**

- 不改 query / lint 任务。
- 不改 wikilink / slug / Saga 事务语义。
- 不做交互式 explorable explanation（仅静态 markdown + 已支持渲染）。
- 不强制重生成存量页面（提供手动"重新增益"动作，但不自动回填）。

---

## 三、设计决策综述（Nick 已确认的岔路）

| 决策 | 选择 | 含义 |
|------|------|------|
| **正确性模型** | 混合：先补充再验证 | 模型自由增益 → verifier 逐条质疑；存疑触发检索 |
| **架构** | Approach 2 双层分离 | writer 产忠实草稿 → enricher 叠增益层 → verifier 只验增益 → reviewer 提交 |
| **页面模型** | 双层 + Obsidian callout | 忠实=普通散文；增益=`[!type]` callout；溯源即 callout |
| **图表** | 同期接 mermaid | 本轮一并接入 mermaid 渲染 |
| **验证检索** | 同期接 web 检索 | verifier 配 web-search MCP 工具核查存疑断言 |

---

## 四、现状数据流（事实基础）

`ingest-service.ts::registerHandler('ingest')`：

1. `loadCleanText` → `prepareIngest`（确定性切块，零 token，构建 `chunkStore`/`chunkRefs`/`outline`）；
2. 预算预检：`estimateIngestCost(...) > agentMaxTokensPerJob` 则 fail-fast；
3. 构建 `AgentContext`（`pending`/`overlay`/`chunkStore`/`budget`/`checkpoint`）；
4. `runPipeline({ steps, ... })`，当前 `steps`（`ingest-service.ts:155`）：

```
[大文件] map  ingest-chunk-summarizer × N   → chunkRefs[].content 写回摘要
sequence      ingest-planner                → plan.pages[]（带 sourceRefs）
fanout        ingest-writer × N             → 每页 {action,path,content} 并入 overlay + pending
sequence      ingest-reviewer               → commit_changeset（提交 pending ∪ input.entries）
```

**关键事实**：
- writer 每页 entry 暂存进 `ctx.pending.entries` + `ctx.overlay`（`orchestrator.ts:156`）；reviewer 不重发未改动页，只发修正页 + index/log。
- fanout 冲突检测：同一阶段内同 `path` 抛 `WriterConflictError`（`orchestrator.ts:147`）。
- 断点续传：`PipelineStep.checkpointAs ∈ {'plan','writer-page','chunk-summary'}`；`IngestCheckpoint`（`types.ts:70`）有 `get/putPlan`、`get/putWriterPage`、`get/putChunkSummary`，内存索引 + 落盘双写（checkpoints-repo）。

---

## 五、核心实现约束（读码发现，决定 agent 形态）

**`agent-loop.ts` 中，结构化输出与工具调用互斥**：

- 有 `outputSchema` 的 skill 走 `generateObject` 路径（`generateStructuredResult`），**不传 tools**——工具被 `compileToolSet` 编译但从未交给模型。（因此现存 writer 声明的 `vault.read/search` 实为 inert。）
- 无 `outputSchema` 的 skill 走 `generateText` 路径（`generateTextResult`），**带 `tools: toolSet` + `maxSteps` 工具循环**（reviewer 即此类）。

**结论**：
- **enricher = 结构化无工具**（增益本就是生成式；wikilink 合法性由下游 `validateChangeset` 兜底，无需实时 `vault.search`）。
- **verifier = 自由文本 + 工具**（reviewer 式；唯有此路径能调 `web.search`）。其"输出修正页"通过工具落地（见 §6.4）。

`buildMessages` 把 skill body 作为 system prompt、`JSON.stringify(input)` 作为 user message——新 skill 沿用同一约定。

---

## 六、目标架构

```
[大文件] map  ingest-chunk-summarizer × N      不变
sequence      ingest-planner                   不变（仍产 plan + sourceRefs）
fanout        ingest-writer × N                忠实层, 基本不变 {action,path,content}
fanout        ingest-enricher × N   【新增】    结构化无工具; 叠加 [!callout] 增益层
fanout        ingest-verifier × N   【新增】    自由文本+工具; 只核查增益 callout
sequence      ingest-reviewer                  不变; 提交 pending ∪ 修正 + index/log
```

### 6.1 planner（不变）

仍产出 `plan.pages[]`（slug/title/summary/tags/rationale/sourceRefs）。P4 可选升级为"学习设计师"（Approach 3 增量，见 §15），本轮不动。

### 6.2 writer（基本不变）— 忠实层

仍输出 `{action, path, content}`，content = 严谨的源材料正文（沿用现有质量，即忠实层）。**关键约束**：writer **只产普通 markdown 散文，不产 `[!callout]`**——增益是 enricher 的职责。可在 writer prompt 明确这一分工。

### 6.3 enricher（新增）— 增益层

- **形态**：结构化输出，无工具。
- **输入**：`{ slug, title, summary, draftContent（writer 产出）, relevantChunks（源边界）, subjectSlug, existingPages, plan, languageDirective, augmentationLevel }`。
  - `draftContent` 从 `carry.writerOutputs[i].content` 或 overlay 读取（orchestrator 在 fanout input 中注入）。
- **输出**：`{ action, path, content }`——**忠实层逐字保留**，在恰当位置**插入 `[!type]` callout**。
- **职责**：依据 `relevantChunks` 与自身知识，补直觉/例题/自测/前置/图示/误区。callout 内可用 `[[wikilink]]` 串联他页、用 KaTeX、用 mermaid（```mermaid 代码块）。
- **强约束**：不得改写/删除忠实层散文；只增不改；不得在普通散文里掺入未经标注的模型断言（所有模型补充必须落在 callout 内，保证 §7 的溯源可辨）。

### 6.4 verifier（新增）— 核查增益层

- **形态**：自由文本 + 工具（无 `outputSchema`）。
- **工具**：`vault.read`、`vault.search`、`web.search`（MCP，见 §11）、`stage_correction`（新增内置工具）。
- **输入**：`{ path, content（enricher 产出）, relevantChunks, subjectSlug, languageDirective }`。
- **职责**：
  1. 只审 `[!type]` callout 内的模型断言（忠实层不在职责内，由 reviewer 查保真）。
  2. 对存疑断言调 `web.search` 取证；
  3. 处置：**修正**（改对）/ **软化**（加限定词）/ **删除**（无依据且无法证实）/ **打标**（低置信加脚注或 `⚠` 提示）；
  4. 经 `stage_correction({ path, content })` 写回修正后的整页；
  5. 最终文本输出一份逐条 verdict 摘要（emit 进 job_events，供 UI/排查）。
- **优雅降级**：若未配 web-search MCP server，`web.search` 不挂载，verifier 退化为纯参数化自检（仍能修正/软化/删除/打标），不阻断流水线。

### 6.5 reviewer（基本不变）

仍读全部页（此时已是 enriched + verified）做最终质检，提交 `pending ∪ 修正 + index/log`。新增轻量职责：抽查"增益层是否与忠实层风格协调、callout 是否合法"。

---

## 七、页面模型（双层 + callout 溯源）

**溯源约定**：
- **普通散文 = 忠实层**（源材料，reviewer 查保真）。
- **`[!type]` callout = 增益层**（模型补充，verifier 核查）。
- 两层在 markdown 中物理可分；读者一眼可辨来源；verifier 的审查目标因此精确（只看 callout）。

**callout 类型**（对应愿景的 概念补充/额外解释/图表/例题/QA + 学习科学）：

| 语法 | 用途 | 学习科学依据 |
|------|------|------|
| `> [!intuition] 💡 直觉` | 动机、为什么、几何/物理图像 | elaboration |
| `> [!example] 📝 例题` | worked example 含解答 | worked-example effect |
| `> [!quiz] ❓ 自测` | Q&A / 自测题 | retrieval practice |
| `> [!background] 🔗 前置/背景` | 前置概念、`[[wikilink]]` 串联 | scaffolding |
| `> [!diagram] 📊 图示` | mermaid / KaTeX / ASCII 图 + 说明 | dual coding |
| `> [!pitfall] ⚠ 常见误区` | 易错点、误解澄清 | misconception repair |

**示例**（重生后的"特征值与特征向量"节选）：

```markdown
### 特征值与特征向量
若存在非零向量 $v$ 和标量 $\lambda$ 满足 $Tv=\lambda v$，则称 $\lambda$ 为 T 的
**特征值**，$v$ 为对应的**特征向量**。              ← 忠实层（writer，书上原话级别）

> [!intuition] 💡 直觉
> 把 T 想成对空间的一次"搅动"：绝大多数向量被转向，唯独特征向量方向不变、
> 只被拉伸 $\lambda$ 倍——它们是这次变换的"骨架轴"。       ← 增益层（enricher → verifier 核查）

> [!example] 📝 例题
> 设 $T(x,y)=(2x,3y)$：$(1,0)\mapsto(2,0)$ 故 $\lambda_1=2$；$(0,1)\mapsto(0,3)$ 故 $\lambda_2=3$。
```

**渲染现实**（`src/lib/markdown-client.ts` 现状）：
- ✅ KaTeX（`remark-math`+`rehype-katex`）、`[[wikilink]]`（自定义插件）已支持。
- ❌ mermaid：无（需接，§10）。
- ⚠ `[!type]` callout：当前退化为普通 blockquote（可读但无样式）——可立即用，样式化是前端小活（§10）。
- ❌ 折叠 `<details>` / 裸 HTML：`allowDangerousHtml:false` 剥离 → 自测题无法折叠，先平铺（可选后续）。

---

## 八、orchestrator 变更

### 8.1 fanout `pending` 改为跨阶段 path last-write-wins

当前 enricher/verifier 重发同 `path` 会被 §4 的同阶段冲突检测误判为 `WriterConflictError`。改造：

- `ctx.pending` 由 `entries: ChangesetEntry[]` 改为**按 path 索引的 map**（或在 push 时按 path 去重覆盖）；同阶段内重复仍报冲突，**跨阶段同 path 覆盖**（后阶段产物覆盖前阶段）。
- `overlay.putEntries` 同样按 path 覆盖（已是 upsert 语义，确认即可）。
- 冲突检测的 `seenSlugs` 改为**每个 fanout step 内部**判重，不跨 step。

### 8.2 checkpointAs 扩展

- `PipelineStep` 的 `checkpointAs` 联合增加 `'enricher-page' | 'verifier-page'`。
- `IngestCheckpoint`（`types.ts:70`）增加 `getEnricherPage/putEnricherPage`、`getVerifierPage/putVerifierPage`（或泛化为 `getStagePage(stage, slug)`）。
- checkpoint.ts + checkpoints-repo + DB 表（`ingest_checkpoints`）的 stage 列扩展。
- 逐页续传：命中 enricher/verifier 检查点则跳过对应 LLM；fanout 每页完成即落盘（沿用现有 writer-page 模式）。

> 注：fanout input 需带 page 身份（slug）供 checkpoint key；enricher/verifier input 已含 `slug`/`path`，`inputLabel` 可识别。

---

## 九、预算与检查点

- +2 fanout 阶段 ≈ 每页 LLM 调用 2–3×（writer→enricher→verifier）。
- `estimateIngestCost`（`ingest-prep.ts`）需计入 enricher + verifier 的预估（按页数 × 阶段系数）；verifier 的 web.search 工具循环额外计 token。
- 默认 `agentMaxTokensPerJob`（settings-repo，当前 500k）上调建议 → **~1.2M**（书本级仍可能触顶，靠预检 fail-fast 提示调高）。
- `reduceCostForResume` 需把 enricher/verifier 已完成页计入折减。
- budget 超限仍走 `BudgetExceededError` → rollback → 不可重试（不变）。

---

## 十、渲染工作（前端，并入本轮）

可**独立先行**（P1），让增益一产出即可视：

1. **mermaid 渲染**：
   - 新增依赖（mermaid）；client 侧组件（动态导入，避免 SSR）。
   - `renderMarkdown`（`markdown-client.ts`）识别 ```mermaid 代码块 → 客户端渲染容器。
   - 注意 SSR/CSP：mermaid 需浏览器环境；Artifact/CSP 场景需内联。SSR 渲染路径（`page-renderer.tsx` 走 rehype-pretty-code）需协调——mermaid 走客户端 hydration。
2. **callout 样式化**：
   - remark/rehype 插件识别 blockquote 首行 `[!type] emoji 标题` → 映射为带样式的 callout 组件（type → 配色/图标）。
   - 优雅降级：插件缺失时仍是合法 blockquote。
3. **（可选）自测题折叠**：需放开 `allowDangerousHtml` 或自定义 directive 支持 `<details>`——标为可选后续，本轮先平铺 Q&A。

---

## 十一、web 检索接地（verifier 工具）

- 复用现有 `McpClientPool`（`agents/tools/mcp/`）；web-search 作为一个 MCP server 配置在 `app_settings`（`mcp/config.ts` 读取）。
- verifier skill frontmatter `tools:` 声明 `mcp.<server>.<tool>`（`agent-loop.ts::toProviderToolName` 已处理点号命名空间 → provider 安全名）。
- **依赖**：需用户提供可用的 web-search MCP server（如 Brave/Tavily/自建）。无则 §6.4 优雅降级。
- 成本/延迟：web.search 仅对 verifier 判定为"存疑"的断言触发（不是每条都查），prompt 明确"高置信常识无需检索"。

---

## 十二、配置

### 12.1 增益强度（per-subject）

- `app_settings` 增设 `augmentationLevel`（**per-subject**，非全局；与 `wikiLanguage` 全局不同——不同主题增益需求不同）。
  - 取值 `{ off, light, standard, deep }`，默认 `standard`。
  - `off` = 跳过 enricher + verifier，退回纯忠实层（= 现有行为）。
  - `light/standard/deep` 调节 enricher 产出的 callout 密度与深度（注入 enricher prompt）。
- settings-repo 增 `getAugmentationLevel(subjectId)` / `setAugmentationLevel`；ingest-service 实时读取，决定是否插入 enricher/verifier step。
- UX：subject 管理页或 settings dialog 加一行"增益强度"。

> 注：现有 settings 多为全局单实例。per-subject 设置需确认 `app_settings` 表结构是否支持按 subject 维度键（如 `key = augmentationLevel:<subjectId>` 或新增列）——实现计划中核定。

### 12.2 模型分层

- enricher 用**最强模型**（增益质量最关键）；verifier 用**强推理模型**（核查需推理 + 工具）。
- 经 `llm-config.json` 的 `tasks["skill:ingest-enricher"]` / `tasks["skill:ingest-verifier"]` 配置（task-router 已支持 `skill:` 前缀）。

---

## 十三、契约 / schema 变更

- **`ChangesetEntry` 不变**（`{action,path,content}`）——双层都在 content 内。
- **frontmatter**：倾向**不加**增益元数据（YAGNI）——靠 callout 是否存在即可判断页面是否含增益。若 UI 需展示"增益强度"徽章，再加 `augmentation` 字段。
- 顺带修复：现有页 frontmatter `sources: []` 为空——本轮确认 `page_sources` 溯源写入是否正常（与增益无关但同属质量，列为附带项，非阻断）。
- 新增 skill 模板文件：`examples/skills/ingest-enricher.md`、`examples/skills/ingest-verifier.md`（worker 启动 `seedSkillFiles` 从 `examples/skills/` 播种到 `vault/.llm-wiki/skills/`，不覆盖已有）。
- skill 版本守卫（`ingest-service.ts:114` 的 `MIN_SKILL_VERSIONS`）增加 enricher/verifier 的最低版本。
- 新增内置工具 `stage_correction`（`agents/tools/builtin/`）+ 在 `ToolRegistry` 注册。

---

## 十四、回填现有页

- 提供**手动**"重新增益"动作：对已有页跑 enricher + verifier（writer 阶段可跳过——忠实层已存在，直接以现有 content 为 draft）。
- 入口：页面操作菜单或 subject 级批量动作；入队一个变体 ingest job（`params.mode = 're-enrich'`，`sourceId` 可空、直接读现有页 content 当 draft）。
- 不自动触发；存量 12 页由用户按需重生成。

---

## 十五、实现分期（roadmap，均在本轮范围，仅落地顺序）

| 阶段 | 内容 | 可独立验收 |
|------|------|-----------|
| **P1 渲染解耦** | mermaid 渲染 + callout 样式化（前端） | 手写含 callout/mermaid 的页面，渲染正确 |
| **P2 核心增益** | enricher skill + 页面模型 + orchestrator last-write-wins + checkpoint/预算扩展 | ingest 产出双层页面（verifier 暂用参数化自检） |
| **P3 接地核查** | web-search MCP 接入 + verifier 升级为检索核查 + `stage_correction` 工具 | 存疑断言被检索核查/修正/打标 |
| **P4 收尾** | `augmentationLevel` per-subject 设置 + 回填动作 +（可选）学习设计师 planner（Approach 3） | 强度可配；存量页可重新增益 |

---

## 十六、测试策略

- **skill examples-roundtrip**（沿用 `skills/__tests__/examples-roundtrip.test.ts`）：enricher/verifier 的 frontmatter + outputSchema 合法、id 与文件名一致、版本号。
- **orchestrator 多阶段 fanout**：last-write-wins（同 path 跨阶段覆盖、同阶段仍报冲突）；checkpoint 续传命中 enricher/verifier 跳过 LLM。
- **ingest-prep 预算**：`estimateIngestCost` 计入新阶段；`reduceCostForResume` 折减包含 enricher/verifier 已完成页。
- **verifier 工具循环**：mock `web.search` + `stage_correction`；验证存疑断言触发检索、修正写回 pending。
- **页面模型契约**：enricher 输出保留忠实层（diff 校验忠实段落不变）、只在 callout 内引入模型断言。
- **渲染**：`markdown-client` 对 callout/mermaid 的解析单测（含降级路径）。

---

## 十七、风险与开放问题

1. **增益正确性残差**：参数化自检 + web 检索仍可能漏判细微错误；缓解 = 可见的 callout 溯源让读者自行校准 + lint 的 contradiction 兜底。
2. **enricher 篡改忠实层**：靠 prompt 强约束 + 测试 diff 校验；若不可靠，后备方案是 enricher 只输出"callout 列表 + 插入锚点"，由 orchestrator 机械拼接（更安全但更死板）——列为 P2 实现时的 fallback。
3. **成本**：书本级 ingest 2–3× token；靠预检 fail-fast + per-subject `off` 兜底。
4. **per-subject 设置存储**：`app_settings` 当前是否支持 subject 维度键，需实现计划核定（§12.1）。
5. **mermaid SSR/CSP**：客户端 hydration 方案需与现有 `page-renderer.tsx`（rehype-pretty-code 异步路径）协调。
6. **web-search MCP 依赖**：用户须自备 server，否则降级——文档需说明。

---

## 十八、相关文件清单（预计改动）

```
新增 skill 模板
  examples/skills/ingest-enricher.md
  examples/skills/ingest-verifier.md
新增内置工具
  src/server/agents/tools/builtin/stage-correction.ts
后端改动
  src/server/services/ingest-service.ts        # steps 插入 enricher/verifier; 版本守卫; augmentationLevel
  src/server/services/ingest-prep.ts            # 预算计入新阶段
  src/server/agents/runtime/orchestrator.ts     # pending last-write-wins; fanout input 注入 draftContent
  src/server/agents/runtime/checkpoint.ts        # enricher/verifier-page 检查点
  src/server/agents/types.ts                     # IngestCheckpoint + PipelineStep checkpointAs 扩展
  src/server/agents/tools/registry.ts            # 注册 stage_correction
  src/server/db/repos/settings-repo.ts           # getAugmentationLevel/setAugmentationLevel
  src/server/db/repos/checkpoints-repo.ts        # stage 列扩展
前端改动
  src/lib/markdown-client.ts                     # mermaid + callout 识别
  src/components/wiki/page-renderer.tsx          # mermaid hydration + callout 样式
  （新增 mermaid 渲染组件 + callout 组件）
配置
  llm-config.json                                # skill:ingest-enricher / skill:ingest-verifier
```

---

_本设计经多轮 brainstorm 确认：hybrid-verify 正确性模型 + Approach 2 双层分离 + callout 页面模型 + 同期接 mermaid 与 web 检索。_

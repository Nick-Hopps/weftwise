# ⑨ Verifier 联网核查（web-grounding）设计

> ingest 增益流水线第 4 阶段 verifier 由「参数化自检（P2）」升级为「联网接地核查（P3）」：对增益 callout 中的存疑断言做 web 检索取证、修正/软化/删除，并把**被引用的网页作为 source 导入** wiki（页面 ↔ source 溯源 + 读者可见）。

---

## 一、背景与动机

### 现状

ingest 内容流水线四阶段：`planner → writer×N → enricher×N → verifier×N`，commit 由 service 层 `finalizeIngest → commitPending` 收口（详见 `agents/CLAUDE.md`）。

- **enricher**：在忠实草稿上叠加 `[!type]` callout 增益层（intuition/example/quiz/background/diagram/pitfall），结构化输出无 tools。
- **verifier（当前 = P2）**：结构化输出无 tools，只看 callout，参数化自检（confident→留 / uncertain→软化 / wrong→删或修），忠实正文逐字复刻。skill `ingest-verifier` version 2。

### P3 目标

增益 callout 是模型自由扩写，自检只能靠模型自身知识。P3 引入 **web 检索取证**：对存疑断言联网核查，证据驱动地修正/软化/删除；并把核查所**引用的网页导入为 source**，让页面事实可溯源、读者可见。

### ⚠️ 核心约束：不得重蹈 packyapi 工具死循环

原增益 spec（`2026-06-20-ingest-augmentation-pipeline-design.md` §6.4/§11）把 P3 设想为**自由文本 + 工具循环的 reviewer 式 verifier**（`generateText` + `web.search` MCP + `stage_correction` 工具）。但 **2026-06-21 已证实该模式在 packyapi 的 openai-compatible 转译下工具死循环**（反复读不消费、永不收口 → 撞 maxSteps），并因此删除了 tool-using reviewer。本项目的 Claude 走的正是 packyapi openai-compatible。

**因此 P3 不照搬原 spec。** 改为：LLM 调用全程保持 `generateObject`（无 tools），web 检索移到**编排代码层确定性执行**——与 2026-06-21 架构决策、与 ⑧「检索在编排层、喂给无 tools 结构化调用」一致。

---

## 二、设计决策

| 维度 | 选择 | 理由 |
|------|------|------|
| **核查架构** | 确定性两段式（triage → 编排层搜索 → apply），全程 `generateObject` 无 tools | 绕开 packyapi 工具死循环；与既有架构一致 |
| **搜索后端** | HTTP 搜索 API（Tavily 契约：search + extract） | worker 进程内最简、最确定；无需 MCP transport/bridge/lifecycle 机制 |
| **后端配置位置** | 落**全局设置** `app_settings`（`settings-repo` + 设置面板），非 `llm-config.json` | 符合 CLAUDE.md 全局设置规则：server 单一真实源、服务层实时读取、UI 改无需重启 worker、不镜像 Zustand |
| **开关/降级** | 配了就开、没配就降级到当前 P2 自检 | 零新增 UI 开关；未配置时零行为变化 |
| **网页 source 内容** | 按需抓正文：apply 定下被引用 URL 后，仅对这些 URL 调 extract 拉全页正文导入 | 导入真正可读、可再-ingest 的完整 source；只为被引用页抓取（不浪费） |

---

## 三、架构：两段式 verify

verifier 步骤由「单次 fanout skill」升级为**逐页两段式**（`kind:'verify'` step）。每页（已增益 `content`）：

```
① triage  skill 'ingest-verifier-triage'  (generateObject, 无 tools)
     输入: 增益页 content + relevantChunks + 身份 + languageDirective
     输出: { doubtfulClaims: [{ excerpt, query, reason }] }   // 仅 callout 层的存疑断言
                          │
            ┌─────────────┴──────────────┐
       doubtfulClaims=[]            doubtfulClaims 非空
       跳过搜索+apply               编排层: 去重 query, 上限 3,
       页原样通过(passthrough)       Promise.allSettled webSearch(query)
       (比当前 P2 更省)                    │
                              ┌────────────┴────────────┐
                          有证据(≥1 query 有结果)      零证据(全失败/空)
                          ② apply skill              退回自检
                          'ingest-verifier-apply'    skill 'ingest-verifier'(v2)
                          (generateObject, 无 tools)  ← 既有降级路径
                          输入: content + evidence(snippets)
                          输出: { action, path, content,
                                  citedSources:[{url,title}] }
                                     │
                          编排层: 把 citedSources 追加进页
                          frontmatter `sources` + 记入 ctx.citedSources
```

**全局降级**：`isWebSearchConfigured()===false` → verify 步骤逐页直接跑既有 `ingest-verifier`(v2) 自检 = **当前 P2 行为零变化**。

**接缝**：orchestrator 的 fanout 骨架（overlay 快照隔离 / `checkpointAs:'verifier-page'` 续传 / path 强制规范 / `ctx.pending` upsert / `WriterConflictError` 冲突检测）**原样复用**；只把「每项 = 一次 `runAgentLoop(verifierSkill)`」替换为「每项 = 一次 `runPageVerification(...)`」。`runPageVerification` 返回与 `AgentRunResult` 同形的 `{ output: ChangesetEntry, tokensUsed, stepCount, ... }`，两次 LLM 调用的 token 经同一 `BudgetTracker` 计入。

---

## 四、组件与文件边界

### 新增

| 文件 | 职责 |
|------|------|
| `src/server/search/web-search.ts` | `isWebSearchConfigured(): boolean`；`webSearch(query, opts?): Promise<WebSearchResult[]>`（Tavily search）；`extractContent(urls): Promise<Array<{ url; content }>>`（Tavily extract，按需抓正文）。**配置经 `settings-repo::getWebSearchConfig()` 实时读 `app_settings`**（每次调用读 DB，UI 改即时生效、无需重启 worker）；未配置（apiKey 空）时 `isWebSearchConfigured` 返回 false，其余函数抛 `LLMConfigError`（与 ⑧ embedding 守卫一致）。类型 `WebSearchResult { title; url; snippet }` 本模块内定义 |
| `src/server/agents/runtime/verify-page.ts` | `runPageVerification(opts): Promise<AgentRunResult>`：triage → 搜索 → apply / 逐页降级；空 claims passthrough；frontmatter `sources` 追加；累积 `ctx.citedSources`。固定引用三个 skill id（triage/apply/self-check），经传入的 `resolveSkill` 解析、复用 `runAgentLoop` 执行每次 LLM 调用 |
| `examples/skills/ingest-verifier-triage.md` | 结构化无 tools；version 1；outputSchema = `{ doubtfulClaims: [{ excerpt, query, reason }] }`。只挑 callout 层中「值得联网核查的存疑断言」，confident 常识不挑 |
| `examples/skills/ingest-verifier-apply.md` | 结构化无 tools；version 1；outputSchema = `{ action, path, content, citedSources:[{url,title}] }`。拿 evidence 修正/软化/删除 callout；忠实正文逐字复刻、不加新 callout、frontmatter 不动；`citedSources` 只列**实际据以修正/支撑**的网页 |

### 修改

| 文件 | 改动 |
|------|------|
| `src/lib/contracts.ts` | 加 `WebSearchProviderSchema`（`z.enum(['tavily'])`，默认 `'tavily'`）/ `WebSearchApiKeySchema`（`z.string().max(N)`，**允许空串=未配置/关闭**）/ `WebSearchMaxResultsSchema`（`z.number().int().min(1).max(10)`，默认 5）+ 对应 `DEFAULT_*`；`AppSettings` 加 `webSearchProvider` / `webSearchApiKey` / `webSearchMaxResults` 三字段 |
| `src/server/db/repos/settings-repo.ts` | 加 3 个 key（`webSearchProvider`/`webSearchApiKey`/`webSearchMaxResults`）+ getter/setter（沿用 `readKey/writeKey/readNumber` 模式、zod 校验）+ 便捷 `getWebSearchConfig(): { provider; apiKey; maxResults }` 供 web-search.ts 一次读取 |
| `src/app/api/settings/route.ts` | `readSettings()` 补 3 字段；`PutBodySchema` 补 3 个 optional；PUT 分支补 set 调用 |
| `src/components/shared/settings-dialog.tsx` | 加 "Web search" section（provider 选择[当前仅 tavily] + apiKey 输入[password] + maxResults 数字），走 `GET/PUT /api/settings` + 本地 state，**不写 Zustand** |
| `src/server/agents/types.ts` | `PipelineStep` 联合加 `{ kind:'verify'; fromOutput; injectPriorPageAs?; checkpointAs?:'verifier-page' }`；`AgentContext` 加可选 `citedSources?`（累积桶）；类型 `CitedSource { url; title; citedBy: string[] }` |
| `src/server/agents/runtime/orchestrator.ts` | fanout 分支 per-item：`step.kind==='verify'` → `runPageVerification(...)`，否则 `runAgentLoop(...)`；其余骨架不动。`ctx.citedSources` 在 runPipeline 入口初始化 |
| `src/server/wiki/wiki-transaction.ts` | `SourceLinkOps` 由单 source 升级为 `{ links: Array<{ sourceId; pageSlugs: string[] }>; extraStagePaths?: string[]; linkPageSource; updateSourcePageLinks; onWarning? }`；`applyChangeset` 提交时 stage `affectedPaths ∪ extraStagePaths`，并遍历 `links` 写 page_sources + `updateSourcePageLinks` |
| `src/server/agents/tools/builtin/commit-changeset.ts` | `commitPending` 构造新版 `SourceLinkOps`：原 ingest 单源并入 `links`；接受调用方传入的 web source `links` + `extraStagePaths` |
| `src/server/services/ingest-service.ts` | verifier fanout step → `kind:'verify'`；`finalizeIngest` 在 commit 前遍历 `ctx.citedSources`：`extractContent(url)` → `saveRawSource(subject, filenameFromUrl, content)` → sourceId，组装 `links` + `extraStagePaths`（raw 文件 + sidecar），传入 `commitPending`；`MIN_SKILL_VERSIONS` 加 `ingest-verifier-triage:1`、`ingest-verifier-apply:1` |
| `llm-config.example.json` | 仅加 `tasks["skill:ingest-verifier-triage"]` / `["skill:ingest-verifier-apply"]` 模型路由注释示例（**搜索后端配置不在这里**，见全局设置） |

既有 `ingest-verifier`(v2) skill **保留不动**（降级路径）。新 skill 文件随 worker `seedSkillFiles` 自动播种（文件不存在才写），**无需手动删 vault 文件**。

---

## 五、数据流

1. **triage**：fanout 标准输入（slug/subjectSlug/content[增益页]/existingPages/relevantChunks/plan/languageDirective）→ `{ doubtfulClaims }`。
2. **搜索（编排层）**：`doubtfulClaims` 的 `query` 去重、取前 3，`Promise.allSettled(webSearch(q))`；汇成 evidence bundle：`[{ query, reason, excerpt, results:[{title,url,snippet}] }]`。**只把 snippet 喂 apply**（不喂 raw 正文，避免 prompt 膨胀）。
3. **apply**：输入 = 增益页 content + evidence bundle → `{ action, path, content, citedSources }`。
4. **provenance（编排层，apply 之后）**：
   - 把 `citedSources` 的 URL **追加进** apply 产出页的 frontmatter `sources`（去重；用 `wiki/frontmatter.ts` parse/serialize 确定性改写——apply 本身不准动 frontmatter）。改写后的 entry 进 `ctx.pending`。
   - 把 `{ url, title, citedBy:[slug] }` 累积进 `ctx.citedSources`（跨页按 URL 去重、合并 citedBy）。
5. **finalize（service 层，pipeline 之后、commit 之前）**：
   - 对 `ctx.citedSources` 每个唯一 URL：`extractContent([url])` 抓正文（失败回落该 URL 的 snippet）→ `saveRawSource(subject, filenameFromUrl(url,title), content)` → `{ id }`。
   - 组 `links = [{ sourceId, pageSlugs: citedBy }]`、`extraStagePaths = [raw 文件, sidecar json]`（`saveRawSource` 写入的两类文件相对 vault 的路径）。
   - 传入 `commitPending(ctx, metaEntries, { webLinks: links, extraStagePaths })` → `applyChangeset` 在同一 ingest commit 内 stage 这些文件 + 写 page_sources。

`filenameFromUrl`：host + 路径末段 + 短 hash + `.md`，`path.basename` 安全化（`saveRawSource` 已有越界防护）。

---

## 六、Provenance：网页 source 导入（核心需求）

「引用网页内容时把对应网页作为 source 导入」三层落地：

| 层 | 写什么 | 谁可见 |
|----|--------|--------|
| **source 实体** | `saveRawSource` → `sources` 表行 + `.llm-wiki/sources/<subject>/<id>.json` sidecar + `raw/<subject>/<file>` 正文；按内容 hash 去重 | rebuild 可从 sidecar 恢复；source 可再-ingest |
| **page ↔ source 溯源** | `page_sources`（`linkPageSource`），与 ingest 自身溯源一致 | DB/graph 结构（当前无阅读 UI 消费，留作溯源/未来图谱） |
| **读者可见引用** | 引用页 frontmatter `sources: string[]` 追加该 URL | `frontmatter-display` 渲染 + 随 vault round-trip |

> ⚠️ 关键：`page_sources` 当前**没有阅读 UI 消费**（仅 `/api/ingest`、`/api/reset` 触及）；读者看到的 source 来自 frontmatter `sources`。故第 3 层（frontmatter 追加）是「让引用对读者可见」的必要项，不可省。

**同一 commit**：扩展 `SourceLinkOps`（多 source + `extraStagePaths`）使网页 source 的 raw/sidecar 文件、page_sources、引用页（含更新后的 frontmatter）都进**同一次 ingest commit**——保持 ⑥ 版本历史/回滚的「整次操作一个 commit」粒度。

**已知限制（回滚不撤源）**：⑥ 回滚某次 ingest 操作会把页面正文还原到 preHead，但**不会撤销已导入的网页 source**（sources 行/文件/page_sources 残留为无害孤儿；`rebuild.ts` 以 sidecar 为权威可重建一致状态）。这与现有 ingest source 的累加语义一致，spec 显式接受。

**已知限制（断点续传不补源）**：`ctx.citedSources` 不进 checkpoint，且 `verifier-page` 命中检查点的页会跳过 `runPageVerification`（不重跑 triage/apply、不再累积 citedSources）。因此若 ingest job **崩溃后续传**，崩溃前已核查页的网页 source**不会被导入**——这些页的引用 URL 仍保留在其 frontmatter `sources`（读者可见层，已烘焙进 checkpoint 缓存的页内容），但缺 source 实体行 + `page_sources`（后者当前无阅读 UI）。仅发生在「崩溃 + 续传」这一稀有路径，且读者可见的 frontmatter 层不受影响，故 spec 显式接受为已知限制；如需补齐，fast-follow = 把 citedSources 一并持久化进 `verifier-page` checkpoint。

---

## 七、配置（全局设置）

搜索后端是"全 app 单实例"配置，落 `app_settings`（与 `wikiLanguage`/agent runtime 设置同管道），**不进 `llm-config.json`**：

| key（`app_settings`） | schema / 默认 | 说明 |
|------|------|------|
| `webSearchProvider` | `z.enum(['tavily'])`，默认 `'tavily'` | 当前仅 tavily，留扩展位 |
| `webSearchApiKey` | `z.string().max(N)`，默认 `''` | **空串 = 未配置/关闭 → 优雅降级纯自检** |
| `webSearchMaxResults` | `z.number().int().min(1).max(10)`，默认 `5` | 每 query 取回结果数 |

- 写读经 `settings-repo`（`getWebSearchConfig()` 一次读三字段；每次读 DB，UI 改即时生效、无需重启 worker）。
- `GET/PUT /api/settings` 收口（auth 守卫；GET 返回 apiKey 原值——与本 app 既有威胁模型一致：设置接口 auth-gated，`llm-config.json` 亦明文存 key）。
- 设置面板新增 "Web search" section（provider 选择 + apiKey password 输入 + maxResults），本地 state 暂存 + `useMutation` PUT，**不写 Zustand**。
- `isWebSearchConfigured()` = provider 合法 且 apiKey 非空（trim 后）。

**模型路由（仍在 `llm-config.json`）**：triage/apply 可经 `tasks["skill:ingest-verifier-triage"]` / `["skill:ingest-verifier-apply"]` 指定模型（task-router 已支持 `skill:` 前缀）；建议 apply 用强推理模型。缺省走 chat 默认模型。这是模型选择，与上面的"搜索后端配置"分属两处，互不混淆。

---

## 八、成本 / 预算 / checkpoint

- **成本**：confident 页只付 1 次**小输出** triage（比当前 P2 重发整页**更省**）；仅存疑页付搜索 + apply（整页输出）。worst case（每页都存疑）≈ triage(小) + apply(整页) ≈ 略高于当前。沿用 1.2M/job 预算余量；`estimateIngestCost`（`ingest-prep.ts`）**不改**（当前已按每页一次 verifier 估算，保守足够）。
- **预算计入**：triage/apply 两次 `runAgentLoop` 经同一 `BudgetTracker`；超限照常抛 `BudgetExceededError`（不可重试）。`extractContent`/`webSearch` 为外部 HTTP，不计 LLM token，仅 emit 遥测。
- **checkpoint**：仍是 `verifier-page` 整页粒度；中途崩溃的页整页重跑（从 triage 起）；搜索结果/extract **不落盘**（重跑重搜重抓，成本可接受）。`saveRawSource` 在 `finalizeIngest`（pipeline 成功之后）才执行——避免中途失败留下孤儿 source。

---

## 九、错误处理

- `webSearch(q)` 失败/超时（单查超时 ~8s）→ 该 query 计 0 结果；某页**全部** query 零结果 → 退回自检 skill（与全局降级统一收口）。
- `extractContent(url)` 失败 → 用该 URL 的 snippet 作为 source 正文（仍导入），emit `ingest:warn`。
- `saveRawSource` 抛错（如非法 filename）→ emit warn、跳过该 source 的导入与 page_sources（不阻断 commit）；frontmatter 中该 URL 仍保留（读者可见引用），只是无 source 实体。
- triage/apply 结构化输出失败 → 沿用 `agent-loop` 既有恢复（从 `err.text` 抢救）+ orchestrator fanout 的 fail-fast；该页落不下则整 job 失败回滚（既有行为）。
- 全程 emit `ingest:verify`（每页 flagged / searched / corrected / sourcesImported 计数）走 SSE。

---

## 十、降级矩阵

| 情形 | 行为 |
|------|------|
| 未配 webSearch | verify 步骤逐页跑 `ingest-verifier`(v2) 自检 = 当前 P2，零变化 |
| 配了，triage 无存疑断言 | 跳过搜索+apply，页原样通过（比 P2 更省） |
| 配了，有存疑但全部搜索零结果 | 该页退回自检 skill |
| 配了，有证据 | apply 证据驱动修正 + 网页 source 导入 |
| extract 失败 | snippet 兜底为 source 正文 |
| saveRawSource 失败 | 跳过该 source 实体，frontmatter URL 保留，不阻断 |

---

## 十一、测试

| 单元 | 用例 |
|------|------|
| `web-search.ts`（mock fetch + mock settings-repo） | 未配置（apiKey 空）→ `isWebSearchConfigured`=false；配置 → search 解析 Tavily 响应为 `WebSearchResult[]`；extract 解析正文；HTTP 错误抛出/被上层捕获；未配置调用 `webSearch` 抛 `LLMConfigError` |
| `settings-repo.ts`（沿用临时 DB fixture） | webSearch 三 key get/set round-trip + 默认回落；`getWebSearchConfig` 聚合；apiKey 空/非空、maxResults 越界校验 |
| `contracts.ts` schemas | `WebSearch*Schema` 合法/非法（坏 provider、maxResults 越界）；apiKey 允许空串 |
| `verify-page.ts`（mock skill + mock web-search） | ①未配置→自检 skill ②triage 空→passthrough（不调搜索/apply）③有证据→apply，citedSources 追加进 frontmatter `sources`、记入 `ctx.citedSources` ④有存疑+零证据→自检 skill ⑤passthrough/apply 的 action 由 existingPages 正确推断 |
| `wiki-transaction.ts`（扩展 SourceLinkOps） | 多 `links` 各自写 page_sources；`extraStagePaths` 进 stage 列表；空 links/paths 向后兼容（不破坏现有单源 ingest 链路） |
| `orchestrator.ts` | `kind:'verify'` step 路由到 `runPageVerification`；checkpoint 命中 `verifier-page` 跳过；pending upsert / 冲突检测仍生效 |
| `examples-roundtrip`（沿用 `skills/__tests__`） | triage/apply 的 frontmatter + outputSchema 合法、id 与文件名一致、version |
| `ingest-service`（mock saveRawSource/extract） | `finalizeIngest` 把 `ctx.citedSources` 转为 `saveRawSource` 调用 + `links`/`extraStagePaths`；空 citedSources 时不改原 commit 行为 |

---

## 十二、受影响文件清单

```
新增:
  src/server/search/web-search.ts
  src/server/agents/runtime/verify-page.ts
  examples/skills/ingest-verifier-triage.md
  examples/skills/ingest-verifier-apply.md
  （各自 __tests__）

修改:
  src/lib/contracts.ts                       # WebSearch 三 schema + DEFAULT + AppSettings 三字段
  src/server/db/repos/settings-repo.ts       # 3 key getter/setter + getWebSearchConfig
  src/app/api/settings/route.ts              # readSettings + PutBodySchema + set 分支补 3 字段
  src/components/shared/settings-dialog.tsx  # "Web search" section（不写 Zustand）
  src/server/agents/types.ts                 # verify step kind + AgentContext.citedSources + CitedSource
  src/server/agents/runtime/orchestrator.ts  # verify step 路由 + citedSources 初始化
  src/server/wiki/wiki-transaction.ts        # SourceLinkOps 多源 + extraStagePaths
  src/server/agents/tools/builtin/commit-changeset.ts  # commitPending 接 web source links
  src/server/services/ingest-service.ts      # verify step; finalizeIngest 导入 cited sources; MIN_SKILL_VERSIONS
  llm-config.example.json                    # 仅 skill 模型路由示例（搜索后端不在此）

文档（合并后同步）:
  src/server/agents/CLAUDE.md / search 相关 / src/server/CLAUDE.md / 根 CLAUDE.md changelog
```

---

## 十三、风险与缓解

| 风险 | 缓解 |
|------|------|
| 工具死循环复发 | 架构上根除：全程 `generateObject` 无 tools，搜索在编排层 |
| web 检索仍漏判细微错误 | callout 可见溯源 + frontmatter `sources` 让读者自校；lint contradiction 兜底 |
| Tavily 依赖 | 未配置优雅降级纯自检；provider 留枚举扩展位（未来可加 brave/searxng） |
| 抓取任意网页正文（SSRF/超大页） | extract 仅对 apply 已选定的 URL；单页超时 + 大小截断（如 ≤ EMBED 级别字符上限）；失败回落 snippet |
| Saga 改动触及写入咽喉 | `SourceLinkOps` 向后兼容（空 links/paths 等价原行为）；扩展点测试覆盖；不改 commit 顺序 |
| 回滚不撤源 | 显式接受为累加语义；rebuild 以 sidecar 为权威 |

---

## 十四、实现阶段建议（供 writing-plans 拆任务）

1. 全局设置链路：`contracts.ts` 三 schema/默认 + `settings-repo` 三 key/`getWebSearchConfig` + `/api/settings` 三字段 + settings-dialog "Web search" section —— 自成一组、可独立测。
2. `web-search.ts`（纯 HTTP 客户端：Tavily search+extract + 经 `getWebSearchConfig` 的配置守卫）—— 叶子、mock fetch 可独立测。
3. 两个 skill 模板（triage/apply）+ examples-roundtrip。
4. `wiki-transaction.ts` `SourceLinkOps` 多源 + `extraStagePaths`（向后兼容）+ `commit-changeset.ts` 适配。
5. `verify-page.ts`（triage→搜索→apply→降级→frontmatter 追加→citedSources 累积）+ `types.ts` 类型。
6. `orchestrator.ts` verify step 路由 + citedSources 初始化。
7. `ingest-service.ts` verify step 接线 + `finalizeIngest` 导入 cited sources + `MIN_SKILL_VERSIONS` + `llm-config.example.json`。

---

_本设计经 brainstorm 确认：确定性两段式（绕开 packyapi 工具死循环）+ HTTP/Tavily 后端（配置落全局设置 `app_settings`，设置面板可配）+ 配了就开/没配降级 + 按需抓正文把被引用网页导入为 source（三层 provenance：source 实体 + page_sources + frontmatter 可见），同一 ingest commit 落地。_

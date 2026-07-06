# 第二大脑演进路线 — 分阶段实施主计划

> **For agentic workers:** 本文件是路线图主计划。规模标注为 **S** 的任务可直接按任务卡实施（配合 superpowers:subagent-driven-development 或 superpowers:executing-plans）；标注 **M/L** 的任务在动手前**必须**先走 brainstorm → spec → 独立详细 plan（仓库既有惯例），本文件只锁定其范围、方案要点、验收标准与依赖。

**目标：** 把系统从"很好的 wiki 生成器"演进为"自学习第二大脑"——自主维护可信、资料收集闭环接通、认知镜像可进化。

**依据：** 2026-07-06 四方向代码级评估（ingest 流水线 / Saga 核心 / 质量闭环 / 检索消费侧）+ Nick 确认的目标三支柱（自主维护 / 省去收集与泛化 / 认知镜像助掌握）。

**架构原则（全局约束，所有任务默认遵守）：**

- Saga 顺序不可绕过；写 vault 必经 `createChangeset → validateChangeset → applyChangeset`，失败必补偿。
- 确定性优先：能用纯函数解决的不用 LLM；LLM 输出一律 `generateObject` + zod。
- canonical 中性 / 读时个性化的宪法边界不动摇：画像相关产物永不写入 vault 正文。
- 新增任何 subject-scoped 表，必须同步补 `subjects-repo.deleteWithContents` 级联删除。
- 单一真实源纪律：wikilink 解析只走 `wikilinks.ts`；领域类型进 `lib/contracts.ts`；全局设置进 `app_settings` + `settings-repo`。
- 中文 commit message 一句话总结；不加 AI 署名。

**阶段总览与依赖：**

```
阶段一 信任地基（正确性收口 + 保真统一）      ← 一切自治功能的前提
   ↓
阶段二 规模天花板（去全量化 + 检索规模化）     ← 库长大前拆掉，独立于阶段三/四
   ↓（弱依赖，可与阶段二并行启动）
阶段三 收集闭环（缺口→研究→ingest）           ← 目标"省去资料收集"的兑现
   ↓
阶段四 认知镜像（知识状态画像 + 掌握闭环）     ← 目标"更易理解和掌握"的兑现
```

---

## 阶段一：信任地基

> 主题：让"放手给 agent"有正当性。本阶段完成前，不推进任何新的自治能力。

### T1.1 Saga 提交点原子性（roll-forward 恢复）— 规模 S/M

**问题：** `wiki-transaction.ts:272-281` git commit 成功后才把 operations 置 `applied`；进程在此窗口崩溃 → `worker-entry.ts:84-119` 恢复时把**已成功提交的变更**误回滚（`reset --hard`），静默丢数据。这是全系统最严重的正确性缺口。

**方案要点：**
1. `commitVaultChanges` 的 commit message 追加确定性标记 `[cs:<changesetId>]`（现有 `[subject:<slug>]` 之后）。
2. `git-service.ts` 新增 `getHeadCommitMessage(): Promise<string>`。
3. 恢复流程（`worker-entry.ts` 扫 pending operations 处）改为三分支：
   - HEAD message 含本 changeset id → **前滚**：补 `post_head`、置 `applied`、对 touched pages 幂等重跑 `indexTouchedPages`；
   - 不含且 `getVaultHead() === preHead` 或存在未提交改动 → 按现状回滚；
   - 不含且 HEAD ≠ preHead 且非本 changeset（他人已提交）→ 只标记 `rolled-back` 并 emit 告警，不做 `restoreToHead`（避免误伤后续提交）。

**涉及文件：** `src/server/git/git-service.ts`、`src/server/wiki/wiki-transaction.ts`、`src/server/worker-entry.ts`、`src/server/wiki/__tests__/`（恢复分支单测：构造"pending op + HEAD 已含 cs 标记"的 vault fixture）。

**验收标准：**
- 模拟"commit 后崩溃"场景恢复后：文件保留、op 状态 `applied`、SQLite 索引与 vault 一致。
- 常规失败路径回滚行为不变（现有测试全绿）。

### T1.2 回滚补偿完整化（page_sources / sidecar）— 规模 S

**问题：** `wiki-transaction.ts:244-265` 写入的 `page_sources` 行与 sidecar 更新不在 `rollbackChangeset` 补偿范围，失败 changeset 残留孤儿溯源。

**方案要点：**
1. `updateSourcePageLinks`（sidecar 写入）从第 253-265 行**移到 git commit 成功之后**执行（best-effort，失败仅告警）——顺序调整直接消除该项的补偿需求。
2. `page_sources` 插入时在 working changeset 内记录 `(pageSlug, sourceId)` 清单；`rollbackChangeset` 按清单删除本次插入的行。

**验收标准：** 构造 index 事务后、commit 前抛错的用例，回滚后 `page_sources` 无本次残留、sidecar 未被修改。

### T1.3 vault 文件锁心跳续租 — 规模 S

**问题：** `vault-mutex.ts:29-47` 锁文件 mtime 创建后从不刷新、10 分钟固定超时、`process.kill(pid,0)` 受 PID 复用误判。ingest 并发调度（2026-07-06）落地后，vault 一致性完全押在这把锁上，弱点权重变大。

**方案要点：**
1. 持锁期间 30 秒间隔 `utimesSync` 刷新锁文件 mtime；释放时清定时器。
2. stale 判定改为：mtime 超过 3× 心跳间隔 **且**（进程不存活 **或** mtime 超硬上限 30 分钟）。
3. 锁文件内容加进程启动时间戳，`isProcessAlive` 命中时二次比对，降低 PID 复用误判。

**验收标准：** 单测覆盖——长持锁（>10 分钟，mock 时钟）不被夺；死进程锁在一个判定周期内被回收；心跳定时器在异常路径也被清理。

### T1.4 统一保真护栏（共享 fidelity 模块）— 规模 M（先出独立 spec）

**问题：** 四条"LLM 改写正文"路径保真标准不一：re-enrich supplement 4 项护栏 floor=0.95；fix `bodyShrankTooMuch` floor=0.5（可静默删近半正文，`fix-deterministic.ts:58-62`）；Lens 整页重塑仅 wikilink 子集校验、无长度 floor（`fidelity.ts:11-21`）；**ingest 更新已有页完全无确定性校验**（`orchestrator.ts:269-278` 只注入不校验）——恰是"增量构建"核心愿景所在的路径。

**方案要点：**
1. 新建 `src/server/wiki/rewrite-fidelity.ts`：`checkRewriteFidelity(original, revised, profile): { ok, violations[] }`；检查项 = 长度 floor、wikilink 目标集合约束（update 场景要求原链接集合为修订版子集）、heading 保留、frontmatter 键不变。
2. 预设分级 profile：`supplement`(0.95，收编现有 supplement-guard)、`merge-update`(0.85，ingest 更新已有页)、`fix`(0.8，替换现 0.5)、`reshape`(0.8 + 链接子集，替换现纯链接校验)。
3. 接入点：orchestrator 对 update 页的 writer 产物 post-check（违规 → 携 violations 重写一次 → 仍违规回落"保留原文 + 追加新材料段"的保守合并）；`fix-tools.ts:61-65`；`reshape-service.ts:50-57`。
4. `supplement-guard.ts` 与 `profile/fidelity.ts` 收编进新模块，删除重复实现。

**验收标准：** 四路径全部经同一模块；ingest 反复 update 同一页时既有 wikilink/heading 不丢失（集成测试）；fix 无法再通过 49% 缩水。

### T1.5 token 预算预扣制 — 规模 S/M

**问题：** `agent-loop.ts:67,95` 调用前校验、调用后记账，fanout N 页并发全部在扣费前通过闸门（`budget.ts:16-27` 无预留），`maxTokensPerJob` 对大文档形同虚设。

**方案要点：** budget tracker 加 `reserve(estimate): ReservationHandle` / `settle(handle, actual)`；fanout 派发每页前按 per-page 估算预扣，run 结束结算差额；`assertWithin` 计入 reserved 部分；预扣失败 → 该页排队等待其他页结算释放额度（信号量语义），而非直接失败。

**验收标准：** 并发 fanout 单测：任意时刻 `spent + reserved ≤ maxTokensPerJob`；超预算大文档在预检或首批预扣时确定性拒绝。

### T1.6 WriterConflict 与检查点顺序 — 规模 S

**问题：** `orchestrator.ts:156-175` 冲突检测发生在逐页检查点落盘（156-159）之后，冲突页已进 checkpoint → 重试续传原样加载缓存、冲突确定性复现、永久死锁。

**方案要点：** ① 冲突检测提前到 `checkpoint.put` 之前；② resume 加载缓存页时重放同 path 冲突校验，命中则丢弃后写者的检查点条目并 emit `ingest:warn`。

**验收标准：** 构造两 writer 同 path 的 plan，job 失败后 retry 能走通（后写者页被重新生成或丢弃）。

### T1.7 curate/fix tool-loop 取消信号 — 规模 S

**问题：** `provider-registry.ts:200-224` 只挂超时 AbortController，不接 `cancel_requested`；用户取消运行中的 curate/fix 只能干等。

**方案要点：** `generateTextWithTools/streamTextWithTools` 加可选 `shouldCancel?: () => boolean`，内部定时轮询（2s）命中即 abort 并抛 `AgentCancelled`（进 worker 现有不可重试分类）；curate/fix service 传入 `() => queue.isCancelRequested(jobId)`。

**验收标准：** 取消运行中的 curate job，在下一个工具步边界内终止且状态为 cancelled 语义（复用现有 `result_json.cancelled`）。

### T1.8 成熟度信号质量化 — 规模 M（可后置到阶段三前）

**问题：** `maintenance-policy.ts:16,75-81` 收敛信号只数 callout 与正文增量——是"体量代理"，LLM 堆噪声也会被判为"仍活跃"；无法支撑"放心默认开启维护"。

**方案要点：** `nextMaturity` 输入加 `qualityDelta`：re-enrich 后记录 verifier 核查通过率变化 + 该页确定性 lint finding 数变化；体量信号降权为辅助项。毕业条件同时考虑"源新鲜度"（stale-source 命中则不毕业）。

**验收标准：** 纯函数单测——质量无改善时即便正文大幅增长也进入 saturation 轨道；stale 源页不毕业。

**阶段一出口条件：** T1.1–T1.7 全部合入且测试通过后，重新评估维护开关默认值（文档化"可开启"判据：保真护栏统一 + 取消可用 + 质量信号就位）。

---

## 阶段二：规模天花板

> 主题：在库长到几百页之前拆掉三个随规模恶化的结构瓶颈。各任务相互独立，可并行。

### T2.1 index/log 页去 LLM 化（确定性渲染）— 规模 M

**问题：** 每次 ingest 的 finalize 把**全 subject 页清单**喂给 `ingest-indexer` LLM 重建 index/log（`ingest-service.ts:239,274-282`）；页数上几百后 prompt 单调膨胀直至超上下文，且每次 ingest 都付一遍全量 token。目录/日志本质是确定性可派生数据。

**方案要点：** 新纯函数 `renderIndexPage(pages: PageMeta[]): string`（按 tag 分组 + 字母序目录）与 `renderLogPage(recentOps)`（最近 N 条操作摘要）；`finalizeIngest` 删除 indexer LLM 调用，直接确定性渲染进同一 commit；`MIN_SKILL_VERSIONS` 移除 indexer 项，`ingest-indexer.md` skill 退役（rollout 说明写清）。

**验收标准：** ingest 后 index/log 可复现（快照测试）；单次 ingest 的 LLM 调用数减一；500 页 fixture 下 finalize 耗时有界。

### T2.2 existingPages 检索式注入 — 规模 M

**问题：** 全量现有页清单注入**每一个** writer/enricher/verify 调用（`orchestrator.ts:246-248`），token 成本 O(现有页数 × 本次页数)，随库规模平方增长。

**方案要点：** planner 保持全量（或分页目录，它需要全局视野判断复用 slug）；fanout 各页注入改为：该页 plan 摘要经 hybrid 检索取 top-20 相关现有页（标题+slug+一行摘要）∪ 该页草稿中已出现的 wikilink 目标。`buildFanoutInput`（`orchestrator.ts:226-280`）改造，检索走现成 `hybridRankSlugs`。

**验收标准：** 500 页 fixture 下单页 fanout 输入 token 有界（<既有全量注入的 20%）；"更新已有页"判定准确率不回退（planner 侧不受影响）。

### T2.3 向量检索规模化 + 新鲜度标记 — 规模 M（先出独立 spec）

**问题：** 每次查询全量载入 subject 向量逐行算余弦（`semantic-search.ts:11-18`、`embeddings-repo.ts:40-56`），无近似最近邻索引；embed 回填异步而 FTS 同步，"刚 ingest 完立刻提问"命中陈旧向量。

**方案要点：** 分两步走——① 先做进程内 LRU 缓存（subject → 解码后的向量矩阵，content_hash 集合变化即失效），把每查询的 BLOB 解码成本摊掉；hybrid 合并时对 `content_hash` 与当前页不匹配的向量命中降权或剔除（消除新鲜度窗口的错误排序）。② 库超 ~5k 页再引入 sqlite-vec（本阶段只留接口缝，不引依赖）。

**验收标准：** 1k 页基准查询 p95 < 50ms；刚更新且向量未回填的页不再以旧向量参与排序（单测）。

### T2.4 operations 表 GC + rebuild 接线 — 规模 S

**问题：** `operations` 无限增长（无任何 prune）；`rebuildDatabaseFromVault` 存在但生产零调用方——灾难恢复能力没接线。

**方案要点：** ① worker sweep 加 `pruneOldOperations`：每 subject 保留最近 500 条或 90 天（取宽），永不删除 status='applied' 且未被 revert 链引用的最近一条；② 新增 `npm run db:rebuild` script 调 `rebuildDatabaseFromVault`，并在 README/CLAUDE.md 记录；③ 顺手修正 `db/CLAUDE.md:120` 关于 FTS 触发器的失实描述（实际为手动维护）。

**验收标准：** prune 单测（保留边界）；手动 rebuild 后 pages/links/FTS/sources 与重建前一致（现有 rebuild 测试扩展）。

### T2.5 检索评估基线 — 规模 S

**问题：** `RRF_K=60`/`VEC_K=10` 为拍定常数，全仓无召回评测，混合检索是否优于单路无从验证；T2.3 调优缺依据。

**方案要点：** `scripts/eval-retrieval.ts` + 入库 golden set（`scripts/fixtures/retrieval-golden.json`，20–30 条"查询 → 期望页"）；输出 recall@5/10 与 MRR，对比纯 FTS / 纯向量 / RRF 三路。

**验收标准：** 脚本可跑、三路对比输出成表；后续检索改动附带评估数字。

---

## 阶段三：收集闭环

> 主题：兑现"省去资料收集"。零件全部现成（Tavily 搜索/抓取、URL ingest、coverage-gap 检测），缺的只是串联。

### T3.1 research job：缺口 → 联网研究 → ingest — 规模 L（必须先 brainstorm + spec）

**问题：** lint 能检出 `coverage-gap` 但 fix 明确不修（`fix-deterministic.ts:8-9`）——系统能看见"缺一块知识"然后什么也不做；获取完全靠人工投喂。

**方案骨架（spec 阶段细化）：**
- 新任务类型 `research`：输入 = coverage-gap findings（或手动主题）→ LLM 生成检索 query（复用 verify triage 的形状与降级链）→ `web-search.ts` Tavily 搜索 + extract → LLM 相关性/质量筛选候选源 → `saveRawSource` + 入队现成 ingest（复用 URL ingest 三件套）。
- 硬护栏（工具层确定性，非提示词）：每 job 源数 cap（≤3）、域名黑白名单（`app_settings`）、独立 token 预算、**默认人工确认**——首版入口为 Health 页 "Research gaps" 按钮，展示候选源清单待勾选后才 ingest；全自动模式后置。
- 与现有体系交互：research 产生的 ingest 走全部既有护栏（保真、curate、embed）；job 事件接 `use-job-stream`。

**验收标准：** Health 页触发 → 候选源确认 → 新 sources 落地 + ingest jobs 完成 → 缺口对应新页生成且 lint 复扫该 gap 消失。

**依赖：** 阶段一全部（自治写入的信任前提）；建议 T2.1/T2.2 先行（research 会放大 ingest 频次，先拆掉 O(N²)）。

### T3.2 Ask AI 未命中 → 待研究队列 + 联网检索 — 规模 M

**问题：** Ask AI 遇库内无答案只回"无内容"（`query-service.ts:45-46`），最高质量的收集信号被丢弃；工具集无 web-search（Tavily 仅 verifier 在用）。

**方案要点：**
1. 新表 `research_backlog`（subject-scoped：question、来源=ask-ai/manual、状态、时间；记得补级联删除）；query 循环末尾结构化自报 coverage 不足时写入 backlog。
2. 仪表盘/Health 展示 backlog，一键转 T3.1 research job。
3. Ask AI 工具集加只读 `web.search`（Tavily，答案中网络来源显式标注"未入库"，不自动写库）；`tool-activity.ts` 补图标映射。

**验收标准：** 库内无答案的提问落入 backlog；开启 web.search 后同问题能给出标注来源的网络答案；backlog 一键转 research 可走通。

**依赖：** T3.1（转研究部分）；web.search 工具部分可独立先行。

### T3.3 主题订阅（节律性主动收集）— 规模 L（后置，需独立 spec）

**方案骨架：** `subjects` 加 watch 配置（关键词、频率）；worker sweep 按节律发起 research job；与维护 sweep 共用闸门与预算上限；默认关闭。**依赖：** T3.1 稳定运行 + 阶段一出口条件达成。

---

## 阶段四：认知镜像加深

> 主题：镜像从"你喜欢什么讲法"进化为"你已经懂什么"，并补上"掌握"的闭环。

### T4.1 行为信号采集层 — 规模 M

**问题：** 画像进化只靠手动"太难/太浅"反馈，信号稀疏；而对话内容、选区追问、quiz 交互等行为数据已在库里或前端事件里，未被采集。

**方案要点：** 扩展 `profile_signals` 信号类型与采集点——selection-ask（现有事件源）、Ask AI 提问主题（写入时脱敏为主题标签）、quiz callout 交互（前端 callout 加作答交互：对/错/跳过，回传 `POST /api/profile/signals`）、页面重复阅读；`signal-reducer` 按信号类型加权（显式反馈 > quiz 结果 > 行为推断），阈值防抖机制保留。

**验收标准：** 各信号类型落库有单测；reducer 加权后画像档位变化符合预期（纯函数测试）。

### T4.2 per-subject 知识状态画像 — 规模 L（必须先 brainstorm + spec）

**问题：** 画像是全局二维（背景 + 表达偏好），建模"怎么讲你舒服"而非"你在各领域懂到什么程度"；同一人在不同 subject 的重塑应完全不同。

**方案骨架：** `user_profiles` 扩为全局偏好 + per-subject 知识状态（familiarity 档位 + 已掌握概念集，页 slug 粒度起步）；来源 = T4.1 信号 + T4.3 quiz 结果；`reshape` 与 re-enrich `supplement` 的 PromptContext 注入 per-subject 画像；canonical 中性边界不变。**依赖：** T4.1。

### T4.3 读者侧间隔复习（掌握闭环）— 规模 L（需独立 spec）

**问题：** 系统给页面做了间隔重复（成熟度阶梯 1/3/7/21/60 天）却没给读者做；quiz 生成后无人追踪作答，"掌握"无机制。

**方案骨架：** 新 `review_schedule` 表（user × page，复用 SPACING_LADDER 的阶梯形状或简化 SM-2）；仪表盘"今日复习"队列 → 呈现到期页的 quiz callouts → 作答结果回写调度（答对升档、答错降档）并作为 T4.2 知识状态信号；与页面成熟度体系互不干扰（读者节律 ≠ 页面节律）。**依赖：** T4.1；可与 T4.2 并行起步（先用页粒度）。

---

## 范围外（本路线图有意不含）

- **图谱知识发现**（跨 subject 边、社区检测、孤儿聚焦）与 **界面重设计**（IDEAS.md）：属"消费侧体验"独立方向，与目标三支柱正交，建议在阶段三之后单独立项。
- **sqlite-vec 引入**：T2.3 仅留接口缝，库规模超 ~5k 页再启动。
- **subject 级联删除的表驱动重构**：现以全局约束（新表必补级联）纪律兜住，暂不重构。

## 实施节奏建议

| 顺序 | 内容 | 说明 |
|------|------|------|
| 第 1 批 | T1.1 + T1.2 + T1.3 | 三个 S 级正确性修复，可一个 worktree 内连续完成 |
| 第 2 批 | T1.4（先 spec）、并行 T1.5–T1.7 | 保真统一是阶段一的核心交付 |
| 第 3 批 | T2.1 + T2.2 + T2.4 + T2.5 | 拆天花板；T2.3 视库规模可缓 |
| 第 4 批 | T3.1（先 brainstorm+spec）→ T3.2 | 收集闭环，目标差异化能力 |
| 第 5 批 | T1.8 → 评估维护默认开启；T4.1 → T4.2/T4.3 | 自治开启 + 镜像加深 |

每个任务独立 worktree（`feat/<描述>`）、完成回合主分支；M/L 任务动手前先出 spec 并确认。

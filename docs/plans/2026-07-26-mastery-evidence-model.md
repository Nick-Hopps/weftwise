# Plan：证据流与逐页掌握度模型

日期：2026-07-26
设计稿：[docs/specs/2026-07-26-mastery-evidence-model.md](../specs/2026-07-26-mastery-evidence-model.md)

按 TDD 推进，每个任务独立可验证、独立提交。`profile_signals` 的替换严格按
「并存加新（任务 11）→ 原子切换（任务 12）→ 删旧（任务 13）」三步，每步系统可运行。

**并行提示**：任务 1、2、5 互不依赖，可任意顺序开始。任务 5（`deriveMastery`）是纯函数、
零 IO，也是整个设计里唯一有真实逻辑复杂度的地方——建议优先写透，它是后续所有消费方的契约。

---

## 任务 1：`ingest-enricher` v7 —— quiz callout 携带答案

> ⚠️ **第一步必须先取当前 v6 原版哈希，改文件之后就取不到了**（可从 git 恢复，但别踩）。
> 本计划已预取：`80b59ca6cac1379537030d577a4802f25cbed8b050ff48bb6e1f3e60550c9a2d`
> 复核命令：`git show HEAD:examples/skills/ingest-enricher.md | shasum -a 256`

- `examples/skills/ingest-enricher.md`：`version: 6 → 7`；quiz callout 段落改为
  「问题（+可选提示）→ `---` → 答案」，并写明答案要求：1–3 句、可自检、
  **不得引入正文里没有的事实**、`---` 分隔符不随 `languageDirective` 翻译。
- `src/server/agents/skills/builtin-manifest.ts`：`BUILTIN_UPGRADE_HASHES['ingest-enricher']`
  追加上述 v6 哈希。**漏这一步，所有未改过 skill 的既有 vault 都会卡在 v6 撞版本门。**
- `src/server/services/ingest-service.ts:200`、`src/server/services/reenrich-service.ts:147`：
  版本门 `'ingest-enricher': 6 → 7`。
- 测试：`ingest-enricher.load.test.ts` 断言 v7 与带答案 quiz 的契约；
  新增 manifest 断言「v6 哈希在白名单内」（防未来再漏）。
- 验证：`npx vitest run src/server/agents/skills/__tests__/`
- 人工验证：删掉本地 `vault/.llm-wiki/skills/ingest-enricher.md` 之外的情况下重启 worker，
  确认 v6 副本被自动升级为 v7 而非报错。

## 任务 2：`page_evidence` 表 + `user_profiles.style_prefs_updated_at`

- `src/server/db/schema.ts`：新增 `pageEvidence`（字段见 spec 第七节；
  `subject_id` FK → `subjects` ON DELETE CASCADE）；
  `userProfiles` 加 `style_prefs_updated_at TEXT`（reducer 的消费边界专用，
  **不能复用 `updated_at`**——后者改背景自述也会变，会误清信号窗口）。
- `src/server/db/client.ts::ensureTables`：`page_evidence` 补
  `CREATE TABLE IF NOT EXISTS` + `page_evidence_page_idx` / `page_evidence_scope_idx`；
  **`user_profiles.style_prefs_updated_at` 必须走守卫式 ALTER**——
  `PRAGMA table_info(user_profiles)` 检测列缺失 → `ALTER TABLE … ADD COLUMN`。
  `CREATE TABLE IF NOT EXISTS` 对**已存在**的表什么都不做，只写它等于既有安装升级后
  拿不到新列、读写立刻 SQL 报错。仓库有多处先例（`subjects.augmentation_level` /
  `jobs` 补列循环 / `operations.subject_id` / `llm_usage`）。
- `npm run db:generate` 产出迁移文件（编号自动分配，勿写死——plan ② 若先落地会占用前一个号）。
- 新增 `src/server/db/__tests__/page-evidence-table.test.ts`：真实 SQLite 建表、
  两个索引存在、`subject_id` CASCADE 生效（删 subject 后证据行消失）。
- 验证：`npx vitest run src/server/db/__tests__/page-evidence-table.test.ts`

## 任务 3：`evidence-repo`

- 新增 `src/server/db/repos/evidence-repo.ts`：`appendEvidence` / `listForPage` /
  `listForSubject` / `deleteByPage` / `movePage`。
  `polarity` / `strength` 由 `kind` 确定性派生后落列（映射表与 kind 联合类型同处定义，
  新增 kind 时穷尽 switch 暴露遗漏）。
- 新增 `src/server/db/repos/__tests__/evidence-repo.test.ts`：append 后可按页读回、
  `listForSubject` 分组正确、`deleteByPage` 只删目标页、`movePage` 迁移且不串页、
  未知 kind 拒绝写入。
- 验证：`npx vitest run src/server/db/repos/__tests__/evidence-repo.test.ts`

## 任务 4：证据的页面生命周期闭合

- `src/server/services/page-write.ts::deletePageInSubject`：删页时 `deleteByPage`。
- `src/server/wiki/page-identity-migration.ts::migratePageIdentityCaches`：按既有六项
  （`page_sources` / `page_embeddings` / `page_maturity` / `page_renditions` /
  `page_rendition_assets` / `profile_signals`）同一 `INSERT…SELECT + DELETE` 模式
  加 `page_evidence` 块。
- `src/server/db/repos/subjects-repo.ts::deleteWithContents`、
  `src/app/api/reset/route.ts`：清理清单补 `page_evidence`。
- 测试：新增/扩展集成用例——删页后重建同名 slug 得到零证据（**不复活**）；
  move 后证据跟随新 slug；`deleteWithContents` 与 reset 各清一次。
- 验证：`npx vitest run src/server/db/repos/__tests__/subjects-cascade-delete.test.ts src/server/wiki/__tests__/page-move-integration.test.ts src/app/api/reset/__tests__/route.test.ts`

## 任务 5：`deriveMastery` 四态派生纯函数（核心）

先把全部用例写成失败测试，再实现。

- 新增 `src/server/profile/mastery.ts`：`MasteryState` / `MasteryConfidence` /
  `EvidenceRow` / `MasteryVerdict`（含 `expiresAt`）、`deriveMastery(evidence, now)`、
  `masteryWindowDays(n): { dueDays, expiryDays }`、`NEGATIVE_WINDOW_DAYS`、
  `MAX_RECENT_EVIDENCE`。
- 新增 `src/server/profile/__tests__/mastery.test.ts`：
  - 空输入 → `unknown` / `none`
  - 五条优先级（spec 决策 3）各自命中，且顺序正确
  - 负证据压过正证据（quiz 答对过但近期有 `selection-ask` → `struggling`）
  - `mastered` 过期回落 **`exposed`** 而非 `unknown`；`expiresAt` 仅 `mastered` 时非空
  - **决策 4 两级语义逐档断言**：1→{1,4} / 2→{3,10} / 3→{7,28} / 4→{21,81} / ≥5→{60,120}；
    **`expiryDays` 恒 > `dueDays`**（防退化回「到期即失效」——原设计的阻断级缺陷）
  - **连击三条定义**（每条锁一个具体失真）：页级累加（同页不同 quiz，不要求同一道题）；
    **同一天多条正证据只算 1**（防反复点判分刷到 120 天）；
    **只有 strong 负证据清零连击**（`citation-hit` 不得打断）
  - **规则 3 的 strength 门槛**：单条 `self-report-easy`、单条 weak `quiz-correct`
    都**不足以判 `mastered`** → 落 `exposed`；两条 weak 正证据才到 `mastered/low`；
    含 strong 则 `mastered/high`
  - 弱负证据单独出现 → `exposed`，**不判 `struggling`**（已定决策 4）
  - `recent` 按时间倒序且截断稳定
- `src/lib/contracts.ts`：加 `MasteryState` / `MasteryVerdict` / `EvidenceKind` DTO。
- 验证：`npx vitest run src/server/profile/__tests__/mastery.test.ts`

## 任务 6：`createRemarkQuiz()` 插件 + `fnv1a`

- 新增 `src/lib/stable-hash.ts`：`fnv1a(text): string`（同步、非加密）。
- `src/lib/markdown-client.ts`：新增 `createRemarkQuiz()`——在 `createRemarkCallouts`
  之后、**且排在 `createRemarkSelectionBlocks()` 之后**注册（spec 决策 6 的顺序约束）；
  按首个 `thematicBreak` 切分，答案段包 `data-quiz-answer` 容器，
  问题段文本 hash 写 `data-quiz-id`。
- 测试（`src/lib/__tests__/markdown-quiz.test.ts` 新增）：
  有 `---` 正确切分 / 无 `---` 原样放行 / 多个 `---` 只按第一个切 /
  非 quiz callout 不受影响 / 答案改写不改 `data-quiz-id`、问题改写则改 /
  与 `selectionBlocks` 同时启用时顶层块 offset 不变。
- 验证：`npx vitest run src/lib/__tests__/markdown-quiz.test.ts src/lib/__tests__/stable-hash.test.ts`

## 任务 7：`interactive` 接缝 + `<QuizBlock>`（暂不发证据）

本任务只建接缝与静态形态，**不接网络**——保证接缝隔离可以独立评审。

> **接缝归属**：`RenderOptions.interactive` 由先落地的一方建。若
> [plan ②](./2026-07-26-known-concept-map-surfaces.md) 的任务 4 已先行完成，
> 接缝已存在（且已带 `assumedKnown` 字段），本任务只需复用并挂 `<QuizBlock>`。

- `src/lib/markdown-client.ts`：`RenderOptions` 加
  `interactive?: { pageSlug: string; subjectSlug: string }`；`div` 覆盖按 `data-quiz-id`
  挂 `<QuizBlock>` 并透传该上下文。
- 新增 `src/components/wiki/quiz-block.tsx`：问题 + 答案折叠开关（纯本地）；
  有 `interactive` 时**预留**判分按钮位（任务 8 接线）。
- `src/components/wiki/page-renderer.tsx`：透传 `interactive`，成为**唯一**传入方。
- 测试：不传 `interactive` 时渲染结果不含判分按钮——对 Chat / 编辑器预览 /
  Source 查看器三条路径各断言一次；答案折叠在传与不传两种情况下都生效。
- 验证：`npx vitest run src/lib/__tests__/ src/components/wiki/__tests__/`

## 任务 8：`POST /api/evidence` + quiz 判分接线

- 新增 `src/app/api/evidence/route.ts`：`requireAuth` + `requireCsrf` +
  `resolveSubjectFromRequest(required)`；body `{ slug, kind, anchor?, detail? }`；
  **写前 `getPageBySlug` 校验 slug 在该 subject 内存在，不存在 404 不落行**
  （否则陈旧客户端会持续累积指向幽灵页的证据，生命周期闭合兜不住）。
  `detail_json` 承载 `viewedSource` / `profileVersion` 等归因字段。
- `quiz-block.tsx`：揭晓后渲染「我答对了 / 我答错了」；按 spec 决策 5 的不对称落 strength
  （有答案判分 → strong；无答案自评答对 → weak、答错 → strong）。失败只 `console.error`。
- 新增 `src/app/api/evidence/__tests__/route.test.ts`：鉴权/CSRF/subject 必填；
  未知 kind 400；写入成功返回 201。
- 验证：`npx vitest run src/app/api/evidence/__tests__/route.test.ts src/components/wiki/__tests__/`
- 人工验证：`npm run dev:all`，在一篇带 v7 quiz 的页面上走完「揭晓 → 判分」，
  查 `page_evidence` 表确认落行且 strength 正确。

## 任务 9：服务端已有落库点接入 D2 / D3 / D4

三处都是 best-effort，包 try/catch，失败只 `console.error`，**不得影响主流程**。

- `src/app/api/query/route.ts`：持久化 user message 时，对每条 `messageReferences`
  追加 `selection-ask`（anchor = section）；流末 `extractCitationsFromAnswer` 结果
  追加 `citation-hit`。
- `src/app/api/lens/[...slug]/route.ts`：POST 成功后追加 `reshape-request`。
- 测试：三处各断言「证据落行」与「证据写入抛错时主响应不变」。
- 验证：`npx vitest run src/app/api/query/__tests__/route.test.ts src/app/api/lens/`

## 任务 10：D5 读完埋点

- **新增 `src/components/wiki/use-page-read-beacon.ts`，由 `wiki-reading-view` 挂载。**
  不改 `reading-progress.tsx`——它只有 `containerRef` / `useContainerScroll` 两个 prop，
  是纯展示组件，没有也不该有 `slug` / `subjectSlug`（决策 9 的第二个实例）。
- hook 复用它已导出的纯函数 `calculateReadingProgress` 做到底判定；滚动到底 **且**
  停留 ≥30s 发一条 `page-read`；同页一次会话去重；阈值写死常量（已定决策 3）。
- 纯逻辑（到底判定 + 停留计时 + 去重）抽成纯函数单测，副作用留在 hook。
- 注意 `wiki-reading-view` 有 split / 普通两个 return 分支，`ReadingProgress` 各渲染一次
  但互斥；beacon hook 只挂一次，不要跟着分支走。
- 验证：`npx vitest run src/components/wiki/__tests__/`

## 任务 11：`GET /api/mastery` + `profile_signals` 并存双写

- 新增 `src/app/api/mastery/route.ts`：无 `slug` 返回全量
  `slug → MasteryVerdictLite`（**不含 `recent`**，图层用不到，带上会让响应随使用量线性膨胀）；
  带 `slug` 返回单页完整 `MasteryVerdict`（含 `recent`，供证据面板）。
  **排除 meta 页，与 `/api/graph` 的 `isMetaPage` 同口径**。
- `src/server/services/apply-signal.ts`：**并存**——继续写 `profile_signals`，
  同时把 style-bearing 信号写一份 `page_evidence`。此时 reducer 仍读旧表，行为不变。
- 测试：mastery 路由的空库（返回 `{}`）与有证据两种情况；双写后两表 style-bearing
  子集等价。
- 验证：`npx vitest run src/app/api/mastery/ src/server/services/__tests__/`

## 任务 12：A 组修复 + reducer 原子切换到证据流

- **A1/A2/A7**：`lens-feedback.tsx` 改为只在查看重塑版时渲染；发送时带
  `viewedSource`；「看原文」切换补 `view_original` 埋点。
- **A3/A4/A5**：`signal-reducer.ts` 输入换 `EvidenceRow[]`，加时间窗与衰减、
  加「只统计 `style_prefs_updated_at` 之后的证据」消费边界、三个维度各自独立阈值。
  **style-bearing kind 用显式白名单 `['self-report-hard','self-report-easy']`**——
  `quiz-wrong` / `selection-ask` 说的是掌握度不是讲法，混进来就等于「答错一道题
  全库降一档」，是缺口 1 的隐蔽复发。加一条断言锁死白名单。
- **A6**：`apply-signal.ts` 对**尚无画像行**的用户只落证据、**跳过 `upsertProfile`**。
  现状是它照写不误，结果 `version` 涨到 1 而 `onboardedAt` 仍为 null，onboarding 弹窗
  持续弹。证据不丢——用户真的完成 onboarding 后，reducer 自然消费到这些历史证据。
- **A8**：`formality` 明确只手动可调——在 `style.ts` 加注释说明，并在 reducer 测试里
  断言任何信号都不改动它。
- 测试：同向连点不再每次降档（棘轮消失）；超窗证据不参与；三维度独立；
  canonical 视图下不再产生风格信号。
- 验证：`npx vitest run src/server/profile/__tests__/ src/server/services/__tests__/ src/components/wiki/__tests__/`

## 任务 13：删旧 —— 退役 `profile_signals`

确认任务 12 上线且 reducer 已完全依赖 `page_evidence` 后执行。

- 删 `src/server/db/repos/signals-repo.ts`、`schema.ts` 的 `profileSignals`、
  `client.ts::migrateProfileSignals`、`src/app/api/profile/signals/route.ts`。
- **`page-identity-migration.ts:85` 的 `profile_signals.slug` 迁移块必须同步删除**——
  表已 DROP 而迁移仍在 `UPDATE profile_signals`，move 页面会直接 SQL 报错。
  这是全 plan 最容易漏的一处：它不在任何 signals 相关目录下。
- `npm run db:generate` 产出 `DROP TABLE profile_signals` 迁移（编号自动分配）。
- 全仓 grep `profile_signals` 确认零残留引用。
- 验证：`npm test`（全量）+ **`npx vitest run src/server/wiki/__tests__/page-move-integration.test.ts`**
  （专门覆盖上一条，确认删表后 move 仍成功）

## 任务 14：文档同步

- `src/server/db/CLAUDE.md`：`page_evidence` 表 + `evidence-repo` + changelog。
- `src/server/CLAUDE.md`：数据模型表补一行；`profile_signals` 退役。
- `src/app/CLAUDE.md`：`/api/evidence`、`/api/mastery` 两条路由 + `/api/profile/signals`
  移除 + changelog。
- `src/lib/CLAUDE.md`：`stable-hash.ts`、`markdown-client` 的 `interactive` 接缝。
- `src/components/CLAUDE.md`：`quiz-block.tsx` + `page-renderer` 唯一传入方。
- `src/server/agents/CLAUDE.md`：enricher v7。
- 根 `AGENTS.md` changelog。
- 验证：`npm run lint && npx tsc --noEmit && npm test`

---

## 收口检查

全部完成后一次性确认：

1. `npm test` 全绿，`npm run lint` 与 `npx tsc --noEmit` 无错。
2. **零证据回归**：在一个从没产生过证据的 subject 上，阅读页 / 重塑 / Chat 行为与改动前
   完全一致（`GET /api/mastery` 返回 `{}`，下游按全 `unknown` 处理）。
3. **生命周期**：删页 → 重建同名 slug → 掌握度为 `unknown`（不复活）。
4. **接缝隔离**：Chat 里贴一段 quiz markdown、编辑器预览里打开带 quiz 的页面，
   两处都**没有**判分按钮。
5. **skill 升级**：未改过 skill 的 vault 重启 worker 后自动升到 v7，不报版本门错误。

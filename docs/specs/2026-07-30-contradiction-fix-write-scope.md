# Contradiction 修不动对侧页：Fix 写白名单从「单页」下沉到「该 finding 涉及的全部页」

日期：2026-07-30
状态：设计定稿（盘问结论已沉淀进「目的 / 约束 / 成功标准」三节）

---

## 一、问题现状

Health 里一条 critical `contradiction` 反复点 Fix 都修不掉，UI 标注「无需更改」。这不是模型能力问题，是**写侧门控把唯一能修好它的那次写入挡掉了**。

### 症状（真实数据，非构造）

当前 lint 快照 `10ea3110`（2026-07-29T20:10:21Z，subject `world-history`）唯一 critical：

- `type: contradiction`，`pageSlug: black-death-and-silk-road`，finding id `92fa9c4e…`
- `evidence` 两条：`black-death-and-silk-road` 与 **`black-death-europe`**
- 内容：1377 年拉古萨检疫制度针对的入境来源，一页写「来自疫区」，另一页写「来自非流行地区」——把防疫逻辑写反了。错在 `black-death-europe`
- lint 自己的 `suggestedFix` 也判在对侧：「若『非流行地区』是笔误，应改为『流行地区』或『疫区』」

两次处置都没动它：

| job | findingIds | 结果 |
|---|---|---|
| `6db3ecd8`（工具栏批量，2 条） | 含 `92fa9c4e…` | 这条 `skipped`；另一条 `fixed` |
| `26bc56a0`（行内重试，1 条） | 只有 `92fa9c4e…` | `skipped`，`writes: 0`，`touchedSlugs: []` |

### 机制（`job_events` 里模型的真实动作，job `26bc56a0`）

```
wiki_read    black-death-and-silk-road
wiki_read    black-death
wiki_read    black-death-europe
wiki_patch   black-death-europe        ← 判对了错在哪边，动手
wiki_inspect
wiki_update  black-death-europe        ← 换个工具再试
wiki_read    black-death-and-silk-road ← 放弃，回读原页
fix:complete 0 edited
```

两次写对侧页都被 `scopeFixWrites`（`fix-service.ts:231`）抛的 `[PAGE_OUT_OF_SCOPE]` 挡掉。模型判断完全正确，只是没有权限落地。

### 根因：白名单按 `finding.pageSlug` 开槽，而 contradiction 天生是双页问题

`fix-service.ts:326`：

```ts
? scopeFixWrites(baseContext, new Set(worklist.map((finding) => finding.pageSlug)))
```

`LintFinding` 只有一个 `pageSlug`，contradiction 的对侧页只存在于 `evidence[].pageSlug` 里（`contracts.ts:604`），**永远进不了白名单**。于是形成一个结构性死区：**凡是「错在对侧页」的 contradiction，无论单条还是批量、重试多少次，都必然 `skipped`。**

这与 7-29 修掉的 orphan 缺陷是同一族错误：*「处置的写入落点 ≠ finding 的 pageSlug」*。orphan 的修复写在**源页**上，contradiction 的修复可能写在**对侧页**上，而门控和判据都按 `pageSlug` 单页假设写死。

### 三个让它看起来「正常」的放大器

1. **prompt 承诺与门控互相矛盾且互不知情**：`fix-prompt.ts:25` 明确写着 *"You MAY update BOTH pages"*，白名单却只给一页；模型不知道白名单存在，只能靠连撞两次墙才发现。
2. **失败静默**：`fix-service.ts:355` 把 `onToolCall` 接到 AI SDK 的 `onStepFinish`（`provider-registry.ts:356`），它只报**发起了哪些 tool call**，拿不到执行结果 —— 所以被拒的 `wiki_patch` 照样记一条「Patching…」。真正带 `error` 的审计回调在 `compile.ts:92`，但 `fix-service` 调 `compileToolSet` 时只传了 `policy`，这条通路现成却没接。
3. **outcome 判据把「改不了」说成「不用改」**：`buildPerFindingOutcomes`（`fix-service.ts:104`）只看 `touchedSlugs` 是否含 `finding.pageSlug`，零写入即 `skipped`；UI 渲染成「无需更改」（`zh-CN.ts:792`）。postcondition 因为零 operation 短路成 `clean`（`postcondition-service.ts:88`），job 报 `completed`。整条链路上没有任何一环说过真话。

### 一个尚未触发、但会被本次改动触发的坑

7-29 的 `isUntouchedSkip`（`remediation-status.ts:236`）已让 `skipped` 留在列表，所以这行现在**看得见**（真实探针：`visible bySeverity { critical: 1 }`）。但它只放过 `skipped`，**`failed` 仍会被 `readHandledOutcome` 移出列表**。因此若只做上面第 3 点（skipped → failed）而不动可见性，这一行会从「留着但骗人」退化成「直接消失」——比现状更糟。

---

## 二、目的

1. **contradiction 能改到对侧页** —— 白名单覆盖该 finding 真正涉及的全部页，模型判对了就能落地。
2. **改不了必须如实报** —— 被门控挡住 → `failed` + 日志可查是哪页被拒，不再显示「无需更改」。
3. **未解决的 finding 留在列表可重试** —— `failed` 与 `skipped` 同等对待，隐藏未解决的问题等于谎报已处理。

---

## 三、约束（盘问结论）

### C1 白名单 = `pageSlug ∪ evidence[].pageSlug`，仅对 contradiction 生效

**Nick 的决策**（在「新增 `relatedSlugs` 契约字段」与「contradiction 干脆不收窄写侧」之间选定）。

- 数据已在手：`finding-identity.ts:39` 的 v2 身份计算**要求** contradiction 有 `evidence.length >= 2`，所以对侧 slug 一定存在。
- `evidence` 在契约上是可选的（`contracts.ts:604`「旧快照可缺失」）——缺失时回退为只含 `pageSlug`，与今天行为一致，不为旧快照引入新失败。
- **只扩 contradiction**。`missing-crossref` 也带 evidence，但它的写入落点就是源页（`linkEnsure` 只写 source），扩白名单是无谓放权。
- 收窄语义没有被削弱，只是从「一页」修正为「这条 finding 涉及的页」——落选的 subject-wide 方案会把 7-27 建立的写侧收窄对这一整类作废。

### C2 被拒必须留痕，且「改不了」判 `failed` 而非 `skipped`

**Nick 的决策**（在「新增独立 `blocked` 状态」与「只补日志不动 outcome」之间选定）。

- 复用现有 `failed`：不动 `RemediationStatus` 契约、不动 `health-snapshot.ts` 白名单、不动两份 i18n，UI 现成的红点与「失败」文案直接可用。落选的 `blocked` 是给一个 C1 修完后本该罕见的状态专门开一档。
- 判定必须依赖**「有写尝试被拒」这个信号**，不能只看零写入 —— 模型判不出哪边对而主动留着，`skipped` 是诚实的，必须保留。
- 信号的取法（实现细节，不新增决策）：让 `scopeFixWrites` 在闭包里自己记账被拒的 slug，**不去 match `PAGE_OUT_OF_SCOPE` 错误字符串**，也不依赖 `compile.ts` 的审计回调传错误文本。
- **归因精度如实记录**：被拒的 slug 按定义不在任何 finding 的可写集里，无法反查是「为哪条 finding 而拒」。因此判定为：本次 job 有写入被门控拒绝 且 该 finding 属 `LLM_FIX_TYPES` 且零写入 → `failed`。**逐条处置（worklist 只有 1 条）时精确；批量处置时偏保守**，可能把同批里「模型主动留着」的 finding 也标成 `failed`。取舍：宁可多报一次失败（下次 lint 会重新判定，且 C4 让它可重试），也不再静默。

### C3 prompt 事前告知白名单，错误消息事后可自救

**Nick 的决策**。

- `buildFixAgenticUserPrompt` 增一节「Writable pages」，直接渲染白名单 slug。注入量由 worklist 大小决定（逐条时 1–3 个 slug），不随 vault 规模增长 —— 不重演 T2.1 的 prompt 膨胀教训。
- 同时把 `scopeFixWrites::assertAllowed` 的错误消息带上允许清单，模型撞第一次就能自我纠正。两者不冲突：一个事前，一个兜底。

### C4 `failed` 不再从列表隐藏

**Nick 的决策**（对比「只靠近期摘要显示失败」）。

`isUntouchedSkip` 的判据从 `skipped` 扩展为 `skipped | failed`（fix/curate 两个 action），语义随之从「未触达」升级为「未解决」。

- `failed` 的语义就是「问题还在」，隐藏它会让 critical 计数说谎 —— 与 7-29 为 `skipped` 写下的理由（*隐藏它等于谎报已处理*）逐字同构。
- `fixed` 的隐藏语义不动；Research 的 `skipped`（dismissed/empty，用户显式忽略）仍属已处理，继续隐藏。
- **涟漪如实记录**：现有 3 条历史 `failed`（探针实测）会随之留在列表直到下次 lint 重新判定，「处置完列表就清空」的观感会改变。Nick 已确认这是想要的行为。

### C5 零回归硬要求

- **postcondition 语义不动**：`postcondition-service.ts:88` 零 operation 短路成 `clean` 是「校验本次实际写入」的正确语义，不改成「校验 finding 是否解决」——那会给每个零写入 job 加一次 LLM 语义复检，还会把合理 `skipped` 误报成 residual。「该修没修」的判定归 outcome 层（C2）。
- `missing-crossref` / `broken-link` / `missing-frontmatter` 的写侧仍收窄到 `finding.pageSlug`。
- 无 `remediationContext` 的旧 `/api/fix` 全量路径继续不收窄写侧。
- All Subjects 只读边界、hydration 安全门、`orphan-source` 的 Delete Source 通路一律不动。

---

## 四、成功标准

1. `contradiction` 的写白名单含 `evidence[].pageSlug`；`evidence` 缺失时回退单页；`missing-crossref` 的白名单**不**因 evidence 扩大。
2. 写工具被门控拒绝时：emit 一条可见的 warn 事件（含被拒页 slug 与允许清单），且该 finding 的 outcome 为 `failed`，不再是 `skipped`。
3. 模型主动留着（无任何被拒写入、零写入）仍判 `skipped`，UI 仍显示「无需更改」。
4. `failed` 的 finding 留在 Health 列表、状态显示「失败」、可再次处置；`fixed` 仍从列表移除并进近期摘要。
5. **真实端到端验收**（Nick 的决策，非仅单测）：重跑一次 discovery 让 `92fa9c4e…` 回到列表 → 点该行 Fix → `black-death-europe` 的「非流行地区」被真实改正、vault 产出 commit、`perFindingOutcomes` 为 `fixed`、该行从列表移除。跑前记录 `data/vault` 的 HEAD 以便回退。
6. `npm run lint` 全绿；`npx vitest run src/server/services src/server/llm/prompts` 不低于基线（4 个直接相关文件基线：148 用例全绿，2026-07-30 05:49 实测）。
7. 新增单测锁定四条纯逻辑：白名单含对侧页 / 被拒→`failed` / 无被拒零写入→`skipped` / `failed` 不隐藏。

# Fix 断链豁免：忠实度护栏放行"已确认断链"的 wikilink 丢弃

日期：2026-07-10 · 状态：已实现

## 问题

`FIDELITY_PROFILES.fix` 的 `linkRule: 'preserve'` 要求原文全部 wikilink 目标 ⊆ 修改后正文，但 broken-link 的两种合法修法（解链为纯文本 / 重链到已有页）本质上都要丢弃断链目标；同时 d0126c6 已禁止 fix 建 stub 页绕过。两条纪律组合把"修断链"这条路彻底封死——fix agent 的更新被护栏确定性拒绝（`Rejected update …: dropped existing wikilink target(s)`），断链永远修不掉。

同一护栏被 `page-write.ts::updatePageInSubject`（Ask AI 的 `wiki_update`）复用，问答路径同样被卡。

## 方案（方案 A：护栏放行"确认已断"的链接目标）

1. **`wiki/rewrite-fidelity.ts`**（保持纯函数）：
   - `checkRewriteFidelity` 新增第 4 参 `options?: RewriteFidelityOptions`，`allowedDroppedTargets?: ReadonlySet<string>`（key 形如 `${targetSubjectSlug}:${targetSlug}`，同 subject 无前缀时 subject 段为空串）。`'preserve'` 分支过滤豁免集内的丢失项；其余检查与三档其它 profile 不受影响。
   - 新增纯函数 `collectMissingLinkTargets(body, pageExists)`：用与 preserve 检查同一套 key 派生（`extractWikiLinks` + targetKey），收集"目标页不存在"的链接 key；存在性判定经谓词注入，模块保持零 IO。
2. **`services/page-write.ts`** 新增 IO 侧 `collectBrokenLinkTargets(subject, body)`：
   - 同 subject：目标 slug ∈（本 subject 页 slug 集 ∪ `normalizeSlug(title)` 集）即视为存在——无 titleResolver 时 `extractWikiLinks` 把 `[[Title]]` 归一为 `slugFromTitle`，可能与页真实 slug 不一致，并入 title 派生形防止误豁免活链；
   - 跨 subject：`subjectsRepo.getBySlug` + `pagesRepo.getPageBySlug` 逐条查。
3. **两个调用点接入**：`fix-tools.ts::updatePage`（fix tool-loop）与 `page-write.ts::updatePageInSubject`（Ask AI `wiki_update`）在调 `checkRewriteFidelity(…, FIDELITY_PROFILES.fix)` 时传入 `allowedDroppedTargets: collectBrokenLinkTargets(subject, doc.body)`。

## 不变式

- 活链一根不许丢：豁免集只含现场确认"目标页不存在"的目标，防幻觉删链保护不减弱。
- 臆造新断链仍被拦：`executePageUpdate` 内核对修改后正文的坏链/残链一律拒绝落盘（既有行为）。
- `supplement` / `merge-update` / `reshape` 三档及其调用方零改动（不传 options 行为完全不变）。

## 已考虑并否决的替代

- **确定性 pre-pass 机械解链**：零 LLM 但失去"重链到语义相近页"的更优修法，一律降级为解链。
- **fix 档 `linkRule: 'none'`**：拆掉活链保护，太钝。

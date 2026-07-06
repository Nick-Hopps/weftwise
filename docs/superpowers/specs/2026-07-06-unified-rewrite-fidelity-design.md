# 统一保真护栏（T1.4）— 设计文档

- 日期：2026-07-06
- 状态：已实施
- 范围：新建共享 fidelity 模块，统一四条"LLM 改写正文"路径的确定性保真校验

## 背景与问题

四条改写路径的保真标准目前不一致，且核心愿景所在的路径最薄弱：

| 路径 | 现有护栏 | 长度 floor |
|------|---------|-----------|
| re-enrich supplement（`supplement-guard.ts`） | 4 项组合 | 0.95 |
| fix tool-loop（`fix-deterministic.ts::bodyShrankTooMuch`） | 长度 | **0.5** |
| Cognitive Lens 整页重塑（`profile/fidelity.ts::checkLinkSubset`） | 仅链接子集 | **无** |
| **ingest 更新已有页**（orchestrator 注入 existingPageContent） | **无（裸靠 writer prompt Rule 8）** | **无** |

## 设计

### 1. 新模块 `src/server/wiki/rewrite-fidelity.ts`

```ts
export interface FidelityProfile {
  minLengthRatio: number;            // revised/original 正文长度下限
  linkRule: 'preserve' | 'subset' | 'none';
  // preserve：original 的 wikilink 目标集合 ⊆ revised（改写不得丢链接）——用于 merge-update / fix / supplement
  // subset：revised 的 wikilink 目标集合 ⊆ original（重塑不得臆造链接）——用于 reshape
  preserveHeadings: boolean;         // original 的 heading 文本集合 ⊆ revised
  preserveFrontmatter: boolean;      // frontmatter 键值不变（比较解析后的对象）
}

export const FIDELITY_PROFILES = {
  supplement:    { minLengthRatio: 0.95, linkRule: 'preserve', preserveHeadings: true,  preserveFrontmatter: true  },
  'merge-update':{ minLengthRatio: 0.85, linkRule: 'preserve', preserveHeadings: true,  preserveFrontmatter: false },
  fix:           { minLengthRatio: 0.8,  linkRule: 'preserve', preserveHeadings: false, preserveFrontmatter: false },
  reshape:       { minLengthRatio: 0.8,  linkRule: 'subset',   preserveHeadings: false, preserveFrontmatter: true  },
} as const;

export function checkRewriteFidelity(
  original: string, revised: string, profile: FidelityProfile,
): { ok: boolean; violations: string[] };
```

- wikilink 提取复用 `wikilinks.ts::extractWikiLinks`（单一真实源），比较解析后 target（含 subject 前缀归一）。
- heading 比较：提取 `#{1,6} ` 文本、trim 后做集合包含（允许新增，不允许丢失）。
- 长度比较：剥离 frontmatter 后的正文字符数。

### 2. 接入点（四处）

1. **ingest merge-update（新增，本任务核心）**：orchestrator 的 writer fanout 产物落检查点前，若该页命中 `existingPages`（update 语义）→ `checkRewriteFidelity(existingPageContent, draft, 'merge-update')`；违规 → 把 violations 拼进指令重写一次 → 仍违规 → **保守回落**：保留现有正文 + 在文末追加新材料段（确定性拼接，emit `ingest:warn`），不整页覆盖。
2. **fix**：`fix-tools.ts` 现有 `bodyShrankTooMuch` 调用点替换为 `checkRewriteFidelity(…, 'fix')`，违规拒绝该次 `wiki.update`（返回 ok:false 给模型，同现有护栏路径）。
3. **reshape**：`reshape-service.ts` 现有 `checkLinkSubset` 调用点替换为 `checkRewriteFidelity(…, 'reshape')`；重写一次→回落 canonical 的既有流程不变。
4. **supplement**：`supplement-guard.ts` 的 4 项检查收编为 `checkRewriteFidelity(…, 'supplement')`，删除重复实现；`runPageSupplement` 的重写/回落流程不变。

### 3. 退役与兼容

- `fix-deterministic.ts::bodyShrankTooMuch`、`profile/fidelity.ts::checkLinkSubset`、`supplement-guard.ts` 检查体退役（保留薄转发或直接删除+改调用方，取决于测试耦合度）。
- 阈值集中在 `FIDELITY_PROFILES`，后续调参单点。

### 4. 测试

- rewrite-fidelity 纯函数矩阵：每 profile × 每检查项的通过/违规用例（含中文 wikilink、带 subject 前缀链接、heading 增删、frontmatter 变更）。
- orchestrator 集成：update 页违规 → 重写一次 → 仍违规 → 保守回落（断言现有正文保留 + warn 事件）。
- fix/reshape/supplement 调用点替换后现有测试全绿（阈值收紧可能需要调整个别现有用例的 fixture）。

## 已知取舍

- fix floor 从 0.5 抬到 0.8：contradiction 修复可能确需删除较多矛盾内容，若实践中误拒率高，后续给 contradiction 类 finding 单独放宽（本版不做分叉）。
- merge-update 的"保守回落"是确定性拼接而非语义合并——宁可格式糙也不丢事实；语义级合并质量交给重写那一次机会。
- 语义忠实度（阈值内改写事实）不在本版范围——需要 LLM 判定，与"确定性护栏"定位冲突，归后续 verifier 方向。

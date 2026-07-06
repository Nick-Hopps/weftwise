/**
 * re-enrich supplement 阶段的确定性忠实度护栏。
 * 薄转发到统一的 `rewrite-fidelity.ts::checkRewriteFidelity`（T1.4），
 * 阈值/检查项收编进 `FIDELITY_PROFILES.supplement`，不再有独立实现。
 */
import { checkRewriteFidelity, FIDELITY_PROFILES } from '@/server/wiki/rewrite-fidelity';

/**
 * 组合护栏：返回是否通过 + 违规项列表（供 runPageSupplement 重写反馈）。
 * originalContent/candidateContent 为带 frontmatter 的完整内容；frontmatter 剥离由
 * checkRewriteFidelity 内部处理。
 */
export function checkSupplementFidelity(
  originalContent: string,
  candidateContent: string,
): { ok: boolean; violations: string[] } {
  return checkRewriteFidelity(originalContent, candidateContent, FIDELITY_PROFILES.supplement);
}

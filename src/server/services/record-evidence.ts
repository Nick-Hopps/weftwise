import { appendEvidence, type AppendEvidenceInput } from '@/server/db/repos/evidence-repo';

/**
 * best-effort 追加证据：失败只 `console.error`，**绝不影响主流程**
 * （沿用 `recordCoverageGap` 的语义）。
 *
 * 掌握度是锦上添花的派生事实；为了记一条证据而让阅读、问答或重塑失败，
 * 是完全不成比例的代价。
 */
export function recordEvidence(input: AppendEvidenceInput): void {
  try {
    appendEvidence(input);
  } catch (error) {
    console.error(`[evidence] failed to record ${input.kind} for ${input.slug}`, error);
  }
}

/** 批量版；逐条独立 try/catch，一条失败不影响其余。 */
export function recordEvidenceBatch(inputs: readonly AppendEvidenceInput[]): void {
  for (const input of inputs) recordEvidence(input);
}

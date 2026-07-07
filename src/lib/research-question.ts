/** 待研究问题去重归一化：trim + 压缩内部空白 + 小写化。用于同 subject 内判重（仅比较，不用于展示）。 */
export function normalizeResearchQuestion(question: string): string {
  return question.trim().replace(/\s+/g, ' ').toLowerCase();
}

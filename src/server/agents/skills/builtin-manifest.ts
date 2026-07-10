export const BUILTIN_SKILLS = {
  'ingest-chunk-summarizer': 'ingest-chunk-summarizer.md',
  'ingest-enricher': 'ingest-enricher.md',
  'ingest-planner': 'ingest-planner.md',
  'ingest-verifier-apply': 'ingest-verifier-apply.md',
  'ingest-verifier-triage': 'ingest-verifier-triage.md',
  'ingest-verifier': 'ingest-verifier.md',
  'ingest-writer': 'ingest-writer.md',
  'reenrich-supplement': 'reenrich-supplement.md',
} as const;

export const RETIRED_BUILTIN_SKILLS = ['ingest-indexer'] as const;

export type RetiredBuiltinSkillId = (typeof RETIRED_BUILTIN_SKILLS)[number];

/** 历史内置模板的完整文件 SHA-256；只允许自动删除精确匹配的原版。 */
export const RETIRED_BUILTIN_HASHES: Record<RetiredBuiltinSkillId, readonly string[]> = {
  'ingest-indexer': ['cef3712f6c94035131dfbe005b91b5d5913f6f63ae09889f24c80b5c77238a8c'],
};

const RETIRED_IDS = new Set<string>(RETIRED_BUILTIN_SKILLS);

export function isRetiredBuiltinSkill(id: string): id is RetiredBuiltinSkillId {
  return RETIRED_IDS.has(id);
}

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

export type BuiltinSkillId = keyof typeof BUILTIN_SKILLS;

export const BUILTIN_UPGRADE_HASHES: Partial<Record<BuiltinSkillId, readonly string[]>> = {
  'ingest-enricher': [
    '4285ea81232e1bf7b2a1c98671f200e6c4cfa09d6a8876dda676bf56d327a318',
    'f44633a47747a8628768182ea951d064906477f54445ace2dfb5488cf903f396',
    // v6 原版（v7 起 quiz callout 用 `---` 携带答案）
    '80b59ca6cac1379537030d577a4802f25cbed8b050ff48bb6e1f3e60550c9a2d',
    // v7 原版（v8 起明确要求 `---` 前后留空 `>` 行、禁止自造 问：/答： 标签）
    '43c234261331d6d64b267e54cc19522e392f0723a599daa6d775a9f4e5fae7e7',
  ],
};

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

export type QueryMode = 'read' | 'propose';

const EXPLANATORY_OR_NEGATED = [
  /(?:如何|怎么|怎样|能否|(?:你)?能|可以.{0,8}吗|不要|别|假设|如果).{0,40}(?:创建|新建|更新|修改|编辑|删除|移除|丰富)/i,
  /\b(?:how\s+(?:do|can|to)|can\s+you|do\s+not|don't|what\s+(?:would|happens?)\s+if|if\s+i)\b/i,
];

const WRITE_ACTION = /(?:创建|新建|更新|修改|编辑|局部修改|删除|移除|重新丰富|再丰富|create|update|edit|patch|delete|remove|re-?enrich)/i;
const WIKI_TARGET = /(?:wiki|知识库|页面|页|page)/i;

/**
 * 只决定 Query 是否能看到无写入副作用的 preview 工具；真正授权仍由 actionId 审批承担。
 */
export function resolveQueryMode(question: string): QueryMode {
  const normalized = question.trim();
  if (!normalized) return 'read';
  if (EXPLANATORY_OR_NEGATED.some((pattern) => pattern.test(normalized))) return 'read';
  return WRITE_ACTION.test(normalized) && WIKI_TARGET.test(normalized) ? 'propose' : 'read';
}

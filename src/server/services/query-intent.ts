export type QueryMode = 'read' | 'propose';

const EXPLANATORY_OR_NEGATED = [
  /(?:如何|怎么|怎样|能否|(?:你)?能|可以.{0,8}吗|不要|别|假设|如果).{0,40}(?:创建|新建|更新|修改|编辑|删除|移除|丰富|回滚|恢复|启动|开始|研究|取消|终止|移动|重命名|改.{0,8}slug)/i,
  /\b(?:how\s+(?:do|can|to)|can\s+you|do\s+not|don't|what\s+(?:would|happens?)\s+if|if\s+i)\b/i,
];

const WRITE_ACTION = /(?:创建|新建|更新|修改|编辑|局部修改|删除|移除|重新丰富|再丰富|移动|重命名|改.{0,8}slug|slug.{0,8}(?:改|重命名)|create|update|edit|patch|delete|remove|re-?enrich|move|rename.{0,32}slug)/i;
const WIKI_TARGET = /(?:wiki|知识库|页面|页|page)/i;
const HISTORY_REVERT = /(?:(?:回滚|恢复).{0,24}(?:历史|版本|操作)|(?:历史|版本|操作).{0,24}(?:回滚|恢复)|\brevert\b.{0,24}\b(?:wiki|history|operation|version)\b)/i;
const WORKFLOW_ACTION = /(?:(?:开始|启动).{0,24}(?:研究|research|重新丰富|再丰富)|(?:取消|终止).{0,24}(?:任务|工作流|job)|\bstart\s+(?:a\s+)?research\b|\bcancel\s+(?:the\s+)?(?:job|workflow)\b)/i;

/**
 * 只决定 Query 是否能看到无写入副作用的 preview 工具；真正授权仍由 actionId 审批承担。
 */
export function resolveQueryMode(question: string): QueryMode {
  const normalized = question.trim();
  if (!normalized) return 'read';
  if (EXPLANATORY_OR_NEGATED.some((pattern) => pattern.test(normalized))) return 'read';
  if (HISTORY_REVERT.test(normalized)) return 'propose';
  if (WORKFLOW_ACTION.test(normalized)) return 'propose';
  return WRITE_ACTION.test(normalized) && WIKI_TARGET.test(normalized) ? 'propose' : 'read';
}

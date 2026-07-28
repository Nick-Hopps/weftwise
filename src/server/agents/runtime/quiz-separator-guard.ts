import { findQuizSeparatorViolations, repairQuizSeparator } from '@/server/wiki/quiz-separator';
import type { AgentRunResult } from './agent-loop';

/**
 * enricher 产物的 quiz 答案分隔符护栏。
 *
 * enricher skill 明写了「答案必须用一行 `---` 与问题分隔」，但实测同一次 ingest 的同一页里
 * 三块 quiz 会有一块脱模——漏掉分隔符，阅读页就退化成不折叠形态、答案直接剧透
 * （`markdown-client.ts::splitQuizCallout` 只认 `thematicBreak`）。
 *
 * 与 `merge-update-fidelity.ts` / `supplement-page.ts` 同构的「重写一次 → 回落」：
 * 违规 → 把 violations 拼回输入重写一次 → 仍违规 → **确定性修复**（`repairQuizSeparator`，
 * 零 token）+ emit warn。回落选确定性修复而非保留原样，是因为修复固化进 vault 后可
 * git diff 审阅、可回滚，比让答案继续剧透强。
 *
 * **合规产物必须原样返回**（连同 AgentRunResult 对象本体），护栏不得改动守约产物的任何字节。
 */
export async function reconcileQuizSeparator(opts: {
  first: AgentRunResult;
  rerun: (extra: Record<string, unknown>) => Promise<AgentRunResult>;
  emit: (type: string, message: string, data?: Record<string, unknown>) => void;
  slug?: string;
}): Promise<AgentRunResult> {
  const { first, rerun, emit, slug } = opts;

  const firstContent = contentOf(first);
  // 无 content 的产物（结构异常）不是 quiz 问题，交给既有的 path/schema 校验处理
  if (firstContent === null) return first;
  if (findQuizSeparatorViolations(firstContent).length === 0) return first;

  const second = await rerun({ quizSeparatorViolations: findQuizSeparatorViolations(firstContent) });
  const secondContent = contentOf(second);
  if (secondContent === null) return second;
  if (findQuizSeparatorViolations(secondContent).length === 0) return second;

  const repair = repairQuizSeparator(secondContent);
  emit(
    'ingest:warn',
    `Quiz answer separator missing in "${slug ?? '?'}" after retry — inserted deterministically`,
    { slug: slug ?? null, repaired: repair.repaired },
  );
  return { ...second, output: withContent(second.output, repair.content) };
}

function contentOf(r: AgentRunResult): string | null {
  const c = (r.output as { content?: unknown } | undefined)?.content;
  return typeof c === 'string' ? c : null;
}

function withContent(output: unknown, content: string): unknown {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return { ...(output as Record<string, unknown>), content };
  }
  return { content };
}

import { checkRewriteFidelity, FIDELITY_PROFILES } from '@/server/wiki/rewrite-fidelity';
import type { AgentRunResult } from './agent-loop';

/**
 * ingest 增量合并（更新已有页）保真护栏。
 * writer 产出违规（相对现有正文丢链接/丢标题/塌缩太多）→ 把 violations 拼进输入重写一次
 * → 仍违规 → 保守回落：不整页覆盖，保留现有正文 + 在文末追加新材料段（确定性拼接，零 token）。
 * 与 supplement-page.ts 的「重写一次→回落」模式同构，但回落语义不同：supplement 回落到原文
 * （因新增材料价值归 enricher 兜底），merge-update 回落必须保住 writer 这次抓到的新材料
 * （否则源材料就白读了），故拼接而非纯回落原文。
 */
export async function reconcileMergeUpdateFidelity(opts: {
  existingContent: string;
  first: AgentRunResult;
  rerun: (extra: Record<string, unknown>) => Promise<AgentRunResult>;
  emit: (type: string, message: string, data?: Record<string, unknown>) => void;
  slug?: string;
}): Promise<AgentRunResult> {
  const { existingContent, first, rerun, emit, slug } = opts;

  const firstContent = contentOf(first);
  const firstCheck = checkRewriteFidelity(existingContent, firstContent, FIDELITY_PROFILES['merge-update']);
  if (firstCheck.ok) return first;

  const second = await rerun({ fidelityViolations: firstCheck.violations });
  const secondContent = contentOf(second);
  const secondCheck = checkRewriteFidelity(existingContent, secondContent, FIDELITY_PROFILES['merge-update']);
  if (secondCheck.ok) return second;

  // 保守回落：保留现有正文逐字不动，在文末追加整段重写后草稿（宁可格式糙也不丢事实；
  // 语义级合并质量交给了上面那一次重写机会）。
  const fallbackContent = `${existingContent.trimEnd()}\n\n---\n\n${secondContent.trim()}`;
  emit('ingest:warn', `Merge-update fidelity check failed for "${slug ?? '?'}" after retry — appending new draft instead of overwriting`, {
    slug: slug ?? null,
    violations: secondCheck.violations,
  });
  return {
    ...second,
    output: withContent(second.output, fallbackContent),
  };
}

function contentOf(r: AgentRunResult): string {
  const c = (r.output as { content?: unknown } | undefined)?.content;
  return typeof c === 'string' ? c : '';
}

function withContent(output: unknown, content: string): unknown {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return { ...(output as Record<string, unknown>), content };
  }
  return { content };
}

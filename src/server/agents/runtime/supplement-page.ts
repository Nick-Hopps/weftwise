import { runAgentLoop, type AgentRunResult } from './agent-loop';
import { checkSupplementFidelity } from './supplement-guard';
import type { AgentContext, SkillTemplate } from '../types';
import type { ChangesetEntry } from '@/lib/contracts';

interface PageInput {
  slug?: string;
  subjectSlug?: string;
  draftContent?: string;
  existingPages?: Array<{ slug?: string }>;
}

/**
 * 逐页画像驱动正文补全：调 skill 产候选 → 确定性护栏 → 失败重写一次（带违规反馈）
 * → 二次仍失败回落原文 passthrough（不阻断后续 enricher/verify）。
 * 返回与 runAgentLoop 同形的 AgentRunResult（token 经同一 ctx.budget 计入）。
 */
export async function runPageSupplement(opts: {
  skill: SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  const { skill, ctx, input } = opts;
  const page = (input ?? {}) as PageInput;
  const original = page.draftContent ?? '';
  const path = `wiki/${String(page.subjectSlug)}/${String(page.slug)}.md`;
  const action = pageAction(page);

  // 第一次
  const first = await runAgentLoop({ skill, ctx, input });
  const firstContent = contentOf(first);
  const firstCheck = checkSupplementFidelity(original, firstContent);
  if (firstCheck.ok) {
    return { ...first, output: { action, path, content: firstContent } satisfies ChangesetEntry };
  }

  // 重写一次：把违规项作为反馈拼回输入
  const retryInput = { ...(input as object), fidelityViolations: firstCheck.violations };
  const second = await runAgentLoop({ skill, ctx, input: retryInput });
  const secondContent = contentOf(second);
  if (checkSupplementFidelity(original, secondContent).ok) {
    return { ...second, output: { action, path, content: secondContent } satisfies ChangesetEntry };
  }

  // 两次都失败 → 回落原文（re-enrich 退化回「只叠 callout」，与改造前等价）
  ctx.emit('reenrich:supplement-fallback', `Supplement fidelity failed for ${page.slug ?? '?'} — keeping original prose`, {
    slug: page.slug ?? null,
    violations: firstCheck.violations,
  });
  return { ...second, output: { action, path, content: original } satisfies ChangesetEntry };
}

function contentOf(r: AgentRunResult): string {
  const c = (r.output as { content?: unknown } | undefined)?.content;
  return typeof c === 'string' ? c : '';
}

function pageAction(page: PageInput): 'create' | 'update' {
  const exists = Array.isArray(page.existingPages)
    ? page.existingPages.some((p) => p?.slug === page.slug)
    : false;
  return exists ? 'update' : 'create';
}

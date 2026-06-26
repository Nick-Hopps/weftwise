import type { Subject } from '@/lib/contracts';
import { streamTextResponse } from '@/server/llm/provider-registry';
import { getWikiLanguage } from '@/server/db/repos/settings-repo';
import { checkLinkSubset } from '@/server/profile/fidelity';
import type { StylePrefs } from '@/server/profile/style';
import {
  RESHAPE_PAGE_SYSTEM_PROMPT,
  RESHAPE_SECTION_SYSTEM_PROMPT,
  buildReshapePageUserPrompt,
  buildReshapeSectionUserPrompt,
} from '@/server/llm/prompts/reshape-prompt';
import type { PromptContext } from '@/server/llm/prompts/prompt-context';

type ProfileLite = { backgroundSummary: string; stylePrefs: StylePrefs };

function ctxFor(subject: Subject): PromptContext {
  return {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };
}

/** 用 streamTextResponse 收全文成字符串（本服务对外是 JSON 响应，不流式）。 */
async function collect(
  task: 'reshape:page' | 'reshape:section',
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = streamTextResponse(task, system, user, signal);
  let out = '';
  for await (const chunk of res.textStream) out += chunk;
  return out.trim();
}

/**
 * 整页重塑：生成 → 保真护栏（wikilink 子集）。失败则点名重写一次；
 * 二次仍失败回落 canonical（fallback=true，调用方不缓存、直显原文）。
 */
export async function reshapePageBody(input: {
  subject: Subject;
  body: string;
  profile: ProfileLite;
  abortSignal?: AbortSignal;
}): Promise<{ body: string; fallback: boolean; model: string | null }> {
  const ctx = ctxFor(input.subject);
  const baseUser = buildReshapePageUserPrompt(input.body, input.profile, ctx);

  let out = await collect('reshape:page', RESHAPE_PAGE_SYSTEM_PROMPT, baseUser, input.abortSignal);
  if (!checkLinkSubset(input.body, out).ok) {
    const retryUser = `${baseUser}\n\n=== CORRECTION ===\nYour previous attempt invented wikilinks not present in the canonical body. Do NOT introduce any new [[link]]. Only use links that already exist.`;
    out = await collect('reshape:page', RESHAPE_PAGE_SYSTEM_PROMPT, retryUser, input.abortSignal);
    if (!checkLinkSubset(input.body, out).ok) {
      return { body: input.body, fallback: true, model: null };
    }
  }
  return { body: out, fallback: false, model: null };
}

/** 段级重塑：单块改写 + 同款保真护栏；失败回落原块。 */
export async function reshapeSection(input: {
  subject: Subject;
  block: string;
  direction: 'simpler' | 'deeper';
  profile: ProfileLite;
  context?: string;
}): Promise<{ block: string; fallback: boolean }> {
  const ctx = ctxFor(input.subject);
  const user = buildReshapeSectionUserPrompt(input.block, input.direction, input.profile, ctx, input.context);
  const out = await collect('reshape:section', RESHAPE_SECTION_SYSTEM_PROMPT, user);
  if (!checkLinkSubset(input.block, out).ok) {
    return { block: input.block, fallback: true };
  }
  return { block: out, fallback: false };
}

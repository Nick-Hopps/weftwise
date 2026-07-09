/**
 * Curate service — 任务类型 'curate'：tool-loop 驱动的页面策展。
 * 模型读页后自行调 wiki.merge/split/delete/create；写能力经 CurateGuard 硬护栏把守。
 * params: { scope: 'pages' | 'subject'; slugs?: string[]; subjectId }
 *  - 'pages'(auto)：scope = slugs(本次 ingest 受影响页) + 本-subject 邻居；seed 限制生效。
 *  - 'subject'(manual)：scope = 全 subject 非 meta 页；无 seed 限制、允许 create。
 */
import { registerHandler } from '../jobs/worker';
import * as queue from '../jobs/queue';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import { expandScopeWithNeighbors, createCurateGuard } from '../wiki/curate-plan';
import { META_PAGE_SLUGS } from '../wiki/page-identity';
import { buildCurateToolContext } from './curate-tools';
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import { generateTextWithTools } from '../llm/provider-registry';
import { CURATE_AGENTIC_SYSTEM_PROMPT, buildCurateAgenticUserPrompt } from '../llm/prompts/curate-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import { toolActivityLine } from '@/lib/tool-activity';
import type { Job } from '@/lib/contracts';

/** 工具循环最大步数（bound 读取轮次；写次数由 guard caps 真正兜底）。 */
export const CURATE_MAX_STEPS = 40;
const CURATE_CAPS = { merge: 5, split: 5, delete: 5, create: 5 };

export async function runCurateJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as { scope?: 'pages' | 'subject'; slugs?: string[]; subjectId?: string };
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('curate job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  // 1. 解析 scope + seedSet
  let scopeSlugs: string[];
  let seedSet: Set<string> | null;
  if (params.scope === 'pages' && Array.isArray(params.slugs)) {
    const seed = params.slugs.filter((s) => !META_PAGE_SLUGS.has(s));
    seedSet = new Set(seed);
    const links = pagesRepo.getAllLinks(subject.id);
    scopeSlugs = expandScopeWithNeighbors(seed, links, subject.id, META_PAGE_SLUGS);
  } else {
    seedSet = null;
    scopeSlugs = pagesRepo.getAllPages(subject.id).map((p) => p.slug).filter((s) => !META_PAGE_SLUGS.has(s));
  }

  emit('curate:start', `Curating ${scopeSlugs.length} page(s) in "${subject.slug}"…`, {
    scope: params.scope ?? 'subject',
    count: scopeSlugs.length,
  });

  if (scopeSlugs.length < 2) {
    emit('curate:complete', 'Nothing to curate (need at least 2 pages).', { merge: 0, split: 0, delete: 0, create: 0, writes: 0 });
    return { merge: 0, split: 0, delete: 0, create: 0, writes: 0 };
  }

  // 2. scope 元数据（slug/title/summary/tags/bodyChars，不喂正文——模型用 wiki.read 自取）
  const metas: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[] = [];
  for (const slug of scopeSlugs) {
    const doc = readPageInSubject(subject.slug, slug);
    if (!doc) continue;
    metas.push({
      slug,
      title: doc.frontmatter.title,
      summary: doc.frontmatter.summary ?? '',
      tags: doc.frontmatter.tags ?? [],
      bodyChars: doc.body.length,
    });
  }

  // 3. 装配 guard + worker ToolContext + 工具集
  const guard = createCurateGuard({ seedSet, caps: CURATE_CAPS });
  const ctx = buildCurateToolContext(subject, { guard, jobId: job.id, emit });
  // wiki.create 仅手动全库模式（seedSet===null）可用：auto 模式不解析它，
  // 省得模型反复试探一个永远 ok:false 的工具浪费步数（guard.canCreate 仍兜底）。
  const toolNames = ['wiki.read', 'wiki.search', 'wiki.list', 'wiki.merge', 'wiki.split', 'wiki.delete'];
  if (seedSet === null) toolNames.push('wiki.create');
  const tools = compileToolSet(createBuiltinToolRegistry().resolve(toolNames), ctx);

  const promptCtx = {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };

  emit('curate:agent:start', `Reviewing ${metas.length} candidate page(s) (mode: ${seedSet === null ? 'manual' : 'auto'}, caps: ${Object.entries(CURATE_CAPS).map(([k, v]) => `${k}≤${v}`).join(' ')})…`, {
    candidates: metas.length,
    mode: seedSet === null ? 'manual' : 'auto',
    caps: CURATE_CAPS,
  });

  // 4. 驱动工具循环
  await generateTextWithTools('curate', {
    system: CURATE_AGENTIC_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildCurateAgenticUserPrompt(metas, promptCtx, { auto: seedSet !== null }) }],
    tools,
    maxSteps: CURATE_MAX_STEPS,
    shouldCancel: () => queue.isCancelRequested(job.id),
    onToolCall: (info) => emit('curate:tool', toolActivityLine(info.tool, info.args), { tool: info.tool }),
  });

  const totals = guard.totals();
  if (totals.writes > 0) enqueueEmbedIndex(subject.id);

  emit(
    'curate:complete',
    `Curation done: ${totals.merge} merge(s), ${totals.split} split(s), ${totals.delete} delete(s), ${totals.create} create(s).`,
    totals,
  );
  return totals as unknown as Record<string, unknown>;
}

registerHandler('curate', runCurateJob);

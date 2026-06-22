import { runAgentLoop, type AgentRunResult } from './agent-loop';
import { isWebSearchConfigured, webSearch, type WebSearchResult } from '../../search/web-search';
import { parseFrontmatter, serializeFrontmatter } from '../../wiki/frontmatter';
import type { AgentContext, SkillTemplate, CitedSource } from '../types';
import type { ChangesetEntry } from '@/lib/contracts';

const TRIAGE_SKILL = 'ingest-verifier-triage';
const APPLY_SKILL = 'ingest-verifier-apply';
const SELF_CHECK_SKILL = 'ingest-verifier';
const MAX_SEARCHES_PER_PAGE = 3;

interface DoubtfulClaim { excerpt: string; query: string; reason: string }
interface EvidenceItem { query: string; reason: string; excerpt: string; results: WebSearchResult[] }

interface PageInput {
  slug?: string;
  subjectSlug?: string;
  content?: string;
  existingPages?: Array<{ slug?: string }>;
}

/**
 * 逐页两段式核查：triage（挑存疑断言）→ 编排层 web 搜索 → apply（证据驱动修正）。
 * 降级：未配置/零证据 → 既有 ingest-verifier 自检 skill；triage 空 → 原样通过。
 * 返回与 runAgentLoop 同形的 AgentRunResult（token 经同一 ctx.budget 计入）。
 */
export async function runPageVerification(opts: {
  resolveSkill: (id: string) => SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  const { resolveSkill, ctx, input } = opts;
  const page = (input ?? {}) as PageInput;

  // 全局降级：未配置 web 搜索 → 既有自检 skill。
  if (!isWebSearchConfigured()) {
    return runAgentLoop({ skill: resolveSkill(SELF_CHECK_SKILL), ctx, input });
  }

  // ① triage
  const triage = await runAgentLoop({ skill: resolveSkill(TRIAGE_SKILL), ctx, input });
  const claims = extractClaims(triage.output);

  // triage 无存疑断言 → passthrough（不搜索、不 apply，比 P2 更省）。
  if (claims.length === 0) {
    return { ...triage, output: passthroughEntry(page) };
  }

  // ② 编排层搜索：query 去重 + 上限 3 + 并发。
  const queries = dedupe(claims.map((c) => c.query)).slice(0, MAX_SEARCHES_PER_PAGE);
  const settled = await Promise.allSettled(queries.map((q) => webSearch(q)));
  const resultsByQuery = new Map<string, WebSearchResult[]>();
  queries.forEach((q, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      resultsByQuery.set(q, s.value);
    } else {
      resultsByQuery.set(q, []);
      ctx.emit('ingest:warn', `Web search failed for query: ${q}`, {
        slug: page.slug ?? null,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      });
    }
  });

  const evidence: EvidenceItem[] = claims
    .filter((c) => queries.includes(c.query))
    .map((c) => ({
      query: c.query,
      reason: c.reason,
      excerpt: c.excerpt,
      results: resultsByQuery.get(c.query) ?? [],
    }));
  const hasEvidence = evidence.some((e) => e.results.length > 0);

  // 有存疑但零证据 → 退回自检（与全局降级统一收口）。
  if (!hasEvidence) {
    ctx.emit('ingest:verify', `No web evidence for ${page.slug ?? '?'} — self-check`, {
      slug: page.slug ?? null,
      flagged: claims.length,
      searched: queries.length,
    });
    return runAgentLoop({ skill: resolveSkill(SELF_CHECK_SKILL), ctx, input });
  }

  // ③ apply：把 evidence（仅 snippet）喂给无 tools 结构化输出。
  const applyRun = await runAgentLoop({
    skill: resolveSkill(APPLY_SKILL),
    ctx,
    input: { ...(input as object), evidence },
  });
  const applied = applyRun.output as {
    action?: 'create' | 'update';
    content?: string;
    citedSources?: Array<{ url?: unknown; title?: unknown }>;
  } | undefined;

  let content = typeof applied?.content === 'string' ? applied.content : (page.content ?? '');
  const cited = normalizeCited(applied?.citedSources);

  if (cited.length > 0) {
    content = appendSourcesToFrontmatter(content, cited.map((c) => c.url));
    recordCitedSources(ctx, page.slug ?? '', cited, evidence);
    // ⑨ 续传补源：record 后同步持久化整张累积列表。JS 单线程——record 与此处快照之间无
    // await，同一 microtask 内并发 fanout 页不会穿插改 Map；citedSources 单调增长，每个有源页
    // 都 persist，故末次写必为完整集，不丢源。续传命中 verifier-page 检查点跳过本函数时，
    // finalize 仍能从 checkpoint rehydrate 出本页的源。
    if (ctx.citedSources) ctx.checkpoint?.putCitedSources([...ctx.citedSources.values()]);
  }

  ctx.emit('ingest:verify', `Verified ${page.slug ?? '?'}`, {
    slug: page.slug ?? null,
    flagged: claims.length,
    searched: queries.length,
    corrected: cited.length,
  });

  const entry: ChangesetEntry = {
    action: pageAction(page),
    path: `wiki/${String(page.subjectSlug)}/${String(page.slug)}.md`,
    content,
  };
  return { ...applyRun, output: entry };
}

function extractClaims(output: unknown): DoubtfulClaim[] {
  const arr = (output as { doubtfulClaims?: unknown })?.doubtfulClaims;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(
      (c): c is DoubtfulClaim =>
        !!c &&
        typeof (c as DoubtfulClaim).excerpt === 'string' &&
        typeof (c as DoubtfulClaim).query === 'string' &&
        typeof (c as DoubtfulClaim).reason === 'string' &&
        (c as DoubtfulClaim).query.trim().length > 0,
    );
}

function normalizeCited(raw: unknown): Array<{ url: string; title: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => ({
      url: typeof (c as { url?: unknown }).url === 'string' ? (c as { url: string }).url : '',
      title: typeof (c as { title?: unknown }).title === 'string' ? (c as { title: string }).title : '',
    }))
    .filter((c) => c.url.length > 0);
}

function passthroughEntry(page: PageInput): ChangesetEntry {
  return {
    action: pageAction(page),
    path: `wiki/${String(page.subjectSlug)}/${String(page.slug)}.md`,
    content: page.content ?? '',
  };
}

function pageAction(page: PageInput): 'create' | 'update' {
  const exists = Array.isArray(page.existingPages)
    ? page.existingPages.some((p) => p?.slug === page.slug)
    : false;
  return exists ? 'update' : 'create';
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter((x) => x.length > 0))];
}

/** 确定性把 URL 追加进页 frontmatter sources（去重）；apply 不准动 frontmatter。 */
function appendSourcesToFrontmatter(content: string, urls: string[]): string {
  const { data, body } = parseFrontmatter(content);
  const existing = Array.isArray(data.sources) ? data.sources : [];
  const merged = [...existing];
  for (const u of urls) {
    if (!merged.includes(u)) merged.push(u);
  }
  return serializeFrontmatter({ ...data, sources: merged }, body);
}

/** 累积 ctx.citedSources（跨页按 url 去重、合并 citedBy）；fallbackContent 取自匹配 snippet。 */
function recordCitedSources(
  ctx: AgentContext,
  slug: string,
  cited: Array<{ url: string; title: string }>,
  evidence: EvidenceItem[],
): void {
  if (!ctx.citedSources) return;
  for (const c of cited) {
    const snippet =
      evidence.flatMap((e) => e.results).find((r) => r.url === c.url)?.snippet ?? '';
    const existing = ctx.citedSources.get(c.url);
    if (existing) {
      if (!existing.citedBy.includes(slug)) existing.citedBy.push(slug);
      if (!existing.fallbackContent && snippet) existing.fallbackContent = snippet;
    } else {
      ctx.citedSources.set(c.url, {
        url: c.url,
        title: c.title,
        citedBy: [slug],
        fallbackContent: snippet,
      } satisfies CitedSource);
    }
  }
}

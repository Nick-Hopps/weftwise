/**
 * Research service — 任务类型 'research'：缺口 → 联网研究 → 候选清单（只发现不写入）。
 *
 * 三阶段：
 *   1. LLM 生成检索 query（generateObject 无 tools；失败 → job 失败）
 *   2. Tavily 搜索每条 query（Promise.allSettled；单条失败 → 跳过该 query，不失败整个 job）
 *   3. LLM 相关性/质量 triage（generateObject；失败 → 降级按搜索排名取前 3 未评分）
 *
 * 全程零 vault/DB 写入（除 jobs/job_events 自身）——候选清单只活在 job resultJson 里，
 * 确认后由前端调用现有 POST /api/ingest { urls } 落地，本 service 不触碰 wiki-transaction。
 *
 * side-effect import：worker-entry import 本文件即完成 registerHandler('research', ...)。
 */
import { registerHandler } from '../jobs/worker';
import * as queue from '../jobs/queue';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { selectLatestFindings } from './lint-latest';
import { isWebSearchConfigured, webSearch } from '../search/web-search';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  ResearchQueriesSchema,
  RESEARCH_QUERIES_SYSTEM_PROMPT,
  buildResearchQueriesUserPrompt,
  ResearchTriageSchema,
  RESEARCH_TRIAGE_SYSTEM_PROMPT,
  buildResearchTriageUserPrompt,
} from '../llm/prompts/research-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import {
  dedupeQueries,
  dedupeCandidates,
  applyTriage,
  fallbackTriage,
  type RawCandidate,
} from './research-plan';
import type { Job, ResearchCandidate } from '@/lib/contracts';
import type { PromptContext } from '../llm/prompts/prompt-context';

interface ResearchParams {
  gapIds?: string[];
  topic?: string;
  subjectId?: string;
}

/**
 * gapIds 引用最近 lint 快照里 coverage-gap findings 的数组下标（EnrichedLintFinding[] 索引，
 * 十进制字符串）。findings 本身无稳定 id，索引即位置，对应快照过期即天然失效（越界被过滤）。
 */
export function resolveTopicsFromGapIds(subjectId: string, gapIds: string[]): string[] {
  const latest = selectLatestFindings(queue.list({ type: 'lint', status: 'completed', subjectId }));
  const indices = new Set(gapIds);
  const descriptions = latest.findings
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => f.type === 'coverage-gap' && indices.has(String(i)))
    .map(({ f }) => f.description);
  return [...new Set(descriptions)]; // 防重复引用同一 gap
}

export async function runResearchJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as ResearchParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('research job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  const topics: string[] = params.topic
    ? [params.topic]
    : resolveTopicsFromGapIds(subjectId, params.gapIds ?? []);

  if (topics.length === 0) {
    throw new Error('No topics resolved for research job (missing/invalid gapIds and no topic)');
  }

  const promptCtx: PromptContext = {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };

  // ① query 生成 — 失败即 job 失败（无候选可搜索）
  emit('research:queries', `Generating search queries for ${topics.length} topic(s)...`, { topics });
  const queriesResult = await generateStructuredOutput(
    'research:queries',
    ResearchQueriesSchema,
    RESEARCH_QUERIES_SYSTEM_PROMPT,
    buildResearchQueriesUserPrompt(topics, promptCtx),
  );
  const queries = dedupeQueries(queriesResult.queries);
  if (queries.length === 0) {
    throw new Error('LLM generated no usable search queries');
  }
  emit('research:queries', `Generated ${queries.length} search query(ies)`, { queries });

  // ② 搜索 — allSettled，单条失败只跳过
  emit('research:search', `Searching ${queries.length} query(ies)...`, { queries });
  const settled = await Promise.allSettled(queries.map((q) => webSearch(q)));
  const rawCandidates: RawCandidate[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      rawCandidates.push(...s.value);
    } else {
      emit('research:search', `Search failed for query "${queries[i]}", skipping`, {
        query: queries[i],
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      });
    }
  });
  const candidates = dedupeCandidates(rawCandidates);
  emit('research:search', `Found ${candidates.length} unique candidate(s)`, { count: candidates.length });

  if (candidates.length === 0) {
    return { candidates: [] as ResearchCandidate[], topics, queries };
  }

  // ③ triage — 失败降级为按排名前 3 未评分
  emit('research:triage', `Triaging ${candidates.length} candidate(s)...`);
  let results: ResearchCandidate[];
  try {
    const triage = await generateStructuredOutput(
      'research:triage',
      ResearchTriageSchema,
      RESEARCH_TRIAGE_SYSTEM_PROMPT,
      buildResearchTriageUserPrompt(topics, candidates, promptCtx),
    );
    results = applyTriage(candidates, triage.results);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emit('research:triage', `Triage failed, falling back to top-3 unscored: ${msg}`);
    results = fallbackTriage(candidates);
  }

  emit('research:complete', `Research complete: ${results.length} candidate(s) proposed`, {
    count: results.length,
  });

  return { candidates: results, topics, queries };
}

registerHandler('research', runResearchJob);

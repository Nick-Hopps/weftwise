/**
 * Research service — 任务类型 'research'：覆盖缺口/零来源薄页 → 联网研究 → 候选清单（只发现不写入）。
 *
 * 三阶段：
 *   1. LLM 生成检索 query（generateObject 无 tools；失败 → job 失败）
 *   2. Tavily 搜索每条 query（Promise.allSettled；单条失败 → 跳过该 query，不失败整个 job）
 *   3. LLM 相关性/质量 triage（generateObject；失败 → 降级按搜索排名取前 3 未评分）
 *
 * 研究本身不写 vault；最终候选与 finding 快照会先原子写入 Research provenance，
 * 批准后再由 research-import coordinator 调度 Ingest Saga。
 *
 * side-effect import：worker-entry import 本文件即完成 registerHandler('research', ...)。
 */
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { webSearch } from '../search/web-search';
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
import * as researchProvenanceRepo from '../db/repos/research-provenance-repo';
import { normalizeRemediationContext } from './remediation-context';
import {
  MAX_RESEARCH_FINDING_IDS,
  resolveResearchScopeFromFindingIds,
} from './research-scope';
import {
  parseResearchFindingSnapshot,
  prepareResearchCandidates,
  validateStoredResearchCandidates,
} from './research-provenance';
import { findingId } from './finding-identity';
import {
  dedupeQueries,
  dedupeCandidates,
  applyTriage,
  fallbackTriage,
  type RawCandidate,
} from '@/lib/research-plan';
import type {
  Job,
  RemediationContext,
  ResearchCandidate,
  ResearchCandidateSnapshot,
} from '@/lib/contracts';
import type { PromptContext } from '../llm/prompts/prompt-context';

interface ResearchParams {
  findingIds?: string[];
  lintJobId?: string;
  topic?: string;
  subjectId?: string;
  remediationContext?: RemediationContext;
}

const FINDING_ID_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** 严格解析 Research 参数，禁止畸形 job 参数降级到另一条执行路径。 */
function parseResearchParams(job: Job): ResearchParams & { subjectId: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(job.paramsJson);
  } catch {
    throw new Error('Research params are not valid JSON');
  }
  if (!isRecord(raw)) throw new Error('Research params must be an object');
  if (hasOwn(raw, 'gapIds')) {
    throw new Error('gapIds is no longer supported; use findingIds with lintJobId');
  }

  if (!job.subjectId) throw new Error('research job missing subjectId');

  if (hasOwn(raw, 'subjectId')) {
    if (typeof raw.subjectId !== 'string' || raw.subjectId.trim().length === 0) {
      throw new Error('Research params subjectId must be a non-empty string');
    }
    if (raw.subjectId !== job.subjectId) {
      throw new Error('Research params subjectId does not match job subjectId');
    }
  }
  const subjectId = job.subjectId;

  const hasFindingIds = hasOwn(raw, 'findingIds');
  const hasTopic = hasOwn(raw, 'topic');
  if (hasFindingIds === hasTopic) {
    throw new Error('Research params must provide exactly one of findingIds or topic');
  }

  if (hasTopic) {
    if (typeof raw.topic !== 'string' || raw.topic.trim().length === 0) {
      throw new Error('Research topic must be a non-empty string');
    }
    if (hasOwn(raw, 'remediationContext')) {
      throw new Error('Research topic params cannot include remediation context');
    }
    if (hasOwn(raw, 'lintJobId')) {
      throw new Error('Research topic params cannot include lintJobId');
    }
    return { subjectId, topic: raw.topic.trim() };
  }

  if (
    !Array.isArray(raw.findingIds)
    || raw.findingIds.length === 0
    || !raw.findingIds.every(
      (findingId) => typeof findingId === 'string' && FINDING_ID_PATTERN.test(findingId),
    )
  ) {
    throw new Error('Research findingIds must contain valid finding IDs');
  }
  if (raw.findingIds.length > MAX_RESEARCH_FINDING_IDS) {
    throw new Error(`Research findingIds must contain at most ${MAX_RESEARCH_FINDING_IDS} values`);
  }
  if (typeof raw.lintJobId !== 'string' || raw.lintJobId.trim().length === 0) {
    throw new Error('Research findingIds require a non-empty lintJobId');
  }

  const findingIds = raw.findingIds as string[];
  const lintJobId = raw.lintJobId;
  if (!hasOwn(raw, 'remediationContext')) {
    throw new Error('Research findingIds require remediation context');
  }
  const context = raw.remediationContext;
  if (!isRecord(context)) {
    throw new Error('Research remediation context must be an object');
  }
  if (context.action !== 'research') {
    throw new Error('Research remediation action mismatch');
  }
  if (
    typeof context.lintJobId !== 'string'
    || !Array.isArray(context.findingIds)
    || context.findingIds.length === 0
    || context.findingIds.length > MAX_RESEARCH_FINDING_IDS
    || !context.findingIds.every(
      (findingId) => typeof findingId === 'string' && FINDING_ID_PATTERN.test(findingId),
    )
  ) {
    throw new Error('Research remediation context is invalid');
  }

  const remediationContext = normalizeRemediationContext({
    lintJobId: context.lintJobId,
    findingIds: context.findingIds,
    action: 'research',
  });
  const normalizedParams = normalizeRemediationContext({
    lintJobId,
    findingIds,
    action: 'research',
  });
  if (
    remediationContext.lintJobId !== normalizedParams.lintJobId
    || !sameStringArray(remediationContext.findingIds, normalizedParams.findingIds)
  ) {
    throw new Error('Research remediation context does not match finding params');
  }

  return { subjectId, findingIds, lintJobId, remediationContext };
}

export async function runResearchJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = parseResearchParams(job);
  const persisted = researchProvenanceRepo.findResearchRunByJobId(job.id, params.subjectId);
  if (persisted) return resultFromPersistedRun(persisted);

  const subject = subjectsRepo.getById(params.subjectId);
  if (!subject) throw new Error(`Subject ${params.subjectId} not found`);

  const scope = params.topic
    ? { topics: [params.topic], findings: [] }
    : resolveResearchScopeFromFindingIds(
      params.subjectId,
      params.lintJobId!,
      params.findingIds!,
    );
  const topics = scope.topics;

  if (topics.length === 0) {
    throw new Error('No topics resolved for research job');
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

  // ③ triage — 失败降级为按排名前 3 未评分
  let results: ResearchCandidate[] = [];
  if (candidates.length > 0) {
    emit('research:triage', `Triaging ${candidates.length} candidate(s)...`);
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
  }

  const stored = researchProvenanceRepo.persistResearchRun({
    subjectId: params.subjectId,
    researchJobId: job.id,
    origin: params.topic ? 'topic' : 'findings',
    lintJobId: params.lintJobId ?? null,
    topic: params.topic ?? null,
    topics,
    queries,
    findings: scope.findings,
    candidates: prepareResearchCandidates(results),
  });
  emit('research:complete', `Research complete: ${results.length} candidate(s) proposed`, {
    runId: stored.run.id,
    count: results.length,
  });

  return resultFromPersistedRun(stored);
}

function resultFromPersistedRun(
  stored: researchProvenanceRepo.StoredResearchRun,
): {
  runId: string;
  candidates: ResearchCandidateSnapshot[];
  topics: string[];
  queries: string[];
} {
  const topics = parseStringArray(stored.run.topicsJson, 'topics');
  const queries = parseStringArray(stored.run.queriesJson, 'queries');
  const candidates = validateStoredResearchCandidates(
    stored.run.id,
    stored.run.candidateSetHash,
    stored.candidates,
  );
  for (const finding of stored.findings) {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(finding.snapshotJson);
    } catch {
      throw new Error(`Persisted Research finding snapshot is invalid: ${finding.findingId}`);
    }
    const parsed = parseResearchFindingSnapshot(snapshot);
    if (findingId({ ...parsed, subjectId: stored.run.subjectId }) !== finding.findingId) {
      throw new Error(`Persisted Research finding ID is invalid: ${finding.findingId}`);
    }
  }
  return { runId: stored.run.id, candidates, topics, queries };
}

function parseStringArray(json: string, label: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`Persisted Research ${label} snapshot is invalid`);
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Persisted Research ${label} snapshot is invalid`);
  }
  return value;
}

registerHandler('research', runResearchJob);

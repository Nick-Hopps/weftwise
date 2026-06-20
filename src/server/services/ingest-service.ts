// src/server/services/ingest-service.ts
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { parseSourceAsync, requiresBuffer } from '../sources/parser-registry';
import { getRawSourceContent, getRawSourceBuffer, updateSourceChunks } from '../sources/source-store';
import {
  getAgentMaxSteps,
  getAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
  getWikiLanguage,
} from '../db/repos/settings-repo';
import { renderLanguageDirective } from '../llm/prompts/prompt-context';
import { runPipeline, type PipelineStep } from '../agents/runtime/orchestrator';
import { createBudgetTracker } from '../agents/runtime/budget';
import { createOverlayVault } from '../agents/runtime/overlay-vault';
import { loadCheckpoint } from '../agents/runtime/checkpoint';
import {
  prepareIngest,
  fillInlineContent,
  isInlinePath,
  estimateIngestCost,
  reduceCostForResume,
} from './ingest-prep';
import { getRuntimeRegistries } from '../worker-runtime';
import { randomUUID } from 'node:crypto';
import type { AgentContext } from '../agents/types';
import type { IngestResult, Job } from '@/lib/contracts';

// 当前单源；prepareIngest 已接受数组，未来多源批量在此扩展
interface IngestParams {
  sourceId: string;
  filename: string;
  subjectId: string;
}

async function loadCleanText(filename: string, subjectSlug: string): Promise<string> {
  let textContent: string;
  let bufferContent: Buffer | null = null;
  if (requiresBuffer(filename)) {
    bufferContent = getRawSourceBuffer(subjectSlug, filename);
    if (!bufferContent) {
      throw new Error(`Source file not found: ${filename}`);
    }
    textContent = '';
  } else {
    const raw = getRawSourceContent(subjectSlug, filename);
    if (!raw) {
      throw new Error(`Source file not found: ${filename}`);
    }
    textContent = raw;
  }
  const parsed = await parseSourceAsync(filename, textContent, bufferContent);
  return parsed.cleanText;
}

registerHandler('ingest', async (job: Job, emit): Promise<Record<string, unknown>> => {
  const params = JSON.parse(job.paramsJson) as Partial<IngestParams>;
  const { sourceId, filename, subjectId } = params;
  if (!sourceId || !filename) throw new Error('Ingest job missing sourceId or filename');
  if (!subjectId) throw new Error('Ingest job missing subjectId — re-queue with a subject');

  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  emit('ingest:start', `Ingest started for subject ${subject.slug}`, { subject: subject.slug, filename });

  emit('ingest:parsing', `Parsing source: ${filename}`);
  const cleanText = await loadCleanText(filename, subject.slug);

  // 解析期确定性准备：预清洗 → 切块（零 token）
  const prep = prepareIngest([{ sourceId, filename, cleanText }]);
  updateSourceChunks(sourceId, prep.chunksBySource[sourceId] ?? []);

  const budgetSnapshot = {
    maxSteps: getAgentMaxSteps(),
    maxTokensPerJob: getAgentMaxTokensPerJob(),
    maxParallelSubAgents: getAgentMaxParallelSubAgents(),
  };

  // 断点续传：载入该 job 已有检查点（重试 = requeue 同一 job.id）
  const checkpoint = loadCheckpoint(job.id);
  if (checkpoint.hasAny()) {
    const p = checkpoint.progress();
    emit(
      'ingest:resuming',
      `Resuming ingest: plan ${p.plan ? 'cached' : 'pending'}, ${p.chunkSummaries} summaries, ${p.writerPages}${p.totalPages ? `/${p.totalPages}` : ''} pages done`,
      { progress: p },
    );
  }

  // 预算预检（spec E.2）：任何 LLM 调用前 fail-fast；恢复态按已完成产物折减估算
  const inline = isInlinePath(prep.totalTokens);
  const fullEstimate = estimateIngestCost(prep.totalTokens, prep.chunkCount, inline);
  const estimatedCost = checkpoint.hasAny()
    ? reduceCostForResume(fullEstimate, checkpoint.progress())
    : fullEstimate;
  emit('ingest:chunking', `Chunked into ${prep.chunkCount} chunks (~${prep.totalTokens} tokens)`, {
    chunkCount: prep.chunkCount,
    totalTokens: prep.totalTokens,
    estimatedCost,
  });
  if (estimatedCost > budgetSnapshot.maxTokensPerJob) {
    throw new Error(
      `Estimated cost ~${estimatedCost} tokens exceeds budget agentMaxTokensPerJob=${budgetSnapshot.maxTokensPerJob}; ` +
      `raise it to >= ${Math.ceil(estimatedCost * 1.1)} in Settings and retry`,
    );
  }

  const { skillRegistry, toolRegistry } = getRuntimeRegistries();

  // Skill 契约版本守卫：planner v2 起产 sourceRefs / writer 收 relevantChunks；
  // writer v3 起 outputSchema 扁平化（去掉 entry 包装——单键包装会被 DeepSeek 等拍平致
  // 结构化输出失败），与 orchestrator 扁平消费强绑定。
  // 播种不覆盖已存在文件，存量 vault 的旧 skill 会静默产零素材/丢页，必须拦截。
  const MIN_SKILL_VERSIONS: Record<string, number> = { 'ingest-planner': 2, 'ingest-writer': 3, 'ingest-reviewer': 2 };
  for (const [skillId, minVersion] of Object.entries(MIN_SKILL_VERSIONS)) {
    const s = skillRegistry.get(skillId);
    if (!s) throw new Error(`Skill not loaded: ${skillId}`);
    if (s.version < minVersion) {
      throw new Error(
        `Skill "${skillId}" is v${s.version} but this pipeline requires v${minVersion}+. ` +
        `Your vault has an outdated copy: delete vault/.llm-wiki/skills/${skillId}.md (or merge the new template from examples/skills/) and restart the worker to re-seed.`,
      );
    }
  }

  const budget = createBudgetTracker(budgetSnapshot);
  const overlay = createOverlayVault({ subjectSlug: subject.slug });

  const ctx: AgentContext = {
    job,
    subject,
    emit,
    budget,
    overlay,
    toolRegistry,
    skillRegistry,
    rootRunId: randomUUID(),
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    chunkStore: prep.chunkStore,
    budgetSnapshot,
    checkpoint,
  };

  const existingPages = pagesRepo
    .getAllPages(subjectId)
    .map((p) => ({ slug: p.slug, title: p.title, summary: p.summary }));

  const languageDirective = renderLanguageDirective(getWikiLanguage());

  // carry 透传 key：让 planner 输出后 fanout/reviewer 仍能读到上下文（planner outputSchema 只有 plan）
  const carryKeys = ['chunkRefs', 'sources', 'subjectSlug', 'existingPages', 'outline', 'languageDirective'];
  const steps: PipelineStep[] = [
    ...(inline
      ? []
      : [{ kind: 'map', skillId: 'ingest-chunk-summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs', checkpointAs: 'chunk-summary' } as const]),
    { kind: 'sequence', skillId: 'ingest-planner', carryThrough: carryKeys, checkpointAs: 'plan' },
    { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page' },
    { kind: 'sequence', skillId: 'ingest-reviewer', omitFromInput: ['chunkRefs', 'outline'] },
  ];

  emit('ingest:planning', `Planning source: ${filename}`, { path: inline ? 'inline' : 'map-reduce' });

  const result = await runPipeline({
    steps,
    resolveSkill: (id) => {
      const s = skillRegistry.get(id);
      if (!s) throw new Error(`Skill not loaded: ${id}`);
      return s;
    },
    ctx,
    initialInput: {
      chunkRefs: inline ? fillInlineContent(prep.chunkRefs, prep.chunkStore) : prep.chunkRefs,
      sources: [{ sourceId, filename }],
      subjectSlug: subject.slug,
      existingPages,
      outline: prep.outline,
      languageDirective,
    },
  }) as IngestResult;

  // 成功（reviewer 已 commit）→ 清除检查点；失败时不清，留给下次重试
  checkpoint.clear();

  return result as unknown as Record<string, unknown>;
});

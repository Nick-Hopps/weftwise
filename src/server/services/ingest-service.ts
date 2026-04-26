import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { parseSourceAsync, requiresBuffer } from '../sources/parser-registry';
import { getRawSourceContent, getRawSourceBuffer } from '../sources/source-store';
import {
  getAgentMaxSteps,
  getAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
} from '../db/repos/settings-repo';
import { runPipeline } from '../agents/runtime/orchestrator';
import { createBudgetTracker } from '../agents/runtime/budget';
import { createOverlayVault } from '../agents/runtime/overlay-vault';
import { getRuntimeRegistries } from '../worker-runtime';
import { randomUUID } from 'node:crypto';
import type { AgentContext } from '../agents/types';
import type { IngestResult, Job } from '@/lib/contracts';

const SOURCE_TEXT_LIMIT = 30_000;

interface IngestParams {
  sourceId: string;
  filename: string;
  subjectId: string;
}

interface PlannedSource {
  filename: string;
  contentSummary: string;
  fullText: string;
}

async function loadSingleSource(filename: string, subjectSlug: string): Promise<PlannedSource> {
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
  return {
    filename,
    contentSummary: '',
    fullText: parsed.cleanText.slice(0, SOURCE_TEXT_LIMIT),
  };
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
  const source = await loadSingleSource(filename, subject.slug);

  const { skillRegistry, toolRegistry } = getRuntimeRegistries();
  const budgetSnapshot = {
    maxSteps: getAgentMaxSteps(),
    maxTokensPerJob: getAgentMaxTokensPerJob(),
    maxParallelSubAgents: getAgentMaxParallelSubAgents(),
  };
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
    budgetSnapshot,
  };

  emit('ingest:planning', `Planning source: ${filename}`, {});

  const result = await runPipeline({
    steps: [
      { kind: 'sequence', skillId: 'ingest-planner' },
      { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages' },
      { kind: 'sequence', skillId: 'ingest-reviewer' },
    ],
    resolveSkill: (id) => {
      const s = skillRegistry.get(id);
      if (!s) throw new Error(`Skill not loaded: ${id}`);
      return s;
    },
    ctx,
    initialInput: {
      sources: [source],
      subjectSlug: subject.slug,
      existingPages: [],
    },
  }) as IngestResult;

  return result as unknown as Record<string, unknown>;
});

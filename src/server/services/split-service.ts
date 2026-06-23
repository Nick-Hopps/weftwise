/**
 * Split service — 任务类型 'split'。逻辑已抽到 wiki/page-ops.ts::executePageSplit。
 * 本文件只做参数解析、subject 解析、事件发射与向量回填。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('split', ...)。
 */
import { registerHandler } from '../jobs/worker';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { executePageSplit } from '../wiki/page-ops';
import type { Job } from '@/lib/contracts';

interface SplitParams {
  sourceSlug?: string;
  hint?: string;
  subjectId?: string;
}

async function runSplitJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as SplitParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('split job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  const { sourceSlug, hint } = params;
  if (!sourceSlug) throw new Error('split job missing sourceSlug');

  emit('split:start', `Splitting "${sourceSlug}"…`, { sourceSlug });
  const res = await executePageSplit(job.id, subject, { sourceSlug, hint });
  emit('split:complete', `Split into ${res.pageSlugs.length} pages; repointed ${res.referencesRepointed} reference(s)`, res);

  enqueueEmbedIndex(subject.id);
  return res;
}

registerHandler('split', runSplitJob);

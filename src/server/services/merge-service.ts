/**
 * Merge service — 任务类型 'merge'。逻辑已抽到 wiki/page-ops.ts::executePageMerge。
 * 本文件只做参数解析、subject 解析、事件发射与向量回填。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('merge', ...)。
 */
import { registerHandler } from '../jobs/worker';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { executePageMerge } from '../wiki/page-ops';
import type { Job } from '@/lib/contracts';

interface MergeParams {
  targetSlug?: string;
  sourceSlug?: string;
  subjectId?: string;
}

async function runMergeJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as MergeParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('merge job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  const { targetSlug, sourceSlug } = params;
  if (!targetSlug || !sourceSlug) throw new Error('merge job missing targetSlug/sourceSlug');

  emit('merge:start', `Merging "${sourceSlug}" into "${targetSlug}"…`, { targetSlug, sourceSlug });
  const res = await executePageMerge(job.id, subject, { targetSlug, sourceSlug });
  emit('merge:complete', `Merged into "${targetSlug}"; repointed ${res.referencesRepointed} reference(s)`, res);

  enqueueEmbedIndex(subject.id);
  return res;
}

registerHandler('merge', runMergeJob);

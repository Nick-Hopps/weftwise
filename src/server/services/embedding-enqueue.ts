import * as queue from '@/server/jobs/queue';

/** 只负责持久化 embedding job；不注册 worker handler，便于事务编排复用。 */
export function enqueueEmbedIndex(subjectId: string): void {
  queue.enqueue('embed-index', { subjectId }, subjectId);
}

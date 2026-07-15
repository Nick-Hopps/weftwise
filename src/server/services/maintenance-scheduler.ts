/**
 * 维护调度：选「到期 + 高优先级」页，在每轮页数上限内回调入队 re-enrich。
 * 只选页 + 回调入队，不直接写盘（写由 re-enrich job 在 worker 串行执行）。
 */
import * as maturityRepo from '../db/repos/maturity-repo';

export function runMaintenanceSweep(opts: {
  now: Date;
  maxPages: number;
  /** 缺省为全部 Subject；传入集合时只扫描其中项目。 */
  subjectIds?: readonly string[];
  enqueue: (slug: string, subjectId: string) => void;
  log: (msg: string) => void;
}): number {
  const nowIso = opts.now.toISOString();
  // 多取一个以判断是否还有剩余到期页（用于 log 截断量）。
  const due = maturityRepo.listDue(nowIso, opts.maxPages + 1, opts.subjectIds);
  const selected = due.slice(0, opts.maxPages);
  for (const d of selected) opts.enqueue(d.slug, d.subjectId);
  if (due.length > opts.maxPages) {
    opts.log(
      `maintenance sweep: enqueued ${selected.length} (cap ${opts.maxPages}); more due pages deferred to next sweep`,
    );
  }
  return selected.length;
}

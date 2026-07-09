import { asc, count, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../client';
import { llmUsage } from '../schema';
import type { UsageSummaryRow } from '@/lib/contracts';

/** llm_usage 保留窗口：90 天（worker sweep tick 按此清理）。 */
export const USAGE_RETENTION_MS = 90 * 24 * 3600 * 1000;

/** 非 finite / 负数归一化为 null（两者皆 null 时整行不记）。 */
function normalizeTokens(n: number | undefined): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

/**
 * 记录一次 LLM 调用用量。best-effort：写库失败吞错返回 false，绝不影响调用方。
 * input/output 两者都缺失（供应商未返回 usage）时不写行，避免污染统计。
 */
export function recordUsage(entry: {
  task: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}): boolean {
  const input = normalizeTokens(entry.inputTokens);
  const output = normalizeTokens(entry.outputTokens);
  if (input === null && output === null) return false;
  try {
    getDb()
      .insert(llmUsage)
      .values({
        task: entry.task,
        model: entry.model,
        inputTokens: input ?? 0,
        outputTokens: output ?? 0,
        createdAt: Date.now(),
      })
      .run();
    return true;
  } catch (err) {
    console.warn('[usage] recordUsage failed (ignored)', err);
    return false;
  }
}

/** 按 (task, model) 聚合；sinceMs 含边界（created_at >= sinceMs）。 */
export function summarizeUsage(sinceMs?: number): UsageSummaryRow[] {
  const db = getDb();
  const base = db
    .select({
      task: llmUsage.task,
      model: llmUsage.model,
      calls: count(),
      inputTokens: sql<number>`sum(${llmUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${llmUsage.outputTokens})`,
    })
    .from(llmUsage);
  const filtered = sinceMs !== undefined ? base.where(gte(llmUsage.createdAt, sinceMs)) : base;
  return filtered
    .groupBy(llmUsage.task, llmUsage.model)
    .orderBy(asc(llmUsage.task), asc(llmUsage.model))
    .all();
}

/** 删除 cutoffMs 之前的行，返回删除行数。 */
export function pruneOldUsage(cutoffMs: number): number {
  const result = getDb().delete(llmUsage).where(lt(llmUsage.createdAt, cutoffMs)).run();
  return result.changes;
}

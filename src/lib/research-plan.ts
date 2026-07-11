/**
 * Research 纯函数：query 去重截断 / 候选 URL 归一化去重 / triage 降级排序 / 默认勾选派生。
 * 全部无副作用、零 server 依赖，放 lib 供 server（research-service）与客户端
 * （research-candidates-dialog）两端复用——对齐 lib/slug.ts、lib/tool-activity.ts 惯例。
 */
import type { ResearchCandidate } from '@/lib/contracts';

export const MAX_QUERIES = 3;
export const MAX_CANDIDATES = 12;
export const MAX_RESULTS = 6;
/** triage 保留门槛：score >= 2 才进入最终产出。 */
export const MIN_TRIAGE_SCORE = 2;
/** 前端默认勾选门槛：score === 3 才默认选中。 */
export const DEFAULT_CHECK_SCORE = 3;

/** 归一化 URL 用于去重：去 trailing slash、忽略 hash、大小写不敏感的 scheme+host。 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

/** query 去重（trim + 大小写不敏感）+ 截断到 MAX_QUERIES。 */
export function dedupeQueries(queries: string[], max: number = MAX_QUERIES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of queries) {
    const q = raw.trim();
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

export interface RawCandidate {
  url: string;
  title: string;
  snippet: string;
}

/** 按归一化 URL 去重（先到先得，保留搜索排名顺序）+ 截断到 MAX_CANDIDATES。 */
export function dedupeCandidates(candidates: RawCandidate[], max: number = MAX_CANDIDATES): RawCandidate[] {
  const seen = new Set<string>();
  const out: RawCandidate[] = [];
  for (const c of candidates) {
    if (!c.url) continue;
    const key = normalizeUrl(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

export interface TriageResult {
  url: string;
  score: number;
  reason: string;
}

/**
 * 用 triage 结果给候选打分排序：score >= MIN_TRIAGE_SCORE 保留，按 score 降序，截断到 MAX_RESULTS。
 * 未出现在 triageResults 中的候选（模型漏打分）视为 score 0，被过滤掉。
 */
export function applyTriage(
  candidates: RawCandidate[],
  triageResults: TriageResult[],
  max: number = MAX_RESULTS,
): ResearchCandidate[] {
  const byUrl = new Map<string, TriageResult>();
  for (const t of triageResults) byUrl.set(normalizeUrl(t.url), t);

  const scored: ResearchCandidate[] = candidates
    .map((c) => {
      const t = byUrl.get(normalizeUrl(c.url));
      return {
        url: c.url,
        title: c.title,
        snippet: c.snippet,
        score: t ? t.score : 0,
        reason: t ? t.reason : null,
      };
    })
    .filter((c) => (c.score ?? 0) >= MIN_TRIAGE_SCORE);

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored.slice(0, max);
}

/**
 * triage 失败时的降级：按搜索排名（候选数组原始顺序即排名）取前 3，标注未评分（score: null）。
 */
export function fallbackTriage(candidates: RawCandidate[], max = 3): ResearchCandidate[] {
  return candidates.slice(0, max).map((c) => ({
    url: c.url,
    title: c.title,
    snippet: c.snippet,
    score: null,
    reason: null,
  }));
}

/** 前端默认勾选派生：score === DEFAULT_CHECK_SCORE 才默认选中；未评分/低分默认不选。 */
export function defaultChecked(candidate: ResearchCandidate): boolean {
  return candidate.score === DEFAULT_CHECK_SCORE;
}

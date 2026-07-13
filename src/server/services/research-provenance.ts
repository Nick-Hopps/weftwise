import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  EnrichedLintFinding,
  ResearchCandidate,
  ResearchCandidateSnapshot,
} from '@/lib/contracts';
import { validateHttpUrl } from '../sources/url-safety';

export type ResearchProvenanceErrorCode =
  | 'invalid-candidate'
  | 'duplicate-candidate-url'
  | 'invalid-selection';

/** Research provenance 在进入仓储前可安全识别的确定性契约错误。 */
export class ResearchProvenanceError extends Error {
  constructor(
    readonly code: ResearchProvenanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ResearchProvenanceError';
  }
}

const ResearchCandidateBodySchema = z.object({
  url: z.string().min(1),
  title: z.string(),
  snippet: z.string(),
  score: z.number().int().min(0).max(3).nullable(),
  reason: z.string().nullable(),
}).strict();

const ResearchCandidateSnapshotSchema = ResearchCandidateBodySchema.extend({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  normalizedUrl: z.string().min(1),
  rank: z.number().int().nonnegative(),
}).strict();

const ResearchFindingSnapshotSchema = z.object({
  type: z.enum([
    'broken-link',
    'orphan',
    'missing-frontmatter',
    'stale-source',
    'contradiction',
    'missing-crossref',
    'coverage-gap',
    'orphan-source',
    'thin-page',
  ]),
  severity: z.enum(['critical', 'warning', 'info']),
  pageSlug: z.string(),
  sourceId: z.string().optional(),
  sourceFilename: z.string().optional(),
  description: z.string(),
  suggestedFix: z.string().nullable(),
  subjectSlug: z.string(),
}).strict();

export type ResearchFindingSnapshot = z.infer<typeof ResearchFindingSnapshotSchema>;

export interface PreparedResearchCandidate {
  normalizedUrl: string;
  snapshot: ResearchCandidate;
  rank: number;
}

export interface StoredResearchCandidateEvidence {
  id: string;
  normalizedUrl: string;
  snapshotJson: string;
  rank: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 生成候选 URL 的稳定身份。这里仅做无网络的语法与静态出网边界校验；
 * 实际抓取仍必须在每一跳重新解析 DNS 并固定连接地址。
 */
export function normalizeResearchCandidateUrl(raw: string): string {
  const url = validateHttpUrl(raw.trim());
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}${url.search}`;
}

/** 稳定 candidate ID，格式由 Phase 2C 设计文档固定。 */
export function researchCandidateId(runId: string, normalizedUrl: string): string {
  return sha256(`${runId}\n${normalizedUrl}`);
}

/** 将模型最终候选变为可持久化、带稳定顺序的候选输入。 */
export function prepareResearchCandidates(
  candidates: ResearchCandidate[],
): PreparedResearchCandidate[] {
  const seen = new Set<string>();
  return candidates.map((candidate, rank) => {
    const parsed = ResearchCandidateBodySchema.parse({
      ...candidate,
      url: candidate.url.trim(),
    });
    const normalizedUrl = normalizeResearchCandidateUrl(parsed.url);
    if (seen.has(normalizedUrl)) {
      throw new ResearchProvenanceError(
        'duplicate-candidate-url',
        `Research candidates contain duplicate normalized URL: ${normalizedUrl}`,
      );
    }
    seen.add(normalizedUrl);
    // snapshot 也使用服务端规范化 URL，避免同一身份因大小写、hash 或尾斜线产生 hash 漂移。
    const snapshot = { ...parsed, url: normalizedUrl };
    return { normalizedUrl, snapshot, rank };
  });
}

/** 按最终候选顺序计算不可变快照 hash，不包含尚未分配的 run/candidate ID。 */
export function researchCandidateSetHash(
  candidates: PreparedResearchCandidate[],
): string {
  const canonical = candidates.map((candidate, index) => {
    if (candidate.rank !== index) {
      throw new ResearchProvenanceError(
        'invalid-candidate',
        'Research candidate ranks must be contiguous and preserve result order',
      );
    }
    const snapshot = ResearchCandidateBodySchema.parse(candidate.snapshot);
    const normalizedUrl = normalizeResearchCandidateUrl(snapshot.url);
    if (normalizedUrl !== candidate.normalizedUrl) {
      throw new ResearchProvenanceError(
        'invalid-candidate',
        'Research candidate URL identity does not match its snapshot',
      );
    }
    return {
      normalizedUrl,
      rank: candidate.rank,
      snapshot,
    };
  });
  return sha256(JSON.stringify(canonical));
}

/** 空选择和重复 ID 都必须在计算批准 hash 前拒绝。 */
export function canonicalizeResearchSelection(candidateIds: string[]): string[] {
  if (candidateIds.length === 0) {
    throw new ResearchProvenanceError(
      'invalid-selection',
      'Research approval selection must not be empty',
    );
  }
  if (candidateIds.some((id) => typeof id !== 'string')) {
    throw new ResearchProvenanceError(
      'invalid-selection',
      'Research approval selection must contain string candidate IDs',
    );
  }
  const unique = new Set(candidateIds);
  if (unique.size !== candidateIds.length || candidateIds.some((id) => id.length === 0)) {
    throw new ResearchProvenanceError(
      'invalid-selection',
      'Research approval selection contains duplicate or empty candidate IDs',
    );
  }
  return [...unique].sort();
}

/** 批准 payload hash 只依赖 run、客户端看到的版本与 canonical selection。 */
export function researchApprovalPayloadHash(
  runId: string,
  version: number,
  candidateIds: string[],
): string {
  const selection = canonicalizeResearchSelection(candidateIds);
  return sha256(JSON.stringify({ runId, version, candidateIds: selection }));
}

/** 严格读取持久化候选，防止损坏 JSON 或身份漂移被当作可批准证据。 */
export function parseResearchCandidateSnapshot(value: unknown): ResearchCandidateSnapshot {
  const snapshot = ResearchCandidateSnapshotSchema.parse(value);
  if (normalizeResearchCandidateUrl(snapshot.url) !== snapshot.normalizedUrl) {
    throw new ResearchProvenanceError(
      'invalid-candidate',
      'Persisted Research candidate URL identity is inconsistent',
    );
  }
  return snapshot;
}

/**
 * 在批准或恢复前重新验证数据库中的整组候选证据；任何 row/snapshot/hash 漂移都 fail-closed。
 */
export function validateStoredResearchCandidates(
  runId: string,
  candidateSetHash: string,
  rows: StoredResearchCandidateEvidence[],
): ResearchCandidateSnapshot[] {
  const ordered = [...rows].sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
  const snapshots = ordered.map((row) => {
    let body: unknown;
    try {
      body = JSON.parse(row.snapshotJson);
    } catch {
      throw new ResearchProvenanceError(
        'invalid-candidate',
        `Persisted Research candidate snapshot is invalid: ${row.id}`,
      );
    }
    const parsedBody = ResearchCandidateBodySchema.parse(body);
    const snapshot = parseResearchCandidateSnapshot({
      ...parsedBody,
      id: row.id,
      normalizedUrl: row.normalizedUrl,
      rank: row.rank,
    });
    if (snapshot.id !== researchCandidateId(runId, snapshot.normalizedUrl)) {
      throw new ResearchProvenanceError(
        'invalid-candidate',
        `Persisted Research candidate ID is invalid: ${row.id}`,
      );
    }
    return snapshot;
  });
  const prepared = snapshots.map((snapshot) => ({
    normalizedUrl: snapshot.normalizedUrl,
    rank: snapshot.rank,
    snapshot: {
      url: snapshot.url,
      title: snapshot.title,
      snippet: snapshot.snippet,
      score: snapshot.score,
      reason: snapshot.reason,
    },
  }));
  if (researchCandidateSetHash(prepared) !== candidateSetHash) {
    throw new ResearchProvenanceError(
      'invalid-candidate',
      'Persisted Research candidate set hash mismatch',
    );
  }
  return snapshots;
}

/** 将 lint finding 物化为不依赖原 lint job 的可解释快照。 */
export function researchFindingSnapshot(
  finding: EnrichedLintFinding,
): ResearchFindingSnapshot {
  return ResearchFindingSnapshotSchema.parse({
    type: finding.type,
    severity: finding.severity,
    pageSlug: finding.pageSlug,
    ...(finding.sourceId === undefined ? {} : { sourceId: finding.sourceId }),
    ...(finding.sourceFilename === undefined ? {} : { sourceFilename: finding.sourceFilename }),
    description: finding.description,
    suggestedFix: finding.suggestedFix,
    subjectSlug: finding.subjectSlug,
  });
}

export function parseResearchFindingSnapshot(value: unknown): ResearchFindingSnapshot {
  return ResearchFindingSnapshotSchema.parse(value);
}

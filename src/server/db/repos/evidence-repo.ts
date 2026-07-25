import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../client';
import { pageEvidence } from '../schema';
import {
  EVIDENCE_KIND_META,
  isEvidenceKind,
  type EvidenceKind,
  type EvidenceRow,
  type EvidenceStrength,
} from '@/lib/contracts';

export interface AppendEvidenceInput {
  userId: string;
  subjectId: string;
  slug: string;
  kind: EvidenceKind;
  anchor?: string | null;
  /** 类型相关载荷（viewedSource / profileVersion 等归因字段），只用于事后审计。 */
  detail?: unknown;
  /** 仅 `quiz-correct` 可上调（见 EVIDENCE_KIND_META.strengthOverridable）。 */
  strength?: EvidenceStrength;
  /** 测试与回填用；缺省取当前时间。 */
  createdAt?: string;
}

/** polarity 与 strength 由 kind 确定性派生后冗余落列——新增 kind 不必回填历史行。 */
function resolveWeights(
  kind: EvidenceKind,
  requested: EvidenceStrength | undefined,
): { polarity: string; strength: EvidenceStrength } {
  const meta = EVIDENCE_KIND_META[kind];
  const strength =
    meta.strengthOverridable && requested ? requested : meta.strength;
  return { polarity: meta.polarity, strength };
}

export function appendEvidence(input: AppendEvidenceInput): void {
  if (!isEvidenceKind(input.kind)) {
    throw new Error(`Unknown evidence kind: ${String(input.kind)}`);
  }
  const { polarity, strength } = resolveWeights(input.kind, input.strength);
  getDb()
    .insert(pageEvidence)
    .values({
      userId: input.userId,
      subjectId: input.subjectId,
      slug: input.slug,
      kind: input.kind,
      polarity,
      strength,
      anchor: input.anchor ?? null,
      detailJson: input.detail === undefined ? null : JSON.stringify(input.detail),
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    .run();
}

const ROW_COLUMNS = {
  kind: pageEvidence.kind,
  polarity: pageEvidence.polarity,
  strength: pageEvidence.strength,
  anchor: pageEvidence.anchor,
  createdAt: pageEvidence.createdAt,
} as const;

type RawRow = { kind: string; polarity: string; strength: string; anchor: string | null; createdAt: string };

function toRow(r: RawRow): EvidenceRow {
  return {
    kind: r.kind as EvidenceRow['kind'],
    polarity: r.polarity as EvidenceRow['polarity'],
    strength: r.strength as EvidenceRow['strength'],
    anchor: r.anchor,
    createdAt: r.createdAt,
  };
}

/** 单页全部证据，按时间正序（派生与审计面都按时间读）。 */
export function listForPage(userId: string, subjectId: string, slug: string): EvidenceRow[] {
  return getDb()
    .select(ROW_COLUMNS)
    .from(pageEvidence)
    .where(
      and(
        eq(pageEvidence.userId, userId),
        eq(pageEvidence.subjectId, subjectId),
        eq(pageEvidence.slug, slug),
      ),
    )
    .orderBy(asc(pageEvidence.createdAt), asc(pageEvidence.id))
    .all()
    .map(toRow);
}

/** 图层全量：一次索引扫描 + 内存分组，不做 N 次单页查询。 */
export function listForSubject(userId: string, subjectId: string): Map<string, EvidenceRow[]> {
  const rows = getDb()
    .select({ slug: pageEvidence.slug, ...ROW_COLUMNS })
    .from(pageEvidence)
    .where(and(eq(pageEvidence.userId, userId), eq(pageEvidence.subjectId, subjectId)))
    .orderBy(asc(pageEvidence.createdAt), asc(pageEvidence.id))
    .all();

  const grouped = new Map<string, EvidenceRow[]>();
  for (const r of rows) {
    const list = grouped.get(r.slug);
    if (list) list.push(toRow(r));
    else grouped.set(r.slug, [toRow(r)]);
  }
  return grouped;
}

/**
 * 删页：清掉该页全部用户的证据。不按 userId 过滤——页面身份没了，谁的证据都失去归属；
 * 留着会在同 slug 重建时复活旧掌握度。
 */
export function deleteByPage(subjectId: string, slug: string): void {
  getDb()
    .delete(pageEvidence)
    .where(and(eq(pageEvidence.subjectId, subjectId), eq(pageEvidence.slug, slug)))
    .run();
}

/** move / rename：证据跟随新 slug（同上，跨全部用户）。 */
export function movePage(subjectId: string, fromSlug: string, toSlug: string): void {
  getDb()
    .update(pageEvidence)
    .set({ slug: toSlug })
    .where(and(eq(pageEvidence.subjectId, subjectId), eq(pageEvidence.slug, fromSlug)))
    .run();
}

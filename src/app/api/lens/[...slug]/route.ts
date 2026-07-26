import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getPageBySlug } from '@/server/db/repos/pages-repo';
import { readPageInSubject } from '@/server/wiki/wiki-store';
import { getProfileOrDefault } from '@/server/db/repos/profiles-repo';
import { computeCanonicalHash } from '@/server/profile/rendition-hash';
import { getLatestRendition, replaceRendition } from '@/server/db/repos/renditions-repo';
import { reshapePageBody } from '@/server/services/reshape-service';
import { buildKnownConceptsForPage, loadSubjectEvidence } from '@/server/profile/concept-map-io';
import { renderKnownConcepts, type KnownConcepts } from '@/server/profile/concept-map';
import { recordEvidence } from '@/server/services/record-evidence';
import { isReshapeConfigured } from '@/server/llm/provider-registry';

export const runtime = 'nodejs';

interface LensContext {
  subject: NonNullable<ReturnType<typeof resolveSubjectFromRequest>['subject']>;
  slug: string;
  body: string;
  userId: string;
  profile: ReturnType<typeof getProfileOrDefault>;
  canonicalHash: string;
}

interface MapSnapshot {
  concepts: KnownConcepts;
  rendered: string | null;
  /**
   * 落库/比对用的确定性序列化。
   *
   * 三段内按**邻域顺序**（`selectNeighborhood` 的首次出现顺序）排列、字段顺序固定——
   * 否则同一份地图两次算出的 JSON 字符串不同，**每一次 GET 都会误报 stale**，
   * 状态行上挂一个永远消不掉的 `Update available`，比不做这个功能更糟。
   */
  serialized: string;
}

/**
 * 算这一页的已知概念地图。**抛错按「无地图」继续**——重塑本身比地图重要，
 * 不该因为算不出地图就让读者拿不到重塑版。
 */
function buildMapSafely(context: LensContext): MapSnapshot | null {
  try {
    const { concepts, omitted } = buildKnownConceptsForPage({
      userId: context.userId,
      subject: context.subject,
      selfSlug: context.slug,
      body: context.body,
      evidenceBySlug: loadSubjectEvidence(context.userId, context.subject.id),
    });
    return {
      concepts,
      rendered: renderKnownConcepts(concepts, { omittedCount: omitted }),
      serialized: serializeKnownConcepts(concepts),
    };
  } catch (error) {
    console.error('[lens] known-concept map failed; continuing without it', error);
    return null;
  }
}

/** 段顺序、条目顺序、字段顺序全部固定；相同地图恒得相同字符串。 */
function serializeKnownConcepts(k: KnownConcepts): string {
  const section = (list: KnownConcepts['mastered']) =>
    list.map((c) => ({ slug: c.slug, title: c.title, state: c.state }));
  return JSON.stringify({
    mastered: section(k.mastered),
    exposed: section(k.exposed),
    struggling: section(k.struggling),
  });
}

/** 从存储的地图快照里取「被明确告知不必重讲」的 slug。解析失败按无地图处理。 */
function assumedKnownFrom(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Partial<KnownConcepts>;
    return (parsed.mastered ?? []).map((c) => c.slug);
  } catch {
    console.error('[lens] stored known_concepts_json is unparseable; ignoring');
    return [];
  }
}

async function resolveContext(
  request: NextRequest,
  params: Promise<{ slug: string[] }>,
): Promise<LensContext | NextResponse> {
  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  if (!getPageBySlug(subject.id, slug)) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }
  const body = readPageInSubject(subject.slug, slug)?.body ?? '';
  const userId = resolveUserId(request);
  const profile = getProfileOrDefault(userId);
  return { subject, slug, body, userId, profile, canonicalHash: computeCanonicalHash(body) };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const context = await resolveContext(request, params);
  if (context instanceof NextResponse) return context;

  const saved = getLatestRendition(context.subject.id, context.slug);
  if (!saved) {
    return NextResponse.json({ renderedMd: context.body, source: 'canonical', stale: false });
  }

  // 掌握度变化**不会**改 profileVersion（那个只在 style_prefs 变时自增）。没有这一项，
  // 答对一道 quiz、或点了「这个我其实不懂」之后旧重塑版照旧显示、不提示 Update available，
  // E3 的纠错闭环在 UI 上无从触发。
  let mapChanged = false;
  if (saved.knownConceptsJson !== null) {
    // 旧行（本功能上线前生成的 rendition）不参与地图比对——否则存量重塑版一上线全变 stale。
    const current = buildMapSafely(context);
    // 补算失败时退回既有两项判 stale，不因此隐藏已保存的重塑版。
    if (current) mapChanged = current.serialized !== saved.knownConceptsJson;
  }

  return NextResponse.json({
    renderedMd: saved.renderedMd,
    source: 'saved',
    // **从存储派生，不重算**：证据可能已经变了，重算出的清单会和当初真正告诉模型的
    // 那份对不上，纠错入口就会挂到模型其实展开讲过的概念上。
    assumedKnown: assumedKnownFrom(saved.knownConceptsJson),
    stale:
      saved.canonicalHash !== context.canonicalHash ||
      saved.profileVersion !== context.profile.version ||
      mapChanged,
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;
  const context = await resolveContext(request, params);
  if (context instanceof NextResponse) return context;
  if (!isReshapeConfigured()) {
    return NextResponse.json({ error: 'Reshape is not configured' }, { status: 503 });
  }

  const map = buildMapSafely(context);

  try {
    const result = await reshapePageBody({
      subject: context.subject,
      body: context.body,
      profile: {
        backgroundSummary: context.profile.backgroundSummary,
        stylePrefs: context.profile.stylePrefs,
      },
      knownConcepts: map?.rendered ?? null,
      abortSignal: request.signal,
    });
    replaceRendition({
      subjectId: context.subject.id,
      slug: context.slug,
      canonicalHash: context.canonicalHash,
      profileVersion: context.profile.version,
      renderedMd: result.body,
      model: result.model,
      assets: result.assets,
      knownConceptsJson: map?.serialized ?? null,
    });
    // D4：主动要求重塑本身就是「原文这样讲我没读顺」的弱信号。best-effort，
    // 失败不影响已经生成好的重塑版。
    recordEvidence({
      userId: context.userId,
      subjectId: context.subject.id,
      slug: context.slug,
      kind: 'reshape-request',
      detail: { profileVersion: context.profile.version },
    });
    return NextResponse.json({
      renderedMd: result.body,
      source: 'generated',
      stale: false,
      // 只有第一段（模型被明确告知「不必重讲」的那些）才挂纠错入口。
      assumedKnown: (map?.concepts.mastered ?? []).map((c) => c.slug),
    });
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json({ error: 'Reshape cancelled' }, { status: 499 });
    }
    console.error('[reshape] generation failed', error);
    return NextResponse.json({ error: 'Failed to reshape page' }, { status: 502 });
  }
}

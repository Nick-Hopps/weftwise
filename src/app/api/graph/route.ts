import { NextRequest, NextResponse } from 'next/server';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { isMetaPage } from '@/server/db/repos/pages-repo';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';

export const runtime = 'nodejs';

/**
 * GET /api/graph
 * Returns { nodes, edges } for the active subject. Cross-subject edges are
 * dropped — the graph view is one workspace at a time.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const pages = pagesRepo
    .getAllPages(subject.id)
    .filter((p) => !isMetaPage(p));
  const links = pagesRepo.getAllLinks(subject.id);

  const inboundCount = new Map<string, number>();
  for (const link of links) {
    if (link.targetSubjectId !== subject.id) continue;
    inboundCount.set(link.targetSlug, (inboundCount.get(link.targetSlug) || 0) + 1);
  }

  const slugSet = new Set(pages.map((p) => p.slug));

  const nodes = pages.map((p) => ({
    id: p.slug,
    label: p.title,
    linkCount: inboundCount.get(p.slug) || 0,
  }));

  const edges = links
    .filter(
      (l) =>
        l.targetSubjectId === subject.id &&
        slugSet.has(l.sourceSlug) &&
        slugSet.has(l.targetSlug)
    )
    .map((l) => ({
      source: l.sourceSlug,
      target: l.targetSlug,
    }));

  return NextResponse.json({
    nodes,
    edges,
    meta: {
      source: 'wiki',
      status: 'ready',
      nodeCount: nodes.length,
      edgeCount: edges.length,
      subjectId: subject.id,
      subjectSlug: subject.slug,
    },
  });
}

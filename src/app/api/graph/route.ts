import { NextRequest, NextResponse } from 'next/server';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { isMetaPage } from '@/server/db/repos/pages-repo';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { buildGraphProjection } from './graph-data';

export const runtime = 'nodejs';

/**
 * GET /api/graph
 * Returns { nodes, edges } for the active subject. Repeated references between
 * the same directed page pair are aggregated; cross-subject edges are dropped.
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

  const { nodes, edges, referenceCount } = buildGraphProjection(pages, links, subject.id);

  return NextResponse.json({
    nodes,
    edges,
    meta: {
      source: 'wiki',
      status: 'ready',
      nodeCount: nodes.length,
      edgeCount: edges.length,
      referenceCount,
      subjectId: subject.id,
      subjectSlug: subject.slug,
    },
  });
}
